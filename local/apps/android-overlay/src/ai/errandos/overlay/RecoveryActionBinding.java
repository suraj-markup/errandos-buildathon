package ai.errandos.overlay;

/**
 * Exact repository-backed identity required by POST /api/device/task/recovery.
 *
 * The Android client never derives or invents any of these values. Recovery
 * rows remain display-only unless the retained event carries this complete
 * binding.
 */
final class RecoveryActionBinding {
    final int version;
    final String interactionId;
    final String operationId;
    final String stepId;
    final String taskId;
    final int taskRevision;
    final long expiresAtEpochMs;

    RecoveryActionBinding(
        int version,
        String interactionId,
        String operationId,
        String stepId,
        String taskId,
        int taskRevision,
        long expiresAtEpochMs
    ) {
        this.version = version;
        this.interactionId = interactionId;
        this.operationId = operationId;
        this.stepId = stepId;
        this.taskId = taskId;
        this.taskRevision = taskRevision;
        this.expiresAtEpochMs = expiresAtEpochMs;
    }

    boolean isExpired(long nowEpochMs) {
        return nowEpochMs >= expiresAtEpochMs;
    }

    boolean sameInteraction(RecoveryActionBinding other) {
        return other != null
            && version == other.version
            && taskRevision == other.taskRevision
            && interactionId.equals(other.interactionId)
            && operationId.equals(other.operationId)
            && stepId.equals(other.stepId)
            && taskId.equals(other.taskId);
    }
}
