package app.dogo.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.UUID;

/** The server forwards calls; drafts, cached messages and unconfirmed sends stay on this device. */
final class RemoteSessions {
    interface Storage { JSONObject get(String key); void put(String key, JSONObject value) throws Exception; }
    interface Client { JSONObject request(String method, String path, JSONObject body) throws Exception; }
    private final Storage storage;
    private final Client client;

    RemoteSessions(Storage storage, Client client) { this.storage = storage; this.client = client; }
    private String key(String scope, String device, String session) {
        return "remote:" + SecureStore.scope(scope, device + "\n" + session);
    }
    synchronized JSONObject cached(String scope, String device, String session) {
        JSONObject result = storage.get(key(scope, device, session));
        return result == null ? new JSONObject() : result;
    }
    private synchronized void update(String scope, String device, String session, String name, Object value) throws Exception {
        JSONObject state = cached(scope, device, session);
        Json.put(state, name, value);
        storage.put(key(scope, device, session), state);
    }
    void draft(String scope, String device, String session, String value) throws Exception {
        update(scope, device, session, "draft", value);
    }
    synchronized JSONObject prepare(String scope, String device, String session, String text) throws Exception {
        JSONObject state = cached(scope, device, session);
        if (state.optJSONObject("pending") != null) throw new IllegalStateException("已有待确认的消息");
        if (text.trim().isEmpty() || text.length() > 256000) throw new IllegalArgumentException("消息不能为空或超过 256000 字符");
        JSONObject pending = Json.of("sessionId", session, "requestId", UUID.randomUUID().toString(), "text", text);
        Json.put(state, "pending", pending);
        if (state.optString("draft").equals(text)) Json.put(state, "draft", "");
        Json.put(state, "accepted", false);
        storage.put(key(scope, device, session), state); // Commit identity and payload before the first network request.
        return pending;
    }
    JSONObject retry(String scope, String device, String session) throws Exception {
        JSONObject pending = cached(scope, device, session).optJSONObject("pending");
        if (pending == null) throw new IllegalStateException("没有待确认的消息");
        JSONObject response = remote(device, "prompt", pending);
        if (!response.optBoolean("accepted", false)) throw new IllegalStateException("电脑没有确认接收");
        synchronized (this) {
            JSONObject state = cached(scope, device, session);
            JSONObject current = state.optJSONObject("pending");
            if (current != null && current.optString("requestId").equals(pending.optString("requestId"))) {
                state.remove("pending");
                Json.put(state, "accepted", true);
                storage.put(key(scope, device, session), state);
            }
        }
        return response;
    }
    synchronized void stopConfirming(String scope, String device, String session) throws Exception {
        JSONObject state = cached(scope, device, session);
        JSONObject pending = state.optJSONObject("pending");
        if (pending == null) return;
        JSONArray saved = state.optJSONArray("unconfirmed_archive");
        if (saved == null) saved = new JSONArray();
        saved.put(pending);
        Json.put(state, "unconfirmed_archive", saved);
        state.remove("pending");
        storage.put(key(scope, device, session), state);
    }
    JSONObject remote(String device, String method, JSONObject args) throws Exception {
        JSONObject response = client.request("POST", "/api/remote/call",
                Json.of("device_id", device, "method", method, "args", args));
        JSONObject value = response.optJSONObject("value");
        if (value == null) throw new IllegalStateException("电脑返回的数据无效");
        return value;
    }
    synchronized JSONObject cachedList(String scope) {
        JSONObject cached = storage.get("remote-list:" + scope);
        return cached == null ? Json.of("items", new JSONArray()) : cached;
    }
    JSONObject list(String scope) throws Exception {
        JSONArray devices = client.request("GET", "/api/devices", null).optJSONArray("items");
        if (devices == null) throw new IllegalStateException("设备列表无效");
        JSONArray old = cachedList(scope).optJSONArray("items");
        ArrayList<JSONObject> items = new ArrayList<>();
        boolean incomplete = false;
        for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device == null || !device.optBoolean("active") || !"desktop".equals(device.optString("kind"))) continue;
            String id = device.optString("id"), name = device.optString("name", "电脑");
            boolean online = device.optBoolean("online");
            if (online) {
                int first = items.size();
                try {
                    String cursor = "";
                    for (int page = 0; page < 3; page++) {
                        JSONObject listing = remote(id, "list", cursor.isEmpty() ? new JSONObject() : Json.of("cursor", cursor));
                        JSONArray pageItems = listing.optJSONArray("items");
                        if (pageItems == null) throw new IllegalStateException("会话列表无效");
                        for (int n = 0; n < pageItems.length(); n++) {
                            JSONObject session = pageItems.optJSONObject(n);
                            if (session == null || session.optString("sessionId").isEmpty()) continue;
                            String sessionId = session.optString("sessionId");
                            JSONObject state = cached(scope, id, sessionId);
                            items.add(Json.of("device", id, "deviceName", name, "online", true,
                                    "sessionId", sessionId, "title", title(session),
                                    "updatedAt", session.opt("updatedAt"), "preview", state.optString("preview")));
                        }
                        String next = listing.optString("nextCursor", "");
                        if (next.isEmpty() || next.equals(cursor)) break;
                        cursor = next;
                        if (page == 2) incomplete = true;
                    }
                    continue;
                } catch (Exception error) { items.subList(first, items.size()).clear(); incomplete = true; }
            }
            if (old != null) for (int n = 0; n < old.length(); n++) {
                JSONObject entry = old.optJSONObject(n);
                if (entry != null && id.equals(entry.optString("device"))) {
                    JSONObject copy = Json.copy(entry);
                    Json.put(copy, "online", false);
                    Json.put(copy, "deviceName", name);
                    items.add(copy);
                }
            }
        }
        items.sort(Comparator.comparingLong(RemoteSessions::updated).reversed());
        JSONArray result = new JSONArray();
        for (int i = 0; i < Math.min(items.size(), 150); i++) result.put(items.get(i));
        JSONObject list = Json.of("items", result, "incomplete", incomplete, "devices", devices);
        synchronized (this) { storage.put("remote-list:" + scope, list); }
        return list;
    }
    private static long updated(JSONObject entry) {
        Object value = entry.opt("updatedAt");
        if (value instanceof Number) return ((Number) value).longValue();
        try { return java.time.Instant.parse(String.valueOf(value)).toEpochMilli(); } catch (Exception ignored) { return 0; }
    }
    static String title(JSONObject session) {
        JSONObject projections = session.optJSONObject("projections");
        JSONObject values = projections == null ? null : projections.optJSONObject("values");
        String title = values == null ? "" : values.optString("title", "");
        return title.isEmpty() ? session.optString("title", "新会话") : title;
    }
    JSONObject detail(String scope, String device, String session) throws Exception {
        JSONArray devices = client.request("GET", "/api/devices", null).optJSONArray("items");
        boolean online = false;
        if (devices != null) for (int i = 0; i < devices.length(); i++) {
            JSONObject d = devices.optJSONObject(i);
            if (d != null && device.equals(d.optString("id")) && d.optBoolean("active") && d.optBoolean("online")) online = true;
        }
        if (!online) return Json.of("online", false, "known", false);
        boolean known = false, running = false;
        String cursor = "";
        for (int page = 0; page < 10; page++) {
            JSONObject listing = remote(device, "list", cursor.isEmpty() ? new JSONObject() : Json.of("cursor", cursor));
            JSONArray items = listing.optJSONArray("items");
            if (items == null) throw new IllegalStateException("会话列表无效");
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item != null && session.equals(item.optString("sessionId")) && item.opt("running") instanceof Boolean) {
                    known = true; running = item.optBoolean("running"); break;
                }
            }
            if (known) break;
            String next = listing.optString("nextCursor", "");
            if (next.isEmpty() || next.equals(cursor)) break;
            cursor = next;
        }
        JSONObject snapshot = remote(device, "snapshot", Json.of("sessionId", session));
        JSONArray messages = conversation(snapshot);
        String preview = "";
        for (int i = messages.length() - 1; i >= 0; i--) {
            JSONObject item = messages.optJSONObject(i);
            if (item != null && !"status".equals(item.optString("role"))) { preview = item.optString("text"); break; }
        }
        if (preview.length() > 160) preview = preview.substring(0, 160) + "…";
        synchronized (this) {
            JSONObject state = cached(scope, device, session);
            Json.put(state, "messages", messages);
            Json.put(state, "preview", preview);
            storage.put(key(scope, device, session), state);
        }
        return Json.of("online", true, "known", known, "running", running, "messages", messages);
    }
    String preview(String scope, String device, String session) throws Exception {
        JSONArray messages = conversation(remote(device, "snapshot", Json.of("sessionId", session)));
        String preview = "";
        for (int i = messages.length() - 1; i >= 0; i--) {
            JSONObject item = messages.optJSONObject(i);
            if (item != null && !"status".equals(item.optString("role"))) { preview = item.optString("text"); break; }
        }
        if (preview.length() > 160) preview = preview.substring(0, 160) + "…";
        synchronized (this) {
            JSONObject state = cached(scope, device, session);
            Json.put(state, "messages", messages);
            Json.put(state, "preview", preview);
            storage.put(key(scope, device, session), state);
        }
        return preview;
    }
    static JSONArray conversation(JSONObject snapshot) {
        JSONArray result = new JSONArray(), records = snapshot.optJSONArray("records");
        if (records == null) return result;
        for (int i = 0; i < records.length(); i++) {
            JSONObject record = records.optJSONObject(i), event = record == null ? null : record.optJSONObject("event");
            JSONObject data = event == null ? null : event.optJSONObject("data");
            if (data == null) continue;
            String type = event.optString("type"), role = "", text = "";
            if (type.equals("user/message")) {
                JSONObject source = data.optJSONObject("source");
                if (source != null && "user".equals(source.optString("kind"))) { role = "user"; text = blocks(data.optJSONArray("content"), false); }
            } else if (type.equals("assistant/message")) {
                JSONObject message = data.optJSONObject("message");
                if (message != null) { role = "assistant"; text = blocks(message.optJSONArray("content"), true); }
            } else if (type.equals("tool/call")) { role = "status"; text = "正在使用工具：" + data.optString("name", "工具"); }
            else if (type.equals("turn/end")) {
                JSONObject reason = data.optJSONObject("reason");
                if (reason != null && ("failed".equals(reason.optString("kind")) || "error".equals(reason.optString("kind")))) {
                    role = "status"; text = "本轮执行出错，请在电脑查看详情。";
                }
            }
            if (!text.isEmpty()) {
                if (text.length() > 16000) text = text.substring(0, 16000) + "\n…（内容已截取）";
                result.put(Json.of("role", role, "text", text));
            }
        }
        return result;
    }
    private static String blocks(JSONArray blocks, boolean assistant) {
        if (blocks == null) return "";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < blocks.length(); i++) {
            JSONObject block = blocks.optJSONObject(i);
            if (block == null) continue;
            String type = block.optString("type");
            String text = type.equals("text") ? block.optString("text") :
                    (!assistant && !type.equals("reasoning") && !type.equals("tool-call") ? "[" + type + "]" : "");
            if (!text.isEmpty()) { if (out.length() > 0) out.append('\n'); out.append(text); }
        }
        return out.toString();
    }
}
