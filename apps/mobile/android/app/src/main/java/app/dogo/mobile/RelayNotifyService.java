package app.dogo.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;

/** User-enabled cross-device message continuity; never runs an Agent. */
public class RelayNotifyService extends Service {
    static final String PREFS = "dogo.notifications";
    static volatile boolean active = false;
    private volatile boolean stopped;
    private volatile HttpsURLConnection stream;
    private Thread worker;
    @Override public IBinder onBind(Intent intent) { return null; }
    static void channels(Context context) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("dogo.connection", "跨设备消息连接", NotificationManager.IMPORTANCE_LOW));
            manager.createNotificationChannel(new NotificationChannel("dogo.updates", "任务与待确认消息", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }
    private PendingIntent open() {
        return PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (!getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("enabled", false)) { stopSelf(); return START_NOT_STICKY; }
        channels(this);
        Notification notification = new NotificationCompat.Builder(this, "dogo.connection").setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("DogO 跨设备消息已开启").setContentText("等待电脑的结果与确认请求；可在 DogO 设置中关闭")
            .setContentIntent(open()).setOngoing(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(100, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        else startForeground(100, notification);
        active = true;
        if (worker == null) { worker = new Thread(this::listen, "dogo-relay-events"); worker.start(); }
        return START_STICKY;
    }
    private void listen() {
        RelayTransport transport = new RelayTransport(this);
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        long backoff = 2000;
        while (!stopped) {
            try {
                String origin = transport.status().getString("url");
                String cursorKey = "cursor:" + origin;
                stream = transport.events(preferences.getLong(cursorKey, 0));
                if (stream.getResponseCode() != 200) throw new IOException("event connection failed");
                backoff = 2000;
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while (!stopped && (line = reader.readLine()) != null) {
                        if (line.length() > 8192) throw new IOException("event too large");
                        if (!line.startsWith("data: ")) continue;
                        JSONObject event = new JSONObject(line.substring(6));
                        deliver(transport, origin, event, preferences);
                        // Only advance after the notification was handled. Reconnect can safely replay.
                        preferences.edit().putLong(cursorKey, event.getLong("seq")).commit();
                    }
                }
            } catch (Exception ignored) { /* Tokens and response bodies never enter logs. Reconnect from the durable cursor. */ }
            finally { if (stream != null) stream.disconnect(); stream = null; }
            if (!stopped) { try { Thread.sleep(backoff); } catch (InterruptedException ignored) {} backoff = Math.min(60000, backoff * 2); }
        }
    }
    private void deliver(RelayTransport transport, String origin, JSONObject event, SharedPreferences preferences) throws Exception {
        String kind = event.getString("kind"), id = event.getString("resource"), title = null;
        String signature = kind + ":" + id;
        if (kind.equals("hub.command")) {
            JSONObject command = transport.hub(origin, "get", new JSONObject().put("id", id).put("type", "command"));
            String status = command.getString("status");
            if (status.equals("succeeded")) title = "电脑任务已完成";
            else if (status.equals("failed") || status.equals("interrupted") || status.equals("cancelled")) title = "电脑任务已结束，请查看说明";
            signature += ":" + status;
        } else if (kind.equals("hub.request")) {
            JSONObject request = transport.hub(origin, "get", new JSONObject().put("id", id).put("type", "request"));
            if (request.optString("state").equals("pending") && !request.has("answer")) title = "DogO 需要你的确认或补充";
        } else if (kind.equals("memory.conflict")) {
            JSONArray conflicts = transport.memory("conflicts", new JSONObject()).getJSONArray("conflicts");
            for (int n = 0; n < conflicts.length(); n++) {
                JSONObject conflict = conflicts.getJSONObject(n);
                if (conflict.getString("id").equals(id) && conflict.optString("status").equals("needs-human")) title = "个人记忆冲突需要你处理";
            }
        } else if (kind.equals("task.finished")) title = "旧版任务有新结果";
        if (title == null || preferences.getBoolean("seen:" + origin + signature, false)) return;
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManagerCompat.from(this).notify(signature.hashCode(), new NotificationCompat.Builder(this, "dogo.updates")
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(title).setContentText("点此打开 DogO 查看；内容不会显示在锁屏上")
            .setContentIntent(open()).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build());
        preferences.edit().putBoolean("seen:" + origin + signature, true).commit();
    }
    @Override public void onDestroy() {
        stopped = true; active = false; if (stream != null) stream.disconnect(); if (worker != null) worker.interrupt(); super.onDestroy();
    }
}
