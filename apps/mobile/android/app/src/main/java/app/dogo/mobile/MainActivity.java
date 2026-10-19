package app.dogo.mobile;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.content.Intent;
import androidx.core.content.ContextCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DogoStorePlugin.class);
        registerPlugin(DogoRelayPlugin.class);
        registerPlugin(DogoAgentPlugin.class);
        super.onCreate(savedInstanceState);
        if (getSharedPreferences(RelayNotifyService.PREFS, 0).getBoolean("enabled", false)) {
            try { ContextCompat.startForegroundService(this, new Intent(this, RelayNotifyService.class)); } catch (Exception ignored) {}
        }
    }
}
