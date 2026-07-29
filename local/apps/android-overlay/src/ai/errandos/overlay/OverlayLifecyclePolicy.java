package ai.errandos.overlay;

final class OverlayLifecyclePolicy {
    private OverlayLifecyclePolicy() {}

    static boolean collapseAllowed(
        boolean autoCollapse,
        boolean recording,
        boolean uploading,
        boolean selectionSubmitting,
        boolean speaking,
        boolean keepVisibleWhileSpeaking,
        boolean devicePaused
    ) {
        return autoCollapse
            && !recording
            && !uploading
            && !selectionSubmitting
            && !devicePaused
            && !(speaking && keepVisibleWhileSpeaking);
    }

    static boolean audioPlaybackAllowed(boolean devicePaused) {
        return !devicePaused;
    }
}
