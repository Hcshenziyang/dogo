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
        assertNull("archived session is hidden", device.findObject(By.text("归档测试会话")));
        UiObject2 filter = device.findObject(By.res(context.getPackageName(), "project_filter"));
        assertNotNull("project filter", filter);
        filter.click();
        UiObject2 project = device.wait(Until.findObject(By.text("测试项目 · Synthetic Mac")), 10000);
        assertNotNull("desktop project", project);
        project.click();
        session = device.wait(Until.findObject(By.text("测试远程会话")), 10000);
        assertNotNull("session in selected project", session);
        session.click();
        assertNotNull("original context", device.wait(Until.findObject(By.textContains("原有上下文")), 20000));
        assertNull("tool calls are hidden", device.findObject(By.textContains("正在使用工具")));
        assertNotNull("idle status", device.wait(Until.findObject(By.textContains("电脑在线 · 可以继续")), 20000));
        UiObject2 expand = device.wait(Until.findObject(By.text("展开")), 10000);
        assertNotNull("long message is collapsed", expand);
        expand.click();
        UiObject2 collapse = device.wait(Until.findObject(By.text("收起")), 10000);
        assertNotNull("expanded message can be collapsed", collapse);
        collapse.click();
        UiObject2 model = device.wait(Until.findObject(By.res(context.getPackageName(), "model_button")), 10000);
        assertNotNull("model button", model);
        model.click();
        UiObject2 modelPicker = device.wait(Until.findObject(By.res(context.getPackageName(), "model_spinner")), 10000);
        assertNotNull("model picker", modelPicker);
        modelPicker.click();
        UiObject2 alternative = device.wait(Until.findObject(By.text("Synthetic · Fixture Alt")), 10000);
        assertNotNull("remote model option", alternative);
        alternative.click();
        UiObject2 effortPicker = device.wait(Until.findObject(By.res(context.getPackageName(), "effort_spinner")), 10000);
        assertNotNull("reasoning picker", effortPicker);
        effortPicker.click();
        UiObject2 high = device.wait(Until.findObject(By.text("高")), 10000);
        assertNotNull("reasoning effort", high);
        high.click();
        device.findObject(By.text("应用")).click();
        long modelDeadline = SystemClock.uptimeMillis() + 15000;
        while (stats().optInt("modelChanges") == 0 && SystemClock.uptimeMillis() < modelDeadline) SystemClock.sleep(200);
        assertEquals("fixture-alt", stats().getJSONObject("selection").optString("model"));
        assertEquals("high", stats().getJSONObject("selection").optString("reasoningEffort"));
        UiObject2 input = device.findObject(By.res(context.getPackageName(), "chat_input"));
        assertNotNull(input);
        input.setText("run synthetic tests");
        UiObject2 send = device.wait(Until.findObject(By.res(context.getPackageName(), "send_message").enabled(true)), 15000);
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

        device.pressBack();
        filter = device.wait(Until.findObject(By.res(context.getPackageName(), "project_filter")), 10000);
        assertNotNull(filter);
        filter.click();
        UiObject2 emptyProject = device.wait(Until.findObject(By.text("空项目 · Synthetic Mac")), 10000);
        assertNotNull("empty project can be selected", emptyProject);
        emptyProject.click();
        UiObject2 newSession = device.wait(Until.findObject(By.res(context.getPackageName(), "new_session").enabled(true)), 15000);
        assertNotNull("new session entry", newSession);
        newSession.click();
        UiObject2 create = device.wait(Until.findObject(By.text("创建会话").enabled(true)), 10000);
        assertNotNull("selected project is preselected", create);
        create.click();
        assertNotNull("lost reply is reported", device.wait(Until.findObject(By.textContains("创建结果尚未确认")), 30000));
        long reconnectDeadline = SystemClock.uptimeMillis() + 15000;
        while (!stats().optBoolean("connected") && SystemClock.uptimeMillis() < reconnectDeadline) SystemClock.sleep(200);
        assertTrue("synthetic desktop reconnects", stats().optBoolean("connected"));
        newSession = device.wait(Until.findObject(By.res(context.getPackageName(), "new_session").enabled(true)), 10000);
        assertNotNull(newSession);
        newSession.click();
        UiObject2 retryCreate = device.wait(Until.findObject(By.text("重试创建").enabled(true)), 10000);
        assertNotNull("retry retains pending project", retryCreate);
        retryCreate.click();
        assertNotNull("new conversation opens", device.wait(Until.findObject(By.res(context.getPackageName(), "chat_input")), 20000));
        JSONObject createResult = stats();
        assertEquals(1, createResult.optInt("createExecutions"));
        assertEquals(2, createResult.optInt("createAttempts"));
        assertEquals(createResult.getJSONArray("createIds").getString(0), createResult.getJSONArray("createIds").getString(1));
        assertEquals("empty-project", createResult.getJSONArray("created").getJSONObject(0).optString("workspaceId"));
    }
}
