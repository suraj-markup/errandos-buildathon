package ai.errandos.overlay;

public final class StatusIngressPolicyTest {
    public static void main(String[] args) {
        String packageName = "ai.errandos.overlay";
        String capability =
            "1234567890123456789012345678901234567890123";
        require(
            !StatusIngressPolicy.accepts(
                StatusIngressPolicy.ACTION,
                packageName,
                packageName,
                null,
                capability
            ),
            "missing capability must be rejected"
        );
        require(
            StatusIngressPolicy.accepts(
                StatusIngressPolicy.ACTION,
                packageName,
                packageName,
                capability,
                capability
            ),
            "package-explicit capability-authenticated STATUS should pass"
        );
        require(
            !StatusIngressPolicy.accepts(
                StatusIngressPolicy.ACTION,
                packageName,
                packageName,
                "0234567890123456789012345678901234567890123",
                capability
            ),
            "wrong capability must be rejected"
        );
        require(
            !StatusIngressPolicy.accepts(
                "ai.errandos.overlay.STATUS.evil",
                packageName,
                packageName,
                capability,
                capability
            ),
            "action matching must be exact"
        );
        require(
            !StatusIngressPolicy.accepts(
                StatusIngressPolicy.ACTION,
                null,
                packageName,
                capability,
                capability
            ),
            "implicit broadcasts must fail closed"
        );
        require(
            !StatusIngressPolicy.accepts(
                StatusIngressPolicy.ACTION,
                "ai.errandos.attacker",
                packageName,
                capability,
                capability
            ),
            "wrong target package must fail closed"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
