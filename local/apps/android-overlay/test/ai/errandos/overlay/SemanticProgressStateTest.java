package ai.errandos.overlay;

public final class SemanticProgressStateTest {
    public static void main(String[] args) {
        SemanticProgressState state = new SemanticProgressState();
        require(state.accept(progress("operation_12345678", 2, false)));
        require(!state.accept(progress("operation_12345678", 2, false)));
        require(!state.accept(progress("operation_12345678", 1, false)));
        require(state.accept(progress("operation_12345678", 3, true)));
        require(!state.accept(progress("operation_12345678", 4, false)));
        require(state.accept(progress("operation_87654321", 0, false)));
    }

    private static OverlayPresentation.TaskProgress progress(
        String operationId,
        int sequence,
        boolean terminal
    ) {
        return new OverlayPresentation.TaskProgress(
            1,
            "task_12345678",
            null,
            operationId,
            "Phone task",
            terminal ? "Completed" : "Working",
            terminal ? "completed" : "verifying",
            sequence,
            0,
            0,
            !terminal,
            terminal ? "not_cancellable" : "cancel_now",
            terminal
        );
    }

    private static void require(boolean condition) {
        if (!condition) throw new AssertionError("progress ordering failed");
    }
}
