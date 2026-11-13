package app.dogo.mobile;

import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** Remove only the old memo draft entries; credentials and device IDs remain. */
final class LegacyMemoCleanup {
    static JSONObject withoutDrafts(JSONObject state) {
        JSONObject next = Json.copy(state);
        List<String> remove = new ArrayList<>();
        for (Iterator<String> keys = next.keys(); keys.hasNext();) {
            String key = keys.next();
            if (key.startsWith("draft:")) remove.add(key);
        }
        for (String key : remove) next.remove(key);
        return next;
    }
}
