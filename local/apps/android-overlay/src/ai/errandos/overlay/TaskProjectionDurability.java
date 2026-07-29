package ai.errandos.overlay;

/**
 * Prepares one all-or-nothing durable projection before any event effects.
 * Android storage applies every field from this immutable value with one
 * SharedPreferences.Editor.commit().
 */
final class TaskProjectionDurability {
    static final class Prepared {
        final String taskId;
        final int sequence;
        final int revision;
        final boolean terminal;
        final String operationId;
        final String checklist;
        final String recoveryPresentation;
        final String verifiedCartPresentation;
        final boolean clearPreviousTaskState;

        Prepared(
            String taskId,
            int sequence,
            int revision,
            boolean terminal,
            String operationId,
            String checklist,
            String recoveryPresentation,
            String verifiedCartPresentation,
            boolean clearPreviousTaskState
        ) {
            this.taskId = taskId;
            this.sequence = sequence;
            this.revision = revision;
            this.terminal = terminal;
            this.operationId = operationId;
            this.checklist = checklist;
            this.recoveryPresentation = recoveryPresentation;
            this.verifiedCartPresentation = verifiedCartPresentation;
            this.clearPreviousTaskState = clearPreviousTaskState;
        }
    }

    private TaskProjectionDurability() {}

    static Prepared prepare(
        TaskEventSubscriptionState cursor,
        TaskChecklistState checklist,
        OverlayPresentation latestPresentation,
        OverlayPresentation verifiedCartPresentation,
        boolean clearPreviousTaskState,
        long nowEpochMs
    ) {
        if (cursor == null || checklist == null || cursor.taskId() == null) {
            return null;
        }
        TaskChecklistState.Snapshot projection = checklist.snapshot();
        if (
            projection.taskId() != null
                && !cursor.taskId().equals(projection.taskId())
        ) {
            return null;
        }
        String recovery = latestPresentation == null
            ? null
            : OverlayRecoverySnapshot.encode(
                latestPresentation,
                true,
                nowEpochMs
            );
        if (latestPresentation != null && recovery == null) return null;

        String verifiedCart = null;
        if (verifiedCartPresentation != null) {
            if (
                verifiedCartPresentation.card.cartSummary == null
                    || !verifiedCartPresentation.card.cartSummary
                        .isVerifiedNotOrdered()
            ) {
                return null;
            }
            verifiedCart = OverlayRecoverySnapshot.encode(
                verifiedCartPresentation,
                true,
                nowEpochMs
            );
            if (verifiedCart == null) return null;
        }
        return new Prepared(
            cursor.taskId(),
            cursor.lastSequence(),
            cursor.taskRevision(),
            cursor.terminal(),
            cursor.operationId(),
            checklist.encode(),
            recovery,
            verifiedCart,
            clearPreviousTaskState
        );
    }
}
