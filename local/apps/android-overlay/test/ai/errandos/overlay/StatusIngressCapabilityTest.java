package ai.errandos.overlay;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public final class StatusIngressCapabilityTest {
    public static void main(String[] args) throws Exception {
        File firstDirectory = Files.createTempDirectory(
            "overlay-ingress-first"
        ).toFile();
        File secondDirectory = Files.createTempDirectory(
            "overlay-ingress-second"
        ).toFile();

        String first = StatusIngressCapability.loadOrCreate(firstDirectory);
        require(first.length() == 43, "capability must contain 256 bits");
        require(
            first.equals(StatusIngressCapability.loadOrCreate(firstDirectory)),
            "capability must remain stable across service restart"
        );
        File stored = new File(
            firstDirectory,
            StatusIngressCapability.FILE_NAME
        );
        require(stored.isFile(), "capability must be stored in private files");
        require(
            first.equals(
                new String(
                    Files.readAllBytes(stored.toPath()),
                    StandardCharsets.US_ASCII
                ).trim()
            ),
            "stored capability must match the authenticated transport token"
        );

        String second = StatusIngressCapability.loadOrCreate(secondDirectory);
        require(
            !first.equals(second),
            "separate installs must not share a capability"
        );

        Files.write(
            stored.toPath(),
            "attacker-controlled".getBytes(StandardCharsets.US_ASCII)
        );
        String rotated = StatusIngressCapability.loadOrCreate(firstDirectory);
        require(
            !first.equals(rotated) && rotated.length() == 43,
            "invalid capability files must fail closed and rotate"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
