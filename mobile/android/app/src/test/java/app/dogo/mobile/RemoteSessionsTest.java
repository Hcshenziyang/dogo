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
        public void put(String key, JSONObject value) { values.put(key, Json.copy(value)); }
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
            if (body.optString("method").equals("list")) return Json.of("value", Json.of("items", new JSONArray().put(Json.of("sessionId", "session"))));
            JSONObject event = Json.of("type", "turn/end", "data", Json.of("reason", Json.of("kind", "completed")));
            return Json.of("value", Json.of("records", new JSONArray().put(Json.of("event", event))));
        });
        assertFalse(remote.detail("a", "mac", "session").optBoolean("known"));
    }
}
