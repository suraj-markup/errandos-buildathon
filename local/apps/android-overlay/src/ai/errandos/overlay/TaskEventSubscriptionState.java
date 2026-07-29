package ai.errandos.overlay;

/**
 * Cursor and ordering guard for the retained task-event stream.
 *
 * A gap never advances the cursor: the caller must reconnect from the last
 * accepted sequence. A retention reset advances only to the server's earliest
 * retained predecessor, then immediately reconnects.
 */
final class TaskEventSubscriptionState {
    enum Decision {
        ACCEPTED,
        STALE,
        GAP,
        WRONG_TASK
    }

    static final class Checkpoint {
        private final String taskId;
        private final int lastSequence;
        private final int taskRevision;
        private final String operationId;
        private final boolean terminal;

        private Checkpoint(
            String taskId,
            int lastSequence,
            int taskRevision,
            String operationId,
            boolean terminal
        ) {
            this.taskId = taskId;
            this.lastSequence = lastSequence;
            this.taskRevision = taskRevision;
            this.operationId = operationId;
            this.terminal = terminal;
        }
    }

    private String taskId;
    private int lastSequence = -1;
    private int taskRevision = -1;
    private String operationId;
    private boolean terminal;

    synchronized void bind(String nextTaskId, int afterSequence) {
        if (nextTaskId == null || nextTaskId.trim().isEmpty()) return;
        if (!nextTaskId.equals(taskId)) {
            taskId = nextTaskId;
            lastSequence = Math.max(-1, afterSequence);
            taskRevision = -1;
            operationId = null;
            terminal = false;
        } else if (afterSequence > lastSequence) {
            lastSequence = afterSequence;
        }
    }

    synchronized void bindIdentity(
        String nextTaskId,
        int afterSequence,
        int revision,
        String nextOperationId
    ) {
        bind(nextTaskId, afterSequence);
        if (nextTaskId == null || !nextTaskId.equals(taskId)) return;
        // A bare task identity can point at a revision newer than retained
        // history. Only seed revision when the acknowledgement also provides
        // a cursor that skips that history.
        if (afterSequence >= 0 && revision >= taskRevision) {
            taskRevision = revision;
        }
        if (nextOperationId != null) operationId = nextOperationId;
        terminal = false;
    }

    synchronized void restore(
        String restoredTaskId,
        int restoredSequence,
        int restoredRevision,
        String restoredOperationId,
        boolean restoredTerminal
    ) {
        taskId = restoredTaskId;
        lastSequence = Math.max(-1, restoredSequence);
        taskRevision = Math.max(-1, restoredRevision);
        operationId = restoredOperationId;
        terminal = restoredTerminal;
    }

    synchronized Checkpoint checkpoint() {
        return new Checkpoint(
            taskId,
            lastSequence,
            taskRevision,
            operationId,
            terminal
        );
    }

    synchronized void restore(Checkpoint checkpoint) {
        if (checkpoint == null) {
            throw new IllegalArgumentException("checkpoint is required");
        }
        taskId = checkpoint.taskId;
        lastSequence = checkpoint.lastSequence;
        taskRevision = checkpoint.taskRevision;
        operationId = checkpoint.operationId;
        terminal = checkpoint.terminal;
    }

    synchronized boolean applyReset(
        String snapshotTaskId,
        int earliestSequence,
        int latestSequence
    ) {
        if (
            taskId == null
                || !taskId.equals(snapshotTaskId)
                || earliestSequence < 0
                || latestSequence < earliestSequence
        ) {
            return false;
        }
        lastSequence = earliestSequence - 1;
        taskRevision = -1;
        operationId = null;
        terminal = false;
        return true;
    }

    synchronized Decision accept(
        String eventTaskId,
        int sequence,
        int revision,
        String eventOperationId,
        boolean eventTerminal
    ) {
        if (taskId == null || !taskId.equals(eventTaskId)) {
            return Decision.WRONG_TASK;
        }
        if (
            sequence <= lastSequence
                || revision < taskRevision
                || terminal
        ) {
            return Decision.STALE;
        }
        if (sequence != lastSequence + 1) return Decision.GAP;
        lastSequence = sequence;
        taskRevision = revision;
        if (eventOperationId != null) operationId = eventOperationId;
        terminal = eventTerminal;
        return Decision.ACCEPTED;
    }

    synchronized String taskId() {
        return taskId;
    }

    synchronized int lastSequence() {
        return lastSequence;
    }

    synchronized int taskRevision() {
        return taskRevision;
    }

    synchronized String operationId() {
        return operationId;
    }

    synchronized boolean terminal() {
        return terminal;
    }
}
