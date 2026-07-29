package ai.errandos.overlay;

public final class MotionPolicyTest {
    public static void main(String[] args) {
        require(
            MotionPolicy.animationsEnabled(1f, false),
            "normal motion must be enabled"
        );
        require(
            !MotionPolicy.animationsEnabled(0f, false),
            "system reduced motion must disable animation"
        );
        require(
            !MotionPolicy.animationsEnabled(1f, true),
            "power save must disable decorative animation"
        );
        require(
            MotionPolicy.waveformLevel(new byte[]{-128, -128, -128}, 3)
                == 0f,
            "centered waveform must be silent"
        );
        require(
            MotionPolicy.waveformLevel(new byte[]{0, 127, 0, 127}, 4)
                > 0.5f,
            "real waveform energy must drive speaking motion"
        );
        require(
            MotionPolicy.waveformLevel(null, 0) == 0f,
            "missing waveform must be safe"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
