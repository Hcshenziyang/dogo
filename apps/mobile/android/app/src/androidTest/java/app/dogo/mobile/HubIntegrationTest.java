package app.dogo.mobile;

import static org.junit.Assert.*;
import static org.junit.Assume.*;
import android.app.*;
import android.content.*;
import android.util.Log;
import androidx.core.content.ContextCompat;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Opt-in test with synthetic content only. Credentials stay in the private debug sandbox. */
@RunWith(AndroidJUnit4.class)
public class HubIntegrationTest {
    private RelayTransport paired() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().endsWith(".devtest"));
        try (InputStream in = new FileInputStream(new File(context.getFilesDir(), "relay-test-pair.json"))) {
            RelayTransport relay = new RelayTransport(context);
            relay.configure(new JSONObject(new String(RelayTransport.readLimited(in, 8192), StandardCharsets.UTF_8)));
            return relay;
        }
    }
    private JSONObject waitDone(RelayTransport relay, String origin, String id) throws Exception {
        long deadline = System.currentTimeMillis() + 240000;
        while (System.currentTimeMillis() < deadline) {
            JSONObject row = relay.hub(origin, "get", new JSONObject().put("id", id).put("type", "command"));
            String state = row.getString("status");
            if (state.equals("succeeded")) return row;
            if (state.equals("failed") || state.equals("interrupted")) fail("Synthetic command did not succeed: " + row.optString("result"));
            Thread.sleep(2000);
        }
        throw new AssertionError("Timed out waiting for paired Mac");
    }
    @Test public void liveV2TasksHistoryNotesMemoryAndBackgroundNotification() throws Exception {
        assumeTrue("yes".equals(InstrumentationRegistry.getArguments().getString("dogoLiveV2")));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        assertTrue(context.getPackageName().endsWith(".devtest"));
        JSONObject pair;
        try (InputStream in = new FileInputStream(new File(context.getFilesDir(), "relay-test-pair.json"))) {
            pair = new JSONObject(new String(RelayTransport.readLimited(in, 8192), StandardCharsets.UTF_8));
        }
        RelayTransport relay = new RelayTransport(context); relay.configure(pair);
        String origin = pair.getString("url"); assertEquals(2, relay.identity().getInt("protocol"));
        Activity activity = instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        context.getSharedPreferences(RelayNotifyService.PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", true).commit();
        instrumentation.runOnMainSync(() -> ContextCompat.startForegroundService(context, new Intent(context, RelayNotifyService.class)));
        Thread.sleep(1500);
        instrumentation.runOnMainSync(() -> activity.moveTaskToBack(true));
        JSONObject note = relay.hub(origin, "note", new JSONObject().put("requestId", UUID.randomUUID()).put("target", "mac")
            .put("title", "v0.1.0 合成资料验收").put("text", "这是一条验收记录，不执行、不写入项目或记忆。")
            .put("attachments", new JSONArray().put(new JSONObject().put("name", "fixture.txt").put("mime", "text/plain").put("data", "Zml4dHVyZQ=="))));
        JSONObject first = relay.hub(origin, "create", new JSONObject().put("requestId", UUID.randomUUID()).put("target", "mac")
            .put("title", "Android v0.1.0 真实链路验收").put("prompt", "这是合成链路验收。不使用工具，不读取文件，不写记忆。请记住本会话的验收代号 DOGO_731，只回答：DOGO_731 已收到。"));
        Log.i("DogOHubTest", "COMMAND=" + first.getString("id"));
        String sessionId = first.getString("sessionId");
        assertTrue(waitDone(relay, origin, first.getString("id")).getString("result").contains("DOGO_731"));
        JSONObject before = relay.hub(origin, "get", new JSONObject().put("id", sessionId).put("type", "session"));
        JSONObject next = relay.hub(origin, "send", new JSONObject().put("requestId", UUID.randomUUID()).put("sessionId", sessionId)
            .put("prompt", "继续合成验收：上轮的验收代号是什么？只回答代号，不调用工具。"));
        assertTrue(waitDone(relay, origin, next.getString("id")).getString("result").contains("DOGO_731"));
        JSONObject after = relay.hub(origin, "get", new JSONObject().put("id", sessionId).put("type", "session"));
        assertEquals(before.getString("nativeId"), after.getString("nativeId"));
        Thread.sleep(6500);
        assertTrue(relay.hub(origin, "history", new JSONObject().put("sessionId", sessionId)).getJSONArray("messages").length() >= 4);
        assertEquals("received", relay.hub(origin, "get", new JSONObject().put("id", note.getString("id")).put("type", "note")).getString("state"));
        assertTrue(RelayNotifyService.active);
        assertTrue(context.getSystemService(NotificationManager.class).getActiveNotifications().length >= 2);
        PersonalMemory memory = new PersonalMemory(context, relay);
        memory.local("configure", new JSONObject().put("enabled", true));
        String memoryPath = "acceptance-" + UUID.randomUUID() + ".md";
        memory.local("write", new JSONObject().put("path", memoryPath).put("content", "Synthetic memory sync fixture; not a real personal preference."));
        memory.sync();
        assertTrue(relay.memory("read", new JSONObject().put("path", memoryPath)).getJSONObject("file").getString("content").contains("Synthetic"));
        memory.local("write", new JSONObject().put("path", memoryPath).put("content", JSONObject.NULL)); memory.sync();
        Log.i("DogOHubTest", "V2_ROUNDTRIP_OK=" + sessionId);
    }
    @Test public void liveContinueNativeUiSession() throws Exception {
        String sessionId = InstrumentationRegistry.getArguments().getString("dogoNativeSession");
        assumeTrue(sessionId != null);
        RelayTransport relay = paired(); String origin = relay.status().getString("url");
        JSONObject before = relay.hub(origin, "get", new JSONObject().put("type", "session").put("id", sessionId));
        assertTrue(before.getString("nativeId").startsWith("session-"));
        JSONObject command = relay.hub(origin, "send", new JSONObject().put("requestId", UUID.randomUUID()).put("sessionId", sessionId)
            .put("prompt", "手机续聊合成验收：上轮在 DSH 界面给出的代号是什么？只回答代号，不使用工具，不读取文件，不写记忆。"));
        assertTrue(waitDone(relay, origin, command.getString("id")).getString("result").contains("NATIVE_827"));
        JSONObject after = relay.hub(origin, "get", new JSONObject().put("type", "session").put("id", sessionId));
        assertEquals(before.getString("nativeId"), after.getString("nativeId"));
        assertEquals(before.getString("instance"), after.getString("instance"));
        assertEquals(before.getString("owner"), after.getString("owner"));
        Log.i("DogOHubTest", "NATIVE_CONTINUATION_OK=" + sessionId);
    }
    @Test public void liveChunkedAttachmentAndReceipt() throws Exception {
        assumeTrue("yes".equals(InstrumentationRegistry.getArguments().getString("dogoLiveV2")));
        RelayTransport relay = paired(); String origin = relay.status().getString("url");
        byte[] bytes = new byte[192 * 1024 + 37]; java.util.Arrays.fill(bytes, (byte) 'x');
        String id = UUID.randomUUID().toString();
        StringBuilder digest = new StringBuilder();
        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(bytes)) digest.append(String.format("%02x", b & 255));
        relay.hub(origin, "artifactBegin", new JSONObject().put("id", id).put("target", "mac")
            .put("name", "synthetic-chunk-fixture.txt").put("mime", "text/plain").put("size", bytes.length).put("sha256", digest));
        for (int offset = 0, index = 0; offset < bytes.length; offset += 192 * 1024, index++) {
            byte[] chunk = java.util.Arrays.copyOfRange(bytes, offset, Math.min(offset + 192 * 1024, bytes.length));
            JSONObject args = new JSONObject().put("id", id).put("index", index).put("data", android.util.Base64.encodeToString(chunk, android.util.Base64.NO_WRAP));
            relay.hub(origin, "artifactChunk", args); relay.hub(origin, "artifactChunk", args); // Retry must be idempotent.
        }
        assertEquals("ready", relay.hub(origin, "artifactSeal", new JSONObject().put("id", id)).getString("state"));
        assertArrayEquals(bytes, relay.artifact(origin, id));
        JSONObject note = relay.hub(origin, "note", new JSONObject().put("requestId", UUID.randomUUID()).put("target", "mac")
            .put("title", "0.4.0 分块附件合成验收").put("text", "仅验证附件与资料回执，不执行任务。")
            .put("artifactIds", new JSONArray().put(id)));
        long deadline = System.currentTimeMillis() + 30000;
        JSONObject received;
        do {
            received = relay.hub(origin, "get", new JSONObject().put("type", "note").put("id", note.getString("id")));
            if ("received".equals(received.getString("state"))) break;
            Thread.sleep(1000);
        } while (System.currentTimeMillis() < deadline);
        assertEquals("received", received.getString("state"));
        assertEquals(id, received.getJSONArray("artifactIds").getString(0));
        for (String state : new String[]{"read", "processed", "archived"})
            assertEquals(state, relay.hub(origin, "noteState", new JSONObject().put("id", note.getString("id")).put("state", state)).getString("state"));
        Log.i("DogOHubTest", "CHUNKED_ARTIFACT_RECEIPT_OK=" + id);
    }
    @Test public void liveMemoryMacToAndroidAndBack() throws Exception {
        String path = InstrumentationRegistry.getArguments().getString("dogoMemoryFixture");
        assumeTrue(path != null);
        assertTrue(path.startsWith("acceptance-") && path.endsWith(".md"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        RelayTransport relay = paired(); PersonalMemory memory = new PersonalMemory(context, relay);
        memory.local("configure", new JSONObject().put("enabled", true)); memory.sync();
        assertEquals("Synthetic Mac memory fixture; not a personal preference.\n", memory.local("read", new JSONObject().put("path", path)).getString("content"));
        memory.local("write", new JSONObject().put("path", path).put("content", "Synthetic Android roundtrip fixture; not a personal preference.\n"));
        memory.sync();
        assertTrue(relay.memory("read", new JSONObject().put("path", path)).getJSONObject("file").getString("content").contains("Android roundtrip"));
        Log.i("DogOHubTest", "MEMORY_RETURNED=" + path);
    }
}
