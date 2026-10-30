package app.dogo.mobile;

import org.json.JSONObject;
import org.junit.Test;
import java.util.UUID;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Run only against scripts/test_server.py, which creates disposable synthetic data. */
public class LiveApiTest {
    @Test public void realServerMemoLifecycleRetryConflictAndDeviceRevocation() throws Exception {
        String origin = System.getProperty("dogo.apiUrl", "");
        assumeTrue(!origin.isEmpty());
        ApiClientTest.MemoryStore store = new ApiClientTest.MemoryStore();
        ApiClient api = new ApiClient(store, true);
        String device = UUID.randomUUID().toString();
        api.login(origin, "android-test", "android-test-password", device, "联调手机");
        assertEquals("android-test", api.request("GET", "/api/auth/me", null).getString("username"));
        EditorDraft draft = EditorDraft.create();
        Json.put(draft.fields(), "content", "午饭 35 元");
        Json.put(draft.fields(), "project", "记账");
        Json.put(draft.data, "dispatch_enabled", true);
        Json.put(draft.data, "instruction", "整理这笔账");
        Json.put(draft.data, "target_device_id", "test-offline-desktop");
        JSONObject created = api.request("POST", "/api/memos", draft.freeze());
        assertEquals("pending", created.getJSONObject("dispatch").getString("status"));
        String path = "/api/memos/" + created.getString("id");
        assertEquals(created.getString("id"), api.request("POST", "/api/memos", draft.freeze()).getString("id"));
        JSONObject tokens = store.session();
        Json.put(tokens, "access_token", "expired-for-test"); store.saveSession(tokens);
        assertEquals(created.getString("id"), api.request("GET", path, null).getString("id"));
        EditorDraft edit = EditorDraft.forMemo("edit", created);
        Json.put(edit.fields(), "content", "午饭 36 元");
        JSONObject updated = api.request("PUT", path, edit.freeze());
        assertEquals(2, updated.getInt("revision"));
        EditorDraft append = EditorDraft.forMemo("append", updated);
        Json.put(append.fields(), "content", "\n晚饭 20 元");
        JSONObject appended = api.request("POST", path + "/append", append.freeze());
        assertEquals("午饭 36 元\n晚饭 20 元", appended.getString("content"));
        ApiClient.ApiException conflict = assertThrows(ApiClient.ApiException.class, () -> api.request("POST", path + "/append", append.freeze()));
        assertEquals("revision_conflict", conflict.code);
        assertEquals(3, api.request("GET", path, null).getInt("revision"));
        assertTrue(api.request("GET", "/api/memos?project=" + ApiClient.encode("记账"), null).getJSONArray("items").length() > 0);
        JSONObject deleted = api.request("DELETE", path, Json.of("revision", appended.getInt("revision")));
        assertFalse(deleted.isNull("deleted_at"));
        assertEquals("cancelled", deleted.getJSONObject("dispatch").getString("status"));
        assertTrue(api.request("GET", "/api/devices", null).getJSONArray("items").length() >= 2);
        api.request("DELETE", "/api/devices/" + device, null);
        assertThrows(ApiClient.ApiException.class, () -> api.request("GET", "/api/auth/me", null));
        assertNull(store.session());
        api.login(origin, "android-test", "android-test-password", device, "联调手机");
        api.logout(); assertNull(store.session());
    }
}
