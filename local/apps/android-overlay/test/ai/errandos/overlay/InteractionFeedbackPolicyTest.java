package ai.errandos.overlay;

public final class InteractionFeedbackPolicyTest {
    public static void main(String[] args) {
        InteractionFeedbackPolicy policy = new InteractionFeedbackPolicy();
        require(
            policy.forListening(true)
                == InteractionFeedbackPolicy.Cue.LISTENING,
            "recording start needs one light cue"
        );
        require(
            policy.forListening(false) == InteractionFeedbackPolicy.Cue.NONE,
            "touch down alone must not vibrate"
        );
        require(
            policy.forTap(true)
                == InteractionFeedbackPolicy.Cue.SELECTION_ACCEPTED,
            "a winning tap needs acknowledgement"
        );
        RetainedTaskEvent verified = event(4, "mutation_verified");
        require(
            policy.forEvent(verified)
                == InteractionFeedbackPolicy.Cue.ITEM_VERIFIED,
            "verified event needs one success cue"
        );
        require(
            policy.forEvent(verified) == InteractionFeedbackPolicy.Cue.NONE,
            "re-rendered verified event must stay silent"
        );
        require(
            policy.forEvent(event(5, "options_ready"))
                == InteractionFeedbackPolicy.Cue.ATTENTION_REQUIRED,
            "a newly required choice needs one attention cue"
        );
        require(
            policy.forEvent(event(6, "searching"))
                == InteractionFeedbackPolicy.Cue.NONE,
            "polling progress must remain silent"
        );
    }

    private static RetainedTaskEvent event(int sequence, String kind) {
        return new RetainedTaskEvent(
            "event_" + sequence,
            "task_12345678",
            1,
            "operation_12345678",
            "step_" + sequence,
            sequence,
            kind,
            kind,
            null,
            1,
            2,
            1_000L,
            "visual_only",
            kind,
            null,
            null
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
