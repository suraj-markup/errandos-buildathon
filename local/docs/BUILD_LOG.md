# Build log

This log records what was genuinely designed, implemented, and verified in the buildathon repository.

## 2026-07-26

### Foundation

- Defined JaldiAI as the transaction-safe execution layer beneath Hermes.
- Chose a single Blinkit grocery vertical slice for the MVP.
- Defined the core proposal, approval, idempotency, receipt, and reconciliation guarantees.
- Separated the deterministic judging path from optional live Android-provider work.

### Typed foundation

- Scaffolded a Node.js and pnpm TypeScript workspace.
- Added runtime-validated contracts for money, product offers, immutable cart proposals, lifecycle states, and commit outcomes.
- Kept `ambiguous` outcomes structurally distinct from verified commits.
- Verified the foundation with typechecking, four contract tests, and a production build.

### Next

1. Implement a deterministic demo provider.
2. Canonicalize and hash exact proposal terms.
3. Enforce approval and idempotent, at-most-once commit behavior.
4. Expose the first narrow JaldiAI tools.
5. Build the request, proposal-review, and status interface.
6. Add an end-to-end demo and verification evidence.

### Local phone agent

- Added a circular Android overlay with press-and-hold voice capture.
- Connected Sarvam STT and TTS so instructions, follow-up questions, progress,
  and results can remain in the user's Indian language.
- Added an OpenAI-backed tool-planning layer with narrow Appium phone actions.
- Added contextual follow-up handling so a spoken product choice or
  “add to cart” continues the pending task.
- Added exact product matching and spoken clarification for ambiguous requests.
- Added guarded COD checkout review with explicit confirmation, provider-state
  fingerprinting, and at-most-once final action protection.
- Verified the speech pipeline across Hindi, Tamil, Marathi, Bengali, Gujarati,
  Kannada, Malayalam, Punjabi, Telugu, and Odia.

### Repository layout

- Added the Hermes/server implementation as the first-class `hosted` workspace.
- Kept the phone/Appium/Sarvam implementation as the first-class `local`
  workspace.
- Preserved local env files while committing only safe env templates.

## 2026-07-27

### Self-contained local execution stack

- Copied the hosted control plane, worker, web client, typed contracts,
  application/domain/persistence packages, provider connectors, Hermes skill,
  infrastructure, tests, scripts, and documentation into `local/`.
- Kept `hosted/` unchanged and independently runnable.
- Preserved the Android overlay, voice app, and ignored local env file.
- Replaced the voice app's hardcoded Blinkit search IDs with the copied
  semantic Appium driver and bounded screen recovery.
- Added an explicit Appium device identifier so USB and wireless ADB devices
  can be selected deterministically.
- Carried opaque Blinkit `offerId` values through spoken clarification state,
  ensuring a follow-up selects the exact visible offer rather than a new
  top-ranked search result.
- Kept pending clarification state after retryable automation failures.
- Added idempotent `already_in_cart` handling for repeated voice commands.

### Live prototype verification

- Confirmed the Pixel, Appium, and local voice server were reachable.
- Reproduced and fixed Blinkit's XML-encoded apostrophe mismatch for
  `Lays`/`Lay's`.
- Verified a broad “Lays” request returns three visible choices without
  changing the cart.
- Verified the selected 58 g Magic Masala offer is added and independently
  present in the cart at quantity one.
- Verified a real two-turn voice exchange: Sarvam transcribed both turns,
  OpenAI selected the stored offer ID, the pending follow-up survived a
  retryable failure, and Sarvam produced a verified spoken cart response.

### Interface boundary

- Kept the overlay scoped to voice capture and task status.
- Deferred visual polish of the floating control until after the execution
  prototype is stable.
