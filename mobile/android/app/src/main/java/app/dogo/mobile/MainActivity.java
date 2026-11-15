package app.dogo.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.Editable;
import android.text.TextWatcher;
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
    private RemoteSessions remote;
    private LinearLayout root, shell;
    private ScrollView pageScroll;
    private MobileUi ui;
    private TextView message;
    private boolean busy, destroyed;
    private String screen = "login";
    private int generation;
    private JSONArray devices = new JSONArray();
    private boolean foreground, remoteInFlight;
    private String selectedDevice = "", selectedSession = "", selectedName = "", selectedTitle = "";
    private boolean hostOnline, stateKnown, sessionRunning;
    private String renderedMessages = "";
    private String autoRetriedId = "";
    private LinearLayout sessionRows, chatMessages;
    private TextView chatStatus, pendingStatus;
    private EditText chatInput;
    private Button sendButton, retryButton, stopRetryButton;
    private final Runnable poll = () -> { if (foreground && screen.equals("chat")) refreshChat(); };
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
            remote = application.remote;
            worker = application.worker;
            store.removeMemoDrafts();
            if (store.session() == null) showLogin(); else showSessions();
        } catch (Exception error) {
            page("本机数据无法读取", "请保留应用数据后排查；当前没有覆盖原文件。");
            label("无法解密或读取本机数据。", 16);
        }
    }
    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (api == null || busy || store.session() == null) return;
        if (screen.equals("settings")) loadSettings();
        else if (screen.equals("sessions")) refreshSessions();
        else if (screen.equals("chat")) refreshChat();
    }
    @Override protected void onPause() {
        foreground = false;
        main.removeCallbacks(poll);
        super.onPause();
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
        if (screen.equals("chat") || screen.equals("settings")) showSessions();
        else moveTaskToBack(true);
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
        pageScroll = scroll;
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
    private String scope() {
        JSONObject session = store.session();
        return SecureStore.scope(session.optString("server"), session.optString("username").toLowerCase(java.util.Locale.ROOT));
    }
    private void background(Job job, Done done, Failed failed) {
        if (remoteInFlight || destroyed) return;
        remoteInFlight = true;
        int version = generation;
        worker.execute(() -> {
            JSONObject result = null;
            Exception error = null;
            try { result = job.run(); } catch (Exception e) { error = e; }
            JSONObject value = result;
            Exception problem = error;
            main.post(() -> {
                remoteInFlight = false;
                if (destroyed) return;
                if (version != generation) {
                    if (foreground && screen.equals("chat")) refreshChat();
                    else if (foreground && screen.equals("sessions")) refreshSessions();
                    return;
                }
                if (problem == null) done.accept(value); else failed.accept(problem);
            });
        });
    }
    private void showSessions() {
        if (store.session() == null) { showLogin(); return; }
        screen = "sessions";
        main.removeCallbacks(poll);
        page("最近会话", "继续电脑上已有的对话。");
        LinearLayout actions = ui.row();
        Button refresh = ui.button("刷新", false, false);
        Button settings = ui.button("设置与设备", false, false);
        actions.addView(refresh, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams right = new LinearLayout.LayoutParams(0, -2, 1);
        right.leftMargin = dp(8);
        actions.addView(settings, right);
        root.addView(actions, ui.spaced(18));
        refresh.setOnClickListener(v -> refreshSessions());
        settings.setOnClickListener(v -> loadSettings());
        sessionRows = ui.column();
        root.addView(sessionRows);
        renderSessions(remote.cachedList(scope()).optJSONArray("items"), true);
        if (foreground) refreshSessions();
    }
    private void renderSessions(JSONArray entries, boolean cached) {
        sessionRows.removeAllViews();
        if (entries == null || entries.length() == 0) {
            TextView empty = ui.text(cached ? "正在读取会话；已打开过的会话会保留在这里。" : "暂无会话。请先在电脑上打开 DogO 设备插件并创建会话。", 15, ui.muted, false);
            sessionRows.addView(empty, ui.spaced(12));
            return;
        }
        for (int i = 0; i < entries.length(); i++) {
            JSONObject item = entries.optJSONObject(i);
            if (item == null) continue;
            String device = item.optString("device"), session = item.optString("sessionId");
            if (device.isEmpty() || session.isEmpty()) continue;
            LinearLayout card = ui.column();
            card.setPadding(dp(18), dp(16), dp(18), dp(16));
            card.setBackground(ui.ripple(ui.surface, 18));
            TextView title = ui.text(item.optString("title", "新会话"), 17, ui.text, true);
            card.addView(title, ui.spaced(8));
            String preview = remote.cached(scope(), device, session).optString("preview", item.optString("preview"));
            TextView excerpt = ui.text(preview.isEmpty() ? "打开查看最近消息" : preview.replace('\n', ' '), 14, ui.muted, false);
            excerpt.setMaxLines(2);
            excerpt.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(excerpt, ui.spaced(8));
            String state = cached ? "状态待更新" : item.optBoolean("online") ? "在线" : "离线或状态未知";
            String timestamp = date(item.opt("updatedAt"));
            TextView meta = ui.text(item.optString("deviceName", "电脑") + " · " + state + (timestamp.isEmpty() ? "" : " · " + timestamp), 12, ui.muted, false);
            card.addView(meta);
            card.setOnClickListener(v -> openChat(device, session, item.optString("deviceName", "电脑"), item.optString("title", "会话")));
            sessionRows.addView(card, ui.spaced(10));
        }
    }
    private String date(Object value) {
        try {
            java.time.Instant instant;
            if (value instanceof Number) {
                long n = ((Number) value).longValue();
                instant = java.time.Instant.ofEpochMilli(n < 1000000000000L ? n * 1000 : n);
            } else instant = java.time.Instant.parse(String.valueOf(value));
            return java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(java.time.ZoneId.systemDefault()).format(instant);
        } catch (Exception ignored) { return ""; }
    }
    private void refreshSessions() {
        if (!foreground || !screen.equals("sessions") || remoteInFlight || busy) return;
        String account = scope();
        say("正在更新会话…");
        background(() -> remote.list(account), result -> {
            renderSessions(result.optJSONArray("items"), false);
            say(result.optBoolean("incomplete") ? "部分会话暂时无法读取，可稍后刷新。" : "");
            loadPreview(result.optJSONArray("items"), 0, account);
        }, error -> {
            renderSessions(remote.cachedList(account).optJSONArray("items"), true);
            say("暂时无法连接服务，显示已保存的会话。");
            if (store.session() == null) { showLogin(); say("登录已失效，请重新登录。"); }
        });
    }
    private void loadPreview(JSONArray entries, int start, String account) {
        if (!foreground || !screen.equals("sessions") || remoteInFlight || entries == null || start >= Math.min(entries.length(), 8)) return;
        JSONObject item = entries.optJSONObject(start);
        if (item == null || !item.optBoolean("online") || !remote.cached(account, item.optString("device"), item.optString("sessionId")).optString("preview").isEmpty()) {
            loadPreview(entries, start + 1, account); return;
        }
        background(() -> Json.of("preview", remote.preview(account, item.optString("device"), item.optString("sessionId"))), value -> {
            renderSessions(entries, false);
            loadPreview(entries, start + 1, account);
        }, error -> loadPreview(entries, start + 1, account));
    }
    private void openChat(String device, String session, String name, String title) {
        selectedDevice = device; selectedSession = session; selectedName = name; selectedTitle = title;
        autoRetriedId = "";
        hostOnline = false; stateKnown = false; sessionRunning = false; renderedMessages = "";
        screen = "chat";
        page(title, name);
        button("‹ 最近会话", 0, this::showSessions);
        chatStatus = label("电脑状态待更新 · 会话状态未知", 13);
        chatStatus.setTextColor(ui.muted);
        pendingStatus = label("", 13);
        pendingStatus.setTextColor(ui.muted);
        pendingStatus.setTextIsSelectable(true);
        chatMessages = ui.column();
        root.addView(chatMessages, ui.spaced(10));
        LinearLayout composer = ui.column();
        composer.setPadding(dp(16), dp(8), dp(16), dp(12));
        composer.setBackgroundColor(ui.surface);
        chatInput = new EditText(this);
        chatInput.setId(R.id.chat_input);
        chatInput.setSaveEnabled(false);
        chatInput.setHint("写下接下来要说的话");
        chatInput.setTextSize(16);
        chatInput.setTextColor(ui.text);
        chatInput.setHintTextColor(ui.muted);
        chatInput.setBackground(ui.inputBackground());
        chatInput.setPadding(dp(14), dp(10), dp(14), dp(10));
        chatInput.setMinLines(2); chatInput.setMaxLines(5);
        chatInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        JSONObject cached = remote.cached(scope(), device, session);
        chatInput.setText(cached.optString("draft"));
        composer.addView(chatInput, ui.spaced(8));
        LinearLayout buttons = ui.row();
        retryButton = ui.button("重新确认", false, false);
        retryButton.setId(R.id.retry_message);
        sendButton = ui.button("发送", true, false);
        sendButton.setId(R.id.send_message);
        buttons.addView(retryButton, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams sendLayout = new LinearLayout.LayoutParams(0, -2, 1);
        sendLayout.leftMargin = dp(8);
        buttons.addView(sendButton, sendLayout);
        composer.addView(buttons);
        stopRetryButton = ui.button("停止确认这条消息", false, false);
        composer.addView(stopRetryButton, ui.spaced(0));
        shell.addView(composer);
        chatInput.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                try { remote.draft(scope(), device, session, s.toString()); }
                catch (Exception error) { say("草稿未能保存，请先复制内容。"); }
                updateChatControls();
            }
            public void afterTextChanged(Editable value) {}
        });
        sendButton.setOnClickListener(v -> sendMessage(false));
        retryButton.setOnClickListener(v -> sendMessage(true));
        stopRetryButton.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("停止确认这条消息？")
                .setMessage("电脑可能已经执行了这条消息。停止确认不会撤销或停止电脑上的工作；原文会保存在本机供复制。")
                .setNegativeButton("返回", null).setPositiveButton("停止确认", (dialog, which) -> {
                    try { remote.stopConfirming(scope(), device, session); autoRetriedId = ""; updateChatControls(); }
                    catch (Exception error) { say("未能保存消息备份，请重试。"); }
                }).show());
        renderChat(cached.optJSONArray("messages"));
        updateChatControls();
        if (foreground) refreshChat();
    }
    private void renderChat(JSONArray messages) {
        String next = messages == null ? "" : messages.toString();
        if (next.equals(renderedMessages)) return;
        boolean atBottom = renderedMessages.isEmpty()
                || pageScroll.getScrollY() + pageScroll.getHeight() >= root.getHeight() - dp(80);
        renderedMessages = next;
        chatMessages.removeAllViews();
        if (messages == null || messages.length() == 0) {
            chatMessages.addView(ui.text("暂无已加载的消息。", 14, ui.muted, false)); return;
        }
        for (int i = 0; i < messages.length(); i++) {
            JSONObject item = messages.optJSONObject(i);
            if (item == null) continue;
            String role = item.optString("role"), text = item.optString("text");
            TextView bubble = ui.text((role.equals("user") ? "你" : role.equals("assistant") ? "AI" : "进度") + "\n" + text,
                    15, ui.text, false);
            bubble.setTextIsSelectable(true);
            bubble.setPadding(dp(16), dp(14), dp(16), dp(14));
            bubble.setBackground(ui.shape(role.equals("user") ? ui.tint : ui.surface, 16, 0));
            chatMessages.addView(bubble, ui.spaced(10));
        }
        TextView note = ui.text("显示电脑返回的最近消息。", 12, ui.muted, false);
        chatMessages.addView(note);
        if (atBottom) pageScroll.post(() -> pageScroll.fullScroll(View.FOCUS_DOWN));
    }
    private void updateChatControls() {
        if (!screen.equals("chat") || chatInput == null) return;
        JSONObject cached = remote.cached(scope(), selectedDevice, selectedSession);
        JSONObject pending = cached.optJSONObject("pending");
        chatStatus.setText((hostOnline ? "电脑在线" : "电脑离线或连接未知") + " · "
                + (!stateKnown ? "会话状态未知" : sessionRunning ? "正在执行" : "可以继续"));
        StringBuilder notice = new StringBuilder();
        if (pending != null) notice.append("发送结果未确认，原消息已保存：\n").append(pending.optString("text"));
        else if (cached.optBoolean("accepted")) notice.append("电脑已收到上一条消息");
        JSONArray archives = cached.optJSONArray("unconfirmed_archive");
        if (archives != null) for (int i = 0; i < archives.length(); i++) {
            JSONObject saved = archives.optJSONObject(i);
            if (saved == null) continue;
            if (notice.length() > 0) notice.append("\n\n");
            notice.append("已停止确认的消息（可复制原文）：\n").append(saved.optString("text"));
        }
        pendingStatus.setText(notice.toString());
        pendingStatus.setVisibility(notice.length() > 0 ? View.VISIBLE : View.GONE);
        boolean ready = foreground && hostOnline && stateKnown && !sessionRunning && !remoteInFlight;
        sendButton.setEnabled(ready && pending == null && !chatInput.getText().toString().trim().isEmpty());
        retryButton.setVisibility(pending == null ? View.GONE : View.VISIBLE);
        retryButton.setEnabled(ready && pending != null);
        stopRetryButton.setVisibility(pending == null ? View.GONE : View.VISIBLE);
        stopRetryButton.setEnabled(!remoteInFlight);
    }
    private void refreshChat() {
        if (!foreground || !screen.equals("chat") || remoteInFlight || busy) return;
        String account = scope(), device = selectedDevice, session = selectedSession;
        background(() -> remote.detail(account, device, session), result -> {
            hostOnline = result.optBoolean("online"); stateKnown = result.optBoolean("known");
            sessionRunning = result.optBoolean("running");
            if (result.has("messages")) renderChat(result.optJSONArray("messages"));
            updateChatControls();
            JSONObject pending = remote.cached(account, device, session).optJSONObject("pending");
            if (!hostOnline) autoRetriedId = "";
            if (pending != null && foreground && hostOnline && stateKnown && !sessionRunning
                    && !pending.optString("requestId").equals(autoRetriedId)) {
                autoRetriedId = pending.optString("requestId");
                sendMessage(true);
                return;
            }
            if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
        }, error -> {
            hostOnline = false; stateKnown = false; autoRetriedId = ""; updateChatControls();
            if (store.session() == null) { showLogin(); say("登录已失效，请重新登录。"); return; }
            if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
        });
        updateChatControls();
    }
    private void sendMessage(boolean retry) {
        if (remoteInFlight || !foreground || !hostOnline || !stateKnown || sessionRunning) return;
        String account = scope(), device = selectedDevice, session = selectedSession;
        if (!retry) {
            try {
                remote.prepare(account, device, session, chatInput.getText().toString());
                chatInput.setText("");
            } catch (Exception error) { say(error instanceof IllegalArgumentException ? error.getMessage() : "消息未能保存，请复制后重试。"); return; }
        }
        main.removeCallbacks(poll);
        background(() -> {
            JSONObject current = remote.detail(account, device, session);
            if (!current.optBoolean("online") || !current.optBoolean("known") || current.optBoolean("running"))
                throw new IllegalStateException("电脑暂时无法接收");
            return remote.retry(account, device, session);
        }, result -> { stateKnown = false; updateChatControls(); refreshChat(); }, error -> {
            JSONObject pending = remote.cached(account, device, session).optJSONObject("pending");
            autoRetriedId = retry && pending != null ? pending.optString("requestId") : "";
            stateKnown = false; updateChatControls();
            say("尚未确认电脑是否收到；请在会话空闲时重新确认。原消息和请求编号已保留。");
            if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
        });
        updateChatControls();
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
                devices = new JSONArray(); showSessions();
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
            button("‹ 最近会话", 0, this::showSessions);
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
