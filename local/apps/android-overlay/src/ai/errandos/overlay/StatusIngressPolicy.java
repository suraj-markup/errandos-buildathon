package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Defense-in-depth policy for the overlay status broadcast.
 *
 * The exported dynamic receiver is reachable only through a package-explicit
 * intent and requires a random capability stored in the app-private files
 * directory. This permits adb shell delivery without trusting the shell UID.
 */
final class StatusIngressPolicy {
    static final String ACTION = "ai.errandos.overlay.STATUS";
    static final String EXTRA_CAPABILITY = "ingressCapability";

    private StatusIngressPolicy() {}

    static boolean accepts(
        String action,
        String targetPackage,
        String expectedPackage,
        String suppliedCapability,
        String expectedCapability
    ) {
        if (
            !ACTION.equals(action)
                || expectedPackage == null
                || !expectedPackage.equals(targetPackage)
                || suppliedCapability == null
                || expectedCapability == null
                || suppliedCapability.length() != expectedCapability.length()
        ) {
            return false;
        }
        return MessageDigest.isEqual(
            suppliedCapability.getBytes(StandardCharsets.UTF_8),
            expectedCapability.getBytes(StandardCharsets.UTF_8)
        );
    }
}
