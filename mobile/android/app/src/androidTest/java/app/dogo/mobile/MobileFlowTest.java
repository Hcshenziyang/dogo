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
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class MobileFlowTest {
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final String pkg = context.getPackageName();

    private UiObject2 field(String id) throws Exception {
        assertTrue(device.wait(Until.gone(By.text("正在连接…")), 15000));
        device.waitForIdle();
        UiObject2 found = device.findObject(By.res(pkg, id));
        if (found == null || found.getVisibleBounds().height() == 0) {
            new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().resourceId(pkg + ":id/" + id));
        }
        found = device.wait(Until.findObject(By.res(pkg, id)), 5000);
        assertNotNull("Missing field " + id, found);
        assertTrue(device.wait(Until.hasObject(By.res(pkg, id).enabled(true)), 15000));
        return device.findObject(By.res(pkg, id));
    }
    private void clickText(String text) throws Exception {
        UiObject2 visible = device.findObject(By.text(text));
        if (visible == null || visible.getVisibleBounds().height() == 0)
            new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text(text));
        UiObject2 found = device.wait(Until.findObject(By.text(text)), 5000);
        assertNotNull(text, found); found.click();
    }
    private void waitText(String text) {
        assertNotNull("Missing text " + text, device.wait(Until.findObject(By.text(text)), 15000));
    }
    private void launch() {
        device.pressHome();
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(pkg);
        assertNotNull(intent);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
    @Test public void nativeUiCreatesEditsAppendsPreservesDraftAndLogsOut() throws Exception {
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        app.store.saveSession(null);
        // The only fixed credentials in the tests belong to a disposable local test server.
        String origin = "http://10.0.2.2:18765";
        String key = "draft:" + SecureStore.scope(origin, "android-test");
        app.store.put(key, null);
        launch();
        waitText("连接你的服务");
        field("server_url").setText(origin);
        field("username").setText("android-test");
        field("password").setText("android-test-password");
        field("device_name").setText("Android UI test");
        field("login").click();
        waitText("备忘录");
        String content = "Android UI " + UUID.randomUUID();
        field("new_memo").click();
        field("content").setText(content);
        device.setOrientationLeft();
        waitText("备忘录");
        device.setOrientationNatural();
        waitText("备忘录");
        clickText("继续本地草稿");
        assertEquals(content, field("content").getText());
        field("project").setText("phone-ui");
        field("back").click();
        waitText("备忘录");
        clickText("继续本地草稿");
        assertEquals(content, field("content").getText());
        clickText("同时交给电脑处理");
        field("instruction").setText("整理这条测试记录");
        clickText("刷新可用电脑");
        waitText("已加载启用的桌面设备；此列表不表示设备在线。");
        clickText("请选择电脑（可先刷新列表）");
        device.wait(Until.findObject(By.text("离线测试电脑 · test-offline-desktop")), 5000).click();
        field("save").click();
        waitText("备忘录详情");
        waitText(content);
        assertNotNull(device.wait(Until.findObject(By.textContains("等待设备接收")), 5000));
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "memo.png"));
        field("edit").click();
        field("content").setText(content + " edited");
        field("save").click();
        waitText("备忘录详情");
        waitText(content + " edited");
        field("append").click();
        field("content").setText(" + append");
        field("save").click();
        waitText("备忘录详情");
        waitText(content + " edited + append");
        field("delete").click();
        waitText("删除备忘录？");
        device.findObject(By.res("android", "button1")).click();
        waitText("备忘录");
        field("project_filter").setText("phone-ui");
        clickText("筛选 / 刷新");
        device.waitForIdle();
        field("settings").click();
        waitText("设置与设备");
        waitText("设备列表已刷新");
        field("logout").click();
        waitText("连接你的服务");
        assertNull(app.store.session());
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "login.png"));
    }

    @Test public void encryptedStorePersistsTokensAndSeparatesDrafts() throws Exception {
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        String id = UUID.randomUUID().toString();
        String a = "draft:" + SecureStore.scope("https://a.example", id);
        String b = "draft:" + SecureStore.scope("https://b.example", id);
        try {
            app.store.put(a, Json.of("content", "private-test-draft"));
            SecureStore reopened = new SecureStore(context);
            assertEquals("private-test-draft", reopened.get(a).optString("content"));
            assertNull(reopened.get(b));
            java.io.File base = new java.io.File(context.getNoBackupFilesDir(), "state.enc");
            java.nio.file.Files.copy(base.toPath(), new java.io.File(base.getPath() + ".bak").toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            java.nio.file.Files.delete(base.toPath());
            assertEquals("private-test-draft", new SecureStore(context).get(a).optString("content"));
            byte[] bytes = java.nio.file.Files.readAllBytes(new java.io.File(context.getNoBackupFilesDir(), "state.enc").toPath());
            assertFalse(new String(bytes, java.nio.charset.StandardCharsets.UTF_8).contains("private-test-draft"));
            assertEquals(app.store.deviceId("https://a.example", id), app.store.deviceId("https://a.example", id));
            assertNotEquals(app.store.deviceId("https://a.example", id), app.store.deviceId("https://b.example", id));
        } finally { app.store.put(a, null); }
    }
}
