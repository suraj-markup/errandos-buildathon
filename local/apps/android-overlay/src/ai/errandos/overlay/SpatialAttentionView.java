package ai.errandos.overlay;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.provider.Settings;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;

final class SpatialAttentionView extends View {
    private static final int LIME = Color.rgb(202, 255, 69);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final ValueAnimator pulse;
    private String subject;
    private RectF exactTarget;
    private float anchorX;
    private float anchorY;
    private float pulseValue;

    SpatialAttentionView(Context context) {
        super(context);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        stroke.setColor(LIME);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(dp(2.5f));
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setShadowLayer(dp(9f), 0f, 0f, Color.argb(150, 202, 255, 69));

        labelPaint.setColor(LIME);
        labelPaint.setTextSize(dp(10f));
        labelPaint.setFakeBoldText(true);
        labelPaint.setLetterSpacing(0.12f);

        pulse = ValueAnimator.ofFloat(0.38f, 1f);
        pulse.setDuration(900L);
        pulse.setRepeatCount(ValueAnimator.INFINITE);
        pulse.setRepeatMode(ValueAnimator.REVERSE);
        pulse.setInterpolator(new AccelerateDecelerateInterpolator());
        pulse.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator animation) {
                pulseValue = (Float) animation.getAnimatedValue();
                invalidate();
            }
        });
    }

    void show(String nextSubject, float nextAnchorX, float nextAnchorY) {
        showBroad(nextSubject, nextAnchorX, nextAnchorY);
    }

    void showBroad(String nextSubject, float nextAnchorX, float nextAnchorY) {
        subject = nextSubject;
        exactTarget = null;
        anchorX = nextAnchorX;
        anchorY = nextAnchorY;
        setVisibility(VISIBLE);
        startPulseIfAllowed();
        invalidate();
    }

    void showExact(RectF nextTarget, float nextAnchorX, float nextAnchorY) {
        if (nextTarget == null || nextTarget.width() < 1f || nextTarget.height() < 1f) {
            hide();
            return;
        }
        subject = "exact";
        exactTarget = new RectF(nextTarget);
        anchorX = nextAnchorX;
        anchorY = nextAnchorY;
        setVisibility(VISIBLE);
        startPulseIfAllowed();
        invalidate();
    }

    void hide() {
        subject = null;
        exactTarget = null;
        pulse.cancel();
        setVisibility(GONE);
    }

    void release() {
        pulse.cancel();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (subject == null || getWidth() <= 0 || getHeight() <= 0) return;

        RectF target = exactTarget == null
            ? targetFor(subject)
            : clampedExactTarget(exactTarget);
        int alpha = Math.round(115 + pulseValue * 120);
        stroke.setAlpha(alpha);
        labelPaint.setAlpha(alpha);

        if (exactTarget != null) {
            canvas.drawRoundRect(target, dp(16f), dp(16f), stroke);
            canvas.drawLine(
                target.left + dp(12f),
                Math.min(getHeight() - dp(4f), target.bottom + dp(5f)),
                target.right - dp(12f),
                Math.min(getHeight() - dp(4f), target.bottom + dp(5f)),
                stroke
            );
        }
        drawCorners(canvas, target);
        drawArrow(canvas, target);
        canvas.drawText(
            labelFor(subject),
            target.left + dp(8f),
            Math.max(dp(18f), target.top - dp(8f)),
            labelPaint
        );
    }

    private RectF clampedExactTarget(RectF value) {
        float margin = dp(4f);
        return new RectF(
            Math.max(margin, Math.min(value.left, getWidth() - margin)),
            Math.max(margin, Math.min(value.top, getHeight() - margin)),
            Math.max(margin, Math.min(value.right, getWidth() - margin)),
            Math.max(margin, Math.min(value.bottom, getHeight() - margin))
        );
    }

    private void startPulseIfAllowed() {
        float scale = 1f;
        try {
            scale = Settings.Global.getFloat(
                getContext().getContentResolver(),
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f
            );
        } catch (Exception ignored) {
            scale = 1f;
        }
        if (scale <= 0f) {
            pulse.cancel();
            pulseValue = 1f;
        } else if (!pulse.isStarted()) {
            pulse.start();
        }
    }

    private RectF targetFor(String value) {
        float width = getWidth();
        float height = getHeight();
        float left = dp(14f);
        float right = width - dp(14f);
        if ("options".equals(value)) {
            return new RectF(left, height * 0.20f, right, height * 0.76f);
        }
        if ("product".equals(value)) {
            return new RectF(left, height * 0.14f, right, height * 0.68f);
        }
        if ("cart".equals(value)) {
            return new RectF(left, height * 0.28f, right, height * 0.78f);
        }
        if ("checkout".equals(value) || "payment".equals(value)) {
            return new RectF(left, height * 0.30f, right, height * 0.84f);
        }
        if ("address".equals(value)) {
            return new RectF(left, height * 0.20f, right, height * 0.72f);
        }
        if (
            "confirmation".equals(value)
                || "recent_orders".equals(value)
        ) {
            return new RectF(left, height * 0.20f, right, height * 0.66f);
        }
        return new RectF(left, height * 0.24f, right, height * 0.64f);
    }

    private void drawCorners(Canvas canvas, RectF target) {
        float corner = dp(24f);
        float radius = dp(18f);
        path.reset();
        path.moveTo(target.left, target.top + corner);
        path.lineTo(target.left, target.top + radius);
        path.quadTo(target.left, target.top, target.left + radius, target.top);
        path.lineTo(target.left + corner, target.top);

        path.moveTo(target.right - corner, target.top);
        path.lineTo(target.right - radius, target.top);
        path.quadTo(target.right, target.top, target.right, target.top + radius);
        path.lineTo(target.right, target.top + corner);

        path.moveTo(target.right, target.bottom - corner);
        path.lineTo(target.right, target.bottom - radius);
        path.quadTo(
            target.right,
            target.bottom,
            target.right - radius,
            target.bottom
        );
        path.lineTo(target.right - corner, target.bottom);

        path.moveTo(target.left + corner, target.bottom);
        path.lineTo(target.left + radius, target.bottom);
        path.quadTo(
            target.left,
            target.bottom,
            target.left,
            target.bottom - radius
        );
        path.lineTo(target.left, target.bottom - corner);
        canvas.drawPath(path, stroke);
    }

    private void drawArrow(Canvas canvas, RectF target) {
        float endX = anchorX < getWidth() / 2f ? target.left : target.right;
        float endY = Math.max(
            target.top + dp(32f),
            Math.min(anchorY, target.bottom - dp(32f))
        );
        float startX = anchorX;
        float startY = anchorY;
        float direction = endX > startX ? 1f : -1f;

        path.reset();
        path.moveTo(startX, startY);
        path.quadTo(
            startX + direction * dp(34f),
            (startY + endY) / 2f,
            endX,
            endY
        );
        canvas.drawPath(path, stroke);

        path.reset();
        path.moveTo(endX, endY);
        path.lineTo(endX - direction * dp(12f), endY - dp(8f));
        path.moveTo(endX, endY);
        path.lineTo(endX - direction * dp(12f), endY + dp(8f));
        canvas.drawPath(path, stroke);
    }

    private String labelFor(String value) {
        if ("exact".equals(value)) return "LOOK HERE";
        if ("options".equals(value)) return "OPTIONS";
        if ("product".equals(value)) return "PRODUCT";
        if ("cart".equals(value)) return "CART";
        if ("checkout".equals(value)) return "CHECKOUT";
        if ("payment".equals(value)) return "PAYMENT";
        if ("address".equals(value)) return "ADDRESS";
        if ("confirmation".equals(value)) return "CONFIRMED";
        if ("recent_orders".equals(value)) return "RECENT ORDERS";
        return "LOOK HERE";
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
