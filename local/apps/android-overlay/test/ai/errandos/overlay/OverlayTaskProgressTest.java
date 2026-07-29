package ai.errandos.overlay;

public final class OverlayTaskProgressTest {
    public static void main(String[] args) {
        OverlayPresentation.TaskProgress known =
            new OverlayPresentation.TaskProgress(
                1,
                "task_12345678",
                "task_item_12345678",
                "operation_12345678",
                "Add grocery item",
                "Verifying phone result",
                "verifying",
                4,
                1,
                3,
                false,
                "reconcile_only",
                false
            );
        require("1 of 3".equals(known.positionLabel()), "known position");
        require(known.hasKnownTotal(), "known total");
        require(
            "FINISHING VERIFICATION".equals(known.cancellationLabel()),
            "reconciliation policy"
        );

        OverlayPresentation.TaskProgress unknown =
            new OverlayPresentation.TaskProgress(
                1,
                "task_12345678",
                null,
                "operation_12345678",
                "Phone task",
                "Waiting for provider",
                "waiting_for_provider",
                1,
                2,
                0,
                true,
                "cancel_now",
                false
            );
        require("Item 2".equals(unknown.positionLabel()), "unknown total");
        require(!unknown.hasKnownTotal(), "no invented total");
        require(
            "CANCEL AVAILABLE".equals(unknown.cancellationLabel()),
            "cancel policy"
        );

        OverlayPresentation.TaskProgress completed =
            new OverlayPresentation.TaskProgress(
                1,
                "task_12345678",
                null,
                "operation_12345678",
                "Review cart",
                "Completed",
                "completed",
                7,
                0,
                0,
                false,
                "not_cancellable",
                true
            );
        require(completed.positionLabel() == null, "no invented position");
        require(completed.cancellationLabel() == null, "terminal is stable");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
