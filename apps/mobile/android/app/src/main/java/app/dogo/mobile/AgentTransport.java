package app.dogo.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;

/** Dedicated mobile Agent vault. The WebView receives configuration metadata, never saved keys. */
final class AgentTransport {
    private final AtomicFile storage;
    private final Map<String, HttpsURLConnection> active = new ConcurrentHashMap<>();
    private final Set<String> cancelled = ConcurrentHashMap.newKeySet();
    private static final String ALIAS = "dogo.agent.v1";
    private long generation = 0;
    private boolean foreground = true;
    AgentTransport(Context context) { storage = new AtomicFile(new File(context.getFilesDir(), "agent.enc")); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private synchronized JSONObject load() throws Exception {
        try {
            byte[] bytes = storage.readFully();
            if (bytes.length < 29 || bytes.length > 262144) throw new IOException("Agent 配置损坏，原文件已保留");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 0, 12));
            return new JSONObject(new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
        } catch (FileNotFoundException absent) {
            if (storage.getBaseFile().exists()) throw absent;
            return new JSONObject().put("endpoint", "").put("model", "").put("apiKey", "").put("mcp", new JSONArray()).put("skills", new JSONArray());
        }
    }
    static String endpoint(String value) throws Exception {
        URL url = new URL(value);
        if (!"https".equals(url.getProtocol()) || url.getHost().isEmpty() || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null)
            throw new IOException("只支持不含账号、查询参数的 HTTPS 地址");
        return url.toString().replaceAll("/+$", "");
    }
    private static String secret(JSONObject next, JSONObject previous, String addressKey) throws Exception {
        String key = next.optString("apiKey", "");
        if (key.length() > 4096 || key.contains("\n") || key.contains("\r")) throw new IOException("密钥格式无效");
        if (!key.isEmpty() || next.optBoolean("clearKey")) return key;
        return next.getString(addressKey).equals(previous.optString(addressKey)) ? previous.optString("apiKey", "") : "";
    }
    static JSONObject validate(JSONObject input, JSONObject previous) throws Exception {
        if (input.toString().length() > 128000) throw new IOException("Agent 配置过大");
        String base = input.optString("endpoint", "").trim();
        if (!base.isEmpty()) base = endpoint(base);
        String model = input.optString("model", "").trim();
        if (model.length() > 200 || model.contains("\n")) throw new IOException("模型名称无效");
        JSONObject result = new JSONObject().put("endpoint", base).put("model", model);
        JSONObject normalized = new JSONObject(input.toString()).put("endpoint", base);
        result.put("apiKey", secret(normalized, previous, "endpoint"));
        JSONArray mcp = input.optJSONArray("mcp"), servers = new JSONArray();
        if (mcp == null || mcp.length() > 6) throw new IOException("最多配置 6 个 MCP 服务");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < mcp.length(); i++) {
            JSONObject server = mcp.getJSONObject(i), old = new JSONObject();
            String id = server.getString("id"), name = server.optString("name", "MCP");
            if (!id.matches("[a-zA-Z0-9_-]{1,60}") || !ids.add(id) || name.length() > 100) throw new IOException("MCP 标识无效或重复");
            JSONArray oldServers = previous.optJSONArray("mcp");
            if (oldServers != null) for (int j = 0; j < oldServers.length(); j++) if (id.equals(oldServers.getJSONObject(j).optString("id"))) old = oldServers.getJSONObject(j);
            JSONObject item = new JSONObject(server.toString()).put("url", endpoint(server.getString("url")));
            servers.put(new JSONObject().put("id", id).put("name", name).put("url", item.getString("url"))
                .put("enabled", server.optBoolean("enabled", false)).put("apiKey", secret(item, old, "url")));
        }
        JSONArray skills = input.optJSONArray("skills"), safeSkills = new JSONArray();
        if (skills == null || skills.length() > 12 || skills.toString().length() > 48000) throw new IOException("Skill 超过数量或文本上限");
        for (int i = 0; i < skills.length(); i++) {
            JSONObject skill = skills.getJSONObject(i);
            if (skill.optString("name").length() > 100 || skill.optString("text").length() > 16000) throw new IOException("Skill 文本过长");
            safeSkills.put(new JSONObject().put("name", skill.optString("name")).put("text", skill.optString("text")).put("enabled", skill.optBoolean("enabled")));
        }
        return result.put("mcp", servers).put("skills", safeSkills).put("memoryMaintenance", input.optBoolean("memoryMaintenance", false));
    }
    synchronized JSONObject status() throws Exception {
        JSONObject result = new JSONObject(load().toString());
        result.put("hasKey", !result.optString("apiKey").isEmpty()); result.remove("apiKey");
        JSONArray servers = result.getJSONArray("mcp");
        for (int i = 0; i < servers.length(); i++) { JSONObject server = servers.getJSONObject(i); server.put("hasKey", !server.optString("apiKey").isEmpty()); server.remove("apiKey"); }
        return result;
    }
    synchronized JSONObject configure(JSONObject input) throws Exception {
        JSONObject next = validate(input, load()); generation++; cancelAll();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        FileOutputStream stream = null;
        try {
            stream = storage.startWrite(); stream.write(cipher.getIV()); stream.write(cipher.doFinal(next.toString().getBytes(StandardCharsets.UTF_8)));
            stream.getFD().sync(); storage.finishWrite(stream);
        } catch (Exception e) { if (stream != null) storage.failWrite(stream); throw e; }
        return status();
    }
    synchronized void cancel(String id) {
        if (cancelled.size() > 256) cancelled.clear(); cancelled.add(id);
        HttpsURLConnection connection = active.get(id); if (connection != null) connection.disconnect();
    }
    synchronized void cancelAll() { for (String id : active.keySet()) cancel(id); }
    synchronized void foreground(boolean value) { foreground = value; if (!value) { generation++; cancelAll(); } }
    JSONObject request(JSONObject input) throws Exception {
        String id = input.getString("id"), target = input.getString("target"), method = input.optString("method", "POST");
        if (!id.matches("[a-zA-Z0-9-]{1,80}")) throw new IOException("请求标识无效");
        JSONObject config, server = null; long revision;
        synchronized (this) { if (!foreground) throw new IOException("手机 Agent 仅在前台执行"); config = load(); revision = generation; }
        String address, apiKey;
        if ("model".equals(target)) {
            if (config.optString("endpoint").isEmpty() || config.optString("model").isEmpty()) throw new IOException("请先配置手机模型");
            address = config.getString("endpoint") + "/chat/completions"; apiKey = config.optString("apiKey");
            if (!"POST".equals(method)) throw new IOException("模型只允许 Chat Completions 请求");
        } else {
            JSONArray servers = config.getJSONArray("mcp");
            for (int i = 0; i < servers.length(); i++) if (target.equals(servers.getJSONObject(i).getString("id"))) server = servers.getJSONObject(i);
            if (server == null || !server.optBoolean("enabled")) throw new IOException("MCP 服务未启用");
            address = server.getString("url"); apiKey = server.optString("apiKey");
            // The mobile client is foreground/request-response, not a background SSE subscriber.
            if ("GET".equals(method)) return new JSONObject().put("status", 405).put("body", "").put("headers", new JSONObject());
            if (!"POST".equals(method) && !"DELETE".equals(method)) throw new IOException("MCP 方法不支持");
        }
        if (!address.equals(input.getString("url"))) throw new IOException("请求目标与用户配置不一致");
        String body = input.optString("body", "");
        if (body.getBytes(StandardCharsets.UTF_8).length > 1048576) throw new IOException("请求超过 1 MiB");
        if ("model".equals(target)) {
            JSONObject parsed = new JSONObject(body);
            if (!config.getString("model").equals(parsed.optString("model")) || parsed.optBoolean("stream")) throw new IOException("模型配置不匹配");
        }
        HttpsURLConnection connection = (HttpsURLConnection) new URL(address).openConnection();
        synchronized (this) {
            if (revision != generation || !foreground) throw new IOException("配置或前台状态已变化，请重新发送");
            if (cancelled.remove(id)) throw new IOException("请求已取消");
            if (active.size() >= 4 || active.containsKey(id)) throw new IOException("请求过于频繁");
            active.put(id, connection);
        }
        try {
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(120000); connection.setRequestMethod(method);
            connection.setRequestProperty("Content-Type", "application/json"); connection.setRequestProperty("Accept", "model".equals(target) ? "application/json" : "application/json, text/event-stream");
            if (!apiKey.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + apiKey);
            JSONObject headers = input.optJSONObject("headers");
            if (headers != null && !"model".equals(target)) for (String name : Arrays.asList("mcp-session-id", "mcp-protocol-version")) {
                String value = headers.optString(name, "");
                if (value.length() > 1024 || value.contains("\r") || value.contains("\n")) throw new IOException("MCP 头无效");
                if (!value.isEmpty()) connection.setRequestProperty(name, value);
            }
            if (!body.isEmpty()) { connection.setDoOutput(true); try (OutputStream out = connection.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); } }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IOException("拒绝跳转：请填写最终 HTTPS 地址");
            JSONObject safeHeaders = new JSONObject();
            for (String name : Arrays.asList("content-type", "mcp-session-id", "mcp-protocol-version")) { String value = connection.getHeaderField(name); if (value != null) safeHeaders.put(name, value); }
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String response = "";
            if (stream != null) try (InputStream in = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int read;
                while ((read = in.read(buffer)) >= 0) {
                    if (Thread.currentThread().isInterrupted() || cancelled.contains(id)) throw new IOException("请求已取消");
                    if (out.size() + read > 2097152) throw new IOException("响应超过 2 MiB，未自动截断");
                    out.write(buffer, 0, read);
                    // A finite MCP POST response may keep its SSE socket alive after the matching response.
                    if (safeHeaders.optString("content-type").contains("text/event-stream") && rpcComplete(out.toString("UTF-8"), body)) break;
                }
                response = out.toString("UTF-8");
            }
            if (!apiKey.isEmpty()) response = response.replace(apiKey, "[redacted]");
            return new JSONObject().put("status", status).put("body", response).put("headers", safeHeaders);
        } finally { active.remove(id); synchronized (this) { cancelled.remove(id); } connection.disconnect(); }
    }
    static boolean rpcComplete(String data, String request) {
        try {
            Object id = new JSONObject(request).opt("id"); if (id == null) return false;
            String normalized = data.replace("\r\n", "\n");
            int end = normalized.lastIndexOf("\n\n"); if (end < 0) return false;
            for (String event : normalized.substring(0, end).split("\n\n")) {
                StringBuilder json = new StringBuilder();
                for (String line : event.split("\n")) if (line.startsWith("data:")) json.append(line.substring(5).trim());
                if (json.length() == 0) continue;
                JSONObject result = new JSONObject(json.toString());
                if (id.equals(result.opt("id")) && (result.has("result") || result.has("error"))) return true;
            }
        } catch (Exception ignored) { }
        return false;
    }
}
