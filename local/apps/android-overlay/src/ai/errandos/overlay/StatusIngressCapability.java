package ai.errandos.overlay;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * Creates the per-install capability used to authenticate adb status ingress.
 *
 * The file lives below the app-private files directory. The host may read it
 * with {@code adb shell run-as ai.errandos.overlay cat
 * files/status-ingress-capability}; ordinary shell and other apps cannot.
 */
final class StatusIngressCapability {
    static final String FILE_NAME = "status-ingress-capability";
    private static final int SECRET_BYTES = 32;

    private StatusIngressCapability() {}

    static String loadOrCreate(File filesDirectory) throws IOException {
        if (filesDirectory == null) {
            throw new IOException("missing private files directory");
        }
        if (!filesDirectory.isDirectory() && !filesDirectory.mkdirs()) {
            throw new IOException("unable to create private files directory");
        }

        File capabilityFile = new File(filesDirectory, FILE_NAME);
        String existing = readValid(capabilityFile);
        if (existing != null) return existing;

        byte[] secret = new byte[SECRET_BYTES];
        new SecureRandom().nextBytes(secret);
        String capability = Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(secret);
        File staged = File.createTempFile(
            FILE_NAME + ".",
            ".tmp",
            filesDirectory
        );
        restrictToOwner(staged);
        boolean installed = false;
        try {
            FileOutputStream output = new FileOutputStream(staged, false);
            try {
                output.write(capability.getBytes(StandardCharsets.US_ASCII));
                output.write('\n');
                output.getFD().sync();
            } finally {
                output.close();
            }
            restrictToOwner(staged);
            try {
                Files.move(
                    staged.toPath(),
                    capabilityFile.toPath(),
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                );
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(
                    staged.toPath(),
                    capabilityFile.toPath(),
                    StandardCopyOption.REPLACE_EXISTING
                );
            }
            restrictToOwner(capabilityFile);
            installed = true;
            return capability;
        } finally {
            if (!installed) staged.delete();
        }
    }

    private static String readValid(File capabilityFile) {
        if (!capabilityFile.isFile()) return null;
        try {
            String candidate = new String(
                Files.readAllBytes(capabilityFile.toPath()),
                StandardCharsets.US_ASCII
            ).trim();
            if (candidate.length() != 43) return null;
            byte[] decoded = Base64.getUrlDecoder().decode(candidate);
            if (decoded.length != SECRET_BYTES) return null;
            restrictToOwner(capabilityFile);
            return candidate;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void restrictToOwner(File file) throws IOException {
        if (
            !file.setReadable(false, false)
                || !file.setWritable(false, false)
                || !file.setExecutable(false, false)
                || !file.setReadable(true, true)
                || !file.setWritable(true, true)
        ) {
            throw new IOException("unable to restrict ingress capability");
        }
    }
}
