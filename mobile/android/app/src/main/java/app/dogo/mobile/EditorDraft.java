package app.dogo.mobile;

import org.json.JSONObject;
import org.json.JSONArray;
import java.util.UUID;

/** Persist the exact write before sending. Unknown results must never silently become new writes. */
final class EditorDraft {
    final JSONObject data;
    EditorDraft(JSONObject data) { this.data = Json.copy(data); }
    static EditorDraft create() {
        return new EditorDraft(Json.of("mode", "create", "request_id", UUID.randomUUID().toString(),
                "fields", Json.of("content", "", "project", "", "category", "", "tags", new JSONArray(), "active", true)));
    }
    static EditorDraft forMemo(String mode, JSONObject memo) {
        JSONObject fields = Json.of("content", mode.equals("append") ? "" : memo.optString("content"),
                "project", memo.optString("project"), "category", memo.optString("category"),
                "tags", memo.optJSONArray("tags"), "active", memo.optBoolean("active", true));
        return new EditorDraft(Json.of("mode", mode, "memo_id", memo.optString("id"),
                "revision", memo.optInt("revision"), "fields", fields));
    }
    String mode() { return data.optString("mode"); }
    String memoId() { return data.optString("memo_id"); }
    JSONObject fields() { return data.optJSONObject("fields"); }
    boolean pending() { return data.optJSONObject("pending") != null; }
    JSONObject freeze() {
        if (pending()) return Json.copy(data.optJSONObject("pending"));
        JSONObject payload;
        if (mode().equals("append")) payload = Json.of("content", fields().optString("content"));
        else payload = Json.copy(fields());
        if (mode().equals("create")) {
            Json.put(payload, "request_id", data.optString("request_id"));
            if (data.optBoolean("dispatch_enabled")) Json.put(payload, "dispatch",
                    Json.of("instruction", data.optString("instruction"), "target_device_id", data.optString("target_device_id")));
        } else Json.put(payload, "revision", data.optInt("revision"));
        Json.put(data, "pending", payload);
        return Json.copy(payload);
    }
    void definiteRejection() { data.remove("pending"); }
    String path() { return mode().equals("create") ? "/api/memos" : "/api/memos/" + ApiClient.encode(memoId()) + (mode().equals("append") ? "/append" : ""); }
    String method() { return mode().equals("edit") ? "PUT" : "POST"; }
}
