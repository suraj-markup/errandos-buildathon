package ai.errandos.overlay;

public final class TaskEventSubscriptionStateTest {
    public static void main(String[] args) {
        TaskEventSubscriptionState state = new TaskEventSubscriptionState();
        state.bindIdentity(
            "task_12345678",
            -1,
            2,
            "operation_12345678"
        );
        require(
            state.accept(
                "task_12345678",
                0,
                2,
                "operation_12345678",
                false
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "first retained event"
        );
        require(
            state.accept(
                "task_12345678",
                0,
                2,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.STALE,
            "duplicate must be stale"
        );
        require(
            state.accept(
                "task_12345678",
                2,
                2,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.GAP,
            "gap must reconnect without cursor advance"
        );
        require(state.lastSequence() == 0, "gap must preserve cursor");
        require(
            state.accept(
                "task_12345678",
                1,
                1,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.STALE,
            "older task revision must be stale"
        );
        require(
            state.accept(
                "task_87654321",
                1,
                3,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.WRONG_TASK,
            "cross-task event must fail closed"
        );

        TaskEventSubscriptionState.Checkpoint beforeReset =
            state.checkpoint();
        require(
            state.applyReset("task_12345678", 5, 8),
            "retention reset must apply to bound task"
        );
        require(state.lastSequence() == 4, "reset reconnect predecessor");
        state.restore(beforeReset);
        require(
            state.lastSequence() == 0,
            "checkpoint rollback must restore durable cursor"
        );
        require(
            state.applyReset("task_12345678", 5, 8),
            "reset can be staged again after rollback"
        );
        require(
            state.accept(
                "task_12345678",
                5,
                3,
                "operation_87654321",
                false
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "ambiguous reconciliation event after reset"
        );
        require(
            !state.terminal(),
            "ambiguity must not stop reconciliation polling"
        );
        require(
            state.accept(
                "task_12345678",
                6,
                3,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "reviewing_cart must follow ambiguity"
        );
        require(
            state.accept(
                "task_12345678",
                7,
                4,
                null,
                true
            ) == TaskEventSubscriptionState.Decision.ACCEPTED,
            "explicit cancelled terminal event"
        );
        require(state.terminal(), "cancelled event must stop polling");
        require(
            state.accept(
                "task_12345678",
                8,
                4,
                null,
                false
            ) == TaskEventSubscriptionState.Decision.STALE,
            "post-terminal update must be rejected"
        );

        TaskEventSubscriptionState restarted =
            new TaskEventSubscriptionState();
        restarted.restore(
            state.taskId(),
            state.lastSequence(),
            state.taskRevision(),
            state.operationId(),
            state.terminal()
        );
        require(restarted.terminal(), "restart retains cancelled terminal");
        require(
            restarted.accept(
                "task_12345678",
                7,
                4,
                null,
                true
            ) == TaskEventSubscriptionState.Decision.STALE,
            "duplicate terminal race after restart must be stale"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
