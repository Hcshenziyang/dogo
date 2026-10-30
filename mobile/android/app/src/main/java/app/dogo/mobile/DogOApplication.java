package app.dogo.mobile;

import android.app.Application;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One credential store and request queue survive Activity recreation. */
public final class DogOApplication extends Application {
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    SecureStore store;
    ApiClient api;
    synchronized void initialize() throws Exception {
        if (store == null) {
            store = new SecureStore(this);
            api = new ApiClient(store, BuildConfig.DEBUG);
        }
    }
}
