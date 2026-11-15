package app.dogo.mobile;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import io.noties.markwon.AbstractMarkwonPlugin;
import io.noties.markwon.Markwon;
import io.noties.markwon.MarkwonConfiguration;
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin;
import io.noties.markwon.ext.tables.TablePlugin;
import io.noties.markwon.ext.tasklist.TaskListPlugin;

final class MarkdownRenderer {
    private MarkdownRenderer() {}
    static Markwon create(Context context) {
        return Markwon.builder(context)
                .usePlugin(StrikethroughPlugin.create())
                .usePlugin(TablePlugin.create(context))
                .usePlugin(TaskListPlugin.create(context))
                .usePlugin(new AbstractMarkwonPlugin() {
                    @Override public void configureConfiguration(MarkwonConfiguration.Builder builder) {
                        builder.linkResolver((view, link) -> {
                            Uri uri = Uri.parse(link);
                            String scheme = uri.getScheme();
                            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme)) return;
                            try { context.startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                            catch (ActivityNotFoundException ignored) { /* No app can open this URL. */ }
                        });
                    }
                }).build();
    }
}
