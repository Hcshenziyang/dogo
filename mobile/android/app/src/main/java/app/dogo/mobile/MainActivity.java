package app.dogo.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
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
    private LinearLayout root, shell, dock;
    private MobileUi ui;
    private TextView message;
    private boolean busy, rendering, destroyed;
    private String screen = "login", projectFilter = "", cursor = "";
    private int generation;
    private final List<JSONObject> memos = new ArrayList<>();
    private JSONArray devices = new JSONArray();
    private JSONObject selected;
    private EditorDraft draft;
    private EditText content, project, category, tags, instruction;
    private CheckBox active, dispatch;
    private Spinner target, planMode, planTarget, planWeekday, planMonthDay;
    private EditText planInstruction, planDate, planTime;
    private CheckBox planPresent, planEnabled;
    private Button planDatePicker, planRefresh;
    private final List<String> targetIds = new ArrayList<>(), planTargetIds = new ArrayList<>();
    private final Runnable saveDraftLater = () -> persistDraft(false);
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
            if (store.session() == null) showLogin(); else loadMemos(true);
        } catch (Exception error) {
            page("本机数据无法读取", "请保留应用数据后排查；当前没有覆盖原文件。");
            label("无法解密或读取本机凭据与草稿。", 16);
        }
    }
    @Override protected void onResume() {
        super.onResume();
        if (api == null || busy || store.session() == null) return;
        if (screen.equals("list")) loadMemos(true);
        else if (screen.equals("detail") && selected != null) loadMemo(selected.optString("id"));
    }
    @Override protected void onStop() {
        if (screen.equals("editor")) persistDraft(false);
        super.onStop();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        main.removeCallbacks(saveDraftLater);
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
        if (screen.equals("editor") && !persistDraft(true)) return;
        if (screen.equals("login") || screen.equals("list")) moveTaskToBack(true);
        else loadMemos(true);
    }

    private int dp(int value) { return ui.dp(value); }
    private void page(String title, String subtitle) {
        View focused = getCurrentFocus();
        if (focused != null) ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(focused.getWindowToken(), 0);
        generation++;
        rendering = true;
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
        TextView caption = ui.text("随手记 · 随处继续", 12, ui.muted, false);
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
        dock = ui.column();
        dock.setPadding(dp(24), dp(10), dp(24), dp(12));
        dock.setVisibility(View.GONE);
        shell.addView(dock);
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
        rendering = false;
    }
    private TextView label(String text, int size) {
        TextView view = ui.text(text, size, ui.text, false);
        root.addView(view, ui.spaced(size >= 28 ? 10 : 14));
        return view;
    }
    private Button button(String title, int id, Runnable action) {
        boolean primary = id == R.id.login || id == R.id.save || id == R.id.new_memo || id == R.id.edit;
        boolean destructive = id == R.id.delete || id == R.id.logout || title.startsWith("放弃") || title.startsWith("禁用 ");
        Button button = ui.button(title, primary, destructive);
        if (id != 0) button.setId(id);
        if (id == R.id.save) {
            dock.setVisibility(View.VISIBLE);
            dock.addView(button, new LinearLayout.LayoutParams(-1, -2));
        } else root.addView(button, ui.spaced(10));
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
        input.setSaveEnabled(false); // Drafts and credentials have an explicit encrypted persistence path.
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
        if (multiline) { input.setMinLines(id == R.id.content ? 7 : 3); input.setGravity(android.view.Gravity.TOP); }
        input.setHint(id == R.id.content ? "一个想法、一段摘录，或者今天的小事…" : "请输入" + title.replace("（选填）", ""));
        root.addView(input, ui.spaced(18));
        return input;
    }
    private CheckBox check(String title, boolean value) {
        CheckBox box = new CheckBox(this);
        box.setText(title);
        box.setTextSize(15);
        box.setTextColor(ui.text);
        box.setButtonTintList(android.content.res.ColorStateList.valueOf(ui.accent));
        box.setPadding(0, dp(8), 0, dp(8));
        box.setMinHeight(dp(48));
        box.setChecked(value);
        root.addView(box, ui.spaced(8));
        return box;
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
    private void navigation(boolean settings) {
        dock.setVisibility(View.VISIBLE);
        LinearLayout row = ui.row();
        row.setBackground(ui.shape(ui.surface, 22, ui.line));
        row.setPadding(dp(6), dp(6), dp(6), dp(6));
        Button notes = ui.button("备忘录", false, false);
        notes.setId(settings ? R.id.back : View.NO_ID);
        notes.setBackground(ui.ripple(settings ? ui.surface : ui.tint, 16));
        notes.setOnClickListener(v -> { if (!busy && settings) loadMemos(true); });
        Button devices = ui.button("设备与设置", false, false);
        devices.setId(R.id.settings);
        devices.setBackground(ui.ripple(settings ? ui.tint : ui.surface, 16));
        devices.setOnClickListener(v -> { if (!busy && !settings) loadSettings(); });
        row.addView(notes, new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(devices, new LinearLayout.LayoutParams(0, -2, 1));
        dock.addView(row);
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
                if (screen.equals("editor") && draft != null && draft.pending()) lockEditor();
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
                say("登录已失效，请重新登录；本地草稿仍保留。");
            } else say(errorText(response));
        } else if (error instanceof IllegalArgumentException) say(error.getMessage());
        else say("请求未完成，请检查网络或本机存储后重试；已有草稿不会被清除。");
    }
    private String errorText(ApiClient.ApiException error) {
        switch (error.code) {
            case "revision_conflict": return "内容版本已变化，请核对最新内容；本地输入仍保留。";
            case "dispatch_in_flight": return "指令已发送、尚未确认，暂不能删除或修改相关计划。";
            case "device_unavailable": return "目标设备不可用，请选择已启用的电脑。";
            case "memo_inactive": return "附带指令时，备忘录必须启用。";
            case "memo_deleted": return "这条备忘录已被删除；本地输入仍保留。";
            case "request_id_reused": return "原请求标识已有不同内容，请先核对服务器记录。";
            case "redirect_refused": return "服务器返回了重定向，请填写最终服务器地址。";
            case "invalid_plan": return "请检查定时计划的时间和设备。";
            case "memo_too_large": return "追加后的正文超出服务器限制。";
            default: return error.status == 422 ? "提交字段不符合接口限制，请检查正文、标签及设备。"
                    : "请求未完成（" + error.status + " / " + error.code + "）";
        }
    }
    private void showLogin() {
        screen = "login";
        page("连接你的服务", "把零散的想法，留在同一个地方。");
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
                projectFilter = ""; cursor = ""; draft = null; selected = null;
                memos.clear(); devices = new JSONArray(); loadMemos(true);
            });
        });
        label("使用已有 DogO 账户登录", 12).setTextColor(ui.muted);
    }
    private String draftKey() {
        JSONObject session = store.session();
        if (session == null) throw new IllegalStateException("请先登录");
        return "draft:" + SecureStore.scope(session.optString("server"), session.optString("username"));
    }
    private void loadMemos(boolean reset) {
        if (store.session() == null) { showLogin(); return; }
        screen = "list";
        if (reset) { memos.clear(); cursor = ""; }
        renderList();
        String query = "/api/memos?limit=30" + (projectFilter.isEmpty() ? "" : "&project=" + ApiClient.encode(projectFilter))
                + (reset || cursor.isEmpty() ? "" : "&cursor=" + ApiClient.encode(cursor));
        run(() -> api.request("GET", query, null), result -> {
            if (reset) memos.clear();
            JSONArray items = result.optJSONArray("items");
            if (items != null) for (int i = 0; i < items.length(); i++) memos.add(items.optJSONObject(i));
            cursor = result.isNull("next_cursor") ? "" : result.optString("next_cursor");
            renderList();
            say(memos.isEmpty() ? "" : "已同步 · " + memos.size() + " 条备忘录");
        });
    }
    private void renderList() {
        page("备忘录", "把现在的灵感，留给下一步。");
        Button create = button("＋ 记录", R.id.new_memo, () -> startEditor(EditorDraft.create()));
        View heading = root.getChildAt(0);
        root.removeView(heading);
        root.removeView(create);
        LinearLayout titleRow = ui.row();
        titleRow.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        titleRow.addView(create, new LinearLayout.LayoutParams(-2, -2));
        root.addView(titleRow, 0, ui.spaced(14));
        if (store.get(draftKey()) != null) button("继续本地草稿", 0, () -> {
            draft = new EditorDraft(store.get(draftKey()));
            prepareEditor();
        });
        EditText filter = field("按项目查看", projectFilter, R.id.project_filter, false);
        filter.setHint("全部项目");
        Button refresh = button("筛选 / 刷新", 0, () -> { projectFilter = filter.getText().toString().trim(); loadMemos(true); });
        root.removeView(filter);
        root.removeView(refresh);
        LinearLayout filters = ui.row();
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(0, dp(52), 1);
        inputParams.setMarginEnd(dp(8));
        filters.addView(filter, inputParams);
        filters.addView(refresh, new LinearLayout.LayoutParams(-2, dp(52)));
        root.addView(filters, ui.spaced(22));
        if (memos.isEmpty()) {
            LinearLayout empty = ui.column();
            empty.setPadding(dp(24), dp(36), dp(24), dp(36));
            empty.setBackground(ui.shape(ui.surface, 24, 0));
            TextView icon = ui.text("＋", 32, ui.accent, false);
            empty.addView(icon, ui.spaced(18));
            empty.addView(ui.text(projectFilter.isEmpty() ? "从一条记录开始" : "这个项目还没有记录", 20, ui.text, true), ui.spaced(12));
            empty.addView(ui.text("随手记下想法、链接或待办。\n需要时，再交给电脑处理。", 14, ui.muted, false));
            root.addView(empty, ui.spaced(16));
        }
        for (JSONObject memo : memos) memoCard(memo);
        if (!cursor.isEmpty()) button("加载更多", 0, () -> loadMemos(false));
        navigation(false);
    }
    private String dateLabel(long epochMillis) {
        if (epochMillis <= 0) return "";
        try {
            java.time.LocalDate date = java.time.Instant.ofEpochMilli(epochMillis)
                    .atZone(java.time.ZoneId.systemDefault()).toLocalDate();
            java.time.LocalDate today = java.time.LocalDate.now();
            return date.equals(today) ? "今天" : date.format(java.time.format.DateTimeFormatter.ofPattern(
                    date.getYear() == today.getYear() ? "M月d日" : "yyyy年M月d日"));
        } catch (Exception ignored) { return ""; }
    }
    private void memoCard(JSONObject memo) {
        LinearLayout card = ui.column();
        card.setPadding(dp(20), dp(18), dp(20), dp(18));
        card.setBackground(ui.ripple(ui.surface, 20));
        String body = memo.optString("content").trim();
        String[] lines = body.split("\n", 2);
        TextView title = ui.text(body.isEmpty() ? "空白备忘录" : lines[0], 18, ui.text, true);
        title.setMaxLines(2);
        title.setEllipsize(android.text.TextUtils.TruncateAt.END);
        card.addView(title, ui.spaced(10));
        if (lines.length > 1 && !lines[1].trim().isEmpty()) {
            TextView preview = ui.text(lines[1].trim(), 14, ui.muted, false);
            preview.setMaxLines(3);
            preview.setEllipsize(android.text.TextUtils.TruncateAt.END);
            card.addView(preview, ui.spaced(16));
        }
        LinearLayout meta = ui.row();
        String group = memo.optString("project");
        TextView projectName = ui.text(group.isEmpty() ? "随手记" : group, 12, ui.accent, true);
        meta.addView(projectName, new LinearLayout.LayoutParams(0, -2, 1));
        meta.addView(ui.text(dateLabel(memo.optLong("updated_at")), 12, ui.muted, false));
        card.addView(meta);
        JSONObject plan = memo.optJSONObject("plan");
        if (plan != null) {
            String state = !memo.optBoolean("active", true) || !plan.optBoolean("enabled", true)
                    ? "已暂停" : !memo.isNull("next_run_at") ? "已设置"
                    : memo.optJSONObject("dispatch") != null
                        && java.util.Arrays.asList("pending", "leased").contains(
                                memo.optJSONObject("dispatch").optString("status"))
                        ? "等待设备接收" : "已触发";
            TextView scheduled = ui.text("定时 · " + state, 12, ui.accent, false);
            scheduled.setPadding(0, dp(12), 0, 0);
            card.addView(scheduled);
        }
        if (memo.optJSONObject("dispatch") != null) {
            TextView status = ui.text(deliveryStatus(memo.optJSONObject("dispatch").optString("status")), 12, ui.muted, false);
            status.setPadding(0, dp(12), 0, 0);
            card.addView(status);
        }
        card.setFocusable(true);
        card.setOnClickListener(v -> { if (!busy) loadMemo(memo.optString("id")); });
        root.addView(card, ui.spaced(12));
    }
    private void pair(View first, View second) {
        int index = root.indexOfChild(first);
        root.removeView(first);
        root.removeView(second);
        LinearLayout row = ui.row();
        LinearLayout.LayoutParams left = new LinearLayout.LayoutParams(0, -2, 1);
        left.setMarginEnd(dp(10));
        row.addView(first, left);
        row.addView(second, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(row, index, ui.spaced(12));
    }
    private void loadMemo(String id) {
        run(() -> api.request("GET", "/api/memos/" + ApiClient.encode(id), null), this::showMemo);
    }
    private void showMemo(JSONObject memo) {
        selected = memo;
        screen = "detail";
        page("备忘录详情", (memo.optString("project").isEmpty() ? "随手记" : memo.optString("project"))
                + "  ·  " + dateLabel(memo.optLong("updated_at")));
        TextView body = label(memo.optString("content"), 18);
        body.setTextIsSelectable(true);
        body.setPadding(dp(20), dp(24), dp(20), dp(24));
        body.setBackground(ui.shape(ui.surface, 20, 0));
        body.setMinHeight(dp(180));
        String metadata = memo.optString("category");
        String memoTags = tagText(memo.optJSONArray("tags"));
        if (!memoTags.isEmpty()) metadata += (metadata.isEmpty() ? "" : "  ·  ") + memoTags;
        if (!memo.optBoolean("active")) metadata += "  ·  已停用";
        if (!metadata.trim().isEmpty()) label(metadata.trim(), 13).setTextColor(ui.muted);
        JSONObject plan = memo.optJSONObject("plan");
        if (plan != null) {
            String mode = plan.optString("mode");
            String frequency = mode.equals("once") ? "单次" : mode.equals("daily") ? "每天"
                    : mode.equals("weekly") ? "每周" : "每月";
            String status = !plan.optBoolean("enabled", true) ? "已暂停"
                    : memo.isNull("next_run_at") ? "等待接收或已触发"
                    : "下次 " + java.time.Instant.ofEpochMilli(memo.optLong("next_run_at"))
                        .atZone(java.time.ZoneId.of(plan.optString("timezone", "Asia/Shanghai")))
                        .format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"));
            label("定时计划 · " + frequency + " · " + status, 14).setTextColor(ui.accent);
            label(plan.optString("instruction"), 14);
        }
        JSONObject delivery = memo.optJSONObject("dispatch");
        if (delivery != null) {
            label("交给电脑的指令", 16);
            label(delivery.optString("instruction"), 15).setTextIsSelectable(true);
            label("目标：" + delivery.optString("target_device_id") + "\n" + deliveryStatus(delivery.optString("status")), 13);
        }
        if (!memo.isNull("deleted_at")) label("这条备忘录已删除。", 15);
        else {
            Button edit = button("编辑", R.id.edit, () -> startEditor(EditorDraft.forMemo("edit", memo)));
            Button append = button("追加内容", R.id.append, () -> startEditor(EditorDraft.forMemo("append", memo)));
            pair(edit, append);
            button("删除", R.id.delete, () -> new AlertDialog.Builder(this).setTitle("删除备忘录？")
                    .setMessage("尚未发送的指令会取消；已接收的工作不会因此停止。")
                    .setNegativeButton("保留", null).setPositiveButton("删除", (dialog, which) ->
                            run(() -> api.request("DELETE", "/api/memos/" + ApiClient.encode(memo.optString("id")),
                                    Json.of("revision", memo.optInt("revision"))), value -> loadMemos(true))).show());
        }
        button("刷新详情", 0, () -> loadMemo(memo.optString("id")));
        button("返回列表", R.id.back, () -> loadMemos(true));
    }
    static String deliveryStatus(String status) {
        switch (status) {
            case "pending": return "等待设备接收（离线时会保留排队）";
            case "leased": return "已发送，等待接收确认";
            case "accepted": return "设备已接收 · 不代表执行完成";
            case "cancelled": return "指令已取消";
            default: return "投递状态：" + status;
        }
    }
    private static String tagText(JSONArray tags) {
        List<String> values = new ArrayList<>();
        if (tags != null) for (int i = 0; i < tags.length(); i++) values.add(tags.optString(i));
        return String.join(", ", values);
    }
    private void startEditor(EditorDraft next) {
        JSONObject saved = store.get(draftKey());
        if (saved != null) {
            new AlertDialog.Builder(this).setTitle("还有一份本地草稿")
                    .setMessage("请先处理已保存的草稿，再开始新的编辑。")
                    .setNegativeButton("返回", null).setPositiveButton("继续草稿", (dialog, which) -> {
                        draft = new EditorDraft(saved); prepareEditor();
                    }).show();
        } else { draft = next; prepareEditor(); }
    }
    private void prepareEditor() {
        // Opening a draft works offline; devices are loaded only when the user needs a target.
        showEditor();
    }
    private void watch(EditText input) {
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { changed(); }
            public void afterTextChanged(Editable e) {}
        });
    }
    private void changed() {
        if (rendering || draft == null || draft.pending()) return;
        main.removeCallbacks(saveDraftLater);
        main.postDelayed(saveDraftLater, 400);
    }
    private void showEditor() {
        screen = "editor";
        page(draft.mode().equals("create") ? "新建备忘录" : draft.mode().equals("edit") ? "编辑备忘录" : "追加内容",
                "草稿保存在本机；点保存后才会提交到服务器。");
        rendering = true;
        JSONObject fields = draft.fields();
        content = field(draft.mode().equals("append") ? "要追加的内容（包含所需换行）" : "正文", fields.optString("content"), R.id.content, true);
        watch(content);
        project = category = tags = instruction = null;
        active = dispatch = null;
        target = planMode = planTarget = planWeekday = planMonthDay = null;
        planInstruction = planDate = planTime = null;
        planPresent = planEnabled = null;
        planDatePicker = planRefresh = null;
        if (!draft.mode().equals("append")) {
            project = field("项目（选填）", fields.optString("project"), R.id.project, false); watch(project);
            int metadataStart = root.getChildCount();
            category = field("分类（选填）", fields.optString("category"), R.id.category, false); watch(category);
            tags = field("标签（逗号分隔，选填）", tagText(fields.optJSONArray("tags")), R.id.tags, false); watch(tags);
            active = check("启用这条备忘录", fields.optBoolean("active", true));
            active.setOnCheckedChangeListener((button, value) -> changed());
            fold("更多属性 · 分类与标签", childrenFrom(metadataStart), false);
        }
        if (draft.mode().equals("create")) {
            dispatch = check("同时交给电脑处理", draft.data.optBoolean("dispatch_enabled"));
            int firstDispatchView = root.getChildCount();
            instruction = field("给电脑的指令（默认新建会话）", draft.data.optString("instruction"), R.id.instruction, true);
            watch(instruction);
            label("目标电脑", 13);
            target = new Spinner(this);
            target.setBackground(ui.spinnerBackground());
            target.setPadding(dp(12), dp(8), dp(40), dp(8));
            root.addView(target, new LinearLayout.LayoutParams(-1, dp(56)));
            fillTargets();
            target.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { changed(); }
                public void onNothingSelected(AdapterView<?> parent) {}
            });
            button("刷新可用电脑", 0, () -> {
                if (!persistDraft(true)) return;
                run(() -> api.request("GET", "/api/devices", null), result -> {
                    devices = result.optJSONArray("items"); fillTargets();
                    if (draft.pending()) lockEditor();
                    say("已加载启用的桌面设备；此列表不表示设备在线。");
                });
            });
            List<View> dispatchViews = new ArrayList<>();
            for (int i = firstDispatchView; i < root.getChildCount(); i++) dispatchViews.add(root.getChildAt(i));
            for (View view : dispatchViews) view.setVisibility(dispatch.isChecked() ? View.VISIBLE : View.GONE);
            dispatch.setOnCheckedChangeListener((button, value) -> {
                if (value && planPresent != null && planPresent.isChecked()) planPresent.setChecked(false);
                for (View view : dispatchViews) view.setVisibility(value ? View.VISIBLE : View.GONE);
                changed();
            });
        }
        if (!draft.mode().equals("append")) showScheduleEditor();
        button(draft.pending() ? "重试原提交" : "保存到服务器", R.id.save, this::submitDraft);
        if (draft.pending() && !draft.mode().equals("create")) button("核对服务器最新内容", 0, this::compareLatest);
        button("保存草稿并返回", R.id.back, () -> { if (persistDraft(true)) loadMemos(true); });
        button("放弃本地草稿", 0, () -> new AlertDialog.Builder(this).setTitle("放弃本地草稿？")
                .setMessage(draft.pending() ? "提交结果可能尚未确认。放弃只删除本地草稿，不撤回服务器上的内容或指令；请先核对，避免重新创建重复内容。" : "尚未提交的本地内容将被清除。")
                .setNegativeButton("保留", null).setPositiveButton("放弃草稿", (dialog, which) -> {
                    try { store.put(draftKey(), null); draft = null; loadMemos(true); }
                    catch (Exception error) { failure(error); }
                }).show());
        rendering = false;
        if (draft.pending()) { lockEditor(); say("正在保留原提交内容。重试不会自动换请求标识或版本。"); }
    }
    private void fillTargets() {
        if (target != null) fillTarget(target, targetIds, draft.data.optString("target_device_id"));
        if (planTarget != null) {
            JSONObject input = draft.data.optJSONObject("schedule");
            fillTarget(planTarget, planTargetIds, input == null ? "" : input.optString("target_device_id"));
        }
    }
    private void fillTarget(Spinner spinner, List<String> ids, String chosen) {
        ids.clear(); ids.add("");
        List<String> names = new ArrayList<>(); names.add("请选择电脑（可先刷新列表）");
        if (devices != null) for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device.optBoolean("active") && "desktop".equals(device.optString("kind"))) {
                ids.add(device.optString("id")); names.add(device.optString("name") + " · " + device.optString("id"));
            }
        }
        if (!chosen.isEmpty() && !ids.contains(chosen)) {
            ids.add(chosen); names.add("原目标 · " + chosen + "（状态待核对）");
        }
        spinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
        spinner.setSelection(Math.max(0, ids.indexOf(chosen)));
    }
    private void watchSchedule(EditText input) {
        input.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            public void onTextChanged(CharSequence s, int start, int before, int count) { scheduleChanged(); }
            public void afterTextChanged(Editable e) {}
        });
    }
    private void scheduleChanged() {
        if (!rendering && draft != null && !draft.pending()) {
            Json.put(draft.data, "plan_dirty", true);
            changed();
        }
    }
    private Spinner scheduleSpinner(int id, String[] labels, int selected) {
        Spinner view = new Spinner(this);
        view.setId(id);
        view.setBackground(ui.spinnerBackground());
        view.setPadding(dp(12), dp(8), dp(40), dp(8));
        view.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, labels));
        view.setSelection(Math.max(0, Math.min(selected, labels.length - 1)));
        root.addView(view, ui.spaced(14));
        view.setMinimumHeight(dp(52));
        return view;
    }
    private void showScheduleEditor() {
        JSONObject input = draft.data.optJSONObject("schedule");
        if (input == null) {
            input = ScheduleDraft.fromPlan(null);
            Json.put(draft.data, "schedule", input);
        }
        final JSONObject settings = input;
        planPresent = check("设置定时执行", draft.data.optBoolean("plan_present"));
        planPresent.setId(R.id.plan_present);
        int start = root.getChildCount();
        planInstruction = field("定时指令", settings.optString("instruction"), R.id.plan_instruction, true);
        watchSchedule(planInstruction);
        label("执行频率", 13);
        String[] modes = {"once", "daily", "weekly", "monthly"};
        int mode = java.util.Arrays.asList(modes).indexOf(settings.optString("mode", "once"));
        planMode = scheduleSpinner(R.id.plan_type, new String[]{"单次", "每天", "每周", "每月"}, mode);
        int from = root.getChildCount();
        planDate = field("单次执行时间", settings.optString("run_at_input"), R.id.plan_date, false);
        planDate.setHint("2026-11-03 20:00");
        watchSchedule(planDate);
        planDatePicker = button("选择日期和时间", 0, () -> {
            java.time.LocalDateTime value;
            try { value = java.time.LocalDateTime.parse(planDate.getText().toString().trim(),
                    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")); }
            catch (Exception ignored) { value = java.time.LocalDateTime.now(); }
            final java.time.LocalDateTime initial = value;
            new android.app.DatePickerDialog(this, (picker, year, month, day) ->
                new android.app.TimePickerDialog(this, (timePicker, hour, minute) ->
                    planDate.setText(String.format(java.util.Locale.ROOT, "%04d-%02d-%02d %02d:%02d",
                            year, month + 1, day, hour, minute)), initial.getHour(), initial.getMinute(), true).show(),
                    initial.getYear(), initial.getMonthValue() - 1, initial.getDayOfMonth()).show();
        });
        List<View> onceViews = childrenFrom(from);
        from = root.getChildCount();
        planTime = field("执行时刻", settings.optString("time", "09:00"), R.id.plan_time, false);
        planTime.setHint("09:00"); watchSchedule(planTime);
        List<View> timeViews = childrenFrom(from);
        from = root.getChildCount();
        label("星期", 13);
        planWeekday = scheduleSpinner(R.id.plan_weekday,
                new String[]{"周一", "周二", "周三", "周四", "周五", "周六", "周日"}, settings.optInt("weekday", 0));
        List<View> weekdayViews = childrenFrom(from);
        from = root.getChildCount();
        label("每月日期（当月没有此日则取最后一天）", 13);
        String[] days = new String[31];
        for (int i = 0; i < 31; i++) days[i] = (i + 1) + " 日";
        planMonthDay = scheduleSpinner(R.id.plan_month_day, days, settings.optInt("day", 1) - 1);
        List<View> monthViews = childrenFrom(from);
        planEnabled = check("启用计划", settings.optBoolean("enabled", true));
        planEnabled.setId(R.id.plan_enabled);
        planEnabled.setOnCheckedChangeListener((button, value) -> scheduleChanged());
        label("目标电脑", 13);
        planTarget = scheduleSpinner(R.id.plan_target, new String[]{"请选择电脑（可先刷新列表）"}, 0);
        fillTargets();
        planTarget.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position >= 0 && position < planTargetIds.size()
                        && !planTargetIds.get(position).equals(settings.optString("target_device_id"))) {
                    Json.put(settings, "target_device_id", planTargetIds.get(position)); scheduleChanged();
                }
            }
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        planRefresh = button("刷新定时目标电脑", 0, () -> {
            if (!persistDraft(true)) return;
            run(() -> api.request("GET", "/api/devices", null), result -> {
                devices = result.optJSONArray("items"); fillTargets();
                if (draft.pending()) lockEditor();
                say("已加载启用的桌面设备；此列表不表示设备在线。");
            });
        });
        label("时间按 " + settings.optString("timezone", "Asia/Shanghai")
                + "；离线等待上线，漏过多次合并一次。", 13).setTextColor(ui.muted);
        List<View> scheduleViews = childrenFrom(start);
        Runnable showFields = () -> {
            boolean visible = planPresent.isChecked();
            for (View view : scheduleViews) view.setVisibility(visible ? View.VISIBLE : View.GONE);
            int choice = planMode.getSelectedItemPosition();
            for (View view : onceViews) view.setVisibility(visible && choice == 0 ? View.VISIBLE : View.GONE);
            for (View view : timeViews) view.setVisibility(visible && choice != 0 ? View.VISIBLE : View.GONE);
            for (View view : weekdayViews) view.setVisibility(visible && choice == 2 ? View.VISIBLE : View.GONE);
            for (View view : monthViews) view.setVisibility(visible && choice == 3 ? View.VISIBLE : View.GONE);
        };
        planPresent.setOnCheckedChangeListener((button, value) -> {
            if (value && dispatch != null && dispatch.isChecked()) dispatch.setChecked(false);
            Json.put(draft.data, "plan_present", value);
            scheduleChanged(); showFields.run();
        });
        planMode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position >= 0 && position < modes.length && !modes[position].equals(settings.optString("mode"))) {
                    Json.put(settings, "mode", modes[position]); scheduleChanged();
                }
                showFields.run();
            }
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        planWeekday.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position != settings.optInt("weekday", 0)) {
                    Json.put(settings, "weekday", position); scheduleChanged();
                }
            }
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        planMonthDay.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position + 1 != settings.optInt("day", 1)) {
                    Json.put(settings, "day", position + 1); scheduleChanged();
                }
            }
            public void onNothingSelected(AdapterView<?> parent) {}
        });
        showFields.run();
    }
    private void collectDraft() {
        if (draft == null || draft.pending() || !screen.equals("editor")) return;
        JSONObject fields = draft.fields();
        Json.put(fields, "content", content.getText().toString());
        if (project != null) {
            Json.put(fields, "project", project.getText().toString().trim());
            Json.put(fields, "category", category.getText().toString().trim());
            String enteredTags = tags.getText().toString();
            if (!enteredTags.equals(tagText(fields.optJSONArray("tags"))))
                Json.put(fields, "tags", Json.tags(enteredTags));
            Json.put(fields, "active", active.isChecked());
        }
        if (planPresent != null) {
            Json.put(draft.data, "plan_present", planPresent.isChecked());
            JSONObject input = draft.data.optJSONObject("schedule");
            Json.put(input, "instruction", planInstruction.getText().toString());
            Json.put(input, "run_at_input", planDate.getText().toString().trim());
            Json.put(input, "time", planTime.getText().toString().trim());
            Json.put(input, "enabled", planEnabled.isChecked());
            int pos = planTarget.getSelectedItemPosition();
            if (pos >= 0 && pos < planTargetIds.size()) Json.put(input, "target_device_id", planTargetIds.get(pos));
        }
        if (dispatch != null) {
            Json.put(draft.data, "dispatch_enabled", dispatch.isChecked());
            Json.put(draft.data, "instruction", instruction.getText().toString());
            int position = target.getSelectedItemPosition();
            if (position >= 0 && position < targetIds.size()) Json.put(draft.data, "target_device_id", targetIds.get(position));
        }
    }
    private boolean persistDraft(boolean announce) {
        main.removeCallbacks(saveDraftLater);
        if (draft == null || !screen.equals("editor")) return true;
        collectDraft();
        try { store.put(draftKey(), draft.data); if (announce) say("草稿已保存在本机"); return true; }
        catch (Exception error) { say("本机草稿保存失败，请暂时不要离开此页。"); return false; }
    }
    private void lockEditor() {
        for (View input : new View[]{content, project, category, tags, active, dispatch, instruction, target,
                planPresent, planEnabled, planInstruction, planDate, planTime, planMode, planTarget,
                planWeekday, planMonthDay, planDatePicker, planRefresh})
            if (input != null) input.setEnabled(false);
    }
    private void submitDraft() {
        collectDraft();
        if (!draft.pending() && draft.data.optBoolean("dispatch_enabled")
                && (draft.data.optString("instruction").trim().isEmpty() || draft.data.optString("target_device_id").isEmpty())) {
            say("请填写指令并选择目标电脑。"); return;
        }
        JSONObject payload;
        try { payload = draft.freeze(); }
        catch (IllegalArgumentException error) { say(error.getMessage()); return; }
        if (!persistDraft(true)) return;
        showEditor();
        run(() -> api.request(draft.method(), draft.path(), payload), result -> {
            try { store.put(draftKey(), null); draft = null; showMemo(result); say("服务器已保存"); }
            catch (Exception error) { say("服务器已保存，本机草稿清理失败；请核对后清理，不要重新创建。"); }
        }, error -> {
            if (error instanceof ApiClient.ApiException) {
                ApiClient.ApiException response = (ApiClient.ApiException) error;
                if (response.status == 409 && (response.code.equals("revision_conflict")
                        || response.code.equals("memo_deleted"))) {
                    say(errorText(response));
                    if (!draft.mode().equals("create")) compareLatest();
                    return;
                }
                // A later rejection does not prove an earlier timed-out attempt was rejected.
                if (response.status >= 400 && response.status < 500 && !draft.data.optBoolean("uncertain")) {
                    draft.definiteRejection(); persistDraft(false); showEditor();
                } else { Json.put(draft.data, "uncertain", true); persistDraft(false); }
            } else { Json.put(draft.data, "uncertain", true); persistDraft(false); }
            failure(error);
        });
    }
    private void compareLatest() {
        run(() -> api.request("GET", "/api/memos/" + ApiClient.encode(draft.memoId()), null), latest -> {
            screen = "compare";
            page("核对版本", "不会自动覆盖或再次追加。请先比较内容。");
            label("服务器内容 · 版本 " + latest.optInt("revision"), 16);
            label(latest.optString("content"), 16).setTextIsSelectable(true);
            label("本地输入", 16);
            label(draft.fields().optString("content"), 16).setTextIsSelectable(true);
            if (!latest.isNull("deleted_at")) label("服务器上的备忘录已删除。", 16);
            else button(draft.mode().equals("append") ? "确认尚未追加，基于新版再编辑" : "基于新版继续编辑", 0, () ->
                    new AlertDialog.Builder(this).setTitle("使用最新版本作为编辑基础？")
                            .setMessage("保留本地输入，下次保存将基于刚才展示的版本。请确认没有重复追加或误覆盖其他设备的内容。")
                            .setNegativeButton("返回核对", null).setPositiveButton("继续编辑", (dialog, which) -> {
                                draft.definiteRejection(); draft.data.remove("uncertain");
                                Json.put(draft.data, "revision", latest.optInt("revision"));
                                showEditor(); persistDraft(false);
                            }).show());
            button("内容已符合预期，清理本地草稿", 0, () -> {
                try { store.put(draftKey(), null); draft = null; showMemo(latest); }
                catch (Exception error) { failure(error); }
            });
            button("返回本地草稿", R.id.back, this::showEditor);
        });
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
            page("设置与设备", "管理连接，保持记录同步。");
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
            navigation(true);
    }
    private void localLogout() {
        try { store.saveSession(null); draft = null; memos.clear(); devices = new JSONArray(); selected = null; showLogin(); }
        catch (Exception error) { say("本机凭据清理失败，请重试。"); }
    }
}
