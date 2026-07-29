package ai.errandos.overlay;

/**
 * Owns the local half of an interaction resolution race. A tap can be sent
 * once, while push-to-talk remains available to resolve the same server-side
 * interaction.
 */
final class CompletionChoiceState {
    enum Status {
        IDLE,
        SUBMITTING,
        ACCEPTED,
        DUPLICATE,
        REJECTED,
        EXPIRED
    }

    private OverlayPresentation.CompletionInteraction interaction;
    private Status status = Status.IDLE;
    private String selectedChoiceId;
    private String message;
    private boolean retryable;

    void attach(
        OverlayPresentation.CompletionInteraction next,
        long nowEpochMs
    ) {
        if (
            interaction == null
                || next == null
                || !interaction.sameInteraction(next)
        ) {
            interaction = next;
            selectedChoiceId = null;
            message = null;
            retryable = false;
            status = next != null && next.isExpired(nowEpochMs)
                ? Status.EXPIRED
                : Status.IDLE;
            return;
        }
        if (
            next.isExpired(nowEpochMs)
                && status != Status.ACCEPTED
                && status != Status.DUPLICATE
        ) {
            status = Status.EXPIRED;
            retryable = false;
            message = "These choices expired. Hold to speak instead.";
        }
    }

    OverlayPresentation.CompletionInteraction begin(
        OverlayPresentation.CompletionChoice choice,
        long nowEpochMs
    ) {
        if (interaction == null || choice == null || !choice.enabled) return null;
        if (interaction.isExpired(nowEpochMs)) {
            status = Status.EXPIRED;
            message = "These choices expired. Hold to speak instead.";
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
        selectedChoiceId = choice.choiceId;
        status = Status.SUBMITTING;
        message = "Submitting choice… You can still hold to speak.";
        retryable = false;
        return interaction;
    }

    void complete(Status next, String nextMessage, boolean canRetry) {
        if (status != Status.SUBMITTING) return;
        status = next;
        message = nextMessage;
        retryable = next == Status.REJECTED && canRetry;
    }

    boolean canTap() {
        return interaction != null
            && (
                status == Status.IDLE
                    || (status == Status.REJECTED && retryable)
            );
    }

    Status status() {
        return status;
    }

    String selectedChoiceId() {
        return selectedChoiceId;
    }

    String message() {
        return message;
    }
}
