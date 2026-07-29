package ai.errandos.overlay;

public final class RecoveryActionStateTest {
    public static void main(String[] args) {
        long now = 10_000L;
        RecoveryActionBinding binding = new RecoveryActionBinding(
            2,
            "recovery_12345678",
            "operation_12345678",
            "step:first",
            "task_12345678",
            7,
            now + 60_000L
        );
        CompanionIssueV2 issue = CompanionIssueV2
            .canonical("mutation_ambiguous")
            .withRecoveryInteraction(binding);
        RecoveryActionState state = new RecoveryActionState();
        state.attach(issue, now);
        CompanionIssueV2.RecoveryAction check =
            issue.recoveryActions.get(0);
        CompanionIssueV2.RecoveryAction stop =
            issue.recoveryActions.get(1);
        require(state.canTap(check), "bound read-only action is enabled");
        require(
            issue.talkBackDescription().contains(
                "Safe server recovery actions are available"
            ),
            "bound issue announces actionable recovery"
        );
        require(
            check.talkBackDescription(true, null).contains(
                "Double tap to run this safe recovery action"
            ),
            "TalkBack identifies an actionable safe row"
        );
        require(
            state.begin(check, now) == binding,
            "tap preserves exact server binding"
        );
        require(!state.canTap(stop), "one-shot winner disables every row");
        state.complete(
            RecoveryActionState.Status.ACCEPTED,
            "Accepted",
            false
        );
        require(!state.canTap(check), "accepted request cannot replay");

        CompanionIssueV2 displayOnly =
            CompanionIssueV2.canonical("mutation_ambiguous");
        state.attach(displayOnly, now);
        require(
            !state.canTap(displayOnly.recoveryActions.get(0)),
            "missing binding stays display-only"
        );

        CompanionIssueV2 locked = CompanionIssueV2
            .canonical("device_locked")
            .withRecoveryInteraction(binding);
        state.attach(locked, now);
        require(
            !state.canTap(locked.recoveryActions.get(0)),
            "manual unlock is never remotely actionable"
        );
        require(
            locked.recoveryActions.get(0)
                .talkBackDescription(
                    false,
                    RecoveryActionPolicy.disabledReason(
                        locked,
                        locked.recoveryActions.get(0)
                    )
                )
                .contains("cannot bypass the device lock"),
            "TalkBack states that unlock is manual"
        );

        RecoveryActionState recreated = new RecoveryActionState();
        recreated.restore(
            issue,
            "check_cart_again",
            RecoveryActionState.Status.SUBMITTING,
            "Sending"
        );
        require(
            recreated.status() == RecoveryActionState.Status.REJECTED
                && recreated.canTap(check),
            "recreation makes an uncertain local request safely retryable"
        );

        CompanionIssueV2 expired = CompanionIssueV2
            .canonical("mutation_ambiguous")
            .withRecoveryInteraction(new RecoveryActionBinding(
                2,
                "recovery_87654321",
                "operation_87654321",
                "step:second",
                "task_12345678",
                8,
                now
            ));
        state.attach(expired, now);
        require(
            state.status() == RecoveryActionState.Status.EXPIRED,
            "expired binding fails closed"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
