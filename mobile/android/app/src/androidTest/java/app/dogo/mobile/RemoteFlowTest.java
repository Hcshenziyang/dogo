package app.dogo.mobile;

import android.content.Context;
import android.content.Intent;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.Until;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class RemoteFlowTest {
    private JSONObject stats() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://10.0.2.2:18790/").openConnection();
        connection.setConnectTimeout(2000);
        connection.setReadTimeout(2000);
        try { return new JSONObject(new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8)); }
        finally { connection.disconnect(); }
    }
    @Test public void resumesExistingConversationAfterLostAcknowledgementAndScreenLock() throws Exception {
        assumeTrue("Use the disposable emulator and local synthetic fixture only", android.os.Build.HARDWARE.contains("ranchu")
                || android.os.Build.HARDWARE.contains("goldfish"));
        boolean fixtureAvailable;
        try { fixtureAvailable = "dogo-synthetic-v1".equals(stats().optString("fixture")); }
        catch (Exception ignored) { fixtureAvailable = false; }
        assumeTrue("Start the local synthetic remote fixture first", fixtureAvailable);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        app.api.login("http://10.0.2.2:18789", "synthetic-user", "synthetic-test-password", "synthetic-phone", "Synthetic Phone");
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        assertNotNull(intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        UiObject2 session = device.wait(Until.findObject(By.text("测试远程会话")), 20000);
        assertNotNull("session list", session);
        session.click();
        assertNotNull("original context", device.wait(Until.findObject(By.textContains("原有上下文")), 20000));
        assertNotNull("idle status", device.wait(Until.findObject(By.textContains("电脑在线 · 可以继续")), 20000));
        UiObject2 input = device.findObject(By.res(context.getPackageName(), "chat_input"));
        assertNotNull(input);
        input.setText("run synthetic tests");
        UiObject2 send = device.findObject(By.res(context.getPackageName(), "send_message"));
        assertNotNull(send);
        assertTrue(send.isEnabled());
        send.click();
        long deadline = SystemClock.uptimeMillis() + 20000;
        while (stats().optInt("executions") == 0 && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200);
        assertEquals(1, stats().optInt("executions"));
        device.sleep();
        SystemClock.sleep(3500);
        device.wakeUp();
        device.executeShellCommand("wm dismiss-keyguard");
        Intent resume = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        resume.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(resume);
        assertNotNull("completion after resuming", device.wait(Until.findObject(By.textContains("测试已完成")), 30000));
        assertNotNull("computer acknowledgement", device.wait(Until.findObject(By.textContains("电脑已收到上一条消息")), 30000));
        JSONObject result = stats();
        assertEquals(1, result.optInt("executions"));
        assertEquals(2, result.optInt("attempts"));
        assertEquals(result.getJSONArray("ids").getString(0), result.getJSONArray("ids").getString(1));
    }
}
