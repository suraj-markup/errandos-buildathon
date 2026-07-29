package ai.errandos.overlay;

/**
 * Monotonic, allocation-light interaction timing for the native companion.
 *
 * The tracker never sees labels, transcripts, network payloads, or product
 * details. Correlation is limited to the server-issued task, interaction, and
 * selection identifiers.
 */
final class InteractionLatencyTracker {
    interface Clock {
        long elapsedRealtime();
    }

    enum Source {
        TAP("tap"),
        VOICE("voice");

        final String value;

        Source(String value) {
            this.value = value;
        }
    }

    static final long LOCAL_ACK_TARGET_MS = 250L;
    private static final long MAX_RECORDED_DURATION_MS = 600_000L;
    private static final int MAX_IDENTIFIER_LENGTH = 160;

    static final class Event {
        final String stage;
        final String source;
        final String taskId;
        final String interactionId;
        final String selectionId;
        final String outcome;
        final long durationMs;
        final boolean durationCapped;
        final boolean withinLocalAckTarget;

        Event(
            String stage,
            String source,
            String taskId,
            String interactionId,
            String selectionId,
            String outcome,
            long durationMs,
            boolean durationCapped,
            boolean withinLocalAckTarget
        ) {
            this.stage = stage;
            this.source = source;
            this.taskId = taskId;
            this.interactionId = interactionId;
            this.selectionId = selectionId;
            this.outcome = outcome;
            this.durationMs = durationMs;
            this.durationCapped = durationCapped;
            this.withinLocalAckTarget = withinLocalAckTarget;
        }

        String logLine() {
            return "interaction_latency.v1"
                + " stage=" + stage
                + " source=" + source
                + " taskId=" + taskId
                + " interactionId=" + interactionId
                + " selectionId=" + selectionId
                + " outcome=" + outcome
                + " durationMs=" + durationMs
                + " durationCapped=" + durationCapped
                + (
                    "local_ack".equals(stage)
                        ? " targetMs=" + LOCAL_ACK_TARGET_MS
                            + " withinTarget=" + withinLocalAckTarget
                        : ""
                );
        }
    }

    final class Attempt {
        private final Source source;
        private final String taskId;
        private final String interactionId;
        private final String selectionId;
        private final long startedAtMs;
        private Long localAcknowledgedAtMs;
        private boolean serverOutcomeRecorded;

        private Attempt(
            Source source,
            String taskId,
            String interactionId,
            String selectionId,
            long startedAtMs
        ) {
            this.source = source;
            this.taskId = safeIdentifier(taskId);
            this.interactionId = safeIdentifier(interactionId);
            this.selectionId = safeIdentifier(selectionId);
            this.startedAtMs = startedAtMs;
        }

        synchronized Event localAcknowledged(String outcome) {
            if (localAcknowledgedAtMs != null) return null;
            long now = clock.elapsedRealtime();
            localAcknowledgedAtMs = now;
            Duration duration = duration(startedAtMs, now);
            return new Event(
                "local_ack",
                source.value,
                taskId,
                interactionId,
                selectionId,
                safeOutcome(outcome),
                duration.value,
                duration.capped,
                duration.value <= LOCAL_ACK_TARGET_MS
            );
        }

        synchronized Event serverOutcome(String outcome) {
            if (serverOutcomeRecorded) return null;
            serverOutcomeRecorded = true;
            long now = clock.elapsedRealtime();
            long baseline = localAcknowledgedAtMs == null
                ? startedAtMs
                : localAcknowledgedAtMs.longValue();
            Duration duration = duration(baseline, now);
            return new Event(
                "server_outcome",
                source.value,
                taskId,
                interactionId,
                selectionId,
                safeOutcome(outcome),
                duration.value,
                duration.capped,
                false
            );
        }
    }

    private static final class Duration {
        final long value;
        final boolean capped;

        Duration(long value, boolean capped) {
            this.value = value;
            this.capped = capped;
        }
    }

    private final Clock clock;

    InteractionLatencyTracker(Clock clock) {
        if (clock == null) throw new IllegalArgumentException("clock required");
        this.clock = clock;
    }

    Attempt start(
        Source source,
        String taskId,
        String interactionId,
        String selectionId
    ) {
        return start(
            source,
            taskId,
            interactionId,
            selectionId,
            clock.elapsedRealtime()
        );
    }

    Attempt start(
        Source source,
        String taskId,
        String interactionId,
        String selectionId,
        long startedAtMs
    ) {
        if (source == null) throw new IllegalArgumentException("source required");
        return new Attempt(
            source,
            taskId,
            interactionId,
            selectionId,
            startedAtMs
        );
    }

    private static Duration duration(long start, long end) {
        long raw = end >= start ? end - start : 0L;
        return new Duration(
            Math.min(raw, MAX_RECORDED_DURATION_MS),
            raw > MAX_RECORDED_DURATION_MS
        );
    }

    private static String safeIdentifier(String value) {
        if (
            value == null
                || value.isEmpty()
                || value.length() > MAX_IDENTIFIER_LENGTH
        ) {
            return "-";
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (
                !(
                    (character >= 'a' && character <= 'z')
                        || (character >= 'A' && character <= 'Z')
                        || (character >= '0' && character <= '9')
                        || character == '_'
                        || character == '-'
                        || character == '.'
                        || character == ':'
                )
            ) {
                return "-";
            }
        }
        return value;
    }

    private static String safeOutcome(String value) {
        String safe = safeIdentifier(value);
        return "-".equals(safe) ? "unknown" : safe;
    }
}
