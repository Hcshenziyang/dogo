package app.dogo.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.*;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Credentials and HTTPS remain in native code. Never returns a token to the WebView. */
final class RelayTransport {
    private static final String ALIAS = "dogo.relay.v1";
    private final AtomicFile storage;
    private final android.content.SharedPreferences accountPreferences;
    RelayTransport(Context context) {
        storage = new AtomicFile(new File(context.getFilesDir(), "relay.enc"));
        accountPreferences = context.getSharedPreferences("dogo.account", 0);
    }

    static JSONObject validate(JSONObject input) throws Exception {
        int version = input.getInt("version"); String device = input.getString("device");
        if (!(version == 1 && "phone".equals(device)) && !(version == 2 && "phone".equals(input.optString("platform")) && device.matches("[a-z0-9][a-z0-9_-]{0,63}")))
            throw new IOException("请选择 phone 设备凭据");
        URL url = new URL(input.getString("url"));
        if (!"https".equals(url.getProtocol()) || url.getHost().isEmpty() || url.getUserInfo() != null ||
            url.getQuery() != null || url.getRef() != null || !(url.getPath().isEmpty() || "/".equals(url.getPath())))
            throw new IOException("凭据必须绑定 HTTPS 服务地址");
        String token = input.getString("token");
        if (!token.matches("[A-Za-z0-9_-]{43,128}")) throw new IOException("设备凭据格式不正确");
        JSONObject pair = new JSONObject();
        pair.put("version", version); pair.put("device", device); pair.put("token", token);
        if (version == 2) pair.put("platform", "phone");
        pair.put("url", new URL(url.getProtocol(), url.getHost(), url.getPort(), "").toString());
        return pair;
    }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(ALIAS, null);
    }
    private JSONObject load() throws Exception {
        byte[] bytes = storage.readFully();
        if (bytes.length < 29 || bytes.length > 16384) throw new IOException("设备凭据损坏");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, bytes, 0, 12));
        return validate(new JSONObject(new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8)));
    }
    JSONObject status() throws Exception {
        JSONObject pair;
        try { pair = load(); }
        catch (FileNotFoundException absent) {
            if (storage.getBaseFile().exists()) throw absent;
            return new JSONObject().put("configured", false).put("url", "").put("device", "");
        }
        return new JSONObject().put("configured", true).put("url", pair.getString("url")).put("device", pair.getString("device"));
    }
    JSONObject configure(JSONObject input) throws Exception {
        JSONObject pair = validate(input);
        JSONObject identity = request(pair, "/v1/identity", null);
        if (!pair.getString("device").equals(identity.optString("device")) || !identity.getJSONArray("services").toString().contains("\"tasks\""))
            throw new IOException("服务身份不匹配，未保存凭据");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        FileOutputStream stream = null;
        try {
            stream = storage.startWrite();
            stream.write(cipher.getIV()); stream.write(cipher.doFinal(pair.toString().getBytes(StandardCharsets.UTF_8)));
            stream.getFD().sync(); storage.finishWrite(stream);
        } catch (Exception e) { if (stream != null) storage.failWrite(stream); throw e; }
        return status();
    }
    JSONObject identity() throws Exception { return request(load(), "/v1/identity", null); }
    private static String serviceOrigin(String value) throws Exception {
        URL url = new URL(value);
        if (!"https".equals(url.getProtocol()) || url.getHost().isEmpty() || url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null || !(url.getPath().isEmpty() || "/".equals(url.getPath())))
            throw new IOException("账号服务必须是 HTTPS 根地址");
        return new URL(url.getProtocol(), url.getHost(), url.getPort(), "").toString();
    }
    /** Never returns a session token or persists a password. Serialized by the plugin executor. */
    JSONObject account(String op, String target, JSONObject args) throws Exception {
        if (!java.util.Arrays.asList("status", "login", "setup", "recover", "devices", "device", "revoke", "password", "logout", "disable-legacy").contains(op)) throw new IOException("账号操作无效");
        if (args.toString().length() > 32768) throw new IOException("账号输入过大");
        JSONObject current = null;
        if (storage.getBaseFile().exists()) current = load();
        if ("status".equals(op) && (target == null || target.isEmpty()) && current == null)
            return new JSONObject().put("configured", false).put("authenticated", false).put("canSetup", false).put("url", "");
        String origin = serviceOrigin(target != null && !target.isEmpty() ? target : current == null ? "" : current.getString("url"));
        if (current != null && !current.getString("url").equals(origin)) current = null;
        JSONObject anonymous = new JSONObject().put("url", origin);
        if ("status".equals(op)) {
            JSONObject result = request(anonymous, "/v3/auth/status", null);
            if (current != null) {
                try { result = request(current, "/v3/auth/me", null); }
                catch (ServiceException error) { if (error.status != 401) throw error; }
            }
            return result.put("configured", current != null).put("canSetup", false).put("url", origin);
        }
        if ("setup".equals(op)) throw new IOException("账号请先在已配对电脑上创建");
        if ("login".equals(op)) {
            String installation = accountPreferences.getString("installation", null);
            if (installation == null) {
                installation = java.util.UUID.randomUUID().toString();
                if (!accountPreferences.edit().putString("installation", installation).commit()) throw new IOException("账号设备标识保存失败");
            }
            JSONObject input = new JSONObject(args.toString()).put("platform", "phone").put("installationId", installation);
            JSONObject login = request(current != null && current.getInt("version") == 1 ? current : anonymous, "/v3/auth/login", input);
            configure(new JSONObject().put("version", 2).put("url", origin).put("platform", "phone").put("device", login.getString("device")).put("token", login.getString("token")));
            return safeAccount(login).put("authenticated", true).put("initialized", true).put("configured", true).put("url", origin);
        }
        if ("recover".equals(op)) {
            JSONObject result = request(anonymous, "/v3/auth/recover", args);
            if (current != null) storage.delete();
            return safeAccount(result);
        }
        if (current == null) throw new IOException("账号尚未登录此服务");
        if ("logout".equals(op)) {
            JSONObject result = new JSONObject().put("ok", true);
            try { if (current.getInt("version") == 2) request(current, "/v3/auth/logout", new JSONObject()); }
            catch (Exception error) { result.put("warning", "本机已退出；服务端未确认失效，请从另一台设备撤销本机。"); }
            storage.delete(); return result;
        }
        JSONObject result = request(current, "/v3/auth/" + op, "devices".equals(op) ? null : args);
        if ("password".equals(op) || ("revoke".equals(op) && current.getString("device").equals(args.optString("id")))) storage.delete();
        return safeAccount(result);
    }
    private static JSONObject safeAccount(JSONObject result) throws Exception {
        JSONObject safe = new JSONObject();
        for (String field : new String[]{"initialized", "authenticated", "legacy", "username", "device", "expiresAt", "recoveryCode", "signInRequired", "devices", "revoked", "ok"})
            if (result.has(field)) safe.put(field, result.get(field));
        return safe;
    }
    JSONObject memory(String op, JSONObject args) throws Exception {
        if (!java.util.Arrays.asList("list", "read", "write", "conflicts", "conflict", "resolve", "versions").contains(op)) throw new IOException("服务操作未授权");
        return request(load(), "/v2/memory", new JSONObject().put("op", op).put("args", args));
    }
    JSONObject hub(String origin, String op, JSONObject args) throws Exception {
        if (op == null || !java.util.Arrays.asList("snapshot", "get", "history", "details", "create", "send", "note", "stop", "answer", "noteState", "artifactBegin", "artifactChunk", "artifactSeal", "artifactRead").contains(op))
            throw new IOException("任务操作未授权");
        JSONObject pair = load();
        if (!pair.getString("url").equals(origin)) throw new IOException("设备服务已改变，请恢复原服务后重试");
        JSONObject body = new JSONObject().put("op", op).put("args", args);
        if (body.toString().getBytes(StandardCharsets.UTF_8).length > 1024 * 1024) throw new IOException("任务内容过大");
        return request(pair, "/v2/hub", body);
    }
    byte[] artifact(String origin, String id) throws Exception {
        JSONObject meta = hub(origin, "artifactRead", new JSONObject().put("id", id));
        int size = meta.getInt("size");
        if (size < 0 || size > 8 * 1024 * 1024) throw new IOException("文件大小超过限制");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int offset = 0, index = 0; offset < size; offset += 192 * 1024, index++) {
            JSONObject chunk = hub(origin, "artifactRead", new JSONObject().put("id", id).put("index", index));
            byte[] bytes = android.util.Base64.decode(chunk.getString("data"), android.util.Base64.DEFAULT);
            if (bytes.length != Math.min(192 * 1024, size - offset)) throw new IOException("文件分块损坏");
            out.write(bytes);
        }
        byte[] bytes = out.toByteArray();
        StringBuilder actual = new StringBuilder();
        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) actual.append(String.format("%02x", b & 255));
        if (!actual.toString().equals(meta.getString("sha256"))) throw new IOException("文件校验失败，未保存不完整内容");
        return bytes;
    }
    HttpsURLConnection events(long after) throws Exception {
        JSONObject pair = load();
        HttpsURLConnection connection = (HttpsURLConnection) new URL(pair.getString("url") + "/v1/events/stream?after=" + Math.max(0, after)).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(45000);
        connection.setRequestProperty("Authorization", "Bearer " + pair.getString("token"));
        connection.setRequestProperty("Accept", "text/event-stream");
        return connection;
    }
    JSONObject publish(JSONObject body, String origin) throws Exception {
        JSONObject pair = load();
        if (!pair.getString("url").equals(origin)) throw new IOException("设备服务已改变，请恢复原服务后重试");
        String requestId = body.getString("requestId");
        String mailbox = body.getString("mailbox");
        if (!requestId.matches("[A-Za-z0-9_-]{1,100}") || !mailbox.matches("/tasks/[a-z0-9][a-z0-9_-]{0,63}"))
            throw new IOException("任务标识无效");
        if (body.getString("title").isEmpty() || body.getString("title").length() > 300 ||
            body.getString("instructions").isEmpty() || body.getString("instructions").length() > 64000)
            throw new IOException("任务内容长度无效");
        JSONObject clean = new JSONObject();
        for (String name : new String[]{"requestId", "mailbox", "title", "instructions"}) clean.put(name, body.getString(name));
        return request(pair, "/v1/tasks", clean);
    }
    JSONObject read(String id, String origin) throws Exception {
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,100}")) throw new IOException("任务标识无效");
        JSONObject pair = load();
        if (!pair.getString("url").equals(origin)) throw new IOException("任务属于其他服务，未读取或传送");
        return request(pair, "/v1/tasks/" + id, null);
    }
    private JSONObject request(JSONObject pair, String path, JSONObject body) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(pair.getString("url") + path).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
        if (pair.has("token")) connection.setRequestProperty("Authorization", "Bearer " + pair.getString("token"));
        connection.setRequestProperty("Accept", "application/json");
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status != 200) throw new ServiceException(status, path.startsWith("/v3/auth/") ? "账号" : "任务");
            try (InputStream in = connection.getInputStream()) {
                return new JSONObject(new String(readLimited(in, 24 * 1024 * 1024), StandardCharsets.UTF_8));
            }
        } finally { connection.disconnect(); }
    }
    private static class ServiceException extends IOException {
        final int status;
        ServiceException(int status, String kind) {
            super(kind + "服务 HTTP " + status + (status == 401 ? "：登录已失效或账号、密码、恢复码错误" : status == 429 ? "：尝试过于频繁，请稍后再试" : status == 400 ? "：检查输入，新密码至少 15 个字符" : "：请检查连接或权限"));
            this.status = status;
        }
    }
    static byte[] readLimited(InputStream input, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int length;
        while ((length = input.read(buffer)) != -1) {
            if (out.size() + length > max) throw new IOException("内容过大");
            out.write(buffer, 0, length);
        }
        return out.toByteArray();
    }
}
