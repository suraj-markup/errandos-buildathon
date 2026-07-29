package ai.errandos.overlay;

public final class ProductSelectionStateTest {
    public static void main(String[] args) {
        long now = 1_000L;
        OverlayPresentation.ProductSelectionBinding binding =
            new OverlayPresentation.ProductSelectionBinding(
                2,
                "pixel-overlay",
                "task_12345678",
                3,
                "interaction_12345678",
                "selection_12345678",
                now + 5_000L
            );
        ProductSelectionState state = new ProductSelectionState();
        state.attach(binding, now);
        require(
            state.status() == ProductSelectionState.Status.IDLE,
            "new binding must be idle"
        );
        require(
            state.begin("offer-1", now) == binding,
            "idle choice must start"
        );
        require(
            state.status() == ProductSelectionState.Status.SUBMITTING,
            "choice must submit"
        );
        require(
            state.begin("offer-2", now) == null,
            "repeated tap must be blocked"
        );
        state.complete(
            ProductSelectionState.Status.REJECTED,
            "retry",
            true
        );
        require(state.canTap(), "retryable rejection must re-enable taps");
        require(
            state.begin("offer-1", now) == binding,
            "retry must preserve the original winning offer"
        );
        state.complete(
            ProductSelectionState.Status.ACCEPTED,
            "accepted",
            false
        );
        require(!state.canTap(), "accepted selection must stay disabled");

        OverlayPresentation.ProductSelectionBinding expired =
            new OverlayPresentation.ProductSelectionBinding(
                2,
                "pixel-overlay",
                "task_12345678",
                4,
                "interaction_abcdefgh",
                "selection_abcdefgh",
                now
            );
        state.attach(expired, now);
        require(
            state.status() == ProductSelectionState.Status.EXPIRED,
            "expired binding must never become tappable"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
