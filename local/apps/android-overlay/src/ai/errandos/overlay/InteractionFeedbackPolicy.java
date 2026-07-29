package ai.errandos.overlay;

/**
 * Maps accepted semantic transitions to one-shot native feedback. Polling,
 * elapsed time, and repeated rendering never produce feedback by themselves.
 */
final class InteractionFeedbackPolicy {
    enum Cue {
        NONE,
        LISTENING,
        SELECTION_ACCEPTED,
        ITEM_VERIFIED,
        ATTENTION_REQUIRED
    }

    private String lastSemanticKey;

    Cue forListening(boolean recordingStarted) {
        return recordingStarted ? Cue.LISTENING : Cue.NONE;
    }

    Cue forTap(boolean wonLocally) {
        return wonLocally ? Cue.SELECTION_ACCEPTED : Cue.NONE;
    }

    Cue forEvent(RetainedTaskEvent event) {
        if (event == null) return Cue.NONE;
        Cue cue = Cue.NONE;
        if ("mutation_verified".equals(event.kind)) {
            cue = Cue.ITEM_VERIFIED;
        } else if (
            "options_ready".equals(event.kind)
                || "waiting_for_user".equals(event.kind)
                || "checkout_ready".equals(event.kind)
        ) {
            cue = Cue.ATTENTION_REQUIRED;
        }
        if (cue == Cue.NONE) return Cue.NONE;
        String key = event.taskId + ":" + event.sequence + ":" + cue.name();
        if (key.equals(lastSemanticKey)) return Cue.NONE;
        lastSemanticKey = key;
        return cue;
    }
}
