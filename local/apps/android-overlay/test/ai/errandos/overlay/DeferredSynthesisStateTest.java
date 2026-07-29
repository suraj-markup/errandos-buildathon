package ai.errandos.overlay;

public final class DeferredSynthesisStateTest {
    public static void main(String[] args) {
        pollsAreBounded();
        newerGenerationCancelsPlaybackOnly();
        staleRaceCannotPlay();
        duplicateReadyCannotReplay();
        pendingPollRestoresWithoutReplay();
        readyAudioIsNeverRestoredForReplay();
    }

    private static void pollsAreBounded() {
        DeferredSynthesisState state = new DeferredSynthesisState(2, 5_000L);
        state.begin("generation-1", "synthesis-1", "pending", null, 100L, 1L);
        require(!state.pollIfDue(199L).poll, "minimum delay must apply");
        require(state.pollIfDue(200L).poll, "first due poll must start");
        state.response(
            "generation-1",
            "synthesis-1",
            "pending",
            null,
            200L,
            100L
        );
        require(state.pollIfDue(300L).poll, "second poll must start");
        state.response(
            "generation-1",
            "synthesis-1",
            "pending",
            null,
            300L,
            100L
        );
        require(
            state.phase() == DeferredSynthesisState.Phase.ABANDONED,
            "pending synthesis must stop at the poll bound"
        );
        require(
            !state.pollIfDue(10_000L).poll,
            "abandoned synthesis must not poll again"
        );
    }

    private static void newerGenerationCancelsPlaybackOnly() {
        DeferredSynthesisState state = new DeferredSynthesisState();
        DeferredSynthesisState.Effect ready = state.begin(
            "generation-1",
            "synthesis-1",
            "ready",
            "audio-one",
            100L,
            150L
        );
        require(ready.play, "ready synthesis must request local playback");
        require(
            state.playbackStarted("generation-1", "synthesis-1"),
            "matching playback must start"
        );
        DeferredSynthesisState.Effect superseded = state.begin(
            "generation-2",
            "synthesis-2",
            "pending",
            null,
            120L,
            150L
        );
        require(
            superseded.cancelPlayback,
            "a newer generation must cancel obsolete playback"
        );
        require(!superseded.play, "pending audio cannot play");
        require(
            state.phase() == DeferredSynthesisState.Phase.POLLING,
            "new generation must remain independently pollable"
        );
    }

    private static void staleRaceCannotPlay() {
        DeferredSynthesisState state = new DeferredSynthesisState();
        state.begin(
            "generation-old",
            "synthesis-old",
            "pending",
            null,
            100L,
            100L
        );
        state.begin(
            "generation-new",
            "synthesis-new",
            "pending",
            null,
            110L,
            100L
        );
        DeferredSynthesisState.Effect stale = state.response(
            "generation-old",
            "synthesis-old",
            "ready",
            "obsolete-audio",
            150L,
            100L
        );
        require(!stale.play, "stale ready response must never play");
        require(
            "generation-new".equals(state.generation()),
            "stale response must not replace the active generation"
        );
    }

    private static void duplicateReadyCannotReplay() {
        DeferredSynthesisState state = new DeferredSynthesisState();
        require(
            state.begin(
                "generation-1",
                "synthesis-1",
                "ready",
                "audio-one",
                100L,
                100L
            ).play,
            "first ready delivery must play"
        );
        require(
            !state.begin(
                "generation-1",
                "synthesis-1",
                "ready",
                "audio-one",
                101L,
                100L
            ).play,
            "duplicate response body must not replay"
        );
        require(
            state.playbackStarted("generation-1", "synthesis-1"),
            "original playback command remains current"
        );
        require(
            !state.response(
                "generation-1",
                "synthesis-1",
                "ready",
                "audio-one",
                102L,
                100L
            ).play,
            "duplicate poll completion must not replay active audio"
        );
    }

    private static void pendingPollRestoresWithoutReplay() {
        DeferredSynthesisState before = new DeferredSynthesisState();
        before.begin(
            "generation-1",
            "synthesis-1",
            "pending",
            null,
            100L,
            150L
        );
        DeferredSynthesisState.Snapshot snapshot = before.pendingSnapshot();
        DeferredSynthesisState after = new DeferredSynthesisState();
        require(
            after.restorePending(snapshot, 200L),
            "fresh pending delivery must restore"
        );
        require(
            after.phase() == DeferredSynthesisState.Phase.POLLING,
            "restart must resume polling"
        );
        require(
            !after.pollIfDue(249L).poll && after.pollIfDue(250L).poll,
            "restored deadline must be preserved"
        );
    }

    private static void readyAudioIsNeverRestoredForReplay() {
        DeferredSynthesisState state = new DeferredSynthesisState();
        state.begin(
            "generation-1",
            "synthesis-1",
            "ready",
            "audio-one",
            100L,
            150L
        );
        require(
            state.pendingSnapshot() == null,
            "ready or playing audio must not be persisted for replay"
        );
        DeferredSynthesisState restarted = new DeferredSynthesisState();
        require(
            !restarted.restorePending(null, 200L),
            "restart without a pending snapshot must remain idle"
        );
        require(
            restarted.phase() == DeferredSynthesisState.Phase.IDLE,
            "restart must not replay old TTS"
        );
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
