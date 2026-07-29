package ai.errandos.overlay;

public final class InteractionLatencyTrackerTest {
    private static final class FakeClock
        implements InteractionLatencyTracker.Clock {
        long now;

        @Override
        public long elapsedRealtime() {
            return now;
        }
    }

    public static void main(String[] args) {
        tracksLocalAndServerLatencySeparately();
        recordsDuplicateStaleAndCancelledOutcomesOnce();
        clampsClockRollbackAndLongDurations();
        rejectsUnsafeCorrelationValues();
    }

    private static void tracksLocalAndServerLatencySeparately() {
        FakeClock clock = new FakeClock();
        clock.now = 1_000L;
        InteractionLatencyTracker tracker =
            new InteractionLatencyTracker(clock);
        InteractionLatencyTracker.Attempt attempt = tracker.start(
            InteractionLatencyTracker.Source.TAP,
            "task_12345678",
            "interaction_12345678",
            "selection_12345678"
        );

        clock.now = 1_040L;
        InteractionLatencyTracker.Event local =
            attempt.localAcknowledged("optimistic_ack");
        require(local.durationMs == 40L, "local ack must use monotonic start");
        require(local.withinLocalAckTarget, "40ms must meet the 250ms target");
        require(
            local.logLine().contains("targetMs=250"),
            "local log must expose its target"
        );

        clock.now = 1_390L;
        InteractionLatencyTracker.Event server =
            attempt.serverOutcome("accepted");
        require(
            server.durationMs == 350L,
            "server timing must start after local acknowledgement"
        );
        require(
            !server.logLine().contains("targetMs="),
            "server outcome must remain a separate metric"
        );
    }

    private static void recordsDuplicateStaleAndCancelledOutcomesOnce() {
        FakeClock clock = new FakeClock();
        InteractionLatencyTracker tracker =
            new InteractionLatencyTracker(clock);
        String[] outcomes = {"duplicate", "stale", "cancelled"};
        for (int index = 0; index < outcomes.length; index += 1) {
            InteractionLatencyTracker.Attempt attempt = tracker.start(
                index == 2
                    ? InteractionLatencyTracker.Source.VOICE
                    : InteractionLatencyTracker.Source.TAP,
                "task_12345678",
                "interaction_12345678",
                "selection_12345678"
            );
            clock.now += 1L;
            require(
                attempt.localAcknowledged("optimistic_ack") != null,
                "first local ack must record"
            );
            clock.now += 1L;
            InteractionLatencyTracker.Event event =
                attempt.serverOutcome(outcomes[index]);
            require(
                outcomes[index].equals(event.outcome),
                "terminal outcome must remain explicit"
            );
            require(
                attempt.serverOutcome(outcomes[index]) == null,
                "duplicate terminal callbacks must not double count"
            );
        }
    }

    private static void clampsClockRollbackAndLongDurations() {
        FakeClock clock = new FakeClock();
        InteractionLatencyTracker tracker =
            new InteractionLatencyTracker(clock);
        InteractionLatencyTracker.Attempt rollback = tracker.start(
            InteractionLatencyTracker.Source.VOICE,
            "task_12345678",
            "interaction_12345678",
            null,
            50L
        );
        clock.now = 40L;
        require(
            rollback.localAcknowledged("cancelled").durationMs == 0L,
            "unexpected clock rollback must not create negative latency"
        );

        InteractionLatencyTracker.Attempt longRunning = tracker.start(
            InteractionLatencyTracker.Source.TAP,
            "task_12345678",
            "interaction_12345678",
            "selection_12345678",
            0L
        );
        clock.now = 700_000L;
        InteractionLatencyTracker.Event capped =
            longRunning.localAcknowledged("stale");
        require(capped.durationMs == 600_000L, "duration must stay bounded");
        require(capped.durationCapped, "bounded values must be identifiable");
    }

    private static void rejectsUnsafeCorrelationValues() {
        FakeClock clock = new FakeClock();
        InteractionLatencyTracker tracker =
            new InteractionLatencyTracker(clock);
        InteractionLatencyTracker.Attempt attempt = tracker.start(
            InteractionLatencyTracker.Source.TAP,
            "milk and paneer",
            "interaction_12345678\npayload",
            "selection_12345678"
        );
        InteractionLatencyTracker.Event event =
            attempt.localAcknowledged("optimistic ack");
        require("-".equals(event.taskId), "free text must not enter logs");
        require("-".equals(event.interactionId), "newlines must not enter logs");
        require("unknown".equals(event.outcome), "outcomes must be bounded tokens");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
