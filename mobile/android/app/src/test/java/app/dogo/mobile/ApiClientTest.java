package app.dogo.mobile;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.Assert.*;

public class ApiClientTest {
    TestHttpServer server;
    String origin;
    MemoryStore store;
    ApiClient api;
    static class MemoryStore implements ApiClient.SessionStore {
        JSONObject value;
        public synchronized JSONObject session() { return value == null ? null : Json.copy(value); }
        public synchronized void saveSession(JSONObject value) { this.value = value == null ? null : Json.copy(value); }
    }
    @Before public void setup() throws Exception {
        server = new TestHttpServer();
        origin = server.origin();
        store = new MemoryStore();
        store.saveSession(Json.of("server", origin, "username", "test", "device_id", "phone", "access_token", "expired", "refresh_token", "refresh-old"));
        api = new ApiClient(store, true);
    }
    @After public void teardown() throws Exception { server.close(); }
    static void respond(TestHttpServer.Exchange exchange, int code, String text) throws IOException { exchange.respond(code, text); }
    @Test public void loginRegistersMobileAndStoresNoPassword() throws Exception {
        server.createContext("/api/auth/login", exchange -> {
            JSONObject body = Json.object(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("mobile", body.optString("device_kind"));
            assertEquals("device-1", body.optString("device_id"));
            respond(exchange, 200, "{\"access_token\":\"new\",\"refresh_token\":\"refresh-new\"}");
        });
        api.login(origin + "/", " test ", "test-password-only", "device-1", "phone");
        assertEquals(origin, store.session().optString("server"));
        assertFalse(store.session().toString().contains("password"));
    }
    @Test public void concurrentRequestsRotateOnceAndPersistBeforeReplay() throws Exception {
        AtomicInteger refreshes = new AtomicInteger();
        AtomicInteger writes = new AtomicInteger();
        JSONObject payload = Json.of("request_id", "same-id", "content", "hello");
        server.createContext("/api/auth/refresh", exchange -> {
            refreshes.incrementAndGet();
            respond(exchange, 200, "{\"access_token\":\"fresh\",\"refresh_token\":\"rotated\"}");
        });
        server.createContext("/api/memos", exchange -> {
            assertEquals(payload.toString(), new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            if ("Bearer expired".equals(exchange.getRequestHeaders().getFirst("Authorization"))) {
                respond(exchange, 401, "{\"error\":{\"code\":\"expired\"}}"); return;
            }
            assertEquals("rotated", store.session().optString("refresh_token"));
            writes.incrementAndGet();
            respond(exchange, 200, "{\"id\":\"memo-1\"}");
        });
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<JSONObject> a = executor.submit(() -> api.request("POST", "/api/memos", payload));
            Future<JSONObject> b = executor.submit(() -> api.request("POST", "/api/memos", payload));
            assertEquals("memo-1", a.get(5, TimeUnit.SECONDS).optString("id"));
            assertEquals("memo-1", b.get(5, TimeUnit.SECONDS).optString("id"));
            assertEquals(1, refreshes.get()); assertEquals(2, writes.get());
        } finally { executor.shutdownNow(); }
    }
    @Test public void rejectedRefreshClearsCredentials() throws Exception {
        server.createContext("/api/memos", e -> respond(e, 401, "{}"));
        server.createContext("/api/auth/refresh", e -> respond(e, 401, "{}"));
        assertThrows(ApiClient.ApiException.class, () -> api.request("GET", "/api/memos", null));
        assertNull(store.session());
    }
    @Test public void temporaryRefreshFailureKeepsCredentials() throws Exception {
        server.createContext("/api/memos", e -> respond(e, 401, "{}"));
        server.createContext("/api/auth/refresh", e -> respond(e, 503, "{}"));
        assertThrows(ApiClient.ApiException.class, () -> api.request("GET", "/api/memos", null));
        assertEquals("refresh-old", store.session().optString("refresh_token"));
    }
    @Test public void redirectDoesNotForwardAuthorization() throws Exception {
        AtomicInteger followed = new AtomicInteger();
        server.createContext("/api/memos", e -> {
            e.getResponseHeaders().set("Location", origin + "/leak"); respond(e, 302, "{}");
        });
        server.createContext("/leak", e -> { followed.incrementAndGet(); respond(e, 200, "{}"); });
        ApiClient.ApiException error = assertThrows(ApiClient.ApiException.class, () -> api.request("GET", "/api/memos", null));
        assertEquals("redirect_refused", error.code); assertEquals(0, followed.get());
    }
    @Test public void nativeDeviceArrayIsReadable() throws Exception {
        server.createContext("/api/devices", e -> respond(e, 200, "[{\"id\":\"pc\",\"active\":true}]"));
        assertEquals("pc", api.request("GET", "/api/devices", null).getJSONArray("items").getJSONObject(0).getString("id"));
    }
    @Test public void normalizeOriginAndRejectUnsafeAddresses() {
        assertEquals("https://example.com", ApiClient.normalizeServer(" HTTPS://EXAMPLE.com:443/ ", false));
        for (String bad : new String[]{"http://example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com?token=x", "https://example.com#part", "file:///tmp/x"})
            assertThrows(IllegalArgumentException.class, () -> ApiClient.normalizeServer(bad, false));
    }
}
