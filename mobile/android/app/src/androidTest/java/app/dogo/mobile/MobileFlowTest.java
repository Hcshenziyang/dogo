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
import org.junit.Before;
import org.junit.runner.RunWith;
import java.util.UUID;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class MobileFlowTest {
    private final UiDevice device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final String pkg = context.getPackageName();

    @Before public void requireDisposableEmulator() {
        org.junit.Assume.assumeTrue("These tests reset local test credentials; use an emulator only",
                android.os.Build.HARDWARE.contains("ranchu") || android.os.Build.HARDWARE.contains("goldfish"));
    }

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
        app.store.put("preferences", null);
        // The only fixed credentials in the tests belong to a disposable local test server.
        String origin = "http://10.0.2.2:18765";
        String key = "draft:" + SecureStore.scope(origin, "android-test");
        app.store.put(key, null);
        launch();
        waitText("连接你的服务");
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "login-redesign.png"));
        if (BuildConfig.DEFAULT_SERVER_URL.isEmpty()) waitText("连接设置  −");
        else clickText("连接设置  ＋");
        field("server_url").setText(origin);
        field("username").setText("android-test");
        field("password").setText("android-test-password");
        field("device_name").setText("Android UI test");
        field("login").click();
        waitText("备忘录");
        device.waitForIdle();
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "list-empty.png"));
        String content = "Android UI " + UUID.randomUUID();
        field("new_memo").click();
        field("content").setText(content);
        device.pressBack();
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "editor-redesign.png"));
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
        device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "settings-redesign.png"));
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

    @Test public void scheduledMemoCanBeCreatedAndPausedOnThePhone() throws Exception {
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        String origin = "http://10.0.2.2:18765";
        String draftKey = "draft:" + SecureStore.scope(origin, "android-test");
        app.store.saveSession(null);
        app.store.put(draftKey, null);
        app.api.login(origin, "android-test", "android-test-password",
                app.store.deviceId(origin, "android-test"), "Android UI test");
        String marker = "手机定时 " + UUID.randomUUID();
        String memoId = null;
        try {
            try (androidx.test.core.app.ActivityScenario<MainActivity> scenario =
                         androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
                field("new_memo").click();
                field("content").setText(marker);
                field("plan_present").click();
                field("plan_instruction").setText("整理本周记录");
                field("plan_type").click();
                chooseOption("每周");
                field("plan_time").setText("08:30");
                field("plan_weekday").click();
                chooseOption("周五");
                clickText("刷新定时目标电脑");
                field("plan_target").click();
                chooseOption("离线测试电脑 · test-offline-desktop");
                hideKeyboard(scenario);
                device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "schedule-editor.png"));
                field("save").click();
                waitText("备忘录详情");
                assertNotNull(device.wait(Until.findObject(By.textContains("定时计划 · 每周")), 5000));
                JSONObject list = app.api.request("GET", "/api/memos?limit=100", null);
                org.json.JSONArray items = list.getJSONArray("items");
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.getJSONObject(i);
                    if (marker.equals(item.optString("content"))) memoId = item.getString("id");
                }
                assertNotNull(memoId);
                JSONObject saved = app.api.request("GET", "/api/memos/" + memoId, null);
                assertEquals("weekly", saved.getJSONObject("plan").getString("mode"));
                assertEquals(4, saved.getJSONObject("plan").getInt("weekday"));
                assertEquals("08:30", saved.getJSONObject("plan").getString("time"));
                field("back").click();
                waitText("定时 · 已设置");
                clickText(marker);
                waitText("备忘录详情");
                field("edit").click();
                field("plan_enabled").click();
                field("save").click();
                waitText("备忘录详情");
                assertNotNull(device.wait(Until.findObject(By.textContains("定时计划 · 每周 · 已暂停")), 5000));
                assertFalse(app.api.request("GET", "/api/memos/" + memoId, null)
                        .getJSONObject("plan").getBoolean("enabled"));
                field("edit").click();
                field("plan_type").click();
                chooseOption("单次");
                field("plan_date").setText("2031-11-03 20:30");
                field("plan_enabled").click();
                field("save").click();
                waitText("备忘录详情");
                JSONObject once = app.api.request("GET", "/api/memos/" + memoId, null).getJSONObject("plan");
                assertEquals("once", once.getString("mode"));
                assertEquals(java.time.Instant.parse("2031-11-03T12:30:00Z").toEpochMilli(), once.getLong("run_at"));
            }
        } finally {
            app.store.put(draftKey, null);
            if (memoId != null) {
                JSONObject saved = app.api.request("GET", "/api/memos/" + memoId, null);
                app.api.request("DELETE", "/api/memos/" + memoId, Json.of("revision", saved.optInt("revision")));
            }
            app.store.saveSession(null);
        }
    }

    @Test public void inFlightPlanShowsReasonAndCanRetryAfterReceipt() throws Exception {
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        String origin = "http://10.0.2.2:18765";
        String draftKey = "draft:" + SecureStore.scope(origin, "android-test");
        app.store.saveSession(null);
        app.store.put(draftKey, null);
        app.api.login(origin, "android-test", "android-test-password",
                app.store.deviceId(origin, "android-test"), "Android UI test");
        String marker = "确认中计划 " + UUID.randomUUID();
        JSONObject created = app.api.request("POST", "/api/memos", Json.of(
                "request_id", UUID.randomUUID().toString(), "content", marker,
                "plan", Json.of("mode", "once", "run_at", System.currentTimeMillis()-1000,
                        "instruction", "测试确认状态", "target_device_id", "test-offline-desktop")));
        String memoId = created.getString("id");
        JSONObject delivery = app.api.request("POST", "/api/test/claim", new JSONObject());
        assertEquals(memoId, delivery.getString("memo_id"));
        try {
            try (androidx.test.core.app.ActivityScenario<MainActivity> scenario =
                         androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
                waitText("备忘录");
                clickText(marker);
                field("edit").click();
                field("plan_date").setText("2031-11-03 20:30");
                field("save").click();
                waitText("指令已发送、尚未确认，暂不能删除或修改相关计划。");
                assertEquals("2031-11-03 20:30", field("plan_date").getText());
                app.api.request("POST", "/api/test/ack", delivery);
                field("save").click();
                waitText("备忘录详情");
                JSONObject saved = app.api.request("GET", "/api/memos/" + memoId, null);
                assertEquals(java.time.Instant.parse("2031-11-03T12:30:00Z").toEpochMilli(),
                        saved.getJSONObject("plan").getLong("run_at"));
            }
        } finally {
            app.store.put(draftKey, null);
            app.api.request("POST", "/api/test/ack", delivery);
            JSONObject saved = app.api.request("GET", "/api/memos/" + memoId, null);
            app.api.request("DELETE", "/api/memos/" + memoId, Json.of("revision", saved.optInt("revision")));
            app.store.saveSession(null);
        }
    }

    private void chooseOption(String name) {
        UiObject2 option = device.wait(Until.findObject(By.text(name)), 5000);
        assertNotNull("Missing option " + name, option);
        option.click();
    }

    private void hideKeyboard(androidx.test.core.app.ActivityScenario<MainActivity> scenario) {
        scenario.onActivity(activity -> ((android.view.inputmethod.InputMethodManager)
                activity.getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(
                activity.getWindow().getDecorView().getWindowToken(), 0));
        device.waitForIdle();
    }

    @Test public void redesignedScreensKeepHiddenMetadataAndRenderBothThemes() throws Exception {
        DogOApplication app = (DogOApplication) context.getApplicationContext();
        app.initialize();
        String origin = "http://10.0.2.2:18765";
        String draftKey = "draft:" + SecureStore.scope(origin, "android-test");
        app.store.saveSession(null);
        app.store.put(draftKey, null);
        app.api.login(origin, "android-test", "android-test-password",
                app.store.deviceId(origin, "android-test"), "Android UI test");
        java.util.List<JSONObject> samples = new java.util.ArrayList<>();
        try {
            String[] titles = {"给周末留一点空白\n去河边走走，带上相机。顺路找一家没去过的咖啡店。",
                    "一个关于产品的小想法\n先让随手记录足够轻，再让电脑接着处理。重要的是思路能继续。",
                    "读到一篇值得再看的文章\n关于长期学习与注意力。晚上回到电脑旁，把几个观点整理出来。"};
            for (int i = 0; i < titles.length; i++) samples.add(app.api.request("POST", "/api/memos",
                    Json.of("request_id", UUID.randomUUID().toString(), "content", titles[i],
                            "project", i == 1 ? "DogO" : i == 0 ? "生活" : "阅读", "active", true)));
            try (androidx.test.core.app.ActivityScenario<MainActivity> scenario =
                         androidx.test.core.app.ActivityScenario.launch(MainActivity.class)) {
                waitText("备忘录");
                field("new_memo");
                waitText("今天");
                device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "list-filled.png"));
                device.executeShellCommand("cmd uimode night yes");
                device.waitForIdle();
                field("new_memo");
                device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "list-dark.png"));
                field("new_memo").click();
                field("content").click();
                field("content").setText("测试折叠属性与本地草稿");
                assertTrue(field("save").getVisibleBounds().height() > 0);
                device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "editor-keyboard.png"));
                hideKeyboard(scenario);
                clickText("更多属性 · 分类与标签  ＋");
                field("category").setText("想法");
                field("tags").setText("移动端, 设计");
                hideKeyboard(scenario);
                clickText("更多属性 · 分类与标签  −");
                field("back").click();
                waitText("备忘录");
                clickText("继续本地草稿");
                clickText("更多属性 · 分类与标签  ＋");
                assertEquals("想法", field("category").getText());
                assertEquals("移动端, 设计", field("tags").getText());
                device.takeScreenshot(new java.io.File(context.getExternalFilesDir(null), "editor-dark.png"));
            }
        } finally {
            device.executeShellCommand("cmd uimode night no");
            app.store.put(draftKey, null);
            for (JSONObject memo : samples) app.api.request("DELETE", "/api/memos/" + memo.optString("id"),
                    Json.of("revision", memo.optInt("revision")));
            app.store.saveSession(null);
            launch();
        }
    }
}
