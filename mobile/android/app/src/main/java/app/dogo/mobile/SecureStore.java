package app.dogo.mobile;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Credentials and drafts stay in app-private storage, encrypted with an Android Keystore key. */
final class SecureStore implements ApiClient.SessionStore {
    private final AtomicFile file;
    private final SecretKey key;
    private JSONObject state;

    SecureStore(Context context) throws Exception {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "state.enc"));
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        String alias = context.getPackageName() + ".state";
        if (!keys.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        key = (SecretKey) keys.getKey(alias, null);
        // Older Android AtomicFile versions may leave only the last committed .bak after a crash.
        if (file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists()) {
            byte[] bytes = file.readFully();
            if (bytes.length < 29) throw new java.io.IOException("本机数据损坏，未覆盖原文件");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 0, 12));
            state = Json.object(new String(cipher.doFinal(bytes, 12, bytes.length - 12), StandardCharsets.UTF_8));
        } else state = new JSONObject();
    }

    synchronized JSONObject get(String name) {
        JSONObject value = state.optJSONObject(name);
        return value == null ? null : Json.copy(value);
    }
    synchronized void put(String name, JSONObject value) throws Exception {
        JSONObject next = Json.copy(state);
        if (value == null) next.remove(name); else Json.put(next, name, value);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(next.toString().getBytes(StandardCharsets.UTF_8));
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(cipher.getIV());
            stream.write(encrypted);
            file.finishWrite(stream);
            state = next;
        } catch (Exception e) {
            if (stream != null) file.failWrite(stream);
            throw e;
        }
    }
    public synchronized JSONObject session() { return get("session"); }
    public synchronized void saveSession(JSONObject session) throws Exception { put("session", session); }

    static String scope(String server, String username) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(
                    (server + "\n" + username.trim()).getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte b : hash) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
            return result.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    synchronized String deviceId(String server, String username) throws Exception {
        String name = "device:" + scope(server, username);
        JSONObject value = get(name);
        if (value == null) {
            value = Json.of("id", UUID.randomUUID().toString());
            put(name, value);
        }
        return value.optString("id");
    }
}
