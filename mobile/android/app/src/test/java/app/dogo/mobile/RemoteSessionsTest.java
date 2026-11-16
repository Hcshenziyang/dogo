package app.dogo.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

public class RemoteSessionsTest {
    static class Memory implements RemoteSessions.Storage {
        final Map<String, JSONObject> values = new HashMap<>();
        public JSONObject get(String key) { return values.containsKey(key) ? Json.copy(values.get(key)) : null; }
        public void put(String key, JSONObject value) {
            if (value == null) values.remove(key); else values.put(key, Json.copy(value));
        }
    }
    @Test public void uncertainSendKeepsOriginalIdentityAndAllowsAnIndependentDraft() throws Exception {
        Memory memory = new Memory();
        JSONArray sent = new JSONArray();
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            sent.put(Json.copy(body.optJSONObject("args")));
            if (sent.length() == 1) throw new IOException("response lost after delivery");
            return Json.of("value", Json.of("accepted", true));
        });
        remote.draft("account-a", "mac", "conversation", "run tests");
        JSONObject prepared = remote.prepare("account-a", "mac", "conversation", "run tests");
        assertFalse(prepared.optString("requestId").isEmpty());
        assertEquals("", remote.cached("account-a", "mac", "conversation").optString("draft"));
        assertThrows(IOException.class, () -> remote.retry("account-a", "mac", "conversation"));
        remote.draft("account-a", "mac", "conversation", "another draft");
        assertThrows(IllegalStateException.class, () -> remote.prepare("account-a", "mac", "conversation", "another draft"));
        remote.retry("account-a", "mac", "conversation");
        assertEquals(sent.getJSONObject(0).toString(), sent.getJSONObject(1).toString());
        assertEquals(prepared.optString("requestId"), sent.getJSONObject(1).optString("requestId"));
        JSONObject state = remote.cached("account-a", "mac", "conversation");
        assertNull(state.optJSONObject("pending"));
        assertTrue(state.optBoolean("accepted"));
        assertEquals("another draft", state.optString("draft"));
        assertNull(remote.cached("account-b", "mac", "conversation").optJSONObject("pending"));
        assertEquals("", remote.cached("account-b", "mac", "conversation").optString("draft"));
    }
    @Test public void localPersistenceFailurePreventsDelivery() throws Exception {
        final boolean[] sent = {false};
        RemoteSessions remote = new RemoteSessions(new RemoteSessions.Storage() {
            public JSONObject get(String key) { return null; }
            public void put(String key, JSONObject value) throws Exception { throw new IOException("disk full"); }
        }, (method, path, body) -> { sent[0] = true; return new JSONObject(); });
        assertThrows(IOException.class, () -> remote.prepare("a", "mac", "session", "hello"));
        assertFalse(sent[0]);
    }
    @Test public void stoppingConfirmationKeepsBothOriginalAndNewDraft() throws Exception {
        Memory memory = new Memory();
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> { throw new IOException("offline"); });
        remote.draft("a", "mac", "session", "first message");
        JSONObject original = remote.prepare("a", "mac", "session", "first message");
        remote.draft("a", "mac", "session", "second draft");
        remote.stopConfirming("a", "mac", "session");
        JSONObject state = remote.cached("a", "mac", "session");
        assertNull(state.optJSONObject("pending"));
        assertEquals("second draft", state.optString("draft"));
        assertEquals(original.toString(), state.getJSONArray("unconfirmed_archive").getJSONObject(0).toString());
    }
    @Test public void statusComesFromSessionListAndOfflineKeepsCachedMessages() throws Exception {
        Memory memory = new Memory();
        final boolean[] online = {true};
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(Json.of("id", "mac", "name", "Mac", "active", true, "kind", "desktop", "online", online[0])));
            if (body.optString("method").equals("workspaces")) return Json.of("value", Json.of("items", new JSONArray(), "archivedSessionIds", new JSONArray()));
            if (body.optString("method").equals("list")) return Json.of("value", Json.of("items", new JSONArray().put(Json.of("sessionId", "session", "running", true, "title", "Title"))));
            JSONObject message = Json.of("content", new JSONArray().put(Json.of("type", "text", "text", "still working")));
            JSONObject event = Json.of("type", "assistant/message", "data", Json.of("message", message));
            return Json.of("value", Json.of("records", new JSONArray().put(Json.of("event", event))));
        });
        JSONObject detail = remote.detail("a", "mac", "session");
        assertTrue(detail.optBoolean("known"));
        assertTrue(detail.optBoolean("running"));
        assertEquals("still working", detail.getJSONArray("messages").getJSONObject(0).optString("text"));
        remote.list("a");
        online[0] = false;
        JSONObject offline = remote.detail("a", "mac", "session");
        assertFalse(offline.optBoolean("online"));
        assertFalse(offline.optBoolean("known"));
        assertEquals("still working", remote.cached("a", "mac", "session").getJSONArray("messages").getJSONObject(0).optString("text"));
        assertEquals(1, remote.list("a").getJSONArray("items").length());
    }
    @Test public void missingRunningFieldIsUnknownEvenWhenSnapshotHasTurnEnd() throws Exception {
        RemoteSessions remote = new RemoteSessions(new Memory(), (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(Json.of("id", "mac", "active", true, "online", true)));
            if (body.optString("method").equals("workspaces")) return Json.of("value", Json.of("items", new JSONArray(), "archivedSessionIds", new JSONArray()));
            if (body.optString("method").equals("list")) return Json.of("value", Json.of("items", new JSONArray().put(Json.of("sessionId", "session"))));
            JSONObject event = Json.of("type", "turn/end", "data", Json.of("reason", Json.of("kind", "completed")));
            return Json.of("value", Json.of("records", new JSONArray().put(Json.of("event", event))));
        });
        assertFalse(remote.detail("a", "mac", "session").optBoolean("known"));
    }
    @Test public void projectsMapSessionsAndRemainAvailableOffline() throws Exception {
        Memory memory = new Memory();
        final boolean[] online = {true}, projectsAvailable = {true};
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(Json.of("id", "mac", "name", "Mac", "kind", "desktop", "active", true, "online", online[0])));
            if (body.optString("method").equals("workspaces")) {
                if (!projectsAvailable[0]) throw new IOException("workspace unavailable");
                return Json.of("value", Json.of("archivedSessionIds", new JSONArray().put("archived"), "items", new JSONArray()
                        .put(Json.of("workspaceId", "p1", "title", "Project", "sessionIds", new JSONArray().put("s1")))
                        .put(Json.of("workspaceId", "p2", "title", "Empty", "sessionIds", new JSONArray()))));
            }
            return Json.of("value", Json.of("items", new JSONArray()
                    .put(Json.of("sessionId", "s1", "running", false))
                    .put(Json.of("sessionId", "s2", "running", false))
                    .put(Json.of("sessionId", "archived", "running", false))));
        });
        JSONObject first = remote.list("a");
        assertEquals(2, first.getJSONArray("projects").length());
        assertEquals("Project", first.getJSONArray("items").getJSONObject(0).optString("projectName"));
        assertEquals("未分组", first.getJSONArray("items").getJSONObject(1).optString("projectName"));
        assertEquals(2, first.getJSONArray("items").length());
        projectsAvailable[0] = false;
        JSONObject partial = remote.list("a");
        assertTrue(partial.optBoolean("incomplete"));
        assertEquals("p1", partial.getJSONArray("items").getJSONObject(0).optString("workspaceId"));
        assertFalse(partial.getJSONArray("projects").getJSONObject(0).optBoolean("online"));
        online[0] = false;
        JSONObject offline = remote.list("a");
        assertEquals(2, offline.getJSONArray("projects").length());
        assertEquals("Project", offline.getJSONArray("items").getJSONObject(0).optString("projectName"));
    }
    @Test public void oldUnverifiedCacheAndArchivedSessionsStayHidden() throws Exception {
        Memory memory = new Memory();
        memory.put("remote-list:a", Json.of("items", new JSONArray().put(Json.of("device", "mac", "sessionId", "archived"))));
        final boolean[] snapshotCalled = {false};
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(Json.of("id", "mac", "kind", "desktop", "active", true, "online", true)));
            if (body.optString("method").equals("workspaces")) return Json.of("value", Json.of("items", new JSONArray(), "archivedSessionIds", new JSONArray().put("archived")));
            if (body.optString("method").equals("snapshot")) snapshotCalled[0] = true;
            return Json.of("value", Json.of("items", new JSONArray().put(Json.of("sessionId", "archived", "running", false))));
        });
        assertEquals(0, remote.cachedList("a").getJSONArray("items").length());
        assertNotNull("legacy data stays on disk until refresh", memory.get("remote-list:a"));
        assertEquals(0, remote.list("a").getJSONArray("items").length());
        assertTrue(remote.detail("a", "mac", "archived").optBoolean("archived"));
        assertFalse("archived session must not be read", snapshotCalled[0]);
    }
    @Test public void modelOptionsPreserveProviderAndReasoningChoices() throws Exception {
        JSONObject reasoning = Json.of("defaultEffort", "low", "efforts", new JSONArray().put(Json.of("id", "high", "name", "高")));
        JSONObject catalog = Json.of("groups", new JSONArray().put(Json.of("id", "provider", "name", "Provider", "models", new JSONArray()
                .put(Json.of("id", "m1", "name", "Model One", "reasoning", reasoning))
                .put(Json.of("id", "m2", "name", "Model Two")))));
        java.util.ArrayList<JSONObject> options = RemoteSessions.modelOptions(catalog);
        assertEquals(2, options.size());
        assertEquals("provider", options.get(0).optString("provider"));
        assertEquals("Provider · Model One", options.get(0).optString("label"));
        assertEquals("high", options.get(0).getJSONObject("reasoning").getJSONArray("efforts").getJSONObject(0).optString("id"));
        RemoteSessions remote = new RemoteSessions(new Memory(), (method, path, body) -> new JSONObject());
        remote.cacheCatalog("account-a", "mac", catalog);
        assertEquals(2, RemoteSessions.modelOptions(remote.cachedCatalog("account-a", "mac")).size());
        assertNull(remote.cachedCatalog("account-b", "mac"));
    }
    @Test public void longMessageKeepsFullTextAndStableSequence() throws Exception {
        String text = "long ".repeat(6000);
        JSONObject event = Json.of("seq", 123, "type", "assistant/message", "data", Json.of("message", Json.of("content", new JSONArray().put(Json.of("type", "text", "text", text)))));
        JSONObject message = RemoteSessions.conversation(Json.of("records", new JSONArray().put(Json.of("event", event)))).getJSONObject(0);
        assertEquals("123", message.optString("id"));
        assertEquals(text, message.optString("text"));
    }
    @Test public void conversationHidesToolActivityButKeepsMessagesAndFailures() throws Exception {
        JSONArray events = new JSONArray()
                .put(Json.of("event", Json.of("type", "user/message", "data", Json.of("source", Json.of("kind", "system"),
                        "content", new JSONArray().put(Json.of("type", "text", "text", "internal context"))))))
                .put(Json.of("event", Json.of("type", "user/message", "data", Json.of("source", Json.of("kind", "user"),
                        "content", new JSONArray().put(Json.of("type", "text", "text", "hello"))
                                .put(Json.of("type", "tool-result")).put(Json.of("type", "image"))))))
                .put(Json.of("event", Json.of("type", "tool/call", "data", Json.of("name", "search"))))
                .put(Json.of("event", Json.of("type", "tool/result", "data", Json.of("result", "noisy"))))
                .put(Json.of("event", Json.of("type", "assistant/message", "data", Json.of("message", Json.of("content", new JSONArray()
                        .put(Json.of("type", "reasoning", "text", "internal thoughts"))
                        .put(Json.of("type", "tool-call", "name", "search"))
                        .put(Json.of("type", "text", "text", "answer")))))))
                .put(Json.of("event", Json.of("type", "turn/end", "data", Json.of("reason", Json.of("kind", "failed")))));
        JSONArray messages = RemoteSessions.conversation(Json.of("records", events));
        assertEquals(3, messages.length());
        assertEquals("hello\n[image]", messages.getJSONObject(0).optString("text"));
        assertEquals("answer", messages.getJSONObject(1).optString("text"));
        assertEquals("本轮执行出错，请在电脑查看详情。", messages.getJSONObject(2).optString("text"));
        JSONArray cached = new JSONArray().put(Json.of("role", "status", "text", "正在使用工具：search"))
                .put(Json.of("role", "status", "text", "本轮执行出错，请在电脑查看详情。"));
        assertEquals(1, RemoteSessions.visibleMessages(cached).length());
        assertEquals("本轮执行出错，请在电脑查看详情。", RemoteSessions.visibleMessages(cached).getJSONObject(0).optString("text"));
    }
    @Test public void createRetriesSameSessionAndProjectAfterLostResponse() throws Exception {
        Memory memory = new Memory();
        JSONArray calls = new JSONArray();
        RemoteSessions.Client client = (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(
                    Json.of("id", "mac", "kind", "desktop", "active", true, "online", true)));
            if ("workspaces".equals(body.optString("method"))) return Json.of("value", Json.of("items", new JSONArray()
                    .put(Json.of("workspaceId", "project-a")).put(Json.of("workspaceId", "project-b"))));
            JSONObject args = Json.copy(body.getJSONObject("args"));
            calls.put(args);
            if (calls.length() == 1) throw new IOException("reply lost after computer created session");
            return Json.of("value", Json.of("sessionId", args.optString("sessionId")));
        };
        RemoteSessions remote = new RemoteSessions(memory, client);
        assertThrows(IOException.class, () -> remote.create("account", "mac", "project-a"));
        JSONObject pending = remote.pendingCreate("account", "mac", "project-a");
        assertNotNull(pending);
        assertEquals("project-a", pending.optString("workspaceId"));
        assertNull(remote.pendingCreate("account", "mac", "project-b"));
        assertNull(remote.pendingCreate("other-account", "mac", "project-a"));
        RemoteSessions reopened = new RemoteSessions(memory, client);
        JSONObject result = reopened.create("account", "mac", "project-a");
        assertEquals(pending.optString("sessionId"), result.optString("sessionId"));
        assertEquals(calls.getJSONObject(0).toString(), calls.getJSONObject(1).toString());
        assertNull(reopened.pendingCreate("account", "mac", "project-a"));
        reopened.create("account", "mac", "");
        assertFalse(calls.getJSONObject(2).has("workspaceId"));
        assertNotEquals(pending.optString("sessionId"), calls.getJSONObject(2).optString("sessionId"));
    }
    @Test public void creationChecksLiveDeviceAndProjectBeforeSending() throws Exception {
        Memory memory = new Memory();
        final boolean[] online = {false};
        final int[] creates = {0};
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(
                    Json.of("id", "mac", "kind", "desktop", "active", true, "online", online[0])));
            if ("workspaces".equals(body.optString("method"))) return Json.of("value", Json.of("items", new JSONArray()));
            creates[0]++;
            return Json.of("value", new JSONObject());
        });
        assertThrows(IllegalStateException.class, () -> remote.create("account", "mac", "project"));
        online[0] = true;
        assertThrows(IllegalStateException.class, () -> remote.create("account", "mac", "project"));
        assertEquals(0, creates[0]);
        assertNull(remote.pendingCreate("account", "mac", "project"));
    }
    @Test public void unexpectedCreateReplyDoesNotDiscardPendingIdentity() throws Exception {
        Memory memory = new Memory();
        RemoteSessions remote = new RemoteSessions(memory, (method, path, body) -> {
            if (path.equals("/api/devices")) return Json.of("items", new JSONArray().put(
                    Json.of("id", "mac", "kind", "desktop", "active", true, "online", true)));
            return Json.of("value", Json.of("sessionId", "different-session"));
        });
        assertThrows(IllegalStateException.class, () -> remote.create("account", "mac", ""));
        assertNotNull(remote.pendingCreate("account", "mac", ""));
    }
}
