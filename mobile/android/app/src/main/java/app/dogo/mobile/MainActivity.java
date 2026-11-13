package app.dogo.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;

public final class MainActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private ExecutorService worker;
    private SecureStore store;
    private ApiClient api;
    private LinearLayout root, shell;
    private MobileUi ui;
    private TextView message;
    private boolean busy, destroyed;
    private String screen = "login";
    private int generation;
    private JSONArray devices = new JSONArray();
    private android.window.OnBackInvokedCallback backCallback;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
        try {
            DogOApplication application = (DogOApplication) getApplication();
            application.initialize();
            store = application.store;
            api = application.api;
            worker = application.worker;
            store.removeMemoDrafts();
            if (store.session() == null) showLogin(); else loadSettings();
        } catch (Exception error) {
            page("本机数据无法读取", "请保留应用数据后排查；当前没有覆盖原文件。");
            label("无法解密或读取本机数据。", 16);
        }
    }
    @Override protected void onResume() {
        super.onResume();
        if (api == null || busy || store.session() == null) return;
        if (screen.equals("settings")) loadSettings();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        if (android.os.Build.VERSION.SDK_INT >= 33 && backCallback != null)
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        super.onDestroy();
    }
    // API 33+ uses the native callback above; this override only supports older Android releases.
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override public void onBackPressed() {
        handleBack();
    }
    private void handleBack() {
        if (busy) return;
        moveTaskToBack(true);
    }

    private int dp(int value) { return ui.dp(value); }
    private void page(String title, String subtitle) {
        View focused = getCurrentFocus();
        if (focused != null) ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(focused.getWindowToken(), 0);
        generation++;
        ui = new MobileUi(this);
        getWindow().getDecorView().setSystemUiVisibility(ui.dark ? 0
                : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        shell = ui.column();
        shell.setBackgroundColor(ui.background);
        LinearLayout top = ui.row();
        top.setPadding(dp(24), dp(8), dp(24), dp(8));
        TextView brand = ui.text("DogO", 21, ui.accent, true);
        brand.setLetterSpacing(-0.03f);
        top.addView(brand, new LinearLayout.LayoutParams(0, dp(40), 1));
        brand.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView caption = ui.text("设备与远程会话", 12, ui.muted, false);
        top.addView(caption);
        shell.addView(top);
        root = ui.column();
        root.setFocusableInTouchMode(true);
        root.setPadding(dp(24), dp(18), dp(24), dp(24));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.addView(root);
        shell.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        shell.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(shell);
        shell.requestApplyInsets();
        TextView heading = label(title, 30);
        heading.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL));
        if (!subtitle.isEmpty()) label(subtitle, 14).setTextColor(ui.muted);
        message = label("", 13);
        message.setId(R.id.message);
        message.setPadding(dp(14), dp(12), dp(14), dp(12));
        message.setBackground(ui.shape(ui.tint, 12, 0));
        message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        message.setVisibility(View.GONE);
        root.removeView(message);
        LinearLayout.LayoutParams notice = new LinearLayout.LayoutParams(-1, -2);
        notice.setMargins(dp(24), 0, dp(24), dp(8));
        shell.addView(message, 1, notice);
    }
    private TextView label(String text, int size) {
        TextView view = ui.text(text, size, ui.text, false);
        root.addView(view, ui.spaced(size >= 28 ? 10 : 14));
        return view;
    }
    private Button button(String title, int id, Runnable action) {
        boolean primary = id == R.id.login;
        boolean destructive = id == R.id.logout || title.startsWith("禁用 ");
        Button button = ui.button(title, primary, destructive);
        if (id != 0) button.setId(id);
        root.addView(button, ui.spaced(10));
        button.setOnClickListener(v -> action.run());
        return button;
    }
    private EditText field(String title, String value, int id, boolean multiline) {
        TextView caption = label(title, 13);
        caption.setTextColor(ui.muted);
        ((LinearLayout.LayoutParams) caption.getLayoutParams()).bottomMargin = dp(7);
        caption.setLabelFor(id);
        EditText input = new EditText(this);
        input.setId(id);
        input.setSaveEnabled(false); // Credentials use an explicit encrypted persistence path.
        input.setTextSize(16);
        input.setTextColor(ui.text);
        input.setHintTextColor(ui.muted);
        input.setText(value);
        input.setContentDescription(title);
        input.setBackground(ui.inputBackground());
        input.setPadding(dp(16), dp(14), dp(16), dp(14));
        input.setMinHeight(dp(52));
        input.setInputType(InputType.TYPE_CLASS_TEXT | (multiline
                ? InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        input.setSingleLine(!multiline);
        input.setLineSpacing(dp(5), 1f);
        input.setHint("请输入" + title.replace("（选填）", ""));
        root.addView(input, ui.spaced(18));
        return input;
    }
    private void fold(String title, List<View> children, boolean open) {
        Button toggle = ui.button(title + (open ? "  −" : "  ＋"), false, false);
        toggle.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        int index = root.indexOfChild(children.get(0));
        root.addView(toggle, index, ui.spaced(10));
        for (View child : children) child.setVisibility(open ? View.VISIBLE : View.GONE);
        toggle.setOnClickListener(v -> {
            boolean expand = children.get(0).getVisibility() == View.GONE;
            for (View child : children) child.setVisibility(expand ? View.VISIBLE : View.GONE);
            toggle.setText(title + (expand ? "  −" : "  ＋"));
        });
    }
    private List<View> childrenFrom(int start) {
        List<View> views = new ArrayList<>();
        for (int i = start; i < root.getChildCount(); i++) views.add(root.getChildAt(i));
        return views;
    }
    private void say(String text) {
        if (message != null) {
            message.setText(text);
            message.setVisibility(text.isEmpty() ? View.GONE : View.VISIBLE);
        }
    }
    private void enabled(View view, boolean value) {
        view.setEnabled(value);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) enabled(group.getChildAt(i), value);
        }
    }
    interface Job { JSONObject run() throws Exception; }
    interface Done { void accept(JSONObject value); }
    interface Failed { void accept(Exception error); }
    private void run(Job job, Done done) { run(job, done, this::failure); }
    private void run(Job job, Done done, Failed failed) {
        if (busy) return;
        busy = true;
        int version = generation;
        enabled(shell, false);
        say("正在连接…");
        worker.execute(() -> {
            JSONObject result = null;
            Exception error = null;
            try { result = job.run(); } catch (Exception e) { error = e; }
            JSONObject finalResult = result;
            Exception finalError = error;
            main.post(() -> {
                busy = false;
                if (destroyed || version != generation) return;
                enabled(shell, true);
                say("");
                if (finalError == null) done.accept(finalResult); else failed.accept(finalError);
            });
        });
    }
    private void failure(Exception error) {
        if (error instanceof ApiClient.ApiException) {
            ApiClient.ApiException response = (ApiClient.ApiException) error;
            if (response.code.equals("invalid_credentials")) {
                say("账户或密码不正确，请重新输入密码。");
            } else if (response.status == 401) {
                showLogin();
                say("登录已失效，请重新登录。");
            } else say(errorText(response));
        } else if (error instanceof IllegalArgumentException) say(error.getMessage());
        else say("请求未完成，请检查网络或本机存储后重试。");
    }
    private String errorText(ApiClient.ApiException error) {
        if (error.code.equals("redirect_refused")) return "服务器返回了重定向，请填写最终服务器地址。";
        return error.status == 422 ? "提交字段不符合接口限制。"
                : "请求未完成（" + error.status + " / " + error.code + "）";
    }
    private void showLogin() {
        screen = "login";
        page("连接你的服务", "登录后管理已连接的设备。");
        JSONObject preferences = store.get("preferences");
        if (preferences == null) preferences = new JSONObject();
        EditText username = field("账户", preferences.optString("username"), R.id.username, false);
        username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        username.setTypeface(android.graphics.Typeface.DEFAULT);
        EditText password = field("密码", "", R.id.password, false);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setTypeface(android.graphics.Typeface.DEFAULT);
        int connectionStart = root.getChildCount();
        EditText server = field("服务器地址", preferences.optString("server", BuildConfig.DEFAULT_SERVER_URL), R.id.server_url, false);
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText name = field("这台手机的名称", preferences.optString("device_name", android.os.Build.MODEL), R.id.device_name, false);
        fold("连接设置", childrenFrom(connectionStart), server.getText().toString().trim().isEmpty());
        button("登录", R.id.login, () -> {
            String secret = password.getText().toString();
            String user = username.getText().toString().trim();
            String deviceName = name.getText().toString().trim();
            if (user.isEmpty() || secret.isEmpty() || deviceName.isEmpty()) { say("请填写账户、密码和设备名称。"); return; }
            final String origin;
            try { origin = ApiClient.normalizeServer(server.getText().toString(), BuildConfig.DEBUG); }
            catch (Exception e) { failure(e); return; }
            password.setText("");
            run(() -> {
                store.put("preferences", Json.of("server", origin, "username", user, "device_name", deviceName));
                return api.login(origin, user, secret, store.deviceId(origin, user), deviceName);
            }, value -> {
                devices = new JSONArray(); loadSettings();
            });
        });
        label("使用已有 DogO 账户登录", 12).setTextColor(ui.muted);
    }
    private void loadSettings() {
        showSettings();
        run(() -> {
            JSONObject me = api.request("GET", "/api/auth/me", null);
            return Json.of("me", me, "devices", api.request("GET", "/api/devices", null).optJSONArray("items"));
        }, result -> {
            devices = result.optJSONArray("devices");
            showSettings();
            say("设备列表已刷新");
        });
    }
    private void showSettings() {
            screen = "settings";
            JSONObject session = store.session();
            page("设置与设备", "管理账户和已连接的设备。");
            TextView account = label(session.optString("username") + "\n" + session.optString("server"), 16);
            account.setPadding(dp(20), dp(20), dp(20), dp(20));
            account.setBackground(ui.shape(ui.surface, 20, 0));
            label("已登记设备 · 启用状态不代表在线", 15);
            if (devices != null) for (int i = 0; i < devices.length(); i++) {
                JSONObject device = devices.optJSONObject(i);
                boolean current = device.optString("id").equals(session.optString("device_id"));
                int deviceStart = root.getChildCount();
                label(device.optString("name") + (current ? "（本机）" : "") + "\n"
                        + (device.optString("kind").equals("mobile") ? "手机" : "电脑") + " · "
                        + (device.optBoolean("active") ? "已启用" : "已禁用"), 16);
                if (device.optBoolean("active")) button("禁用 " + device.optString("name"), 0, () ->
                        new AlertDialog.Builder(this).setTitle("禁用此设备？")
                                .setMessage("该设备的凭据将失效。重新用密码登录可以启用它。")
                                .setNegativeButton("取消", null).setPositiveButton("禁用", (dialog, which) ->
                                        run(() -> api.request("DELETE", "/api/devices/" + ApiClient.encode(device.optString("id")), null), value -> {
                                            if (current) localLogout(); else loadSettings();
                                        })).show());
                LinearLayout card = ui.column();
                card.setBackground(ui.shape(ui.surface, 20, 0));
                card.setPadding(dp(18), dp(18), dp(18), dp(8));
                for (View child : childrenFrom(deviceStart)) {
                    root.removeView(child);
                    card.addView(child);
                }
                root.addView(card, ui.spaced(12));
            }
            button("退出当前账户", R.id.logout, () -> run(() -> { api.logout(); return new JSONObject(); }, value -> localLogout(), error -> {
                if (store.session() == null) { localLogout(); return; }
                new AlertDialog.Builder(this).setTitle("未能确认服务端退出")
                        .setMessage("可重试，或仅清除本机凭据。仅在本机退出不会撤销服务器凭据，也不会取消远端工作。")
                        .setNegativeButton("稍后重试", null).setPositiveButton("仅在本机退出", (dialog, which) -> localLogout()).show();
            }));
    }
    private void localLogout() {
        try { store.saveSession(null); devices = new JSONArray(); showLogin(); }
        catch (Exception error) { say("本机凭据清理失败，请重试。"); }
    }
}
