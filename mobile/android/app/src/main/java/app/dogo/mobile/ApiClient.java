package app.dogo.mobile;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/** One serialized HTTP client: refresh tokens rotate, so refresh/replay must be ordered. */
final class ApiClient {
    interface SessionStore {
        JSONObject session();
        void saveSession(JSONObject session) throws Exception;
    }
    static final class ApiException extends IOException {
        final int status;
        final String code;
        ApiException(int status, String code) {
            super("HTTP " + status + " · " + code);
            this.status = status;
            this.code = code;
        }
    }
    private final SessionStore store;
    private final boolean allowHttp;

    ApiClient(SessionStore store, boolean allowHttp) {
        this.store = store;
        this.allowHttp = allowHttp;
    }

    static String normalizeServer(String value, boolean allowHttp) {
        try {
            URI uri = new URI(value.trim());
            String scheme = uri.getScheme();
            if (!("https".equalsIgnoreCase(scheme)
                    || (allowHttp && "http".equalsIgnoreCase(scheme)))
                    || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getQuery() != null || uri.getFragment() != null
                    || !(uri.getPath().isEmpty() || "/".equals(uri.getPath()))
                    || uri.getPort() > 65535 || uri.getPort() == 0) {
                throw new IllegalArgumentException();
            }
            int port = uri.getPort();
            if (("https".equalsIgnoreCase(scheme) && port == 443)
                    || ("http".equalsIgnoreCase(scheme) && port == 80)) port = -1;
            return new URI(scheme.toLowerCase(java.util.Locale.ROOT), null,
                    uri.getHost().toLowerCase(java.util.Locale.ROOT), port, null, null, null).toString();
        } catch (Exception e) {
            throw new IllegalArgumentException(allowHttp
                    ? "请输入服务器根地址，如 https://dogo.example.com（开发版也支持 HTTP）"
                    : "请输入 HTTPS 服务器根地址，如 https://dogo.example.com");
        }
    }

    synchronized JSONObject login(String server, String username, String password,
                                  String deviceId, String deviceName) throws Exception {
        String origin = normalizeServer(server, allowHttp);
        JSONObject tokens = exchange(origin, "POST", "/api/auth/login", null,
                Json.of("username", username.trim(), "password", password,
                        "device_id", deviceId, "device_name", deviceName.trim(), "device_kind", "mobile"));
        JSONObject session = Json.of("server", origin, "username", username.trim(),
                "device_id", deviceId, "access_token", tokens.getString("access_token"),
                "refresh_token", tokens.getString("refresh_token"));
        store.saveSession(session);
        return session;
    }

    synchronized JSONObject request(String method, String path, JSONObject body) throws Exception {
        JSONObject session = store.session();
        if (session == null) throw new ApiException(401, "login_required");
        String origin = normalizeServer(session.getString("server"), allowHttp);
        try {
            return exchange(origin, method, path, session.getString("access_token"), body);
        } catch (ApiException error) {
            if (error.status != 401) throw error;
        }
        JSONObject tokens;
        try {
            tokens = exchange(origin, "POST", "/api/auth/refresh", null,
                    Json.of("refresh_token", session.getString("refresh_token")));
        } catch (ApiException error) {
            if (error.status == 401) store.saveSession(null);
            throw error;
        }
        Json.put(session, "access_token", tokens.getString("access_token"));
        Json.put(session, "refresh_token", tokens.getString("refresh_token"));
        store.saveSession(session); // Persist rotation before replaying the identical request.
        try {
            return exchange(origin, method, path, session.getString("access_token"), body);
        } catch (ApiException error) {
            if (error.status == 401) store.saveSession(null);
            throw error;
        }
    }

    synchronized void logout() throws Exception {
        request("POST", "/api/auth/logout", null);
        store.saveSession(null);
    }

    static String encode(String value) {
        try { return URLEncoder.encode(value, StandardCharsets.UTF_8.name()); }
        catch (java.io.UnsupportedEncodingException impossible) { throw new AssertionError(impossible); }
    }

    private JSONObject exchange(String origin, String method, String path, String token,
                                JSONObject body) throws Exception {
        if (!path.startsWith("/api/") || path.contains("#")) throw new IllegalArgumentException("无效接口");
        HttpURLConnection connection = (HttpURLConnection) new URI(origin + path).toURL().openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(20000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new ApiException(status, "redirect_refused");
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = read(stream);
            JSONObject result;
            try { result = text.trim().startsWith("[") ? Json.of("items", new org.json.JSONArray(text))
                    : (text.isEmpty() ? new JSONObject() : new JSONObject(text)); }
            catch (Exception e) {
                if (status >= 400) throw new ApiException(status, "server_error");
                throw new IOException("服务器响应不是有效 JSON");
            }
            if (status >= 400) {
                JSONObject error = result.optJSONObject("error");
                throw new ApiException(status, error == null ? "invalid_request" : error.optString("code", "server_error"));
            }
            return result;
        } finally { connection.disconnect(); }
    }

    private static String read(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int size;
            while ((size = input.read(buffer)) != -1) {
                if (out.size() + size > 4 * 1024 * 1024) throw new IOException("服务器响应过大");
                out.write(buffer, 0, size);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
