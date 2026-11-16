package app.dogo.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
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
    void selection(String scope, String device, String session, JSONObject value) throws Exception {
        update(scope, device, session, "selection", value);
    }
    synchronized JSONObject cachedCatalog(String scope, String device) {
        return storage.get("remote-catalog:" + SecureStore.scope(scope, device));
    }
    synchronized void cacheCatalog(String scope, String device, JSONObject value) throws Exception {
        storage.put("remote-catalog:" + SecureStore.scope(scope, device), value);
    }
    static ArrayList<JSONObject> modelOptions(JSONObject catalog) {
        ArrayList<JSONObject> options = new ArrayList<>();
        JSONArray groups = catalog == null ? null : catalog.optJSONArray("groups");
        if (groups == null) return options;
        for (int i = 0; i < groups.length(); i++) {
            JSONObject group = groups.optJSONObject(i);
            if (group == null || group.optString("id").isEmpty()) continue;
            JSONArray models = group.optJSONArray("models");
            if (models == null) continue;
            for (int j = 0; j < models.length(); j++) {
                JSONObject model = models.optJSONObject(j);
                if (model == null || model.optString("id").isEmpty()) continue;
                options.add(Json.of("provider", group.optString("id"), "model", model.optString("id"),
                        "label", group.optString("name", group.optString("id")) + " · " + model.optString("name", model.optString("id")),
                        "reasoning", model.optJSONObject("reasoning")));
            }
        }
        return options;
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
    private String createKey(String scope, String device, String workspace) {
        return "remote-create:" + SecureStore.scope(scope, device + "\n" + workspace);
    }
    synchronized JSONObject pendingCreate(String scope, String device, String workspace) {
        return storage.get(createKey(scope, device, workspace));
    }
    synchronized JSONObject prepareCreate(String scope, String device, String workspace) throws Exception {
        String key = createKey(scope, device, workspace);
        JSONObject pending = storage.get(key);
        if (pending == null) {
            pending = Json.of("sessionId", "dogo-" + UUID.randomUUID());
            if (!workspace.isEmpty()) Json.put(pending, "workspaceId", workspace);
            storage.put(key, pending);
        }
        return pending;
    }
    JSONObject create(String scope, String device, String workspace) throws Exception {
        if (device.isEmpty() || device.length() > 128 || workspace.length() > 128)
            throw new IllegalArgumentException("电脑或项目无效，请刷新后重试。");
        JSONArray devices = client.request("GET", "/api/devices", null).optJSONArray("items");
        boolean online = false;
        if (devices != null) for (int i = 0; i < devices.length(); i++) {
            JSONObject entry = devices.optJSONObject(i);
            if (entry != null && device.equals(entry.optString("id")) && "desktop".equals(entry.optString("kind"))
                    && entry.optBoolean("active") && entry.optBoolean("online")) online = true;
        }
        if (!online) throw new IllegalStateException("电脑当前不在线，请连接后重试。");
        if (!workspace.isEmpty()) {
            JSONArray projects = remote(device, "workspaces", new JSONObject()).optJSONArray("items");
            if (projects == null) throw new IllegalStateException("无法确认电脑上的项目，请刷新后重试。");
            boolean found = false;
            for (int i = 0; i < projects.length(); i++) {
                JSONObject project = projects.optJSONObject(i);
                if (project != null && workspace.equals(project.optString("workspaceId"))) found = true;
            }
            if (!found) throw new IllegalStateException("电脑上已找不到该项目，请刷新后重试。");
        }
        JSONObject pending = prepareCreate(scope, device, workspace);
        JSONObject result = remote(device, "create", pending);
        if (!pending.optString("sessionId").equals(result.optString("sessionId")))
            throw new IllegalStateException("未能确认新会话，请使用相同项目重试。");
        synchronized (this) {
            JSONObject current = pendingCreate(scope, device, workspace);
            if (current != null && pending.optString("sessionId").equals(current.optString("sessionId")))
                storage.put(createKey(scope, device, workspace), null);
        }
        return result;
    }
    synchronized JSONObject cachedList(String scope) {
        JSONObject cached = storage.get("remote-list:" + scope);
        if (cached == null || !cached.optBoolean("archiveChecked"))
            return Json.of("items", new JSONArray(), "projects", new JSONArray());
        return cached;
    }
    private synchronized void hideArchivedSession(String scope, String device, String session) throws Exception {
        JSONObject list = cachedList(scope);
        JSONArray entries = list.optJSONArray("items"), filtered = new JSONArray();
        if (entries != null) for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry != null && !(device.equals(entry.optString("device")) && session.equals(entry.optString("sessionId"))))
                filtered.put(entry);
        }
        Json.put(list, "items", filtered);
        Json.put(list, "archiveChecked", true);
        storage.put("remote-list:" + scope, list);
    }
    JSONObject list(String scope) throws Exception {
        JSONArray devices = client.request("GET", "/api/devices", null).optJSONArray("items");
        if (devices == null) throw new IllegalStateException("设备列表无效");
        JSONObject previous = cachedList(scope);
        JSONArray old = previous.optJSONArray("items"), oldProjects = previous.optJSONArray("projects");
        ArrayList<JSONObject> items = new ArrayList<>();
        JSONArray projects = new JSONArray();
        boolean incomplete = false;
        for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device == null || !device.optBoolean("active") || !"desktop".equals(device.optString("kind"))) continue;
            String id = device.optString("id"), name = device.optString("name", "电脑");
            boolean online = device.optBoolean("online");
            HashMap<String, JSONObject> assignments = new HashMap<>();
            HashSet<String> archived = new HashSet<>();
            boolean projectKnown = false;
            if (online) {
                try {
                    JSONObject baseline = remote(id, "workspaces", new JSONObject());
                    JSONArray workspaces = baseline.optJSONArray("items");
                    JSONArray archivedIds = baseline.optJSONArray("archivedSessionIds");
                    if (workspaces == null || archivedIds == null) throw new IllegalStateException("无法确认项目或归档状态");
                    for (int n = 0; n < archivedIds.length(); n++) archived.add(archivedIds.optString(n));
                    for (int n = 0; n < workspaces.length(); n++) {
                        JSONObject workspace = workspaces.optJSONObject(n);
                        if (workspace == null || workspace.optString("workspaceId").isEmpty()) continue;
                        JSONObject project = Json.of("device", id, "deviceName", name,
                                "workspaceId", workspace.optString("workspaceId"),
                                "title", workspace.optString("title", "未命名项目"), "online", true);
                        projects.put(project);
                        JSONArray sessions = workspace.optJSONArray("sessionIds");
                        if (sessions != null) for (int j = 0; j < sessions.length(); j++)
                            assignments.putIfAbsent(sessions.optString(j), project);
                    }
                    projectKnown = true;
                } catch (Exception error) { incomplete = true; }
            }
            if (!projectKnown) {
                if (oldProjects != null) for (int n = 0; n < oldProjects.length(); n++) {
                    JSONObject project = oldProjects.optJSONObject(n);
                    if (project != null && id.equals(project.optString("device"))) {
                        JSONObject copy = Json.copy(project);
                        Json.put(copy, "online", false);
                        Json.put(copy, "deviceName", name);
                        projects.put(copy);
                    }
                }
                if (old != null) for (int n = 0; n < old.length(); n++) {
                    JSONObject entry = old.optJSONObject(n);
                    if (entry != null && id.equals(entry.optString("device")) && entry.optBoolean("projectKnown"))
                        assignments.put(entry.optString("sessionId"), Json.of("workspaceId", entry.optString("workspaceId"), "title", entry.optString("projectName")));
                }
            }
            if (online && projectKnown) {
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
                            if (archived.contains(sessionId)) continue;
                            JSONObject state = cached(scope, id, sessionId);
                            JSONObject project = assignments.get(sessionId);
                            boolean known = projectKnown || project != null;
                            items.add(Json.of("device", id, "deviceName", name, "online", true,
                                    "sessionId", sessionId, "title", title(session),
                                    "updatedAt", session.opt("updatedAt"), "preview", state.optString("preview"),
                                    "projectKnown", known, "workspaceId", project == null ? "" : project.optString("workspaceId"),
                                    "projectName", project == null ? (known ? "未分组" : "项目未知") : project.optString("title")));
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
                if (entry != null && id.equals(entry.optString("device"))
                        && (!projectKnown || !archived.contains(entry.optString("sessionId")))) {
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
        JSONObject list = Json.of("items", result, "projects", projects, "incomplete", incomplete, "devices", devices, "archiveChecked", true);
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
        JSONArray archived = remote(device, "workspaces", new JSONObject()).optJSONArray("archivedSessionIds");
        if (archived == null) throw new IllegalStateException("无法确认会话归档状态");
        for (int i = 0; i < archived.length(); i++) if (session.equals(archived.optString(i))) {
            hideArchivedSession(scope, device, session);
            return Json.of("online", true, "known", false, "archived", true);
        }
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
        JSONObject projections = snapshot.optJSONObject("projections");
        JSONObject values = projections == null ? null : projections.optJSONObject("values");
        JSONObject modelSelection = values == null ? null : values.optJSONObject("modelSelection");
        JSONObject selection = modelSelection == null ? null : modelSelection.optJSONObject("next");
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
            if (selection != null) Json.put(state, "selection", selection);
            storage.put(key(scope, device, session), state);
        }
        JSONObject result = Json.of("online", true, "known", known, "running", running, "messages", messages);
        if (selection != null) Json.put(result, "selection", selection);
        return result;
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
            } else if (type.equals("turn/end")) {
                JSONObject reason = data.optJSONObject("reason");
                if (reason != null && ("failed".equals(reason.optString("kind")) || "error".equals(reason.optString("kind")))) {
                    role = "status"; text = "本轮执行出错，请在电脑查看详情。";
                }
            }
            if (!text.isEmpty()) {
                String id = String.valueOf(event.opt("seq") != null ? event.opt("seq") : record.opt("seq") != null ? record.opt("seq") : i);
                result.put(Json.of("id", id, "role", role, "text", text));
            }
        }
        return result;
    }
    static JSONArray visibleMessages(JSONArray messages) {
        JSONArray result = new JSONArray();
        if (messages == null) return result;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject item = messages.optJSONObject(i);
            if (item == null) continue;
            if ("status".equals(item.optString("role")) && item.optString("text").startsWith("正在使用工具：")) continue;
            result.put(item);
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
            boolean internal = type.equals("reasoning") || type.equals("thinking") || type.equals("tool-call")
                    || type.equals("tool-result") || type.equals("tool_call") || type.equals("tool_result");
            String text = type.equals("text") ? block.optString("text") : (!assistant && !internal ? "[" + type + "]" : "");
            if (!text.isEmpty()) { if (out.length() > 0) out.append('\n'); out.append(text); }
        }
        return out.toString();
    }
}
