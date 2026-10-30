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
    private LinearLayout root;
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
    private Spinner target;
    private final List<String> targetIds = new ArrayList<>();
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

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void page(String title, String subtitle) {
        View focused = getCurrentFocus();
        if (focused != null) ((android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(focused.getWindowToken(), 0);
        generation++;
        rendering = true;
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setFocusableInTouchMode(true);
        root.setPadding(dp(20), dp(12), dp(20), dp(32));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(root);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(scroll);
        scroll.requestApplyInsets();
        label("DogO", 13).setTextColor(0xff137a70);
        label(title, 28).setTypeface(null, android.graphics.Typeface.BOLD);
        if (!subtitle.isEmpty()) label(subtitle, 14).setTextColor(0xff596762);
        message = label("", 14);
        message.setId(R.id.message);
        rendering = false;
    }
    private TextView label(String text, int size) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(0xff20332f);
        view.setPadding(0, dp(6), 0, dp(6));
        root.addView(view, new LinearLayout.LayoutParams(-1, -2));
        return view;
    }
    private Button button(String title, int id, Runnable action) {
        Button button = new Button(this);
        button.setText(title);
        if (id != 0) button.setId(id);
        button.setAllCaps(false);
        button.setMaxLines(2);
        button.setEllipsize(android.text.TextUtils.TruncateAt.END);
        root.addView(button, new LinearLayout.LayoutParams(-1, dp(52)));
        button.setOnClickListener(v -> action.run());
        return button;
    }
    private EditText field(String title, String value, int id, boolean multiline) {
        label(title, 13);
        EditText input = new EditText(this);
        input.setId(id);
        input.setSaveEnabled(false); // Drafts and credentials have an explicit encrypted persistence path.
        input.setTextSize(16);
        input.setText(value);
        input.setContentDescription(title);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (multiline
                ? InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
        input.setSingleLine(!multiline);
        if (multiline) { input.setMinLines(4); input.setGravity(android.view.Gravity.TOP); }
        root.addView(input, new LinearLayout.LayoutParams(-1, -2));
        return input;
    }
    private CheckBox check(String title, boolean value) {
        CheckBox box = new CheckBox(this);
        box.setText(title);
        box.setChecked(value);
        root.addView(box);
        return box;
    }
    private void say(String text) { if (message != null) message.setText(text); }
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
        enabled(root, false);
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
                enabled(root, true);
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
            case "dispatch_in_flight": return "指令已发送、尚未确认，暂不能删除备忘录。";
            case "device_unavailable": return "目标设备不可用，请选择已启用的电脑。";
            case "memo_inactive": return "附带指令时，备忘录必须启用。";
            case "memo_deleted": return "这条备忘录已被删除；本地输入仍保留。";
            case "request_id_reused": return "原请求标识已有不同内容，请先核对服务器记录。";
            case "redirect_refused": return "服务器返回了重定向，请填写最终服务器地址。";
            case "memo_too_large": return "追加后的正文超出服务器限制。";
            default: return error.status == 422 ? "提交字段不符合接口限制，请检查正文、标签及设备。"
                    : "请求未完成（" + error.status + " / " + error.code + "）";
        }
    }
    private void showLogin() {
        screen = "login";
        page("连接你的服务", "登录后查看备忘录，或把指令交给电脑处理。");
        JSONObject preferences = store.get("preferences");
        if (preferences == null) preferences = new JSONObject();
        EditText server = field("服务器地址", preferences.optString("server"), R.id.server_url, false);
        server.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        EditText username = field("账户", preferences.optString("username"), R.id.username, false);
        EditText password = field("密码", "", R.id.password, false);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        EditText name = field("这台手机的名称", preferences.optString("device_name", android.os.Build.MODEL), R.id.device_name, false);
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
        label("账户由服务端创建。此版本仅提供登录、备忘录和设备管理。", 13);
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
            say(memos.isEmpty() ? "还没有备忘录，记下第一件事吧。" : "已从服务器刷新");
        });
    }
    private void renderList() {
        page("备忘录", "记下内容，需要时交给指定电脑。");
        button("＋ 新建备忘录", R.id.new_memo, () -> startEditor(EditorDraft.create()));
        if (store.get(draftKey()) != null) button("继续本地草稿", 0, () -> {
            draft = new EditorDraft(store.get(draftKey()));
            prepareEditor();
        });
        EditText filter = field("项目筛选（留空显示全部）", projectFilter, R.id.project_filter, false);
        button("筛选 / 刷新", 0, () -> { projectFilter = filter.getText().toString().trim(); loadMemos(true); });
        for (JSONObject memo : memos) {
            String text = memo.optString("content").replace('\n', ' ');
            if (text.length() > 70) text = text.substring(0, 70) + "…";
            String group = memo.optString("project");
            button((text.isEmpty() ? "（空白内容）" : text) + (group.isEmpty() ? "" : "  ·  " + group), 0,
                    () -> loadMemo(memo.optString("id")));
        }
        if (!cursor.isEmpty()) button("加载更多", 0, () -> loadMemos(false));
        button("设置与设备", R.id.settings, this::loadSettings);
    }
    private void loadMemo(String id) {
        run(() -> api.request("GET", "/api/memos/" + ApiClient.encode(id), null), this::showMemo);
    }
    private void showMemo(JSONObject memo) {
        selected = memo;
        screen = "detail";
        page("备忘录详情", "项目：" + memo.optString("project", "") + "  ·  版本 " + memo.optInt("revision"));
        label(memo.optString("content"), 18).setTextIsSelectable(true);
        label("分类：" + memo.optString("category") + "\n标签：" + tagText(memo.optJSONArray("tags"))
                + "\n" + (memo.optBoolean("active") ? "已启用" : "已停用"), 13);
        JSONObject delivery = memo.optJSONObject("dispatch");
        if (delivery != null) {
            label("交给电脑的指令", 16);
            label(delivery.optString("instruction"), 15).setTextIsSelectable(true);
            label("目标：" + delivery.optString("target_device_id") + "\n" + deliveryStatus(delivery.optString("status")), 13);
        }
        if (!memo.isNull("deleted_at")) label("这条备忘录已删除。", 15);
        else {
            button("编辑", R.id.edit, () -> startEditor(EditorDraft.forMemo("edit", memo)));
            button("追加内容", R.id.append, () -> startEditor(EditorDraft.forMemo("append", memo)));
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
        target = null;
        if (!draft.mode().equals("append")) {
            project = field("项目（选填）", fields.optString("project"), R.id.project, false); watch(project);
            category = field("分类（选填）", fields.optString("category"), R.id.category, false); watch(category);
            tags = field("标签（逗号分隔，选填）", tagText(fields.optJSONArray("tags")), R.id.tags, false); watch(tags);
            active = check("启用这条备忘录", fields.optBoolean("active", true));
            active.setOnCheckedChangeListener((button, value) -> changed());
        }
        if (draft.mode().equals("create")) {
            dispatch = check("同时交给电脑处理", draft.data.optBoolean("dispatch_enabled"));
            int firstDispatchView = root.getChildCount();
            instruction = field("给电脑的指令（默认新建会话）", draft.data.optString("instruction"), R.id.instruction, true);
            watch(instruction);
            label("目标电脑", 13);
            target = new Spinner(this);
            root.addView(target);
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
                for (View view : dispatchViews) view.setVisibility(value ? View.VISIBLE : View.GONE);
                changed();
            });
        }
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
        targetIds.clear();
        targetIds.add("");
        List<String> names = new ArrayList<>();
        names.add("请选择电脑（可先刷新列表）");
        String chosen = draft.data.optString("target_device_id");
        if (devices != null) for (int i = 0; i < devices.length(); i++) {
            JSONObject device = devices.optJSONObject(i);
            if (device.optBoolean("active") && "desktop".equals(device.optString("kind"))) {
                targetIds.add(device.optString("id"));
                names.add(device.optString("name") + " · " + device.optString("id"));
            }
        }
        if (!chosen.isEmpty() && !targetIds.contains(chosen)) {
            targetIds.add(chosen); names.add("原目标 · " + chosen + "（状态待核对）");
        }
        target.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
        target.setSelection(Math.max(0, targetIds.indexOf(chosen)));
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
        for (View input : new View[]{content, project, category, tags, active, dispatch, instruction, target})
            if (input != null) input.setEnabled(false);
    }
    private void submitDraft() {
        collectDraft();
        if (!draft.pending() && draft.data.optBoolean("dispatch_enabled")
                && (draft.data.optString("instruction").trim().isEmpty() || draft.data.optString("target_device_id").isEmpty())) {
            say("请填写指令并选择目标电脑。"); return;
        }
        JSONObject payload = draft.freeze();
        if (!persistDraft(true)) return;
        showEditor();
        run(() -> api.request(draft.method(), draft.path(), payload), result -> {
            try { store.put(draftKey(), null); draft = null; showMemo(result); say("服务器已保存"); }
            catch (Exception error) { say("服务器已保存，本机草稿清理失败；请核对后清理，不要重新创建。"); }
        }, error -> {
            if (error instanceof ApiClient.ApiException) {
                ApiClient.ApiException response = (ApiClient.ApiException) error;
                if (response.status == 409) {
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
            page("设置与设备", session.optString("username") + "\n" + session.optString("server"));
            label("已登记设备 · 启用状态不代表在线", 15);
            if (devices != null) for (int i = 0; i < devices.length(); i++) {
                JSONObject device = devices.optJSONObject(i);
                boolean current = device.optString("id").equals(session.optString("device_id"));
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
            }
            button("退出当前账户", R.id.logout, () -> run(() -> { api.logout(); return new JSONObject(); }, value -> localLogout(), error -> {
                if (store.session() == null) { localLogout(); return; }
                new AlertDialog.Builder(this).setTitle("未能确认服务端退出")
                        .setMessage("可重试，或仅清除本机凭据。仅在本机退出不会撤销服务器凭据，也不会取消远端工作。")
                        .setNegativeButton("稍后重试", null).setPositiveButton("仅在本机退出", (dialog, which) -> localLogout()).show();
            }));
            button("返回备忘录", R.id.back, () -> loadMemos(true));
    }
    private void localLogout() {
        try { store.saveSession(null); draft = null; memos.clear(); devices = new JSONArray(); selected = null; showLogin(); }
        catch (Exception error) { say("本机凭据清理失败，请重试。"); }
    }
}
