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
    @Test public void scheduledWritesFreezeExactPlanAndLeaveOldPlansUnchangedWhenEditingContent() {
        JSONObject plan = Json.of("id", "plan-id", "mode", "weekly", "enabled", true,
                "timezone", "Asia/Shanghai", "time", "09:30", "weekday", 2,
                "instruction", "整理", "target_device_id", "pc");
        JSONObject memo = Json.of("id", "memo", "revision", 5, "content", "原文", "plan", plan);
        EditorDraft plain = EditorDraft.forMemo("edit", memo);
        Json.put(plain.fields(), "content", "新正文");
        assertFalse(plain.freeze().has("plan"));
        EditorDraft scheduled = EditorDraft.forMemo("edit", memo);
        Json.put(scheduled.data, "plan_dirty", true);
        Json.put(scheduled.data.optJSONObject("schedule"), "instruction", "  整理  \n");
        JSONObject body = scheduled.freeze();
        assertEquals("  整理  \n", body.optJSONObject("plan").optString("instruction"));
        assertEquals("weekly", body.optJSONObject("plan").optString("mode"));
        assertEquals(2, body.optJSONObject("plan").optInt("weekday"));
        assertFalse(body.optJSONObject("plan").has("id"));
        Json.put(scheduled.data.optJSONObject("schedule"), "instruction", "不同内容");
        assertEquals(body.toString(), scheduled.freeze().toString());
        EditorDraft removed = EditorDraft.forMemo("edit", memo);
        Json.put(removed.data, "plan_dirty", true);
        Json.put(removed.data, "plan_present", false);
        assertTrue(removed.freeze().has("plan"));
        assertTrue(removed.freeze().isNull("plan"));
    }
    @Test public void oneTimePlanUsesItsTimezoneAndRejectsMissingWallTimes() {
        JSONObject input = ScheduleDraft.fromPlan(null);
        Json.put(input, "instruction", "整理");
        Json.put(input, "target_device_id", "pc");
        Json.put(input, "run_at_input", "2026-11-03 20:30");
        assertEquals(java.time.Instant.parse("2026-11-03T12:30:00Z").toEpochMilli(),
                ScheduleDraft.payload(input).optLong("run_at"));
        Json.put(input, "timezone", "America/New_York");
        Json.put(input, "run_at_input", "2026-03-08 02:30");
        try { ScheduleDraft.payload(input); fail("DST gap must be rejected"); }
        catch (IllegalArgumentException expected) { assertNotNull(expected.getMessage()); }
    }
}
