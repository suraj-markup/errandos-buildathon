package ai.errandos.overlay;

final class ProductSelectionState {
    enum Status {
        IDLE,
        SUBMITTING,
        ACCEPTED,
        REJECTED,
        DUPLICATE,
        EXPIRED,
        WORKING
    }

    private OverlayPresentation.ProductSelectionBinding binding;
    private Status status = Status.IDLE;
    private String selectedOfferId;
    private String message;
    private boolean retryable;

    void attach(
        OverlayPresentation.ProductSelectionBinding nextBinding,
        long nowEpochMs
    ) {
        if (
            binding == null
                || nextBinding == null
                || !binding.sameSelection(nextBinding)
        ) {
            binding = nextBinding;
            selectedOfferId = null;
            message = null;
            retryable = false;
            status = nextBinding != null
                    && nextBinding.isExpired(nowEpochMs)
                ? Status.EXPIRED
                : Status.IDLE;
        } else if (
            nextBinding.isExpired(nowEpochMs)
                && status != Status.ACCEPTED
                && status != Status.DUPLICATE
        ) {
            status = Status.EXPIRED;
            retryable = false;
            message = "This choice expired. Speak your choice instead.";
        }
    }

    OverlayPresentation.ProductSelectionBinding begin(
        String offerId,
        long nowEpochMs
    ) {
        if (binding == null) return null;
        if (binding.isExpired(nowEpochMs)) {
            status = Status.EXPIRED;
            retryable = false;
            message = "This choice expired. Speak your choice instead.";
            return null;
        }
        if (
            status == Status.SUBMITTING
                || status == Status.ACCEPTED
                || status == Status.DUPLICATE
                || status == Status.EXPIRED
                || status == Status.WORKING
                || (status == Status.REJECTED && !retryable)
        ) {
            return null;
        }
        if (
            status == Status.REJECTED
                && selectedOfferId != null
                && !selectedOfferId.equals(offerId)
        ) {
            message = "A different late choice was ignored.";
            retryable = false;
            status = Status.WORKING;
            return null;
        }
        selectedOfferId = offerId;
        status = Status.SUBMITTING;
        message = "Selection saved. Sending…";
        retryable = false;
        return binding;
    }

    void complete(Status nextStatus, String nextMessage, boolean canRetry) {
        if (status != Status.SUBMITTING && status != Status.WORKING) return;
        status = nextStatus;
        message = nextMessage;
        retryable = nextStatus == Status.REJECTED && canRetry;
    }

    void resolveWinner(
        String winnerOfferId,
        Status winnerStatus,
        String nextMessage
    ) {
        if (
            winnerOfferId == null
                || winnerStatus == null
                || (
                    winnerStatus != Status.ACCEPTED
                        && winnerStatus != Status.DUPLICATE
                )
        ) {
            return;
        }
        if (
            (status == Status.ACCEPTED || status == Status.DUPLICATE)
                && selectedOfferId != null
                && !selectedOfferId.equals(winnerOfferId)
        ) {
            // Once an authoritative winner is visible, a late response cannot
            // replace it with a second winner.
            return;
        }
        selectedOfferId = winnerOfferId;
        status = winnerStatus;
        message = nextMessage;
        retryable = false;
    }

    void restore(
        OverlayPresentation.ProductSelectionBinding restoredBinding,
        String offerId,
        Status restoredStatus,
        String restoredMessage
    ) {
        if (
            restoredBinding == null
                || binding == null
                || !binding.sameSelection(restoredBinding)
                || offerId == null
                || restoredStatus == null
                || restoredStatus == Status.IDLE
                || restoredStatus == Status.EXPIRED
        ) {
            return;
        }
        selectedOfferId = offerId;
        status = restoredStatus;
        message = restoredMessage;
        retryable = false;
    }

    OverlayPresentation.ProductSelectionBinding binding() {
        return binding;
    }

    Status status() {
        return status;
    }

    String selectedOfferId() {
        return selectedOfferId;
    }

    String message() {
        return message;
    }

    boolean canTap() {
        return binding != null
            && (
                status == Status.IDLE
                    || (status == Status.REJECTED && retryable)
            );
    }
}
