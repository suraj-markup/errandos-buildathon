package ai.errandos.overlay;

/**
 * Releases observable effects only after a synchronous durable commit.
 *
 * Callers may stage reducer/cursor changes before entering the gate. When the
 * commit fails or throws, {@code rollback} must restore that in-memory state.
 * Render, haptic, accessibility, and speech effects are never invoked on that
 * path.
 */
final class AtomicPersistenceGate {
    interface Commit {
        boolean run() throws Exception;
    }

    interface Rollback {
        void run();
    }

    interface Effect {
        void run();
    }

    private AtomicPersistenceGate() {}

    static boolean persistBeforeEffects(
        Commit commit,
        Rollback rollback,
        Effect... effects
    ) {
        if (commit == null || rollback == null) {
            throw new IllegalArgumentException(
                "commit and rollback are required"
            );
        }
        boolean committed = false;
        try {
            committed = commit.run();
        } catch (Exception ignored) {
            // Persistence exceptions fail closed exactly like commit=false.
        }
        if (!committed) {
            try {
                rollback.run();
            } catch (RuntimeException ignored) {
                // Never release effects after either persistence or rollback
                // failure. The caller can reconcile from durable state.
            }
            return false;
        }
        if (effects != null) {
            for (Effect effect : effects) {
                if (effect != null) effect.run();
            }
        }
        return true;
    }
}
