package app.dogo.mobile;

import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import android.app.Activity;
import android.content.Intent;
import android.util.AtomicFile;
import androidx.activity.result.ActivityResult;
import java.io.File;
import java.io.OutputStream;
import java.util.concurrent.*;

@CapacitorPlugin(name = "DogoAgent")
public class DogoAgentPlugin extends Plugin {
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private AgentTransport transport;
    @Override public void load() { transport = new AgentTransport(getContext()); }
    @PluginMethod public void status(PluginCall call) { io.execute(() -> { try { call.resolve(JSObject.fromJSONObject(transport.status())); } catch (Exception e) { call.reject("无法读取 Agent 配置；请勿清除应用数据"); } }); }
    @PluginMethod public void configure(PluginCall call) { io.execute(() -> { try { call.resolve(JSObject.fromJSONObject(transport.configure(call.getData()))); } catch (Exception e) { call.reject("配置未保存：请核对 HTTPS 地址、密钥格式和文本大小"); } }); }
    @PluginMethod public void request(PluginCall call) { io.execute(() -> { try { call.resolve(JSObject.fromJSONObject(transport.request(call.getData()))); } catch (Exception e) { call.reject("Agent 请求失败或已取消。请检查网络、模型名称、服务地址及授权；不会自动重试工具。"); } }); }
    @PluginMethod public void cancel(PluginCall call) { transport.cancel(call.getString("id", "")); call.resolve(); }
    @PluginMethod public void exportHistory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT); intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json"); intent.putExtra(Intent.EXTRA_TITLE, "dogo-phone-chats.json");
        startActivityForResult(call, intent, "historyDestination");
    }
    @ActivityCallback private void historyDestination(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.resolve(new JSObject().put("saved", false)); return; }
        io.execute(() -> {
            try {
                AtomicFile file = new AtomicFile(new File(getContext().getFilesDir(), "agent.v1.json"));
                if (file.getBaseFile().length() > 32 * 1024 * 1024) throw new java.io.IOException();
                byte[] bytes = file.readFully();
                try (OutputStream out = getContext().getContentResolver().openOutputStream(result.getData().getData(), "w")) { if (out == null) throw new java.io.IOException(); out.write(bytes); }
                call.resolve(new JSObject().put("saved", true));
            } catch (Exception e) { call.reject("导出失败；本机对话原文仍保留"); }
        });
    }
    @Override protected void handleOnPause() { if (transport != null) transport.foreground(false); }
    @Override protected void handleOnResume() { if (transport != null) transport.foreground(true); }
    @Override protected void handleOnDestroy() { if (transport != null) transport.foreground(false); io.shutdownNow(); }
}
