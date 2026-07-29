# Clicky-pattern gap audit for the JaldiAI native companion

Date: 2026-07-27

Scope: `local/apps/android-overlay/**` and the presentation boundary it
consumes. This audit does not authorize shopping, cart mutation, checkout, or
ordering.

## Verified current state

The Android companion now has the core interaction states found useful in the
Clicky reference, expressed with JaldiAI's own native implementation and visual
identity:

- a persistent 64 dp draggable companion;
- a live microphone-amplitude waveform while recording;
- an indeterminate spinner for real working/searching/adding/checkout status
  broadcasts;
- a pulsing speaking state while Sarvam audio is playing;
- waiting, success, ambiguous, and error glyphs;
- progressive 292 dp capsules and bounded 336 dp context cards;
- defensive version-1 presentation parsing with legacy fallback;
- exact-offer product-choice rows;
- semantic current-screen attention cues in a separate non-touchable window;
- push-to-talk barge-in that stops current TTS playback before recording.

Build and deployment verification:

- native build passed with one existing deprecated-API warning;
- APK: `local/apps/android-overlay/dist/errandos-overlay-debug.apk`;
- local and installed SHA-256:
  `4bbcf1b7df1e3660f604515e7ce32970056e5c4cfec3435fa6182dd6db5ebf54`;
- installed size: 37,291 bytes;
- install completed on Pixel 9 USB serial `55221VDAQ000J1`;
- supported `MainActivity` startup path launched the non-exported service;
- service reported `isForeground=true`, notification ID `73`;
- companion window reported `168x168 px` at 420 dpi, equal to `64x64 dp`;
- semantic attention window was present but hidden at rest.

No Blinkit operation or cart mutation was used for this deployment check.

## Remaining gaps

### P0 — explicit cancellation boundaries

The overlay supports speech barge-in, but barge-in is not the same as cancelling
an in-flight phone operation.

Current behavior:

- starting a new hold stops TTS playback;
- a hold during `uploading` displays “Still working on your last request”;
- there is no cancel affordance, cancel request, operation ID, cancellation
  token, or acknowledgement from the execution layer;
- an Appium action that may already have crossed a mutation boundary cannot be
  distinguished from one that is still safely cancellable.

Required design before implementation:

1. Assign every phone operation an opaque operation ID.
2. Publish a cancellation policy with each progress state:
   `safe_to_cancel`, `stop_after_current_step`, or `not_cancellable`.
3. Permit cancellation only before a declared mutation/dispatch boundary.
4. Make cancellation idempotent and return a verified terminal result.
5. Never convert an unknown post-mutation outcome into “cancelled.”
6. Keep final ordering non-cancellable after dispatch and reconcile ambiguity
   instead.

### P0 — card-tap interruption and duplicate suppression

Product-choice rows submit an exact `offerId`, and the native `uploading` guard
prevents a second local submission. The end-to-end boundary still needs proof
that:

- a tap resolves only the currently pending clarification;
- a stale card cannot resolve a newer conversation state;
- tap plus near-simultaneous voice input cannot enqueue the same addition
  twice;
- repeated taps are idempotently rejected by the server;
- the server returns an explicit accepted/rejected choice result before the
  card changes state.

This is the active card-tap debugging scope. The audit intentionally makes no
code change to that path.

### P1 — richer live progress is not wired end to end

The shared presentation contract already allows:

```text
task.title
task.step
task.progress
```

However:

- `buildOverlayPresentation()` does not emit `task`;
- the Java `OverlayPresentation` model and parser do not retain it;
- `OverlayCardView` derives a generic headline from mode;
- execution broadcasts provide useful but coarse text states rather than a
  structured progress sequence.

The spinner is therefore truthful but not richly informative. The next slice
should carry task title, current semantic step, optional bounded progress, and
operation ID from execution through the presentation builder to the native
capsule.

Suggested steps for grocery work:

```text
Understanding request
Opening Blinkit
Searching products
Reading visible options
Waiting for your choice
Adding exact offer
Verifying cart line and quantity
Done
```

Progress must describe observed execution, not simulated percentages.

### P1 — conversation history is time-bounded, not turn-bounded

The voice server retains one conversation state per client with a ten-minute
TTL and uses OpenAI `previous_response_id`. The native overlay intentionally
shows only the latest presentation.

Still missing:

- an explicit maximum turn count or response-chain length;
- deterministic truncation that preserves pending product/checkout state;
- explicit `start over` history reset shared with the native companion;
- cleanup for inactive client IDs beyond lazy TTL checks;
- a small user-visible recent-turn surface, if product research shows it is
  actually needed.

Transactional state must remain structured and must not depend on prose history.

### P1 — attention regions are semantic but approximate

`SpatialAttentionView` maps subjects such as `options`, `cart`, and `checkout`
to broad percentage-based screen regions. This is privacy-safe and
non-touchable, but it is not anchored to a freshly verified element.

A future refinement may use sanitized geometry produced locally by the semantic
driver, provided that:

- raw screenshots, UI XML, selectors, and unrestricted coordinates never enter
  the public tool surface;
- the region belongs to the same serialized operation and screen observation;
- stale geometry is discarded after navigation;
- invalid geometry falls back to a general “check current screen” cue.

### P2 — speaking animation is rhythmic, not audio-reactive

Listening uses real `MediaRecorder.getMaxAmplitude()` samples. TTS speaking uses
a phase-based pulse rather than the decoded reply's audio amplitude. This is
truthful as a speaking indicator, but it does not mirror speech energy.

If audio-reactive TTS is desired, derive levels from playback data or a
supported visualizer path without delaying audio or retaining voice data.

### P2 — service restart recovery

The service restarts with “Hold to speak” and does not reconstruct:

- the latest structured presentation;
- an active backend operation;
- a pending clarification card;
- TTS playback state.

Persist only the minimum safe presentation/workflow reference. On restart,
query the local coordinator for authoritative state rather than assuming the
previous operation succeeded or failed.

### P2 — native regression coverage

The custom Java build verifies compilation, but the companion lacks automated
native tests for:

- mode-to-glyph mapping;
- amplitude normalization;
- animation lifecycle and release;
- tap/drag/hold separation;
- TTS barge-in;
- stale and repeated product-choice taps;
- cancellation policy rendering;
- structured task progress;
- service recreation;
- accessibility and reduced-motion behavior.

Add focused JVM tests where possible and a small real-device/instrumentation
matrix for touch, lifecycle, and WindowManager behavior.

## Recommended next sequence

1. Finish the active card-tap interruption/duplicate-suppression investigation.
2. Specify the operation-ID and cancellation-policy contract without adding a
   cancel button yet.
3. Wire structured `task` progress through TypeScript and Android.
4. Add state-transition and touch-regression tests.
5. Add restart recovery using coordinator truth.
6. Refine semantic attention geometry only after the above safety boundaries
   are stable.

Do not combine cancellation, richer progress, and final-order behavior into one
implementation slice. Each needs its own acceptance tests and safety review.
