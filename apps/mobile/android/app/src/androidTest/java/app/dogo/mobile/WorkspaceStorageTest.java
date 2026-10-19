package app.dogo.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import android.util.AtomicFile;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Native filesystem check only; never touches a user's actual workspace. */
@RunWith(AndroidJUnit4.class)
public class WorkspaceStorageTest {
    @Test
    public void atomicFileRetainsLastCommitAfterInterruptedWrite() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("app.dogo.mobile.devtest", context.getPackageName());
        File target = File.createTempFile("dogo-storage-test-", ".json", context.getCacheDir());
        AtomicFile file = new AtomicFile(target);
        try {
            FileOutputStream first = file.startWrite();
            first.write("{\"version\":1}".getBytes(StandardCharsets.UTF_8));
            first.getFD().sync();
            file.finishWrite(first);
            FileOutputStream interrupted = file.startWrite();
            interrupted.write("broken".getBytes(StandardCharsets.UTF_8));
            file.failWrite(interrupted);
            assertEquals("{\"version\":1}", new String(new AtomicFile(target).readFully(), StandardCharsets.UTF_8));
        } finally { file.delete(); }
    }
}
