package app.dogo.mobile;

import org.json.JSONObject;
import org.junit.Test;
import java.util.UUID;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Run only against scripts/test_server.py, which creates disposable synthetic data. */
public class LiveApiTest {
    @Test public void realServerAuthenticationAndDeviceRevocation() throws Exception {
        String origin = System.getProperty("dogo.apiUrl", "");
        assumeTrue(!origin.isEmpty());
        ApiClientTest.MemoryStore store = new ApiClientTest.MemoryStore();
        ApiClient api = new ApiClient(store, true);
        String device = UUID.randomUUID().toString();
        api.login(origin, "android-test", "android-test-password", device, "联调手机");
        assertEquals("android-test", api.request("GET", "/api/auth/me", null).getString("username"));
        JSONObject tokens = store.session();
        Json.put(tokens, "access_token", "expired-for-test"); store.saveSession(tokens);
        assertEquals("android-test", api.request("GET", "/api/auth/me", null).getString("username"));
        assertTrue(api.request("GET", "/api/devices", null).getJSONArray("items").length() >= 2);
        api.request("DELETE", "/api/devices/" + device, null);
        assertThrows(ApiClient.ApiException.class, () -> api.request("GET", "/api/auth/me", null));
        assertNull(store.session());
        api.login(origin, "android-test", "android-test-password", device, "联调手机");
        api.logout(); assertNull(store.session());
    }
}
