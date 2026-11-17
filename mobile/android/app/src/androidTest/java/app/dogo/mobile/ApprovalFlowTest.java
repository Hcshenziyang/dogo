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
public class ApprovalFlowTest {
    private JSONObject stats() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://10.0.2.2:18790/").openConnection();
        connection.setConnectTimeout(2000); connection.setReadTimeout(2000);
        try { return new JSONObject(new String(connection.getInputStream().readAllBytes(), StandardCharsets.UTF_8)); }
        finally { connection.disconnect(); }
    }
    @Test public void canReviewAndResolveBothChoices() throws Exception {
        assumeTrue("Disposable emulator only", android.os.Build.HARDWARE.contains("ranchu") || android.os.Build.HARDWARE.contains("goldfish"));
        boolean fixture; try { fixture = "dogo-synthetic-v1".equals(stats().optString("fixture")); } catch (Exception e) { fixture = false; }
        assumeTrue("Synthetic fixture required", fixture);
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DogOApplication app = (DogOApplication) context.getApplicationContext(); app.initialize();
        app.api.login("http://10.0.2.2:18789", "synthetic-user", "synthetic-test-password", "synthetic-phone", "Synthetic Phone");
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        assertNotNull(intent); intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(intent);
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        for (int i = 0; i < 2; i++) {
            boolean allow = i == 0;
            UiObject2 session = device.wait(Until.findObject(By.text(allow ? "审批允许测试" : "审批拒绝测试")), 20000);
            assertNotNull("pending session", session); session.click();
            assertNotNull("pending indicator", device.wait(Until.findObject(By.textContains("等待审批")), 20000));
            UiObject2 review = device.wait(Until.findObject(By.res(context.getPackageName(), "approval_review").enabled(true)), 20000);
            assertNotNull("review action", review); review.click();
            assertNotNull("reason", device.wait(Until.findObject(By.textContains(allow ? "合成测试：允许" : "合成测试：拒绝")), 10000));
            assertNotNull("full arguments", device.findObject(By.textContains(allow ? "printf synthetic-allow" : "printf synthetic-reject")));
            UiObject2 action = device.findObject(By.res(context.getPackageName(), allow ? "approval_allow" : "approval_reject"));
            assertNotNull(action); assertTrue(action.isEnabled()); action.click();
            long deadline = SystemClock.uptimeMillis() + 15000;
            while (stats().getJSONArray("approvalOutcomes").length() < i + 1 && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200);
            JSONObject recorded = stats().getJSONArray("approvalOutcomes").getJSONObject(i);
            assertEquals(allow ? "allowed-once" : "rejected", recorded.optString("decision"));
            assertTrue("completed approval disappears", device.wait(Until.gone(By.res(context.getPackageName(), "approval_review")), 15000));
            device.pressBack();
        }
        assertEquals("exactly one response per approval", 2, stats().getJSONArray("approvalOutcomes").length());
    }
}
