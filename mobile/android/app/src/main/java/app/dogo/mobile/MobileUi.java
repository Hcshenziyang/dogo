package app.dogo.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Shared native visual primitives. Screen composition and actions stay in the Activity. */
final class MobileUi {
    final Context context;
    final boolean dark;
    final int background, surface, text, muted, line, accent, tint, onAccent, danger;

    MobileUi(Context context) {
        this.context = context;
        dark = (context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        background = dark ? 0xff121a19 : 0xfff5f7f5;
        surface = dark ? 0xff1d2927 : 0xffffffff;
        text = dark ? 0xffe6eeeb : 0xff203a34;
        muted = dark ? 0xffa2b4ad : 0xff677c74;
        line = dark ? 0xff34443e : 0xffe1e8e3;
        accent = dark ? 0xff9bd8be : 0xff22664f;
        tint = dark ? 0xff253d34 : 0xffe5f0e8;
        onAccent = dark ? 0xff173a2b : 0xffffffff;
        danger = dark ? 0xffffb2a7 : 0xffa94336;
    }

    int dp(int size) { return Math.round(size * context.getResources().getDisplayMetrics().density); }

    GradientDrawable shape(int color, int radius, int border) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        if (border != 0) drawable.setStroke(dp(1), border);
        return drawable;
    }

    RippleDrawable ripple(int color, int radius) {
        return new RippleDrawable(ColorStateList.valueOf(dark ? 0x229bd8be : 0x1922664f),
                shape(color, radius, 0), shape(0xffffffff, radius, 0));
    }

    TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        view.setFontFeatureSettings("kern");
        view.setIncludeFontPadding(false);
        view.setLineSpacing(dp(4), 1f);
        if (bold) view.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return view;
    }

    LinearLayout column() {
        LinearLayout view = new LinearLayout(context);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    LinearLayout row() {
        LinearLayout view = new LinearLayout(context);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setOrientation(LinearLayout.HORIZONTAL);
        return view;
    }

    Button button(String title, boolean primary, boolean destructive) {
        Button button = new Button(context);
        button.setText(title);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        button.setTextColor(new ColorStateList(new int[][] {new int[]{-android.R.attr.state_enabled}, new int[]{}},
                new int[] {muted, destructive ? danger : primary ? onAccent : accent}));
        button.setBackground(ripple(primary ? accent : surface, 16));
        button.setMinHeight(dp(48));
        button.setMinimumHeight(dp(48));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(16), dp(10), dp(16), dp(10));
        button.setMaxLines(2);
        button.setEllipsize(android.text.TextUtils.TruncateAt.END);
        button.setStateListAnimator(null);
        return button;
    }

    StateListDrawable inputBackground() {
        StateListDrawable drawable = new StateListDrawable();
        drawable.addState(new int[]{android.R.attr.state_focused}, shape(surface, 14, accent));
        drawable.addState(new int[]{}, shape(surface, 14, line));
        return drawable;
    }

    android.graphics.drawable.Drawable spinnerBackground() {
        android.graphics.drawable.Drawable arrow = new android.graphics.drawable.Drawable() {
            private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            @Override public void draw(android.graphics.Canvas canvas) {
                android.graphics.Rect bounds = getBounds();
                float x = bounds.right - dp(22), y = bounds.centerY();
                paint.setColor(muted);
                paint.setStrokeWidth(dp(2));
                paint.setStyle(android.graphics.Paint.Style.STROKE);
                paint.setStrokeCap(android.graphics.Paint.Cap.ROUND);
                canvas.drawLine(x - dp(4), y - dp(2), x, y + dp(2), paint);
                canvas.drawLine(x, y + dp(2), x + dp(4), y - dp(2), paint);
            }
            @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
            @Override public void setColorFilter(android.graphics.ColorFilter filter) { paint.setColorFilter(filter); }
            @SuppressWarnings("deprecation")
            @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
        };
        return new android.graphics.drawable.LayerDrawable(
                new android.graphics.drawable.Drawable[]{shape(surface, 14, line), arrow});
    }

    LinearLayout.LayoutParams spaced(int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(bottom);
        return params;
    }
}
