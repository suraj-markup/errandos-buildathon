package ai.errandos.overlay;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public final class AndroidSafetySourceContractTest {
    public static void main(String[] args) throws Exception {
        Path androidRoot = Paths.get(args[0]);
        String manifest = read(androidRoot.resolve("AndroidManifest.xml"));
        String ingress = read(androidRoot.resolve(
            "src/ai/errandos/overlay/StatusIngressPolicy.java"
        ));
        String capability = read(androidRoot.resolve(
            "src/ai/errandos/overlay/StatusIngressCapability.java"
        ));
        String build = read(androidRoot.resolve("build.sh"));
        String gate = read(androidRoot.resolve(
            "src/ai/errandos/overlay/AtomicPersistenceGate.java"
        ));
        String service = read(androidRoot.resolve(
            "src/ai/errandos/overlay/OverlayService.java"
        ));

        absent(manifest, "ai.errandos.overlay.permission.INTERNAL_STATUS");
        contains(ingress, "MessageDigest.isEqual(");
        contains(ingress, "expectedPackage.equals(targetPackage)");
        contains(capability, "new SecureRandom().nextBytes(secret)");
        contains(capability, "StandardCopyOption.ATOMIC_MOVE");
        contains(capability, "status-ingress-capability");
        contains(build, "--debug-mode");
        contains(gate, "if (!committed)");
        before(gate, "rollback.run();", "effect.run();");
        contains(service, "Context.RECEIVER_EXPORTED");
        contains(service, "StatusIngressCapability.loadOrCreate(");
        contains(service, "StatusIngressPolicy.EXTRA_CAPABILITY");
        contains(service, "intent.getPackage()");
        absent(service, "StatusIngressPolicy.SIGNATURE_PERMISSION");
        contains(service, "AtomicPersistenceGate.persistBeforeEffects(");
        contains(service, "task_events.effects_blocked_persist_failed");
        contains(service, "taskChecklistState.applyResetSnapshot(");
        contains(service, "task_events.retention_reset_hydrated");
        contains(service, "/api/voice/synthesis");
        contains(service, "synthesis identity mismatch");
        contains(service, "player != mediaPlayer");
        contains(service, "task.cancelled_terminal");
    }

    private static String read(Path path) throws Exception {
        return new String(
            Files.readAllBytes(path),
            StandardCharsets.UTF_8
        );
    }

    private static void contains(String source, String expected) {
        if (!source.contains(expected)) {
            throw new AssertionError("missing safety source contract: " + expected);
        }
    }

    private static void absent(String source, String forbidden) {
        if (source.contains(forbidden)) {
            throw new AssertionError(
                "unsafe source contract present: " + forbidden
            );
        }
    }

    private static void before(
        String source,
        String first,
        String second
    ) {
        int firstIndex = source.indexOf(first);
        int secondIndex = source.indexOf(second);
        if (firstIndex < 0 || secondIndex <= firstIndex) {
            throw new AssertionError(
                "expected safety order: " + first + " before " + second
            );
        }
    }
}
