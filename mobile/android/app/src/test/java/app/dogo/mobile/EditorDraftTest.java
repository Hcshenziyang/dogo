package app.dogo.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class EditorDraftTest {
    @Test public void uncertainCreateSurvivesRestartWithExactBodyAndRequestId() {
        EditorDraft draft = EditorDraft.create();
        Json.put(draft.fields(), "content", "午饭 35 元");
        Json.put(draft.data, "dispatch_enabled", true);
        Json.put(draft.data, "instruction", "整理账目");
        Json.put(draft.data, "target_device_id", "pc");
        JSONObject original = draft.freeze();
        EditorDraft restarted = new EditorDraft(Json.object(draft.data.toString()));
        Json.put(restarted.fields(), "content", "new edits cannot alter a pending request");
        assertEquals(original.toString(), restarted.freeze().toString());
        assertTrue(restarted.pending());
    }
    @Test public void appendRetryKeepsOriginalRevision() {
        EditorDraft draft = EditorDraft.forMemo("append", Json.of("id", "memo", "content", "old", "revision", 3));
        Json.put(draft.fields(), "content", "\nnew");
        JSONObject original = draft.freeze();
        Json.put(draft.data, "revision", 4);
        assertEquals(3, draft.freeze().optInt("revision"));
        assertEquals(original.toString(), draft.freeze().toString());
        assertFalse(original.has("project"));
    }
    @Test public void updatePreservesAllBusinessFields() {
        JSONObject memo = Json.of("id", "memo", "revision", 9, "content", "old", "project", "账本", "category", "生活", "tags", Json.tags("餐饮,午饭"), "active", false);
        EditorDraft draft = EditorDraft.forMemo("edit", memo);
        Json.put(draft.fields(), "content", "changed");
        JSONObject payload = draft.freeze();
        assertEquals("账本", payload.optString("project"));
        assertEquals("生活", payload.optString("category"));
        assertEquals(2, payload.optJSONArray("tags").length());
        assertFalse(payload.optBoolean("active"));
        assertEquals(9, payload.optInt("revision"));
    }
}
