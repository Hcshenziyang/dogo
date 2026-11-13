package app.dogo.mobile;

import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class LegacyMemoCleanupTest {
    @Test public void removesOnlyMemoDraftsPreservingOtherData() {
        JSONObject before = Json.of("draft:first", Json.of("content", "synthetic"),
                "draft:second", Json.of("content", "synthetic"),
                "session", Json.of("username", "synthetic"),
                "preferences", Json.of("server", "https://example.test"),
                "device:abc", Json.of("id", "device"));
        JSONObject after = LegacyMemoCleanup.withoutDrafts(before);
        assertEquals(3, after.length());
        assertFalse(after.has("draft:first"));
        assertFalse(after.has("draft:second"));
        assertEquals("synthetic", after.optJSONObject("session").optString("username"));
        assertEquals("device", after.optJSONObject("device:abc").optString("id"));
        assertTrue(before.has("draft:first"));
    }
}
