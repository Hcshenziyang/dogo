package app.dogo.mobile;

import static org.junit.Assert.*;
import android.app.Instrumentation;
import android.content.*;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Runs the packaged UI and real native store, with synthetic model replies at the test-only bridge. */
@RunWith(AndroidJUnit4.class)
public class AgentUiTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private String js(MainActivity activity, String source) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        instrumentation.runOnMainSync(() -> activity.getBridge().getWebView().evaluateJavascript(source, value -> { result.set(value); done.countDown(); }));
        assertTrue(done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void waitFor(MainActivity activity, String expression) throws Exception {
        for (int n = 0; n < 120; n++) { if ("true".equals(js(activity, expression))) return; Thread.sleep(100); }
        fail("UI condition not reached: " + expression + " / " + js(activity, "document.body.innerText.slice(-2400)"));
    }
    private MainActivity launch(Context context) { return (MainActivity) instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
    private void click(MainActivity activity, String label) throws Exception { js(activity, "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===" + JSONObject.quote(label) + ")?.click()"); }
    @Test public void standaloneChatToolApprovalAndFullActivityRestartKeepHistory() throws Exception {
        Context context = instrumentation.getTargetContext(); assertTrue(context.getPackageName().endsWith(".devtest"));
        new AgentTransport(context).configure(new JSONObject().put("endpoint", "https://model.fixture/v1").put("model", "fixture").put("apiKey", "")
            .put("clearKey", true).put("mcp", new JSONArray()).put("skills", new JSONArray()));
        MainActivity activity = launch(context);
        try {
            waitFor(activity, "document.body.innerText.includes('资料箱')");
            click(activity, "对话"); waitFor(activity, "document.body.innerText.includes('随身聊一聊')");
            waitFor(activity, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='新对话'&&!b.disabled)");
            // Replace only model requests, in the disposable debug WebView. Native vault/store/memory remain real.
            js(activity, "window.__fixtureCalls=0;window.__realNativePromise=window.Capacitor.nativePromise;window.Capacitor.nativePromise=function(plugin,method,options){if(plugin==='DogoAgent'&&method==='request'&&options.target==='model'){window.__fixtureCalls++;const first=window.__fixtureCalls===1;return Promise.resolve({status:200,headers:{'content-type':'application/json'},body:JSON.stringify({id:'ui-fixture',model:'fixture',created:1,choices:[{index:0,finish_reason:first?'tool_calls':'stop',message:first?{role:'assistant',content:null,tool_calls:[{id:'ui-call',type:'function',function:{name:'dogo_memory_list',arguments:'{}'}}]}:{role:'assistant',content:'PHONE_UI_FIXTURE_731 已完成'}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})});}return window.__realNativePromise.apply(this,arguments)};");
            click(activity, "新对话"); waitFor(activity, "!!document.querySelector('textarea[aria-label=\"手机对话输入\"]')");
            js(activity, "(()=>{const e=document.querySelector('textarea[aria-label=\"手机对话输入\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'PHONE_UI_FIXTURE_731');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
            waitFor(activity, "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='发送'&&!b.disabled)"); click(activity, "发送");
            waitFor(activity, "document.body.innerText.includes('允许这次工具调用')");
            assertEquals("1", js(activity, "window.__fixtureCalls"));
            click(activity, "允许本次"); waitFor(activity, "document.body.innerText.includes('PHONE_UI_FIXTURE_731 已完成')");
            assertEquals("2", js(activity, "window.__fixtureCalls"));
            assertEquals("true", js(activity, "document.documentElement.scrollWidth<=window.innerWidth+1"));
            MainActivity first = activity; instrumentation.runOnMainSync(first::finish); Thread.sleep(300);
            activity = launch(context); waitFor(activity, "document.body.innerText.includes('资料箱')"); click(activity, "对话");
            waitFor(activity, "document.body.innerText.includes('PHONE_UI_FIXTURE_731 已完成')");
            assertEquals("false", js(activity, "document.body.innerText.includes('允许这次工具调用')"));
        } finally { MainActivity last = activity; instrumentation.runOnMainSync(last::finish); }
    }
}
