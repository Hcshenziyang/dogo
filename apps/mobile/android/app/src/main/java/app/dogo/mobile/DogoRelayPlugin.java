package app.dogo.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.Manifest;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

@CapacitorPlugin(name = "DogoRelay", permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) })
public class DogoRelayPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private RelayTransport transport;
    private PersonalMemory memory;
    private final ScheduledExecutorService syncTimer = Executors.newSingleThreadScheduledExecutor();
    @Override public void load() {
        transport = new RelayTransport(getContext()); memory = new PersonalMemory(getContext(), transport);
        syncTimer.scheduleWithFixedDelay(() -> {
            if (getContext().getSharedPreferences("dogo.memory", 0).getBoolean("enabled", false)) {
                try { memory.sync(); } catch (Exception ignored) {}
            }
        }, 5, 30, TimeUnit.SECONDS);
    }
    @Override protected void handleOnDestroy() { syncTimer.shutdownNow(); io.shutdown(); }
    private interface Operation { JSONObject run() throws Exception; }
    private void run(PluginCall call, Operation operation) {
        io.execute(() -> {
            try { call.resolve(JSObject.fromJSONObject(operation.run())); }
            catch (Exception error) {
                // Do not expose URLs, credential content, or exception stack traces to JS/logcat.
                String message = error.getMessage();
                call.reject(message != null && (message.startsWith("账号") || message.startsWith("记忆") || message.startsWith("文件") || message.startsWith("任务") || message.startsWith("设备") || message.startsWith("凭据") || message.startsWith("请选择") || message.startsWith("服务"))
                    ? message : "网络或安全存储不可用；任务保留，请检查连接后重试");
            }
        });
    }
    @PluginMethod public void status(PluginCall call) { run(call, () -> transport.status()); }
    @PluginMethod public void account(PluginCall call) { run(call, () -> {
        JSONObject result = transport.account(call.getString("op"), call.getString("url"), call.getObject("args", new JSObject()));
        if (!transport.status().optBoolean("configured")) {
            getContext().getSharedPreferences(RelayNotifyService.PREFS, 0).edit().putBoolean("enabled", false).commit();
            getContext().stopService(new Intent(getContext(), RelayNotifyService.class));
        }
        return result;
    }); }
    @PluginMethod public void identity(PluginCall call) { run(call, () -> transport.identity()); }
    @PluginMethod public void publish(PluginCall call) { run(call, () -> transport.publish(call.getObject("input"), call.getString("origin"))); }
    @PluginMethod public void read(PluginCall call) { run(call, () -> transport.read(call.getString("id"), call.getString("origin"))); }
    @PluginMethod public void hub(PluginCall call) { run(call, () -> transport.hub(call.getString("origin"), call.getString("op"), call.getObject("args"))); }
    @PluginMethod public void memory(PluginCall call) {
        if ("export".equals(call.getString("op"))) {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json"); intent.putExtra(Intent.EXTRA_TITLE, "dogo-personal-memory.json");
            startActivityForResult(call, intent, "memoryDestination"); return;
        }
        run(call, () -> memory.local(call.getString("op"), call.getObject("args", new JSObject())));
    }
    @ActivityCallback private void memoryDestination(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.resolve(new JSObject().put("saved", false)); return; }
        run(call, () -> {
            byte[] bytes = memory.local("export", new JSONObject()).toString(2).getBytes(StandardCharsets.UTF_8);
            try (java.io.OutputStream out = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) {
                if (out == null) throw new java.io.IOException("文件目标不可写"); out.write(bytes);
            }
            return new JSONObject().put("saved", true);
        });
    }
    @PluginMethod public void notificationStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", getContext().getSharedPreferences(RelayNotifyService.PREFS, 0).getBoolean("enabled", false));
        result.put("active", RelayNotifyService.active);
        result.put("permission", NotificationManagerCompat.from(getContext()).areNotificationsEnabled()); call.resolve(result);
    }
    @PluginMethod public void notifications(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        if (enabled && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermission"); return;
        }
        setNotifications(call, enabled);
    }
    @PermissionCallback private void notificationPermission(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) { call.reject("通知权限未开启，可在系统设置中允许"); return; }
        setNotifications(call, true);
    }
    private void setNotifications(PluginCall call, boolean enabled) {
        try {
            getContext().getSharedPreferences(RelayNotifyService.PREFS, 0).edit().putBoolean("enabled", enabled).commit();
            Intent intent = new Intent(getContext(), RelayNotifyService.class);
            if (enabled) ContextCompat.startForegroundService(getContext(), intent); else getContext().stopService(intent);
            notificationStatus(call);
        } catch (Exception e) { call.reject("后台通知启动失败，请重新打开应用后重试"); }
    }
    @PluginMethod public void importPairing(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE); intent.setType("application/json");
        startActivityForResult(call, intent, "pairingResult");
    }
    @PluginMethod public void saveArtifact(PluginCall call) {
        String name = call.getString("name", "attachment.bin"), id = call.getString("id", "");
        if (name.length() > 200 || name.matches(".*[\\\\/\\x00-\\x1f].*") || !id.matches("[a-f0-9-]{36}")) { call.reject("文件标识无效"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream"); intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "artifactDestination");
    }
    @ActivityCallback private void artifactDestination(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("文件保存已取消"); return; }
        run(call, () -> {
            byte[] bytes = transport.artifact(call.getString("origin"), call.getString("id"));
            try (java.io.OutputStream out = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) {
                if (out == null) throw new java.io.IOException("文件目标不可写"); out.write(bytes);
            }
            return new JSONObject().put("saved", true);
        });
    }
    @ActivityCallback private void pairingResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("设备凭据导入已取消"); return;
        }
        run(call, () -> {
            try (InputStream stream = getContext().getContentResolver().openInputStream(result.getData().getData())) {
                if (stream == null) throw new IllegalArgumentException("No file");
                JSONObject pair = new JSONObject(new String(RelayTransport.readLimited(stream, 8192), StandardCharsets.UTF_8));
                return transport.configure(pair);
            }
        });
    }
}
