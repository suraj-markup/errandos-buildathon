package ai.errandos.overlay;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.animation.LinearInterpolator;

final class CompanionGlyphView extends View {
    private static final int LIME = Color.rgb(202, 255, 69);
    private static final int AMBER = Color.rgb(255, 200, 87);
    private static final int RED = Color.rgb(255, 107, 107);
    private static final int TEXT = Color.rgb(247, 250, 245);

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF arcBounds = new RectF();
    private final ValueAnimator motion;
    private String mode = "idle";
    private String tone = "neutral";
    private float audioLevel;
    private float motionPhase;
    private boolean motionEnabled = true;

    CompanionGlyphView(Context context) {
        super(context);
        setLayerType(View.LAYER_TYPE_SOFTWARE, null);
        motion = ValueAnimator.ofFloat(0f, 1f);
        motion.setDuration(900L);
        motion.setRepeatCount(ValueAnimator.INFINITE);
        motion.setInterpolator(new LinearInterpolator());
        motion.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
            @Override
            public void onAnimationUpdate(ValueAnimator animation) {
                motionPhase = (Float) animation.getAnimatedValue();
                invalidate();
            }
        });
        refreshMotionPreference();
    }

    void setMode(String nextMode, String nextTone) {
        refreshMotionPreference();
        mode = nextMode == null ? "idle" : nextMode;
        tone = nextTone == null ? "neutral" : nextTone;
        if (motionEnabled && isAnimatedMode()) {
            if (!motion.isStarted()) motion.start();
        } else {
            motion.cancel();
            motionPhase = 0f;
        }
        invalidate();
    }

    void setAudioLevel(float nextLevel) {
        audioLevel = Math.max(0f, Math.min(nextLevel, 1f));
        if ("listening".equals(mode) || "responding".equals(mode)) {
            invalidate();
        }
    }

    void refreshMotionPreference() {
        float animatorScale = Settings.Global.getFloat(
            getContext().getContentResolver(),
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f
        );
        PowerManager powerManager = (PowerManager) getContext()
            .getSystemService(Context.POWER_SERVICE);
        motionEnabled = MotionPolicy.animationsEnabled(
            animatorScale,
            powerManager != null && powerManager.isPowerSaveMode()
        );
        if (!motionEnabled) {
            motion.cancel();
            motionPhase = 0f;
        }
    }

    void release() {
        motion.cancel();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float centerX = getWidth() / 2f;
        float centerY = getHeight() / 2f;
        int accent = accentColor();
        paint.setColor(accent);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        paint.setShadowLayer(dp(8f), 0f, 0f, Color.argb(145, Color.red(accent), Color.green(accent), Color.blue(accent)));

        if ("listening".equals(mode)) {
            drawWaveform(canvas, centerX, centerY);
        } else if (isProcessingMode()) {
            drawSpinner(canvas, centerX, centerY);
        } else if ("responding".equals(mode)) {
            drawSpeakingCompanion(canvas, centerX, centerY);
        } else if ("success".equals(mode)) {
            drawCheck(canvas, centerX, centerY);
        } else if ("error".equals(mode) || "ambiguous".equals(mode)) {
            drawAlert(canvas, centerX, centerY);
        } else if ("disconnected".equals(mode)) {
            drawDisconnected(canvas, centerX, centerY);
        } else if ("paused".equals(mode)) {
            drawPaused(canvas, centerX, centerY);
        } else if ("waiting_for_user".equals(mode)) {
            drawWaiting(canvas, centerX, centerY);
        } else {
            drawCompanion(canvas, centerX, centerY, 1f);
        }
    }

    private boolean isAnimatedMode() {
        return "listening".equals(mode)
            || "responding".equals(mode)
            || isProcessingMode();
    }

    private boolean isProcessingMode() {
        return "understanding".equals(mode)
            || "reading".equals(mode)
            || "acting".equals(mode)
            || "verifying".equals(mode);
    }

    private int accentColor() {
        if ("error".equals(tone)) return RED;
        if ("ambiguous".equals(tone) || "attention".equals(tone)) return AMBER;
        if ("neutral".equals(tone)) return TEXT;
        return LIME;
    }

    private void drawWaveform(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.FILL);
        float easedLevel = (float) Math.pow(audioLevel, 0.68);
        float[] profiles = new float[]{0.48f, 0.76f, 1f, 0.76f, 0.48f};
        float barWidth = dp(2.6f);
        float gap = dp(3.2f);
        float totalWidth = barWidth * profiles.length + gap * (profiles.length - 1);
        float startX = centerX - totalWidth / 2f;
        for (int index = 0; index < profiles.length; index += 1) {
            float idlePulse = (float) ((Math.sin(
                motionPhase * Math.PI * 2 + index * 0.7
            ) + 1) * dp(0.8f));
            float height = dp(4f)
                + easedLevel * dp(16f) * profiles[index]
                + idlePulse;
            float left = startX + index * (barWidth + gap);
            canvas.drawRoundRect(
                left,
                centerY - height / 2f,
                left + barWidth,
                centerY + height / 2f,
                barWidth / 2f,
                barWidth / 2f,
                paint
            );
        }
    }

    private void drawSpinner(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2.6f));
        float radius = dp(10f);
        arcBounds.set(
            centerX - radius,
            centerY - radius,
            centerX + radius,
            centerY + radius
        );
        canvas.drawArc(
            arcBounds,
            motionPhase * 360f - 90f,
            268f,
            false,
            paint
        );
    }

    private void drawSpeakingCompanion(Canvas canvas, float centerX, float centerY) {
        float reactiveLevel = motionEnabled ? audioLevel : 0f;
        float pulse = 1f + 0.12f * reactiveLevel;
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.5f));
        paint.setAlpha(Math.round(45f + 90f * reactiveLevel));
        canvas.drawCircle(
            centerX,
            centerY,
            dp(13f) + reactiveLevel * dp(6f),
            paint
        );
        paint.setAlpha(255);
        drawCompanion(canvas, centerX, centerY, pulse);
    }

    private void drawCompanion(
        Canvas canvas,
        float centerX,
        float centerY,
        float scale
    ) {
        paint.setStyle(Paint.Style.FILL);
        float size = dp(12f) * scale;
        path.reset();
        path.moveTo(centerX - size * 0.72f, centerY - size);
        path.lineTo(centerX + size, centerY);
        path.lineTo(centerX - size * 0.72f, centerY + size);
        path.lineTo(centerX - size * 0.22f, centerY);
        path.close();
        canvas.save();
        canvas.rotate(-18f, centerX, centerY);
        canvas.drawPath(path, paint);
        canvas.restore();
    }

    private void drawCheck(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(3f));
        path.reset();
        path.moveTo(centerX - dp(8f), centerY);
        path.lineTo(centerX - dp(2f), centerY + dp(6f));
        path.lineTo(centerX + dp(10f), centerY - dp(8f));
        canvas.drawPath(path, paint);
    }

    private void drawAlert(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2.5f));
        canvas.drawCircle(centerX, centerY, dp(10f), paint);
        canvas.drawLine(
            centerX,
            centerY - dp(5f),
            centerX,
            centerY + dp(2f),
            paint
        );
        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(centerX, centerY + dp(6f), dp(1.5f), paint);
    }

    private void drawWaiting(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.FILL);
        for (int index = -1; index <= 1; index += 1) {
            canvas.drawCircle(
                centerX + index * dp(7f),
                centerY,
                dp(index == 0 ? 2.6f : 2.1f),
                paint
            );
        }
    }

    private void drawPaused(Canvas canvas, float centerX, float centerY) {
        paint.setStyle(Paint.Style.FILL);
        canvas.drawRoundRect(
            centerX - dp(7f),
            centerY - dp(9f),
            centerX - dp(2f),
            centerY + dp(9f),
            dp(2f),
            dp(2f),
            paint
        );
        canvas.drawRoundRect(
            centerX + dp(2f),
            centerY - dp(9f),
            centerX + dp(7f),
            centerY + dp(9f),
            dp(2f),
            dp(2f),
            paint
        );
    }

    private void drawDisconnected(
        Canvas canvas,
        float centerX,
        float centerY
    ) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2.3f));
        arcBounds.set(
            centerX - dp(11f),
            centerY - dp(9f),
            centerX + dp(11f),
            centerY + dp(13f)
        );
        canvas.drawArc(arcBounds, 215f, 110f, false, paint);
        arcBounds.inset(dp(4f), dp(4f));
        canvas.drawArc(arcBounds, 215f, 110f, false, paint);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawCircle(centerX, centerY + dp(7f), dp(1.7f), paint);
        paint.setStyle(Paint.Style.STROKE);
        canvas.drawLine(
            centerX - dp(10f),
            centerY - dp(10f),
            centerX + dp(10f),
            centerY + dp(10f),
            paint
        );
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }
}
