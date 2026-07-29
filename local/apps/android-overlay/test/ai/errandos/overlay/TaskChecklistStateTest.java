package ai.errandos.overlay;

import java.util.List;

public final class TaskChecklistStateTest {
    public static void main(String[] args) {
        projectsOrderedChecklistWithoutInventingChecks();
        projectsExactIntermediateAndRecoveryPhases();
        keepsConnectionStatesPresentationOnly();
        preservesVerifiedTruthAcrossRetentionRebase();
        atomicallyHydratesAuthoritativeResetProjection();
        continuesFromAmbiguityThroughCartReconciliation();
        rejectsStaleCrossTaskAndPostTerminalEvents();
        explicitCancellationStopsWithoutInventingSequence();
        restoresWithoutAndroidOrJsonDependencies();
    }

    private static void projectsOrderedChecklistWithoutInventingChecks() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_milk",
            "searching",
            "Searching for milk",
            "Looking for an available match."
        )), "first search");
        require(state.apply(event(
            1,
            1,
            "step_milk",
            "options_ready",
            "Choose milk",
            "Two available matches."
        )), "wait for choice");
        require(state.apply(event(
            2,
            1,
            "step_milk",
            "selection_accepted",
            "Amul milk selected",
            "Preparing the next safe step."
        )), "selected");
        require(state.apply(event(
            3,
            1,
            "step_milk",
            "mutation_started",
            "Adding Amul milk",
            "The cart change is in progress."
        )), "adding");

        TaskChecklistState.Snapshot adding = state.snapshot();
        require(adding.totalItems() == 3, "authoritative total");
        require(adding.items().size() == 3, "all positions projected");
        require(adding.completedCount() == 0, "adding is not checked");
        require(
            adding.items().get(0).phase() == TaskChecklistState.Phase.ADDING,
            "active adding row"
        );
        require(
            adding.items().get(1).phase() == TaskChecklistState.Phase.PENDING,
            "future position remains pending"
        );

        require(state.apply(event(
            4,
            1,
            "step_milk",
            "mutation_verified",
            "Amul milk added",
            "The requested cart state was verified."
        )), "verified");
        TaskChecklistState.Snapshot verified = state.snapshot();
        require(verified.completedCount() == 1, "verified check count");
        require(verified.items().get(0).verified(), "first check");
        require(
            verified.items().get(0).phase()
                == TaskChecklistState.Phase.VERIFIED,
            "verified row"
        );

        require(state.apply(event(
            5,
            1,
            "step_ice_cream",
            "moving_to_next_step",
            "Next: ice cream",
            "Preparing to search for ice cream."
        )), "move to next item");
        TaskChecklistState.Snapshot next = state.snapshot();
        require(next.items().get(0).verified(), "first check retained");
        require(
            next.items().get(1).phase()
                == TaskChecklistState.Phase.SEARCHING,
            "next position becomes active"
        );
        require(
            "step_ice_cream".equals(next.items().get(1).stepId()),
            "next step identity stays with next position"
        );
        require(
            "Next: ice cream".equals(next.activeLabel()),
            "exact retained active label"
        );
    }

    private static void projectsExactIntermediateAndRecoveryPhases() {
        TaskChecklistState state = new TaskChecklistState();
        assertPhase(
            state,
            event(0, 1, "step_a", "searching", "Searching", null),
            TaskChecklistState.Phase.SEARCHING
        );
        assertPhase(
            state,
            event(1, 1, "step_a", "options_ready", "Choose one", null),
            TaskChecklistState.Phase.WAITING
        );
        assertPhase(
            state,
            event(2, 1, "step_a", "selection_accepted", "Chosen", null),
            TaskChecklistState.Phase.SELECTED
        );
        assertPhase(
            state,
            event(3, 1, "step_a", "mutation_started", "Adding", null),
            TaskChecklistState.Phase.ADDING
        );
        assertPhase(
            state,
            event(4, 1, "step_a", "ambiguous", "Checking cart", null),
            TaskChecklistState.Phase.AMBIGUOUS
        );

        TaskChecklistState blocked = new TaskChecklistState();
        assertPhase(
            blocked,
            event(
                0,
                1,
                "step_b",
                "blocked",
                "Phone locked",
                "Unlock your phone to continue."
            ),
            TaskChecklistState.Phase.BLOCKED
        );

        TaskChecklistState reviewing = new TaskChecklistState();
        assertPhase(
            reviewing,
            event(
                0,
                1,
                "step_c",
                "reviewing_cart",
                "Checking your cart",
                null
            ),
            TaskChecklistState.Phase.VERIFYING
        );
    }

    private static void keepsConnectionStatesPresentationOnly() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_milk",
            "mutation_verified",
            "Milk added",
            "Verified."
        )), "verified event");
        require(state.apply(event(
            1,
            1,
            "step_bread",
            "moving_to_next_step",
            "Next: bread",
            null
        )), "next event");

        state.setPaused(true, "Task paused");
        TaskChecklistState.Snapshot paused = state.snapshot();
        require(
            paused.activePhase() == TaskChecklistState.Phase.PAUSED,
            "paused active phase"
        );
        require(paused.completedCount() == 1, "pause preserves check count");
        require(paused.items().get(0).verified(), "verified item stays checked");
        require(
            paused.items().get(1).phase()
                == TaskChecklistState.Phase.PAUSED,
            "remaining item appears paused"
        );

        state.setDisconnected(true, "Phone connection lost");
        TaskChecklistState.Snapshot disconnected = state.snapshot();
        require(
            disconnected.activePhase()
                == TaskChecklistState.Phase.DISCONNECTED,
            "disconnected takes visual precedence"
        );
        require(
            "Phone connection lost".equals(disconnected.activeLabel()),
            "exact disconnection label"
        );
        require(
            disconnected.completedCount() == 1,
            "disconnect cannot create transaction truth"
        );

        state.setDisconnected(false, null);
        state.setPaused(false, null);
        require(
            state.snapshot().activePhase()
                == TaskChecklistState.Phase.SEARCHING,
            "retained phase resumes"
        );
    }

    private static void preservesVerifiedTruthAcrossRetentionRebase() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_milk",
            "mutation_verified",
            "Milk added",
            "Verified."
        )), "verified before retention reset");
        require(state.apply(event(
            1,
            1,
            "step_bread",
            "searching",
            "Searching for bread",
            null
        )), "in-flight item before retention reset");

        state.rebaseForRetention(9);
        TaskChecklistState.Snapshot rebased = state.snapshot();
        require(rebased.lastSequence() == 9, "rebase cursor");
        require(rebased.completedCount() == 1, "verified count retained");
        require(rebased.items().get(0).verified(), "verified row retained");
        require(
            rebased.items().get(1).phase()
                == TaskChecklistState.Phase.PENDING,
            "unretained in-flight state fails closed"
        );
        require(state.apply(event(
            10,
            2,
            "step_bread",
            "searching",
            "Searching for bread",
            null
        )), "retained tail continues after rebase");
    }

    private static void atomicallyHydratesAuthoritativeResetProjection() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_old",
            "mutation_verified",
            "Old milk",
            "Old local state"
        )), "old projection");
        state.setDisconnected(true, "Phone connection lost");

        TaskChecklistState.ResetSnapshot reset =
            new TaskChecklistState.ResetSnapshot(
                "task_12345678",
                12,
                9,
                3,
                TaskChecklistState.Phase.VERIFYING,
                "Reviewing cart",
                false,
                java.util.Arrays.asList(
                    new TaskChecklistState.ResetItem(
                        1,
                        null,
                        "Milk",
                        "500 ml · Qty 1 · ₹29",
                        TaskChecklistState.Phase.VERIFIED,
                        true
                    ),
                    new TaskChecklistState.ResetItem(
                        2,
                        null,
                        "Bread",
                        "400 g · Qty 1 · ₹45",
                        TaskChecklistState.Phase.VERIFIED,
                        true
                    ),
                    new TaskChecklistState.ResetItem(
                        3,
                        "step_cart",
                        "Cart review",
                        "Read-only reconciliation",
                        TaskChecklistState.Phase.VERIFYING,
                        false
                    )
                )
            );
        require(
            state.applyResetSnapshot(reset),
            "complete authoritative reset must hydrate"
        );
        TaskChecklistState.Snapshot hydrated = state.snapshot();
        require(hydrated.lastSequence() == 12, "reset cursor hydrated");
        require(hydrated.taskRevision() == 9, "reset revision hydrated");
        require(hydrated.completedCount() == 2, "reset progress hydrated");
        require(
            hydrated.activePhase() == TaskChecklistState.Phase.VERIFYING,
            "disconnect overlay cleared by reconciliation snapshot"
        );
        require(
            "400 g · Qty 1 · ₹45".equals(
                hydrated.items().get(1).detail()
            ),
            "item detail hydrated"
        );
        require(
            "step_cart".equals(hydrated.items().get(2).stepId()),
            "active item hydrated"
        );

        TaskChecklistState.ResetSnapshot malformed =
            new TaskChecklistState.ResetSnapshot(
                "task_12345678",
                13,
                10,
                2,
                TaskChecklistState.Phase.SEARCHING,
                "Malformed",
                false,
                java.util.Arrays.asList(
                    new TaskChecklistState.ResetItem(
                        1,
                        null,
                        "One",
                        null,
                        TaskChecklistState.Phase.PENDING,
                        false
                    ),
                    new TaskChecklistState.ResetItem(
                        1,
                        null,
                        "Duplicate",
                        null,
                        TaskChecklistState.Phase.PENDING,
                        false
                    )
                )
            );
        require(
            !state.applyResetSnapshot(malformed),
            "partial/duplicate reset must fail atomically"
        );
        require(
            state.snapshot().lastSequence() == 12
                && state.snapshot().completedCount() == 2,
            "failed reset cannot mix cursor and old rows"
        );
    }

    private static void continuesFromAmbiguityThroughCartReconciliation() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_a",
            "ambiguous",
            "Checking what happened",
            "Read-only recovery will not repeat the cart change."
        )), "ambiguity accepted");
        require(
            !state.snapshot().terminal(),
            "ambiguity is a nonterminal reconciliation phase"
        );
        require(state.apply(event(
            1,
            1,
            "step_a",
            "reviewing_cart",
            "Reviewing cart",
            "Checking the current cart without repeating the change."
        )), "reviewing cart accepted after ambiguity");
        require(
            state.snapshot().activePhase()
                == TaskChecklistState.Phase.VERIFYING,
            "disconnect-to-reconcile phase"
        );
        require(state.apply(new RetainedTaskEvent(
            "event_cancelled",
            "task_12345678",
            6,
            "operation_12345678",
            "step_a",
            2,
            "cancelled",
            "Task cancelled",
            "No more phone work will run.",
            1,
            3,
            1002L,
            "visual_only",
            "Task cancelled",
            null,
            null,
            true
        )), "explicit cancellation accepted");
        require(state.snapshot().terminal(), "cancelled projection terminal");
        require(
            state.snapshot().activePhase()
                == TaskChecklistState.Phase.CANCELLED,
            "cancelled phase projected exactly"
        );
    }

    private static void rejectsStaleCrossTaskAndPostTerminalEvents() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            4,
            1,
            "step_a",
            "searching",
            "Searching",
            null
        )), "retention window may start above zero");
        require(!state.apply(event(
            4,
            1,
            "step_a",
            "mutation_verified",
            "Not accepted",
            null
        )), "duplicate rejected");
        require(!state.apply(new RetainedTaskEvent(
            "event_wrong",
            "task_87654321",
            5,
            "operation_12345678",
            "step_a",
            5,
            "mutation_verified",
            "Not accepted",
            null,
            1,
            3,
            1005L,
            "visual_only",
            "Not accepted",
            null,
            null
        )), "cross-task rejected");
        require(state.snapshot().completedCount() == 0, "no false check");

        TaskChecklistState terminal = new TaskChecklistState();
        require(terminal.apply(event(
            0,
            1,
            "step_a",
            "completed",
            "Cart ready",
            null
        )), "terminal accepted");
        require(terminal.snapshot().terminal(), "terminal projected");
        require(!terminal.apply(event(
            1,
            1,
            "step_a",
            "searching",
            "Late search",
            null
        )), "post-terminal rejected");
        require(
            terminal.snapshot().completedCount() == 0,
            "task completion cannot invent item checks"
        );
    }

    private static void explicitCancellationStopsWithoutInventingSequence() {
        TaskChecklistState state = new TaskChecklistState();
        require(state.apply(event(
            0,
            1,
            "step_milk",
            "searching",
            "Searching for milk",
            null
        )), "active task");
        require(
            state.markCancelled(
                "task_12345678",
                6,
                "Task cancelled. No further phone work will run."
            ),
            "explicit task cancellation"
        );
        TaskChecklistState.Snapshot cancelled = state.snapshot();
        require(cancelled.terminal(), "cancelled task must be terminal");
        require(
            cancelled.activePhase() == TaskChecklistState.Phase.CANCELLED,
            "cancelled phase"
        );
        require(
            cancelled.lastSequence() == 0,
            "task snapshot cannot invent a retained event sequence"
        );
    }

    private static void restoresWithoutAndroidOrJsonDependencies() {
        TaskChecklistState original = new TaskChecklistState();
        require(original.apply(event(
            0,
            1,
            "step_a",
            "mutation_verified",
            "Milk added",
            "Verified."
        )), "verified before persistence");
        require(original.apply(event(
            1,
            1,
            "step_b",
            "moving_to_next_step",
            "Next: bread",
            "Preparing to search."
        )), "next before persistence");
        original.setPaused(true, "Task paused");

        TaskChecklistState restored =
            TaskChecklistState.decode(original.encode());
        TaskChecklistState.Snapshot snapshot = restored.snapshot();
        require("task_12345678".equals(snapshot.taskId()), "task restored");
        require(snapshot.lastSequence() == 1, "cursor restored");
        require(snapshot.totalItems() == 3, "total restored");
        require(snapshot.completedCount() == 1, "checks restored");
        require(
            snapshot.activePhase() == TaskChecklistState.Phase.PAUSED,
            "presentation overlay restored"
        );
        List<TaskChecklistState.Item> items = snapshot.items();
        require(items.get(0).verified(), "verified bit restored");
        require(
            "step_b".equals(items.get(1).stepId()),
            "ordered next step restored"
        );
        try {
            items.clear();
            throw new AssertionError("snapshot list must be immutable");
        } catch (UnsupportedOperationException expected) {
            // Expected.
        }

        try {
            TaskChecklistState.decode("not-an-encoding");
            throw new AssertionError("invalid persistence must fail closed");
        } catch (IllegalArgumentException expected) {
            // Expected.
        }
    }

    private static void assertPhase(
        TaskChecklistState state,
        RetainedTaskEvent event,
        TaskChecklistState.Phase phase
    ) {
        require(state.apply(event), "phase event accepted");
        require(state.snapshot().activePhase() == phase, phase.value());
    }

    private static RetainedTaskEvent event(
        int sequence,
        int current,
        String stepId,
        String kind,
        String title,
        String detail
    ) {
        return new RetainedTaskEvent(
            "event_" + sequence,
            "task_12345678",
            5,
            "operation_12345678",
            stepId,
            sequence,
            kind,
            title,
            detail,
            current,
            3,
            1000L + sequence,
            "visual_only",
            title,
            null,
            null
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
