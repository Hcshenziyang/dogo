package app.dogo.mobile;

import static org.junit.Assert.*;
import static org.junit.Assume.*;
import android.content.Context;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class RelayTransportTest {
    @Test public void rejectsUnsafeCredentialOriginsAndWrongDevice() throws Exception {
        for (String origin : new String[]{"http://relay.example", "https://u:p@relay.example", "https://relay.example/path", "https://relay.example/?secret=x"}) {
            JSONObject pair = new JSONObject().put("version", 1).put("device", "phone").put("url", origin).put("token", "p".repeat(43));
            try { RelayTransport.validate(pair); fail("Unsafe origin accepted"); } catch (IOException expected) { }
        }
        try { RelayTransport.validate(new JSONObject().put("version", 1).put("device", "mac").put("url", "https://relay.example").put("token", "p".repeat(43))); fail("Wrong device accepted"); }
        catch (IOException expected) { }
    }
    /** Opt-in network test. Pairing input is copied into the private debug sandbox, never packaged in an APK. */
    @Test public void liveNativeHttpsRoundtripAndEncryptedStorage() throws Exception {
        assumeTrue("yes".equals(InstrumentationRegistry.getArguments().getString("dogoLive")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().endsWith(".devtest"));
        File input = new File(context.getFilesDir(), "relay-test-pair.json");
        JSONObject pair;
        try (InputStream stream = new FileInputStream(input)) {
            pair = new JSONObject(new String(RelayTransport.readLimited(stream, 8192), StandardCharsets.UTF_8));
        }
        RelayTransport relay = new RelayTransport(context);
        JSONObject configured = relay.configure(pair);
        assertTrue(configured.getBoolean("configured")); assertFalse(configured.has("token"));
        byte[] encrypted;
        try (InputStream stream = new FileInputStream(new File(context.getFilesDir(), "relay.enc"))) { encrypted = RelayTransport.readLimited(stream, 16384); }
        assertFalse(new String(encrypted, StandardCharsets.UTF_8).contains(pair.getString("token")));
        assertEquals("phone", new RelayTransport(context).identity().getString("device"));
        String origin = configured.getString("url");
        JSONObject task = relay.publish(new JSONObject().put("requestId", "android_" + UUID.randomUUID()).put("mailbox", "/tasks/mac")
            .put("title", "Android 原生链路验收")
            .put("instructions", "只检查 DogO 联调测试目录，列出测试文件。不读取个人文件，不调用模型。"), origin);
        String id = task.getString("id");
        Log.i("DogORelayTest", "TASK_ID=" + id);
        long deadline = System.currentTimeMillis() + 240000;
        while (System.currentTimeMillis() < deadline) {
            JSONObject result = relay.read(id, origin);
            if ("succeeded".equals(result.getString("status"))) {
                assertTrue(result.getString("result").contains("hello.ts"));
                Log.i("DogORelayTest", "ROUNDTRIP_OK=" + id);
                return;
            }
            if ("failed".equals(result.getString("status"))) fail("Remote execution failed");
            Thread.sleep(1500);
        }
        fail("Timed out waiting for the explicitly approved desktop test task");
    }
}
