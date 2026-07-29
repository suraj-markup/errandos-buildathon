package ai.errandos.overlay;

public final class OverlayLifecyclePolicyTest {
    public static void main(String[] args) {
        require(
            !OverlayLifecyclePolicy.collapseAllowed(
                true, false, false, false, true, true, false
            ),
            "card must persist throughout Sarvam TTS"
        );
        require(
            OverlayLifecyclePolicy.collapseAllowed(
                true, false, false, false, false, true, false
            ),
            "card may collapse after TTS completes"
        );
        require(
            !OverlayLifecyclePolicy.collapseAllowed(
                true, true, false, false, false, false, false
            ),
            "recording card must persist"
        );
        require(
            !OverlayLifecyclePolicy.collapseAllowed(
                true, false, false, false, false, false, true
            ),
            "paused device must not schedule overlay work"
        );
        require(
            !OverlayLifecyclePolicy.audioPlaybackAllowed(true),
            "lock or doze must suppress newly arriving TTS"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
