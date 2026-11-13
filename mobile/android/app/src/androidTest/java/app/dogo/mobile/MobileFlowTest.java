package app.dogo.mobile;

import android.content.Context;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.Until;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class MobileFlowTest {
    @Test public void upgradeClearsDraftButPreservesAccountSettings() throws Exception {
        assumeTrue("Use a disposable emulator only", android.os.Build.HARDWARE.contains("ranchu")
                || android.os.Build.HARDWARE.contains("goldfish"));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        JSONObject session = app.store.session();
        JSONObject preferences = app.store.get("preferences");
        String key = "draft:synthetic-test";
        try {
            app.store.saveSession(null);
            app.store.put("preferences", Json.of("username", "synthetic-test"));
            app.store.put(key, Json.of("content", "synthetic draft"));
            Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            assertNotNull(intent);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
            assertNotNull(device.wait(Until.findObject(By.text("连接你的服务")), 10000));
            assertNull(app.store.get(key));
            assertEquals("synthetic-test", app.store.get("preferences").optString("username"));
            assertNull(device.findObject(By.text("备忘录")));
        } finally {
            app.store.put(key, null);
            app.store.put("preferences", preferences);
            app.store.saveSession(session);
        }
    }
}
