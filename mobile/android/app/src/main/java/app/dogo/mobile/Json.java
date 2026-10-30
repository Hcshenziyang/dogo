package app.dogo.mobile;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class Json {
    private Json() {}
    static JSONObject object(String text) {
        try { return new JSONObject(text); }
        catch (JSONException e) { throw new IllegalArgumentException("无效的 JSON 数据", e); }
    }
    static JSONObject copy(JSONObject value) { return object(value.toString()); }
    static JSONObject put(JSONObject object, String key, Object value) {
        try { object.put(key, value); return object; }
        catch (JSONException e) { throw new IllegalArgumentException(e); }
    }
    static JSONObject of(Object... pairs) {
        JSONObject result = new JSONObject();
        for (int i = 0; i < pairs.length; i += 2) put(result, (String) pairs[i], pairs[i + 1]);
        return result;
    }
    static JSONArray tags(String text) {
        JSONArray result = new JSONArray();
        for (String tag : text.split("[,，]")) {
            if (!tag.trim().isEmpty()) result.put(tag.trim());
        }
        return result;
    }
}
