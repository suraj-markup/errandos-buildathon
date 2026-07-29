package ai.errandos.overlay;

/**
 * Rejects duplicate, out-of-order, and post-terminal updates for one operation.
 * Different operation IDs represent an explicit workflow hand-off or retry.
 */
final class SemanticProgressState {
    private String operationId;
    private int sequence = -1;
    private boolean terminal;

    boolean accept(OverlayPresentation.TaskProgress progress) {
        if (progress == null) return true;
        if (!progress.operationId.equals(operationId)) {
            operationId = progress.operationId;
            sequence = progress.sequence;
            terminal = progress.terminal;
            return true;
        }
        if (terminal || progress.sequence <= sequence) return false;
        sequence = progress.sequence;
        terminal = progress.terminal;
        return true;
    }
}
