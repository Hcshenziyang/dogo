package app.dogo.mobile;

import android.app.Application;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One credential store and request queue survive Activity recreation. */
public final class DogOApplication extends Application {
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    SecureStore store;
    ApiClient api;
    RemoteSessions remote;
    synchronized void initialize() throws Exception {
        if (store == null) {
            store = new SecureStore(this);
            api = new ApiClient(store, BuildConfig.DEBUG);
            remote = new RemoteSessions(new RemoteSessions.Storage() {
                public org.json.JSONObject get(String key) { return store.get(key); }
                public void put(String key, org.json.JSONObject value) throws Exception { store.put(key, value); }
            }, api::request);
        }
    }
}
