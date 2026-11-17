package app.dogo.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import androidx.test.uiautomator.UiScrollable;
import androidx.test.uiautomator.UiSelector;
import androidx.test.uiautomator.Until;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Opt-in: requires the disposable local server and two prepared native Harness sessions. */
@RunWith(AndroidJUnit4.class)
public class NativeApprovalFlowTest {
    @Test public void androidResolvesRealHarnessRequests() throws Exception {
        assumeTrue("Disposable emulator only", android.os.Build.HARDWARE.contains("ranchu") || android.os.Build.HARDWARE.contains("goldfish"));
        assumeTrue("Prepare isolated native sessions and opt in explicitly", "true".equals(InstrumentationRegistry.getArguments().getString("dogoNativeApproval")));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DogOApplication app = (DogOApplication) context.getApplicationContext(); app.initialize();
        app.api.login("http://10.0.2.2:18789", "synthetic-user", "synthetic-test-password", "synthetic-phone", "Synthetic Phone");
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        assertNotNull(intent); intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK); context.startActivity(intent);
        UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        for (int i = 0; i < 2; i++) {
            boolean allow = i == 0;
            String title = allow ? "手机真实审批允许" : "手机真实审批拒绝";
            UiObject2 session = device.wait(Until.findObject(By.text(title)), 12000);
            if (session == null) {
                new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text(title));
                session = device.wait(Until.findObject(By.text(title)), 10000);
            }
            assertNotNull("real Harness session", session); session.click();
            UiObject2 review = device.wait(Until.findObject(By.res(context.getPackageName(), "approval_review").enabled(true)), 20000);
            assertNotNull("native approval", review); review.click();
            assertNotNull("native reason", device.wait(Until.findObject(By.textContains("验证合成审批")), 10000));
            assertNotNull("native command", device.findObject(By.textContains("printf synthetic-approval")));
            UiObject2 action = device.findObject(By.res(context.getPackageName(), allow ? "approval_allow" : "approval_reject"));
            assertNotNull(action); assertTrue(action.isEnabled()); action.click();
            assertTrue("resolved approval disappears", device.wait(Until.gone(By.res(context.getPackageName(), "approval_review")), 20000));
            device.pressBack();
        }
    }
}
