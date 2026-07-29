package ai.errandos.overlay;

final class MotionPolicy {
    private MotionPolicy() {}

    static boolean animationsEnabled(
        float animatorDurationScale,
        boolean powerSaveMode
    ) {
        return animatorDurationScale > 0f && !powerSaveMode;
    }

    static float waveformLevel(byte[] waveform, int count) {
        if (waveform == null || count <= 0) return 0f;
        int limit = Math.min(count, waveform.length);
        double squared = 0d;
        for (int index = 0; index < limit; index += 1) {
            float centered = (waveform[index] & 0xff) - 128f;
            squared += centered * centered;
        }
        float rms = (float) Math.sqrt(squared / limit) / 128f;
        return Math.max(0f, Math.min(1f, rms * 1.8f));
    }
}
