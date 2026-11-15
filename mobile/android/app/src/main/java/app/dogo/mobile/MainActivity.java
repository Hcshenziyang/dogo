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
import java.util.HashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import io.noties.markwon.Markwon;

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
    private final HashSet<String> expandedMessages = new HashSet<>();
    private Markwon markdown;
    private JSONObject selectedModel, modelCatalog;
    private boolean applyingModel;
    private String autoRetriedId = "";
    private String projectFilterKey = "@all";
    private JSONArray projectOptions = new JSONArray();
    private JSONArray currentEntries = new JSONArray();
    private boolean showingCachedEntries;
    private LinearLayout sessionRows, chatMessages;
    private TextView chatStatus, pendingStatus;
    private EditText chatInput;
    private Button sendButton, retryButton, stopRetryButton;
    private Button projectButton;
    private Button modelButton;
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
        markdown = MarkdownRenderer.create(this);
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
        projectButton = ui.button("全部项目 ▾", false, false);
        projectButton.setId(R.id.project_filter);
        projectButton.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        root.addView(projectButton, ui.spaced(12));
        projectButton.setOnClickListener(v -> chooseProject());
        sessionRows = ui.column();
        root.addView(sessionRows);
        JSONObject cached = remote.cachedList(scope());
        setProjects(cached.optJSONArray("projects"));
        renderSessions(cached.optJSONArray("items"), true);
        if (foreground) refreshSessions();
    }
    private String projectKey(JSONObject project) {
        return project.optString("device") + "\n" + project.optString("workspaceId");
    }
    private void setProjects(JSONArray projects) {
        projectOptions = projects == null ? new JSONArray() : projects;
        String label = projectFilterKey.equals("@ungrouped") ? "未分组" : "全部项目";
        boolean found = projectFilterKey.startsWith("@");
        for (int i = 0; i < projectOptions.length(); i++) {
            JSONObject project = projectOptions.optJSONObject(i);
            if (project != null && projectFilterKey.equals(projectKey(project))) {
                label = project.optString("title", "未命名项目"); found = true; break;
            }
        }
        if (!found) { projectFilterKey = "@all"; label = "全部项目"; }
        projectButton.setText(label + " ▾");
    }
    private void chooseProject() {
        ArrayList<String> labels = new ArrayList<>(), keys = new ArrayList<>();
        labels.add("全部项目"); keys.add("@all");
        labels.add("未分组"); keys.add("@ungrouped");
        for (int i = 0; i < projectOptions.length(); i++) {
            JSONObject project = projectOptions.optJSONObject(i);
            if (project == null) continue;
            labels.add(project.optString("title", "未命名项目") + " · " + project.optString("deviceName", "电脑"));
            keys.add(projectKey(project));
        }
        int selected = Math.max(0, keys.indexOf(projectFilterKey));
        new AlertDialog.Builder(this).setTitle("选择项目")
                .setSingleChoiceItems(labels.toArray(new String[0]), selected, (dialog, which) -> {
                    projectFilterKey = keys.get(which);
                    setProjects(projectOptions);
                    renderSessions(currentEntries, showingCachedEntries);
                    dialog.dismiss();
                }).setNegativeButton("取消", null).show();
    }
    private void renderSessions(JSONArray entries, boolean cached) {
        currentEntries = entries == null ? new JSONArray() : entries;
        showingCachedEntries = cached;
        sessionRows.removeAllViews();
        if (currentEntries.length() == 0) {
            TextView empty = ui.text(cached ? "正在读取会话；已打开过的会话会保留在这里。" : "暂无会话。请先在电脑上打开 DogO 设备插件并创建会话。", 15, ui.muted, false);
            sessionRows.addView(empty, ui.spaced(12));
            return;
        }
        int shown = 0;
        for (int i = 0; i < currentEntries.length(); i++) {
            JSONObject item = currentEntries.optJSONObject(i);
            if (item == null) continue;
            String device = item.optString("device"), session = item.optString("sessionId");
            if (device.isEmpty() || session.isEmpty()) continue;
            String key = device + "\n" + item.optString("workspaceId");
            if (projectFilterKey.equals("@ungrouped") && (!item.optBoolean("projectKnown") || !item.optString("workspaceId").isEmpty())) continue;
            if (!projectFilterKey.startsWith("@") && !projectFilterKey.equals(key)) continue;
            shown++;
            LinearLayout card = ui.column();
            card.setPadding(dp(18), dp(16), dp(18), dp(16));
            card.setBackground(ui.ripple(ui.surface, 18));
            TextView title = ui.text(item.optString("title", "新会话"), 17, ui.text, true);
            card.addView(title, ui.spaced(8));
            String preview = remote.cached(scope(), device, session).optString("preview", item.optString("preview"));
            String excerptText = preview.isEmpty() ? "打开查看最近消息" : markdown.toMarkdown(preview).toString().replace('\n', ' ');
            TextView excerpt = ui.text(excerptText, 14, ui.muted, false);
            excerpt.setMaxLines(2);
            excerpt.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(excerpt, ui.spaced(8));
            String state = cached ? "状态待更新" : item.optBoolean("online") ? "在线" : "离线或状态未知";
            String timestamp = date(item.opt("updatedAt"));
            TextView meta = ui.text(item.optString("projectName", "项目未知") + " · " + item.optString("deviceName", "电脑") + " · " + state + (timestamp.isEmpty() ? "" : " · " + timestamp), 12, ui.muted, false);
            card.addView(meta);
            card.setOnClickListener(v -> openChat(device, session, item.optString("deviceName", "电脑"), item.optString("title", "会话")));
            sessionRows.addView(card, ui.spaced(10));
        }
        if (shown == 0) sessionRows.addView(ui.text("此项目暂无已加载的会话。", 15, ui.muted, false));
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
            setProjects(result.optJSONArray("projects"));
            renderSessions(result.optJSONArray("items"), false);
            say(result.optBoolean("incomplete") ? "部分会话暂时无法读取，可稍后刷新。" : "");
            loadPreview(result.optJSONArray("items"), 0, account);
        }, error -> {
            JSONObject cached = remote.cachedList(account);
            setProjects(cached.optJSONArray("projects"));
            renderSessions(cached.optJSONArray("items"), true);
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
        expandedMessages.clear();
        selectedModel = remote.cached(scope(), device, session).optJSONObject("selection");
        modelCatalog = remote.cachedCatalog(scope(), device);
        if (selectedModel == null && modelCatalog != null) selectedModel = modelCatalog.optJSONObject("default");
        applyingModel = false;
        autoRetriedId = "";
        hostOnline = false; stateKnown = false; sessionRunning = false; renderedMessages = "";
        screen = "chat";
        page(title, name);
        markdown = MarkdownRenderer.create(this);
        root.removeViewAt(0);
        if (!name.isEmpty()) root.removeViewAt(0);
        root.setPadding(dp(16), dp(8), dp(16), dp(16));
        LinearLayout top = (LinearLayout) shell.getChildAt(0);
        top.removeAllViews();
        Button back = ui.button("‹", false, false);
        back.setContentDescription("返回最近会话");
        back.setTextSize(24);
        back.setPadding(0, 0, 0, 0);
        top.addView(back, new LinearLayout.LayoutParams(dp(48), dp(48)));
        back.setOnClickListener(v -> showSessions());
        LinearLayout heading = ui.column();
        heading.setPadding(dp(12), 0, 0, 0);
        TextView chatTitle = ui.text(title, 18, ui.text, true);
        chatTitle.setSingleLine(true); chatTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.addView(chatTitle);
        TextView chatDevice = ui.text(name, 12, ui.muted, false);
        chatDevice.setSingleLine(true); chatDevice.setEllipsize(android.text.TextUtils.TruncateAt.END);
        heading.addView(chatDevice);
        top.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        chatStatus = ui.text("电脑状态待更新 · 会话状态未知", 12, ui.muted, false);
        pendingStatus = label("", 13);
        pendingStatus.setTextColor(ui.muted);
        pendingStatus.setTextIsSelectable(true);
        chatMessages = ui.column();
        root.addView(chatMessages, ui.spaced(10));
        LinearLayout composer = ui.column();
        composer.setPadding(dp(16), dp(8), dp(16), dp(12));
        composer.setBackgroundColor(ui.surface);
        composer.addView(chatStatus, ui.spaced(6));
        modelButton = ui.button("选择模型与思考强度 ▾", false, false);
        modelButton.setId(R.id.model_button);
        modelButton.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        composer.addView(modelButton, ui.spaced(6));
        modelButton.setOnClickListener(v -> loadModels());
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
            String id = item.optString("id", "index-" + i) + ":" + role;
            LinearLayout card = ui.column();
            card.setPadding(dp(16), dp(14), dp(16), dp(10));
            card.setBackground(ui.shape(role.equals("user") ? ui.tint : ui.surface, 16, 0));
            TextView who = ui.text(role.equals("user") ? "你" : role.equals("assistant") ? "AI" : "进度", 12, ui.muted, true);
            TextView body = ui.text("", 15, ui.text, false);
            body.setTextIsSelectable(true);
            if (role.equals("status")) body.setText(text); else markdown.setMarkdown(body, text);
            body.setMaxLines(expandedMessages.contains(id) ? Integer.MAX_VALUE : 8);
            body.setEllipsize(android.text.TextUtils.TruncateAt.END);
            Button expand = ui.button(expandedMessages.contains(id) ? "收起" : "展开", false, false);
            expand.setId(R.id.expand_message);
            expand.setMinHeight(dp(40)); expand.setMinimumHeight(dp(40));
            expand.setPadding(dp(10), dp(4), dp(10), dp(4));
            expand.setTextSize(13);
            boolean likelyLong = text.length() > 240 || text.chars().filter(c -> c == '\n').count() >= 8;
            expand.setVisibility(expandedMessages.contains(id) || likelyLong ? View.VISIBLE : View.GONE);
            expand.setOnClickListener(v -> {
                if (expandedMessages.remove(id)) { body.setMaxLines(8); expand.setText("展开"); }
                else { expandedMessages.add(id); body.setMaxLines(Integer.MAX_VALUE); expand.setText("收起"); }
            });
            LinearLayout header = ui.row();
            header.addView(who, new LinearLayout.LayoutParams(0, -2, 1));
            header.addView(expand, new LinearLayout.LayoutParams(-2, -2));
            card.addView(header, ui.spaced(8));
            card.addView(body, ui.spaced(4));
            body.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
                android.text.Layout layout = body.getLayout();
                int lines = layout == null ? 0 : layout.getLineCount();
                if (lines > 8 || (lines == 8 && (layout.getEllipsisCount(7) > 0 || layout.getLineEnd(7) < body.length())))
                    expand.setVisibility(View.VISIBLE);
            });
            chatMessages.addView(card, ui.spaced(10));
        }
        TextView note = ui.text("显示电脑返回的最近消息。", 12, ui.muted, false);
        chatMessages.addView(note);
        if (atBottom) pageScroll.post(() -> pageScroll.fullScroll(View.FOCUS_DOWN));
    }
    private void updateChatControls() {
        if (!screen.equals("chat") || chatInput == null) return;
        JSONObject cached = remote.cached(scope(), selectedDevice, selectedSession);
        JSONObject pending = cached.optJSONObject("pending");
        String status = (hostOnline ? "电脑在线" : "电脑离线或连接未知") + " · "
                + (!stateKnown ? "会话状态未知" : sessionRunning ? "正在执行" : "可以继续");
        if (pending != null) status += " · 消息待确认";
        else if (cached.optBoolean("accepted")) status += " · 电脑已收到上一条消息";
        chatStatus.setText(status);
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
        String model = selectedModel == null ? "" : selectedModel.optString("model");
        String effort = selectedModel == null ? "" : selectedModel.optString("reasoningEffort");
        for (JSONObject option : RemoteSessions.modelOptions(modelCatalog)) {
            if (!option.optString("provider").equals(selectedModel == null ? "" : selectedModel.optString("provider"))
                    || !option.optString("model").equals(model)) continue;
            model = option.optString("label", model);
            JSONObject reasoning = option.optJSONObject("reasoning");
            JSONArray efforts = reasoning == null ? null : reasoning.optJSONArray("efforts");
            if (efforts != null) for (int i = 0; i < efforts.length(); i++) {
                JSONObject choice = efforts.optJSONObject(i);
                if (choice != null && choice.optString("id").equals(effort)) { effort = choice.optString("name", effort); break; }
            }
            break;
        }
        modelButton.setText(model.isEmpty() ? "选择模型与思考强度 ▾" : model + (effort.isEmpty() ? "" : " · " + effort) + " ▾");
        modelButton.setEnabled(foreground && hostOnline && stateKnown && pending == null && !applyingModel);
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
            if (result.optBoolean("archived")) {
                showSessions(); say("该会话已在电脑上归档，已从手机列表隐藏。"); return;
            }
            hostOnline = result.optBoolean("online"); stateKnown = result.optBoolean("known");
            sessionRunning = result.optBoolean("running");
            if (!applyingModel && result.optJSONObject("selection") != null) selectedModel = result.optJSONObject("selection");
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
    private void loadModels() {
        if (!foreground || !screen.equals("chat") || !hostOnline || !stateKnown) return;
        if (remoteInFlight) { say("正在刷新会话，请稍后选择模型。"); return; }
        main.removeCallbacks(poll);
        String account = scope(), device = selectedDevice;
        say("正在读取电脑的模型列表…");
        background(() -> {
            JSONObject catalog = remote.remote(device, "models", new JSONObject());
            remote.cacheCatalog(account, device, catalog);
            return catalog;
        }, catalog -> {
            say(""); modelCatalog = catalog;
            if (selectedModel == null) selectedModel = catalog.optJSONObject("default");
            updateChatControls();
            showModelDialog(catalog);
        }, error -> {
            say("无法读取电脑的模型列表，请检查电脑连接后重试。");
            updateChatControls();
            if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
        });
        updateChatControls();
    }
    private void showModelDialog(JSONObject catalog) {
        ArrayList<JSONObject> models = RemoteSessions.modelOptions(catalog);
        if (models.isEmpty()) {
            say("电脑没有返回可用模型，请在电脑端检查模型配置。");
            if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
            return;
        }
        JSONObject current = selectedModel != null ? selectedModel : catalog.optJSONObject("default");
        int currentIndex = 0;
        boolean currentFound = false;
        ArrayList<String> names = new ArrayList<>();
        for (int i = 0; i < models.size(); i++) {
            JSONObject model = models.get(i);
            names.add(model.optString("label"));
            if (current != null && current.optString("provider").equals(model.optString("provider"))
                    && current.optString("model").equals(model.optString("model"))) { currentIndex = i; currentFound = true; }
        }
        if (current != null && !current.optString("model").isEmpty() && !currentFound) {
            String unavailable = "当前不可用：" + current.optString("provider") + " / " + current.optString("model");
            models.add(0, Json.of("provider", current.optString("provider"), "model", current.optString("model"), "label", unavailable, "unavailable", true));
            names.add(0, unavailable);
            currentIndex = 0;
        }
        LinearLayout content = ui.column();
        content.setPadding(dp(24), dp(8), dp(24), dp(8));
        TextView modelLabel = ui.text("执行模型", 13, ui.muted, true);
        content.addView(modelLabel, ui.spaced(8));
        Spinner modelPicker = new Spinner(this);
        modelPicker.setId(R.id.model_spinner);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, names);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        modelPicker.setAdapter(adapter);
        modelPicker.setBackground(ui.spinnerBackground());
        modelPicker.setPadding(dp(12), dp(8), dp(36), dp(8));
        content.addView(modelPicker, new LinearLayout.LayoutParams(-1, dp(52)));
        TextView effortLabel = ui.text("思考强度", 13, ui.muted, true);
        effortLabel.setPadding(0, dp(16), 0, dp(8));
        content.addView(effortLabel);
        Spinner effortPicker = new Spinner(this);
        effortPicker.setId(R.id.effort_spinner);
        effortPicker.setBackground(ui.spinnerBackground());
        effortPicker.setPadding(dp(12), dp(8), dp(36), dp(8));
        content.addView(effortPicker, new LinearLayout.LayoutParams(-1, dp(52)));
        TextView noEfforts = ui.text("此模型没有可选的思考强度", 13, ui.muted, false);
        content.addView(noEfforts, ui.spaced(8));
        TextView note = ui.text("会同步修改电脑的默认模型，从下次发送开始生效。", 12, ui.muted, false);
        note.setPadding(0, dp(14), 0, 0);
        content.addView(note);
        ArrayList<String> effortIds = new ArrayList<>();
        JSONObject chosen = current;
        modelPicker.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onNothingSelected(AdapterView<?> parent) {}
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                JSONObject option = models.get(position), reasoning = option.optJSONObject("reasoning");
                JSONArray efforts = reasoning == null ? null : reasoning.optJSONArray("efforts");
                ArrayList<String> effortNames = new ArrayList<>();
                effortIds.clear();
                String fallback = reasoning == null ? "" : reasoning.optString("defaultEffort", "");
                if (fallback.isEmpty()) { effortIds.add(""); effortNames.add("模型默认"); }
                if (efforts != null) for (int i = 0; i < efforts.length(); i++) {
                    JSONObject item = efforts.optJSONObject(i);
                    if (item == null || item.optString("id").isEmpty()) continue;
                    effortIds.add(item.optString("id"));
                    effortNames.add(item.optString("name", item.optString("id")));
                }
                boolean supported = efforts != null && efforts.length() > 0 && !effortNames.isEmpty();
                effortLabel.setVisibility(supported ? View.VISIBLE : View.GONE);
                effortPicker.setVisibility(supported ? View.VISIBLE : View.GONE);
                noEfforts.setText(option.optBoolean("unavailable") ? "请另选电脑当前可用的模型。" : "此模型没有可选的思考强度");
                noEfforts.setVisibility(supported ? View.GONE : View.VISIBLE);
                ArrayAdapter<String> effortAdapter = new ArrayAdapter<>(MainActivity.this, android.R.layout.simple_spinner_item, effortNames);
                effortAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
                effortPicker.setAdapter(effortAdapter);
                String selected = chosen != null && chosen.optString("provider").equals(option.optString("provider"))
                        && chosen.optString("model").equals(option.optString("model"))
                        ? chosen.optString("reasoningEffort", fallback) : fallback;
                int index = effortIds.indexOf(selected);
                if (index >= 0) effortPicker.setSelection(index);
            }
        });
        modelPicker.setSelection(currentIndex);
        int version = generation;
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("模型与思考强度").setView(content)
                .setNegativeButton("取消", null).setPositiveButton("应用", null).create();
        dialog.setOnDismissListener(ignored -> {
            if (!applyingModel && foreground && version == generation && screen.equals("chat")) {
                main.removeCallbacks(poll); main.postDelayed(poll, 4000);
            }
        });
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            if (remoteInFlight || applyingModel) return;
            int index = modelPicker.getSelectedItemPosition();
            if (index < 0 || index >= models.size()) return;
            JSONObject option = models.get(index);
            if (option.optBoolean("unavailable")) { noEfforts.setText("请先选择电脑当前可用的模型。"); return; }
            JSONObject args = Json.of("sessionId", selectedSession, "provider", option.optString("provider"), "model", option.optString("model"));
            int effortIndex = effortPicker.getSelectedItemPosition();
            if (effortPicker.getVisibility() == View.VISIBLE && effortIndex >= 0 && effortIndex < effortIds.size()
                    && !effortIds.get(effortIndex).isEmpty()) Json.put(args, "reasoningEffort", effortIds.get(effortIndex));
            String account = scope(), device = selectedDevice, session = selectedSession;
            applyingModel = true;
            dialog.dismiss();
            say("正在同步模型选择…");
            background(() -> {
                JSONObject result = remote.remote(device, "selectModel", args);
                JSONObject selected = result.optJSONObject("selected");
                if (selected == null) throw new IllegalStateException("电脑未确认模型选择");
                remote.selection(account, device, session, selected);
                return selected;
            }, result -> {
                selectedModel = result; applyingModel = false;
                say("模型已更新，下次发送生效。"); updateChatControls();
                if (foreground && screen.equals("chat")) main.postDelayed(poll, 4000);
            }, error -> {
                applyingModel = false; stateKnown = false; updateChatControls();
                say("暂未确认模型是否更新，请刷新后重试。");
                if (foreground && screen.equals("chat")) main.postDelayed(poll, 1000);
            });
            updateChatControls();
        }));
        dialog.show();
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
