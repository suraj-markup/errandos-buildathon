package ai.errandos.overlay;

public final class AtomicPersistenceGateTest {
    public static void main(String[] args) {
        commitFailureRollsBackCursorAndBlocksEveryEffect();
        commitExceptionRollsBackAndBlocksEveryEffect();
        successfulCommitReleasesEffectsInOrder();
    }

    private static void commitFailureRollsBackCursorAndBlocksEveryEffect() {
        final int[] cursor = new int[] { 7 };
        final int[] effects = new int[] { 0, 0, 0, 0 };
        final int durableCursor = cursor[0];
        cursor[0] = 8;

        boolean released = AtomicPersistenceGate.persistBeforeEffects(
            new AtomicPersistenceGate.Commit() {
                @Override
                public boolean run() {
                    return false;
                }
            },
            new AtomicPersistenceGate.Rollback() {
                @Override
                public void run() {
                    cursor[0] = durableCursor;
                }
            },
            increment(effects, 0),
            increment(effects, 1),
            increment(effects, 2),
            increment(effects, 3)
        );

        require(!released, "commit=false must keep the gate closed");
        require(cursor[0] == 7, "failed commit must not advance cursor");
        require(effects[0] == 0, "render must be blocked");
        require(effects[1] == 0, "haptic must be blocked");
        require(effects[2] == 0, "TalkBack must be blocked");
        require(effects[3] == 0, "TTS must be blocked");
    }

    private static void commitExceptionRollsBackAndBlocksEveryEffect() {
        final int[] cursor = new int[] { 11 };
        final int[] effectCount = new int[] { 0 };
        final int durableCursor = cursor[0];
        cursor[0] = 12;

        boolean released = AtomicPersistenceGate.persistBeforeEffects(
            new AtomicPersistenceGate.Commit() {
                @Override
                public boolean run() throws Exception {
                    throw new Exception("storage unavailable");
                }
            },
            new AtomicPersistenceGate.Rollback() {
                @Override
                public void run() {
                    cursor[0] = durableCursor;
                }
            },
            increment(effectCount, 0)
        );

        require(!released, "commit exception must keep the gate closed");
        require(cursor[0] == 11, "exception must restore cursor");
        require(effectCount[0] == 0, "exception must block effects");
    }

    private static void successfulCommitReleasesEffectsInOrder() {
        final StringBuilder order = new StringBuilder();
        boolean released = AtomicPersistenceGate.persistBeforeEffects(
            new AtomicPersistenceGate.Commit() {
                @Override
                public boolean run() {
                    order.append("commit");
                    return true;
                }
            },
            new AtomicPersistenceGate.Rollback() {
                @Override
                public void run() {
                    order.append("rollback");
                }
            },
            append(order, ":render"),
            append(order, ":haptic"),
            append(order, ":talkback"),
            append(order, ":tts")
        );

        require(released, "successful commit must open the gate");
        require(
            "commit:render:haptic:talkback:tts".equals(order.toString()),
            "effects must follow persistence in declared order"
        );
    }

    private static AtomicPersistenceGate.Effect increment(
        final int[] values,
        final int index
    ) {
        return new AtomicPersistenceGate.Effect() {
            @Override
            public void run() {
                values[index] += 1;
            }
        };
    }

    private static AtomicPersistenceGate.Effect append(
        final StringBuilder target,
        final String value
    ) {
        return new AtomicPersistenceGate.Effect() {
            @Override
            public void run() {
                target.append(value);
            }
        };
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
