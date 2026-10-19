package app.dogo.mobile;

import android.content.Context;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

/** Private ordinary files, with a durable version baseline. No external directory scanning. */
final class PersonalMemory {
    private final File root;
    private final AtomicFile metadata;
    private final RelayTransport transport;
    private final Context context;
    PersonalMemory(Context context, RelayTransport transport) {
        this.context = context;
        this.root = new File(context.getFilesDir(), "personal-memory");
        this.metadata = new AtomicFile(new File(context.getFilesDir(), "memory-sync.json"));
        this.transport = transport;
    }
    private static String hash(String text) throws Exception {
        if (text == null) return "null";
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(); for (byte b : digest) result.append(String.format("%02x", b & 255)); return result.toString();
    }
    private File file(String name) throws Exception {
        if (name == null || name.length() > 240 || name.split("/").length > 12 || !name.matches("(?:[a-z0-9][a-z0-9_-]*/)*[a-z0-9][a-z0-9_-]*\\.(md|txt|json)")) throw new IOException("记忆文件名需使用小写英文/数字，以 md/txt/json 结尾");
        for (String part : name.split("/")) if (part.matches("(?i)(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\\..*)?")) throw new IOException("文件名不适合跨设备同步");
        File target = new File(root, name);
        if (!target.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator)) throw new IOException("目录不安全");
        return target;
    }
    private String read(File target) throws Exception {
        if (!target.exists()) return null;
        if (target.length() > 1024 * 1024) throw new IOException("记忆文件过大");
        return new String(new AtomicFile(target).readFully(), StandardCharsets.UTF_8);
    }
    private void write(File target, String content) throws Exception {
        if (!target.getParentFile().isDirectory() && !target.getParentFile().mkdirs()) throw new IOException("无法创建目录");
        String before = read(target);
        if (before != null && !before.equals(content)) {
            File backups = new File(root, ".backups"); backups.mkdirs();
            atomic(new AtomicFile(new File(backups, UUID.randomUUID() + ".json")), new JSONObject().put("path", target.getAbsolutePath().substring(root.getAbsolutePath().length() + 1)).put("content", before).toString());
        }
        if (content == null) new AtomicFile(target).delete(); else atomic(new AtomicFile(target), content);
    }
    private static void atomic(AtomicFile target, String content) throws Exception {
        FileOutputStream out = null;
        try { out = target.startWrite(); out.write(content.getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); target.finishWrite(out); }
        catch (Exception e) { if (out != null) target.failWrite(out); throw e; }
    }
    private JSONObject state() throws Exception {
        try { return new JSONObject(new String(metadata.readFully(), StandardCharsets.UTF_8)); }
        catch (FileNotFoundException absent) { return new JSONObject().put("files", new JSONObject()); }
    }
    private void scan(File folder, String prefix, Map<String, String> found) throws Exception {
        File[] children = folder.listFiles(); if (children == null) return;
        for (File child : children) {
            if (child.getName().startsWith(".")) continue;
            String name = prefix + child.getName();
            if (child.isDirectory()) scan(child, name + "/", found); else { file(name); found.put(name, read(child)); }
            if (found.size() > 1000) throw new IOException("记忆文件超过 1000 个");
        }
    }
    synchronized JSONObject local(String op, JSONObject args) throws Exception {
        if (op.equals("configure")) {
            context.getSharedPreferences("dogo.memory", 0).edit().putBoolean("enabled", args.getBoolean("enabled")).commit();
            return local("status", new JSONObject());
        }
        if (op.equals("sync")) return sync();
        if (op.equals("read")) { String content = read(file(args.getString("path"))); return new JSONObject().put("content", content == null ? JSONObject.NULL : content); }
        if (op.equals("write")) {
            String content = args.isNull("content") ? null : args.getString("content");
            if (content != null && content.length() > 256000) throw new IOException("记忆内容过大");
            File target = file(args.getString("path"));
            if (args.has("base") && !Objects.equals(read(target), args.isNull("base") ? null : args.getString("base"))) throw new IOException("记忆已变化，请重新读取后合并");
            write(target, content);
            return new JSONObject().put("saved", true).put("synced", false);
        }
        if (op.equals("rename")) {
            File source = file(args.getString("path")), target = file(args.getString("target"));
            String base = args.isNull("base") ? null : args.getString("base");
            if (base == null || !Objects.equals(read(source), base) || read(target) != null) throw new IOException("记忆源已变化或目标已存在");
            write(target, base); write(source, null); return new JSONObject().put("saved", true);
        }
        if (op.equals("export")) {
            Map<String, String> files = new TreeMap<>(); scan(root, "", files);
            return new JSONObject().put("format", "dogo-personal-memory-v1").put("exportedAt", System.currentTimeMillis()).put("files", new JSONObject(files));
        }
        if (Arrays.asList("versions", "policy", "configurePolicy", "list", "claim", "defer").contains(op)) return transport.memory(op, args);
        if (op.equals("conflicts")) return transport.memory("conflicts", new JSONObject());
        if (op.equals("resolve")) return transport.memory("resolve", args);
        if (!op.equals("status")) throw new IOException("未知记忆操作");
        Map<String, String> files = new TreeMap<>(); scan(root, "", files);
        return new JSONObject().put("files", new JSONArray(files.keySet())).put("at", state().optLong("at", 0))
            .put("enabled", context.getSharedPreferences("dogo.memory", 0).getBoolean("enabled", false));
    }
    synchronized JSONObject sync() throws Exception {
        if (!context.getSharedPreferences("dogo.memory", 0).getBoolean("enabled", false)) throw new IOException("记忆同步未开启");
        JSONObject status = transport.status();
        if (!status.optBoolean("configured")) throw new IOException("设备尚未配对");
        JSONObject state = state(); String origin = status.getString("url");
        if (state.has("origin") && !origin.equals(state.getString("origin"))) throw new IOException("记忆文件夹属于另一服务，未上传");
        state.put("origin", origin); JSONObject bases = state.getJSONObject("files");
        Map<String, String> local = new TreeMap<>(); scan(root, "", local);
        JSONArray manifest = transport.memory("list", new JSONObject()).getJSONArray("files");
        Map<String, JSONObject> remote = new HashMap<>();
        for (int i = 0; i < manifest.length(); i++) { JSONObject entry = manifest.getJSONObject(i); file(entry.getString("path")); remote.put(entry.getString("path"), entry); }
        Set<String> names = new TreeSet<>(local.keySet()); names.addAll(remote.keySet()); bases.keys().forEachRemaining(names::add);
        JSONArray conflicts = transport.memory("conflicts", new JSONObject()).getJSONArray("conflicts");
        int changes = 0, unresolved = 0;
        for (String name : names) {
            String here = local.get(name), localHash = hash(here);
            JSONObject there = remote.get(name), base = bases.optJSONObject(name);
            long version = there == null ? 0 : there.getLong("version");
            String remoteHash = there == null || there.isNull("hash") ? "null" : there.getString("hash");
            long baseVersion = base == null ? 0 : base.getLong("version");
            if (base != null && (there == null || version < baseVersion || (version == baseVersion && !remoteHash.equals(base.getString("hash"))))) { unresolved++; continue; }
            boolean changed = base == null ? here != null : !localHash.equals(base.getString("hash"));
            boolean remoteChanged = base == null ? there != null : version != baseVersion;
            if (!localHash.equals(remoteHash)) {
                if (changed && remoteChanged) {
                    JSONObject resolved = null;
                    for (int i = 0; i < conflicts.length(); i++) { JSONObject c = conflicts.getJSONObject(i);
                        if (c.optString("path").equals(name) && c.optString("source").equals(status.getString("device")) && c.optLong("baseVersion") == baseVersion && c.optString("status").equals("resolved") && c.optLong("resolutionVersion") == version && Objects.equals(c.isNull("local") ? null : c.getString("local"), here)) resolved = c;
                    }
                    if (resolved == null) { transport.memory("conflict", new JSONObject().put("path", name).put("baseVersion", baseVersion).put("local", here == null ? JSONObject.NULL : here)); unresolved++; continue; }
                    JSONObject latest = transport.memory("read", new JSONObject().put("path", name)).getJSONObject("file");
                    if (latest.getLong("version") != version) { unresolved++; continue; }
                    String content = latest.isNull("content") ? null : latest.getString("content");
                    write(file(name), content); localHash = hash(content); changes++;
                } else if (changed) {
                    JSONObject result = transport.memory("write", new JSONObject().put("path", name).put("baseVersion", version).put("content", here == null ? JSONObject.NULL : here));
                    if (result.has("conflict")) { unresolved++; continue; }
                    version = result.getJSONObject("file").getLong("version"); changes++;
                } else {
                    JSONObject latest = transport.memory("read", new JSONObject().put("path", name)).getJSONObject("file");
                    if (latest.getLong("version") != version) { unresolved++; continue; }
                    String content = latest.isNull("content") ? null : latest.getString("content");
                    write(file(name), content); localHash = hash(content); changes++;
                }
            }
            bases.put(name, new JSONObject().put("version", version).put("hash", localHash)); atomic(metadata, state.toString());
        }
        state.put("at", System.currentTimeMillis()); atomic(metadata, state.toString());
        return new JSONObject().put("changes", changes).put("conflicts", unresolved).put("at", state.getLong("at"));
    }
}
