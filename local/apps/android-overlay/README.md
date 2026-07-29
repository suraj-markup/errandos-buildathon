# JaldiAI Android overlay

Minimal native status overlay for the buildathon phone agent.

- Shows working, clarification, success, cart-ready, and error states above Blinkit.
- Press and hold the circular button to record. Releasing sends the command.
- Drag the compact circle to move it; the chosen position is remembered.
- Tap to reveal or hide the latest status. While listening or working it expands
  into a compact horizontal pill instead of covering the active application.
- Version-1 structured responses render as three progressive surfaces: a 64 dp
  companion, a 292 dp activity capsule, or a bounded 336 dp context card.
- Versioned semantic task progress shows only observed execution checkpoints,
  including queue position such as `1 of 3`, cancellation policy, verification,
  reconciliation, and stable terminal results. It never invents a percentage.
- Retained V2 events project into a persistent ordered checklist. Only an
  accepted `mutation_verified` event can check an item; local pause and
  connection states never create transaction success.
- The persistent companion morphs with the real interaction state: a
  microphone-reactive waveform while listening, spinner while the backend or
  phone is working, speech pulse during TTS, and distinct waiting, success, and
  error glyphs.
- Product-choice, checkout, provider-constraint, receipt, changed-terms, and
  ambiguous cards are parsed defensively. Unknown versions and malformed cards
  fall back to the legacy reply instead of crashing.
- Product-choice rows are interactive and accessible: title, image when
  supplied, size, price, unit price, availability, and structured
  recommendation labels remain explicit. A winning tap is persisted and
  highlighted before its idempotent exact-offer submission, while
  press-and-hold voice resolves the same retained interaction.
- A verified final cart renders line quantities, unit and line prices,
  subtotal, address, and `NOT ORDERED` beside only the bounded safe next
  actions supplied by the retained interaction.
- Listening, accepted selection, verified completion, and required-attention
  haptics are one-shot semantic cues; polling and rerendering stay silent.
- Verified provider-screen presentations can show a non-touchable pulsing
  semantic region and directional arrow. The phone receives only a subject such
  as `options`, `cart`, or `checkout`; it never receives screenshots, UI XML,
  selectors, or coordinates.
- Sarvam handles STT and TTS; the pill plays the spoken reply while Blinkit remains visible.
- Sarvam remains responsible for STT and TTS when the user chooses the voice path.
- It never confirms a cart mutation unless the Appium bridge verifies it.

Build with `./build.sh`. The APK is written to `dist/errandos-overlay-debug.apk`.

## Safe fixture validation

The checked-in fixtures exercise parsing and reducer behavior without
searching, changing a cart, or placing an order. `./build.sh` runs those
fixtures through the native JVM suites before packaging the APK.

The `ai.errandos.overlay.STATUS` receiver accepts only a package-explicit
broadcast carrying a random per-install capability. The capability file is
owner-only app data and the debug APK is deliberately linked with
`--debug-mode`, so the local server transport is:

```sh
adb shell run-as ai.errandos.overlay \
  cat files/status-ingress-capability
adb shell am broadcast \
  -a ai.errandos.overlay.STATUS \
  -p ai.errandos.overlay \
  --es ingressCapability CAPABILITY_FROM_FIRST_COMMAND
```

Do not put `am broadcast` inside `run-as`: Android's ActivityManager shell
entry point accepts only the root and shell UIDs. A missing/wrong capability,
an implicit broadcast, or a different target package is rejected before any
render or persistence effect.

`fixtures/checkout-review.json` covers the persistent `NOT ORDERED` state,
`fixtures/invalid-version.json` verifies the compact safe fallback, and
`fixtures/structured-progress-matrix.json` covers semantic progress without
contacting Blinkit or changing the phone.
