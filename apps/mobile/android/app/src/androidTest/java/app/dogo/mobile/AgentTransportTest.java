package app.dogo.mobile;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import android.content.Context;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class AgentTransportTest {
    private JSONObject fixture() throws Exception { return new JSONObject().put("endpoint", "https://model.fixture/v1").put("model", "fixture").put("apiKey", "synthetic-key-never-real").put("mcp", new JSONArray()).put("skills", new JSONArray()); }
    @Test public void configurationRejectsInsecureEndpointsAndNeverReusesKeyOnNewHost() throws Exception {
        JSONObject valid = AgentTransport.validate(fixture(), new JSONObject());
        for (String address : new String[]{"http://model.fixture/v1", "https://user:password@model.fixture/v1", "https://model.fixture/v1?key=secret", "https://model.fixture/v1#fragment"}) {
            try { AgentTransport.validate(fixture().put("endpoint", address), new JSONObject()); fail(address); } catch (java.io.IOException expected) { }
        }
        JSONObject input = fixture().put("apiKey", "");
        assertEquals("synthetic-key-never-real", AgentTransport.validate(input, valid).getString("apiKey"));
        input.put("endpoint", "https://another.fixture/v1"); assertEquals("", AgentTransport.validate(input, valid).getString("apiKey"));
        assertEquals("", AgentTransport.validate(fixture().put("apiKey", "").put("clearKey", true), valid).getString("apiKey"));
    }
    @Test public void nativeVaultDoesNotExposeKeysAndRefusesUnconfiguredTargets() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().endsWith(".devtest"));
        AgentTransport transport = new AgentTransport(context); JSONObject status = transport.configure(fixture());
        assertTrue(status.getBoolean("hasKey")); assertFalse(status.toString().contains("synthetic-key-never-real")); assertFalse(status.has("apiKey"));
        AgentTransport restored = new AgentTransport(context); assertEquals("fixture", restored.status().getString("model"));
        try { restored.request(new JSONObject().put("id", "fixture").put("target", "model").put("url", "https://evil.fixture/v1/chat/completions").put("method", "POST").put("body", "{}")); fail(); } catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("不一致")); }
        try { restored.request(new JSONObject().put("id", "fixture").put("target", "unknown").put("url", "https://evil.fixture/mcp")); fail(); } catch (java.io.IOException expected) { assertTrue(expected.getMessage().contains("未启用")); }
        transport.configure(fixture().put("apiKey", "").put("clearKey", true));
    }
    @Test public void finiteMcpSseStopsOnlyAfterMatchingCompleteResponse() {
        String request = "{\"id\":1,\"method\":\"tools/call\"}";
        assertFalse(AgentTransport.rpcComplete("data: {\"id\":2,\"result\":{}}\n\n", request));
        assertFalse(AgentTransport.rpcComplete("data: {\"id\":1,\"result\":{}}", request));
        assertTrue(AgentTransport.rpcComplete("event: message\r\ndata: {\"id\":1,\"result\":{}}\r\n\r\n", request));
    }
}
