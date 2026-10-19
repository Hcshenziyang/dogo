package app.dogo.mobile;

import android.util.AtomicFile;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Small, private offline workspace. No paths or arbitrary files are exposed to the WebView. */
@CapacitorPlugin(name = "DogoStore")
public class DogoStorePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private AtomicFile resolveFile(String key) {
        String name;
        if ("dogo.workspace.v1".equals(key)) name = "workspace.v1.json";
        else if ("dogo.workspace.v1.backup".equals(key)) name = "workspace.v1.backup.json";
        else if ("dogo.hub.v2".equals(key)) name = "hub.v2.json";
        else if ("dogo.agent.v1".equals(key)) name = "agent.v1.json";
        else if ("dogo.memory.maintenance.v1".equals(key)) name = "memory.maintenance.v1.json";
        else throw new IllegalArgumentException("Unknown workspace key");
        return new AtomicFile(new File(getContext().getFilesDir(), name));
    }

    @PluginMethod
    public void get(PluginCall call) {
        io.execute(() -> {
            try {
                AtomicFile file = resolveFile(call.getString("key"));
                JSObject result = new JSObject();
                try {
                    if (file.getBaseFile().length() > 32 * 1024 * 1024) throw new IllegalStateException("Workspace too large");
                    byte[] bytes = file.readFully();
                    if (bytes.length > 32 * 1024 * 1024) throw new IllegalStateException("Workspace too large");
                    result.put("value", new String(bytes, StandardCharsets.UTF_8));
                } catch (FileNotFoundException absent) {
                    if (file.getBaseFile().exists()) throw absent;
                    result.put("value", JSONObject.NULL);
                }
                call.resolve(result);
            } catch (Exception error) {
                call.reject("无法读取本地数据，请勿卸载或清除应用数据");
            }
        });
    }

    @PluginMethod
    public void set(PluginCall call) {
        io.execute(() -> {
            AtomicFile file = null;
            FileOutputStream stream = null;
            try {
                file = resolveFile(call.getString("key"));
                String value = call.getString("value");
                if (value == null) throw new IllegalArgumentException("Value required");
                byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 32 * 1024 * 1024) throw new IllegalArgumentException("Workspace too large");
                stream = file.startWrite();
                stream.write(bytes);
                stream.getFD().sync();
                file.finishWrite(stream);
                call.resolve();
            } catch (Exception error) {
                if (file != null && stream != null) file.failWrite(stream);
                call.reject("本地保存失败，请检查设备空间后重试；之前的数据仍保留");
            }
        });
    }
}
