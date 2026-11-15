package app.dogo.mobile;

import android.text.Spanned;
import android.text.style.StrikethroughSpan;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import io.noties.markwon.Markwon;
import io.noties.markwon.core.spans.EmphasisSpan;
import io.noties.markwon.core.spans.StrongEmphasisSpan;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class MarkdownRendererTest {
    @Test public void rendersMarkdownWithRealAndroidSpans() {
        Markwon markdown = MarkdownRenderer.create(InstrumentationRegistry.getInstrumentation().getTargetContext());
        Spanned result = markdown.toMarkdown("**加粗**、*斜体*、~~删除~~和 `代码`\n\n- 列表");
        assertFalse(result.toString().contains("**"));
        assertTrue(result.toString().contains("加粗"));
        assertFalse(result.toString().contains("~~"));
        assertTrue("bold span", result.getSpans(0, result.length(), StrongEmphasisSpan.class).length > 0);
        assertTrue("italic span", result.getSpans(0, result.length(), EmphasisSpan.class).length > 0);
        assertTrue("strikethrough span", result.getSpans(0, result.length(), StrikethroughSpan.class).length > 0);
    }
}
