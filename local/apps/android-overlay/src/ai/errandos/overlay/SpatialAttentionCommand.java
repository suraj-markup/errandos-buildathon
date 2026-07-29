package ai.errandos.overlay;

import android.graphics.RectF;

import org.json.JSONObject;

final class SpatialAttentionCommand {
    static final int VERSION = 1;

    final String operationId;
    final String observationId;
    final String screenFingerprint;
    final long expiresAtEpochMs;
    final RectF overlayRectPx;
    final int overlayWidthPx;
    final int overlayHeightPx;
    final int overlayDensityDpi;
    final int overlayRotationDegrees;

    private SpatialAttentionCommand(
        String operationId,
        String observationId,
        String screenFingerprint,
        long expiresAtEpochMs,
        RectF overlayRectPx,
        int overlayWidthPx,
        int overlayHeightPx,
        int overlayDensityDpi,
        int overlayRotationDegrees
    ) {
        this.operationId = operationId;
        this.observationId = observationId;
        this.screenFingerprint = screenFingerprint;
        this.expiresAtEpochMs = expiresAtEpochMs;
        this.overlayRectPx = overlayRectPx;
        this.overlayWidthPx = overlayWidthPx;
        this.overlayHeightPx = overlayHeightPx;
        this.overlayDensityDpi = overlayDensityDpi;
        this.overlayRotationDegrees = overlayRotationDegrees;
    }

    static SpatialAttentionCommand parse(JSONObject payload, long nowEpochMs) {
        if (payload == null || payload.optInt("version", -1) != VERSION) {
            throw new IllegalArgumentException("invalid attention version");
        }
        String operationId = boundedId(payload, "operationId");
        String observationId = boundedId(payload, "observationId");
        String fingerprint = boundedId(payload, "screenFingerprint");
        long expiresAt = payload.optLong("expiresAtEpochMs", -1L);
        if (expiresAt <= nowEpochMs || expiresAt > nowEpochMs + 10000L) {
            throw new IllegalArgumentException("invalid attention expiry");
        }

        JSONObject normalized = payload.optJSONObject("normalizedRect");
        if (
            normalized == null
                || !validNormalized(
                    finite(normalized, "left"),
                    finite(normalized, "top"),
                    finite(normalized, "right"),
                    finite(normalized, "bottom")
                )
        ) {
            throw new IllegalArgumentException("invalid normalized rectangle");
        }

        JSONObject display = payload.optJSONObject("display");
        if (display == null) {
            throw new IllegalArgumentException("missing display metadata");
        }
        int overlayWidth = positiveInt(display, "overlayWidthPx");
        int overlayHeight = positiveInt(display, "overlayHeightPx");
        int overlayDensity = positiveInt(display, "overlayDensityDpi");
        int overlayRotation = rotation(display, "overlayRotationDegrees");

        JSONObject rect = payload.optJSONObject("overlayRectPx");
        if (rect == null) {
            throw new IllegalArgumentException("missing overlay rectangle");
        }
        float left = finite(rect, "left");
        float top = finite(rect, "top");
        float right = finite(rect, "right");
        float bottom = finite(rect, "bottom");
        if (
            left < 0f
                || top < 0f
                || right > overlayWidth
                || bottom > overlayHeight
                || right - left < 1f
                || bottom - top < 1f
        ) {
            throw new IllegalArgumentException("invalid overlay rectangle");
        }
        return new SpatialAttentionCommand(
            operationId,
            observationId,
            fingerprint,
            expiresAt,
            new RectF(left, top, right, bottom),
            overlayWidth,
            overlayHeight,
            overlayDensity,
            overlayRotation
        );
    }

    boolean matchesDisplay(
        int widthPx,
        int heightPx,
        int densityDpi,
        int rotationDegrees
    ) {
        return widthPx == overlayWidthPx
            && heightPx == overlayHeightPx
            && densityDpi == overlayDensityDpi
            && rotationDegrees == overlayRotationDegrees;
    }

    private static String boundedId(JSONObject payload, String name) {
        String value = payload.optString(name, "").trim();
        if (value.isEmpty() || value.length() > 200) {
            throw new IllegalArgumentException("invalid attention binding");
        }
        return value;
    }

    private static int positiveInt(JSONObject payload, String name) {
        int value = payload.optInt(name, -1);
        if (value <= 0) {
            throw new IllegalArgumentException("invalid display metadata");
        }
        return value;
    }

    private static int rotation(JSONObject payload, String name) {
        int value = payload.optInt(name, -1);
        if (value != 0 && value != 90 && value != 180 && value != 270) {
            throw new IllegalArgumentException("invalid display rotation");
        }
        return value;
    }

    private static float finite(JSONObject payload, String name) {
        double value = payload.optDouble(name, Double.NaN);
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            throw new IllegalArgumentException("invalid attention number");
        }
        return (float) value;
    }

    private static boolean validNormalized(
        float left,
        float top,
        float right,
        float bottom
    ) {
        return left >= 0f
            && top >= 0f
            && right <= 1f
            && bottom <= 1f
            && left < right
            && top < bottom;
    }
}
