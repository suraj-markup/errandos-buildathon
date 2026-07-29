package ai.errandos.overlay;

/**
 * Pure state machine for delivery of deferred speech synthesis.
 *
 * It deliberately has no command capable of cancelling a phone operation or
 * the server-side synthesis job. Superseding a generation can only cancel
 * local playback.
 */
final class DeferredSynthesisState {
    static final int DEFAULT_MAX_POLLS = 8;
    static final long DEFAULT_MAX_ELAPSED_MS = 8_000L;
    static final long MIN_POLL_DELAY_MS = 100L;
    static final long MAX_POLL_DELAY_MS = 1_000L;

    enum Phase {
        IDLE,
        POLLING,
        READY,
        PLAYING,
        FINISHED,
        ABANDONED
    }

    static final class Effect {
        static final Effect NONE = new Effect(false, false, false, null);

        final boolean cancelPlayback;
        final boolean poll;
        final boolean play;
        final String audioBase64;

        Effect(
            boolean cancelPlayback,
            boolean poll,
            boolean play,
            String audioBase64
        ) {
            this.cancelPlayback = cancelPlayback;
            this.poll = poll;
            this.play = play;
            this.audioBase64 = audioBase64;
        }
    }

    static final class Snapshot {
        final String generation;
        final String synthesisId;
        final int pollsStarted;
        final long startedAtEpochMs;
        final long nextPollAtEpochMs;

        Snapshot(
            String generation,
            String synthesisId,
            int pollsStarted,
            long startedAtEpochMs,
            long nextPollAtEpochMs
        ) {
            this.generation = generation;
            this.synthesisId = synthesisId;
            this.pollsStarted = pollsStarted;
            this.startedAtEpochMs = startedAtEpochMs;
            this.nextPollAtEpochMs = nextPollAtEpochMs;
        }
    }

    private final int maxPolls;
    private final long maxElapsedMs;
    private String generation;
    private String synthesisId;
    private Phase phase = Phase.IDLE;
    private int pollsStarted;
    private long startedAtEpochMs;
    private long nextPollAtEpochMs;
    private boolean pollInFlight;

    DeferredSynthesisState() {
        this(DEFAULT_MAX_POLLS, DEFAULT_MAX_ELAPSED_MS);
    }

    DeferredSynthesisState(int maxPolls, long maxElapsedMs) {
        if (maxPolls < 1) {
            throw new IllegalArgumentException("maxPolls must be positive");
        }
        if (maxElapsedMs < MIN_POLL_DELAY_MS) {
            throw new IllegalArgumentException(
                "maxElapsedMs must allow at least one poll"
            );
        }
        this.maxPolls = maxPolls;
        this.maxElapsedMs = maxElapsedMs;
    }

    Effect begin(
        String nextGeneration,
        String nextSynthesisId,
        String status,
        String audioBase64,
        long nowEpochMs,
        long pollAfterMs
    ) {
        if (!validIdentifier(nextGeneration) || !validIdentifier(nextSynthesisId)) {
            return abandonCurrent();
        }
        if (
            nextGeneration.equals(generation)
                && nextSynthesisId.equals(synthesisId)
        ) {
            return Effect.NONE;
        }

        boolean cancelPlayback = phase == Phase.PLAYING;
        generation = nextGeneration;
        synthesisId = nextSynthesisId;
        pollsStarted = 0;
        startedAtEpochMs = nowEpochMs;
        nextPollAtEpochMs = nowEpochMs;
        pollInFlight = false;
        phase = Phase.IDLE;
        Effect effect = response(
            nextGeneration,
            nextSynthesisId,
            status,
            audioBase64,
            nowEpochMs,
            pollAfterMs
        );
        return new Effect(
            cancelPlayback || effect.cancelPlayback,
            effect.poll,
            effect.play,
            effect.audioBase64
        );
    }

    Effect pollIfDue(long nowEpochMs) {
        if (phase != Phase.POLLING || pollInFlight) return Effect.NONE;
        if (isExhausted(nowEpochMs)) {
            phase = Phase.ABANDONED;
            return Effect.NONE;
        }
        if (nowEpochMs < nextPollAtEpochMs) return Effect.NONE;
        pollsStarted += 1;
        pollInFlight = true;
        return new Effect(false, true, false, null);
    }

    Effect response(
        String responseGeneration,
        String responseSynthesisId,
        String status,
        String audioBase64,
        long nowEpochMs,
        long pollAfterMs
    ) {
        if (!matches(responseGeneration, responseSynthesisId)) {
            return Effect.NONE;
        }
        if (
            phase == Phase.ABANDONED
                || phase == Phase.FINISHED
                || (
                    "ready".equals(status)
                        && (
                            phase == Phase.READY
                                || phase == Phase.PLAYING
                        )
                )
        ) {
            return Effect.NONE;
        }
        pollInFlight = false;
        if ("pending".equals(status)) {
            if (isExhausted(nowEpochMs)) {
                phase = Phase.ABANDONED;
                return Effect.NONE;
            }
            phase = Phase.POLLING;
            nextPollAtEpochMs = safeAdd(
                nowEpochMs,
                boundedDelay(pollAfterMs)
            );
            return Effect.NONE;
        }
        if ("ready".equals(status) && hasAudio(audioBase64)) {
            phase = Phase.READY;
            return new Effect(false, false, true, audioBase64);
        }
        phase = Phase.ABANDONED;
        return Effect.NONE;
    }

    void pollFailed(
        String responseGeneration,
        String responseSynthesisId,
        long nowEpochMs,
        long retryAfterMs
    ) {
        if (!matches(responseGeneration, responseSynthesisId)) return;
        pollInFlight = false;
        if (isExhausted(nowEpochMs)) {
            phase = Phase.ABANDONED;
            return;
        }
        phase = Phase.POLLING;
        nextPollAtEpochMs = safeAdd(
            nowEpochMs,
            boundedDelay(retryAfterMs)
        );
    }

    boolean playbackStarted(
        String playbackGeneration,
        String playbackSynthesisId
    ) {
        if (
            phase != Phase.READY
                || !matches(playbackGeneration, playbackSynthesisId)
        ) {
            return false;
        }
        phase = Phase.PLAYING;
        return true;
    }

    void playbackFinished(
        String playbackGeneration,
        String playbackSynthesisId
    ) {
        if (
            phase == Phase.PLAYING
                && matches(playbackGeneration, playbackSynthesisId)
        ) {
            phase = Phase.FINISHED;
        }
    }

    Snapshot pendingSnapshot() {
        if (phase != Phase.POLLING) return null;
        return new Snapshot(
            generation,
            synthesisId,
            pollsStarted,
            startedAtEpochMs,
            nextPollAtEpochMs
        );
    }

    boolean restorePending(Snapshot snapshot, long nowEpochMs) {
        if (
            snapshot == null
                || !validIdentifier(snapshot.generation)
                || !validIdentifier(snapshot.synthesisId)
                || snapshot.pollsStarted < 0
                || snapshot.pollsStarted >= maxPolls
                || snapshot.startedAtEpochMs > nowEpochMs
                || elapsed(snapshot.startedAtEpochMs, nowEpochMs)
                    >= maxElapsedMs
        ) {
            clear();
            return false;
        }
        generation = snapshot.generation;
        synthesisId = snapshot.synthesisId;
        pollsStarted = snapshot.pollsStarted;
        startedAtEpochMs = snapshot.startedAtEpochMs;
        nextPollAtEpochMs = Math.max(
            nowEpochMs,
            snapshot.nextPollAtEpochMs
        );
        pollInFlight = false;
        phase = Phase.POLLING;
        return true;
    }

    void clear() {
        generation = null;
        synthesisId = null;
        pollsStarted = 0;
        startedAtEpochMs = 0L;
        nextPollAtEpochMs = 0L;
        pollInFlight = false;
        phase = Phase.IDLE;
    }

    String generation() {
        return generation;
    }

    String synthesisId() {
        return synthesisId;
    }

    Phase phase() {
        return phase;
    }

    int pollsStarted() {
        return pollsStarted;
    }

    long nextPollAtEpochMs() {
        return nextPollAtEpochMs;
    }

    private Effect abandonCurrent() {
        boolean cancelPlayback = phase == Phase.PLAYING;
        phase = Phase.ABANDONED;
        pollInFlight = false;
        return new Effect(cancelPlayback, false, false, null);
    }

    private boolean matches(
        String candidateGeneration,
        String candidateSynthesisId
    ) {
        return generation != null
            && synthesisId != null
            && generation.equals(candidateGeneration)
            && synthesisId.equals(candidateSynthesisId);
    }

    private boolean isExhausted(long nowEpochMs) {
        return pollsStarted >= maxPolls
            || elapsed(startedAtEpochMs, nowEpochMs) >= maxElapsedMs;
    }

    private static long elapsed(long start, long end) {
        if (end <= start) return 0L;
        return end - start;
    }

    private static long boundedDelay(long requestedMs) {
        if (requestedMs < MIN_POLL_DELAY_MS) return MIN_POLL_DELAY_MS;
        return Math.min(requestedMs, MAX_POLL_DELAY_MS);
    }

    private static long safeAdd(long left, long right) {
        if (Long.MAX_VALUE - left < right) return Long.MAX_VALUE;
        return left + right;
    }

    private static boolean hasAudio(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static boolean validIdentifier(String value) {
        if (value == null || value.isEmpty() || value.length() > 160) {
            return false;
        }
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            boolean valid = character >= 'A' && character <= 'Z'
                || character >= 'a' && character <= 'z'
                || character >= '0' && character <= '9'
                || character == '.'
                || character == '_'
                || character == ':'
                || character == '-';
            if (!valid) return false;
        }
        return true;
    }
}
