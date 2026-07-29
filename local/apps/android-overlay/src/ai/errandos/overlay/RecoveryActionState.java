package ai.errandos.overlay;

/**
 * Owns the local winner for one recovery interaction.
 */
final class RecoveryActionState {
    enum Status {
        IDLE,
        SUBMITTING,
        ACCEPTED,
        DUPLICATE,
        REJECTED,
        EXPIRED
    }

    private CompanionIssueV2 issue;
    private RecoveryActionBinding binding;
    private Status status = Status.IDLE;
    private String selectedActionId;
    private String message;
    private boolean retryable;

    void attach(CompanionIssueV2 next, long nowEpochMs) {
        RecoveryActionBinding nextBinding =
            next == null ? null : next.recoveryInteraction;
        if (
            binding == null
                || nextBinding == null
                || !binding.sameInteraction(nextBinding)
        ) {
            issue = next;
            binding = nextBinding;
            selectedActionId = null;
            message = null;
            retryable = false;
            status = nextBinding != null && nextBinding.isExpired(nowEpochMs)
                ? Status.EXPIRED
                : Status.IDLE;
            return;
        }
        issue = next;
        if (
            nextBinding.isExpired(nowEpochMs)
                && status != Status.ACCEPTED
                && status != Status.DUPLICATE
        ) {
            status = Status.EXPIRED;
            retryable = false;
            message = "This recovery action expired. Refresh task status.";
        }
    }

    RecoveryActionBinding begin(
        CompanionIssueV2.RecoveryAction action,
        long nowEpochMs
    ) {
        if (!RecoveryActionPolicy.canSubmit(issue, action)) return null;
        if (binding.isExpired(nowEpochMs)) {
            status = Status.EXPIRED;
            message = "This recovery action expired. Refresh task status.";
            retryable = false;
            return null;
        }
        if (
            status == Status.SUBMITTING
                || status == Status.ACCEPTED
                || status == Status.DUPLICATE
                || status == Status.EXPIRED
                || (status == Status.REJECTED && !retryable)
        ) {
            return null;
        }
        selectedActionId = action.actionId;
        status = Status.SUBMITTING;
        message = "Recovery request received. Checking safely…";
        retryable = false;
        return binding;
    }

    void complete(Status next, String nextMessage, boolean canRetry) {
        if (status != Status.SUBMITTING) return;
        status = next;
        message = nextMessage;
        retryable = next == Status.REJECTED && canRetry;
    }

    void restore(
        CompanionIssueV2 nextIssue,
        String actionId,
        Status nextStatus,
        String nextMessage
    ) {
        if (
            nextIssue == null
                || nextIssue.recoveryInteraction == null
                || actionId == null
        ) {
            return;
        }
        issue = nextIssue;
        binding = nextIssue.recoveryInteraction;
        selectedActionId = actionId;
        status = nextStatus == Status.SUBMITTING
            ? Status.REJECTED
            : nextStatus;
        message = nextStatus == Status.SUBMITTING
            ? "Checking whether the saved recovery request was accepted…"
            : nextMessage;
        retryable = nextStatus == Status.SUBMITTING
            || nextStatus == Status.REJECTED;
    }

    boolean canTap(CompanionIssueV2.RecoveryAction action) {
        return RecoveryActionPolicy.canSubmit(issue, action)
            && (
                status == Status.IDLE
                    || (status == Status.REJECTED && retryable)
            );
    }

    Status status() {
        return status;
    }

    String selectedActionId() {
        return selectedActionId;
    }

    String message() {
        return message;
    }
}
