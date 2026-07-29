# JaldiAI Realtime, Vision, and Safe Phone-Agent Master Implementation Plan

> **Status:** Active implementation sequence as of 2026-07-28 — 44 of 62
> implementation tasks have production-reachable evidence; 18 remain.
>
> **Extends:** [`../local-phone-agent-implementation-plan.md`](../local-phone-agent-implementation-plan.md)
>
> **Adaptive hardening continuation:** The goal-retention, dynamic planning,
> persistent context, interactive progress, checkout-continuation, and
> dead-code convergence work identified by the latest multi-item/COD logs is
> tracked in
> [`2026-07-28-adaptive-phone-agent-hardening-plan.md`](2026-07-28-adaptive-phone-agent-hardening-plan.md).
> That plan also requires an evidence audit because this header and the
> numbered task checkboxes are currently inconsistent.
>
> **Incorporates:**
>
> - [`2026-07-27-screen-aware-companion-interface.md`](2026-07-27-screen-aware-companion-interface.md)
> - [`2026-07-27-clicky-pattern-gap-audit.md`](2026-07-27-clicky-pattern-gap-audit.md)
> - [`../2026-07-27-sarvam-realtime-control-adr.md`](../2026-07-27-sarvam-realtime-control-adr.md)
>
> This document is the forward-looking delivery plan. The earlier phone plan
> remains the source of truth for the command, execution, product-selection,
> checkout, and existing verification foundations.

## 1. Goal

Turn the current local JaldiAI Android companion into a low-latency,
screen-aware, interruption-friendly phone agent that:

- uses Sarvam for Indian-language speech recognition and speech synthesis;
- uses GPT Realtime as a persistent text-and-image control model for screen
  understanding, task reasoning, and narrow tool proposals;
- understands the visible Blinkit screen when visual context is useful;
- points at a freshly verified product, cart, checkout, or recovery target;
- preserves the exact product and multi-item workflow across follow-ups;
- allows both voice and touch product selection;
- shows truthful live progress instead of a generic waiting state;
- safely interrupts conversational output without incorrectly cancelling an
  in-flight phone mutation;
- verifies every cart mutation before advancing;
- keeps checkout review and final ordering behind an explicit, durable safety
  boundary;
- recovers authoritative task state after a process, service, network, or
  device interruption.

The intended experience for “Add milk and ice cream” is:

```text
Hold JaldiAI and speak
  → Sarvam transcribes the Indian-language or code-mixed utterance
  → the transcript enters a persistent GPT Realtime control session
  → JaldiAI understands the complete two-item task
  → task 1 of 2: milk
  → Blinkit opens and searches
  → JaldiAI reads semantic results and, when useful, a fresh screenshot
  → the overlay points to verified milk choices
  → the user taps a card or speaks a choice
  → the exact offer is added once
  → the cart line, price, pack, and quantity are reconciled
  → task 2 of 2: ice cream
  → the same flow continues
  → JaldiAI reports the verified cart summary
  → nothing is ordered without a separately reviewed confirmation
```

## 2. Architecture decision

Use a hybrid architecture rather than replacing Sarvam speech or the
deterministic phone driver with a voice or vision model.

```text
Android microphone
  → Sarvam STT
  → persistent GPT Realtime text/image control session
  → server-owned structured task and tool adapter
  → serialized Blinkit execution service
  → Appium semantic driver for exact actions and verification
  → optional screenshot plus ephemeral element references for visual context
  → deterministic presentation builder
  → Sarvam TTS
  → native companion, capsule, context card, and attention overlay
```

Responsibilities:

| Layer | Authority |
| --- | --- |
| Sarvam speech provider | Indian-language STT and TTS, including code-mixed voice input and spoken output |
| GPT Realtime control model | Intent, task reasoning, image context, clarification semantics, and narrow tool proposals; text output only |
| Structured workflow | Current task, item queue, allowed transition, pending choice, and cancellation policy |
| Execution service | Serialized phone ownership, recovery policy, mutation boundary, and result classification |
| Semantic Appium driver | Exact provider identity, element targeting, mutation, and read-only verification |
| Vision input | Understanding visible layout and selecting an ephemeral semantic element reference |
| Presentation builder | Verified spoken and visual response |
| Android overlay | Audio capture/playback, direct interaction, progress rendering, and non-touchable attention |

The model must never become the source of truth for:

- whether a cart mutation succeeded;
- which opaque provider offer was selected;
- whether a provider screen is fresh;
- raw tap coordinates;
- whether checkout terms are unchanged;
- whether an order was placed.

## 3. Current implementation baseline

### 3.1 Verified complete

The current repository already has:

- [x] Read-only `search_products` separate from cart mutation.
- [x] Exact `add_cart_item` with opaque offer ID and quantity.
- [x] Exact cart quantity update and removal commands.
- [x] Runtime validation before Appium execution.
- [x] One serialized local phone operation queue.
- [x] One reversible Blinkit execution service and recovery policy.
- [x] Stage-specific execution failures.
- [x] Ordered multi-product execution that pauses at the first clarification.
- [x] Durable-in-turn retention of the active product and later queued items.
- [x] Exact ordinal, flavor, size, and option-number clarification.
- [x] Deterministic retry, skip, and product-workflow cancellation phrases.
- [x] Concise spoken product labels separate from canonical provider titles.
- [x] Deterministic voice and visual presentation.
- [x] A versioned overlay presentation contract with safe parsing.
- [x] A 64 dp companion, 292 dp capsule, and bounded 336 dp context card.
- [x] Listening waveform, working spinner, speaking pulse, and terminal glyphs.
- [x] Persistent waiting, checkout review, error, receipt, and ambiguity modes.
- [x] Interactive exact-offer product rows while preserving voice selection.
- [x] TTS barge-in at the presentation layer.
- [x] A separate non-touchable attention overlay.
- [x] Approximate semantic attention subjects such as options, cart, and
      checkout.
- [x] Screen-aware deterministic presentation policy.
- [x] Structured request, provider, model, tool, workflow, and result logging.
- [x] Post-mutation cart reconciliation for delayed or missing quantity
      controls.
- [x] Support for Blinkit option sheets that expose only a product title.
- [x] A Realtime WebRTC session route prototype.
- [x] Checkout contracts with proposal expiry, fingerprint comparison,
      idempotency, at-most-once dispatch, and ambiguous-result concepts.

### 3.2 Partially implemented

- [~] Conversation state is a typed phase union, but it remains embedded in the
      voice route and stored in a ten-minute in-memory map.
- [~] Product card taps are exact and invalid offers are rejected, but there is
      no explicit clarification ID, accepted-selection acknowledgement, or
      proven tap-plus-voice duplicate suppression.
- [~] Product cancellation exists, but there is no operation-aware cancellation
      of an in-flight Appium task.
- [~] Progress broadcasts exist, but the shared `task.title`, `task.step`, and
      `task.progress` fields are not wired end to end.
- [~] Current-screen attention exists, but it uses broad percentage regions
      rather than verified element geometry.
- [~] Realtime session creation exists, but it is an audio-oriented WebRTC
      prototype. The Pixel overlay still uses the bounded `/api/voice/turn`
      Sarvam → GPT-4.1-mini → Sarvam pipeline, and there is no persistent
      server-side text/image Realtime control session.
- [~] Checkout behavior exists in legacy paths, but preparation and final
      confirmation have not fully migrated to the unified execution service.
- [~] Native compilation and real-device canaries exist, but automated native
      state, gesture, lifecycle, and accessibility coverage is limited.

### 3.3 Not implemented

- [ ] Screenshot capture and vision interpretation in the active phone flow.
- [ ] Ephemeral screenshot-to-element-reference grounding.
- [ ] Precise verified spatial attention geometry.
- [ ] Production server-side Realtime text/image control transport.
- [ ] Realtime access to the complete safe phone tool adapter.
- [ ] Shadow comparison of GPT Realtime control decisions against the current
      GPT-4.1-mini control path using Sarvam transcripts.
- [ ] Explicit local operation IDs and cancellation policies.
- [ ] Durable task repository and restart recovery.
- [ ] Explicit turn-count and history bounds.
- [ ] Audio-reactive TTS animation.
- [ ] Full native and live race-condition regression coverage.

## 4. Comparison with the previous phone implementation plan

| Previous milestone | Current status | Work carried into this plan |
| --- | --- | --- |
| 1. Define local command model | Mostly complete | Add operation, cancellation, clarification-selection, and screenshot-observation commands |
| 2. Unified execution service | Reversible actions complete; checkout partial | Move checkout behind the same service; expose operation lifecycle and cancellation boundary |
| 3. Exact product selection | Core complete | Finish pack/price verification, exact deduplication, unavailable offers, and stale-choice protection |
| 4. Conversation state machine | Partial | Extract transitions, add durable task/item state, bounded history, start-over, replacement, and terminal cleanup |
| 5. Deterministic presentation | Core complete | Add structured task progress, operation policy, precise attention, Realtime control events, and Sarvam playback events |
| 6. Refactor voice route | Partial | Extract speech, Realtime, vision, workflow, operation registry, and repository adapters |
| 7. Overlay progress and interaction | Mostly complete visually | Wire truthful semantic steps, safe cancel availability, accepted/rejected card state, and audio-reactive output |
| 8. Consolidate checkout | Pending | Complete unified preparation, fresh term comparison, expiry, ambiguity, and no-retry safety |
| 9. Tests and live verification | Strong reversible coverage | Add race, screenshot, Realtime, cancellation, restart, native accessibility, and checkout-change matrices |

Changes to previous assumptions:

1. Do not delete the Realtime path. Convert it into a text/image control path
   behind `JALDI_REALTIME_CONTROL_V1`.
2. Keep Sarvam as the production STT/TTS provider and keep the current bounded
   HTTP route as a production fallback.
3. Permit screenshots only through a private, ephemeral observation pipeline;
   never add screenshots to the public phone tool contract.
4. Replace approximate attention with verified local geometry only after the
   operation and stale-input boundaries are complete.
5. Treat Sarvam TTS interruption, Realtime response cancellation, and
   phone-operation cancellation as three different mechanisms.

## 5. Safety and correctness invariants

These requirements apply to every delivery.

1. Only one operation may control one phone at a time.
2. Every phone operation has an opaque local `operationId`.
3. Every user task has an opaque `taskId`.
4. Every pending product question has an opaque `clarificationId`.
5. Every interactive answer has a one-use `selectionId` or idempotency key.
6. A stale clarification can never resolve a newer task.
7. Tap and voice answers for the same clarification can produce at most one
   accepted selection.
8. A model function call is a proposal to the local tool adapter, not authority
   to mutate the phone.
9. Search and screenshot observation are read-only.
10. Every reversible mutation is verified from provider state before success.
11. A post-mutation unknown result is reconciled read-only before retry.
12. The system never repeats a mutation merely because presentation or TTS
    failed.
13. Cancellation is permitted only according to the operation's current
    cancellation policy.
14. An unknown post-mutation state is never labelled cancelled.
15. Checkout preparation never places an order.
16. Final dispatch remains separately confirmed, idempotent, and at most once.
17. Changed checkout terms invalidate the previous review.
18. An ambiguous final result never uses success styling or automatic retry.
19. Screenshot interpretation never supplies raw tap coordinates to the
    executor.
20. Raw screenshots, audio, UI XML, selectors, element bounds, OTPs, and
    payment details never appear in structured logs.

## 6. Target state and contracts

### 6.1 Task state

Suggested internal state:

```ts
type LocalPhoneTaskV1 = {
  version: 1;
  taskId: string;
  clientId: string;
  status:
    | 'active'
    | 'waiting_for_user'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'ambiguous';
  items: LocalTaskItemV1[];
  activeItemIndex: number;
  conversationTurnCount: number;
  createdAt: string;
  updatedAt: string;
};

type LocalTaskItemV1 = {
  itemId: string;
  request: string;
  quantity: number;
  status:
    | 'pending'
    | 'searching'
    | 'awaiting_choice'
    | 'selected'
    | 'adding'
    | 'verifying'
    | 'verified'
    | 'skipped'
    | 'failed';
  selectedOffer?: {
    offerId: string;
    title: string;
    packSize?: string;
    priceAmount: number;
    priceCurrency: 'INR';
  };
  attempts: number;
  lastFailure?: LocalExecutionFailureV1;
};
```

Transactional state must live here, not only in model conversation prose.

### 6.2 Operation lifecycle

```ts
type LocalPhoneOperationV1 = {
  version: 1;
  operationId: string;
  taskId: string;
  itemId?: string;
  kind:
    | 'search_products'
    | 'inspect_cart'
    | 'add_cart_item'
    | 'set_cart_item_quantity'
    | 'remove_cart_item'
    | 'prepare_checkout'
    | 'confirm_order'
    | 'capture_screen_observation';
  status:
    | 'queued'
    | 'running'
    | 'waiting_for_user'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'ambiguous';
  step: string;
  sequence: number;
  cancellationPolicy:
    | 'safe_to_cancel'
    | 'stop_after_current_step'
    | 'not_cancellable';
  mutationBoundary:
    | 'not_started'
    | 'before_mutation'
    | 'mutation_attempted'
    | 'verified'
    | 'final_dispatch_attempted';
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
};
```

### 6.3 Clarification and selection

```ts
type ProductClarificationV1 = {
  version: 1;
  clarificationId: string;
  taskId: string;
  itemId: string;
  operationId: string;
  status: 'open' | 'resolving' | 'resolved' | 'expired' | 'cancelled';
  options: ProductChoiceV1[];
  createdAt: string;
  expiresAt: string;
};

type ProductSelectionV1 = {
  clarificationId: string;
  selectionId: string;
  offerId: string;
  source: 'voice' | 'overlay_tap';
};
```

The server atomically transitions `open → resolving` for the first valid
selection. Every later tap or voice answer receives the existing accepted
result and cannot enqueue a second add.

### 6.4 Structured progress

Every operation emits ordered progress:

```ts
type LocalOperationProgressV1 = {
  operationId: string;
  sequence: number;
  mode:
    | 'understanding'
    | 'reading'
    | 'acting'
    | 'verifying'
    | 'waiting_for_user';
  title: string;
  step: string;
  progress?: number;
  cancellationPolicy: LocalPhoneOperationV1['cancellationPolicy'];
  occurredAt: string;
};
```

Use an indeterminate indicator unless progress is based on known completed
steps. Do not simulate percentages for provider waits.

### 6.5 Private screen observation

Screenshot data remains internal and ephemeral:

```ts
type PrivateScreenObservationV1 = {
  observationId: string;
  operationId: string;
  deviceId: string;
  packageName: string;
  activityName?: string;
  screenKind: AndroidScreenKindV1;
  screenFingerprint: string;
  capturedAt: string;
  expiresAt: string;
  image: {
    mimeType: 'image/jpeg' | 'image/png';
    bytes: Uint8Array;
    width: number;
    height: number;
  };
  elements: Array<{
    elementRef: string;
    role: string;
    label: string;
    bounds: PrivateRect;
  }>;
};
```

Rules:

- This type is not exported through the public tool contract.
- Image bytes are not written to disk by default.
- Bounds are retained only inside the local observation registry.
- Logs contain observation ID, dimensions, screen kind, duration, element
  count, and redaction status—not image contents or labels.
- Any navigation, orientation change, new operation, or mismatched screen
  fingerprint invalidates the observation.

### 6.6 Vision grounding result

The model selects an ephemeral reference rather than coordinates:

```ts
type VisionGroundingResultV1 =
  | {
      status: 'grounded';
      observationId: string;
      elementRef: string;
      semanticSubject:
        | 'options'
        | 'product'
        | 'cart'
        | 'checkout'
        | 'payment'
        | 'address'
        | 'confirmation';
      confidence: 'high' | 'medium';
    }
  | {
      status: 'not_grounded';
      reason:
        | 'no_relevant_element'
        | 'ambiguous'
        | 'restricted_screen'
        | 'stale_observation';
    };
```

The local observation registry resolves `elementRef → bounds`. The model never
returns a coordinate.

### 6.7 Private spatial attention command

Precise geometry is delivered only to the installed Android companion:

```ts
type PrivateSpatialAttentionCommandV1 = {
  observationId: string;
  operationId: string;
  screenFingerprint: string;
  normalizedRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  expiresAt: string;
};
```

It must not be included in model prompts, public MCP tools, analytics, or
durable conversation state.

## 7. P0 — correctness and mutation safety

P0 work must land before Realtime is allowed to issue production mutations.

### P0.1 Extract an authoritative workflow state machine

**Work:**

- [ ] Move phase definitions and transitions out of
      `app/api/voice/turn/route.ts`.
- [ ] Create pure transition functions with exhaustive state matching.
- [ ] Add `taskId`, per-item state, and active-item index.
- [ ] Preserve the entire requested product list as structured state.
- [ ] Add `start_over`.
- [ ] Allow a clearly unrelated new request to replace an open clarification
      through an explicit transition.
- [ ] Clear terminal state predictably.
- [ ] Keep pending checkout and pending product clarification mutually
      exclusive.
- [ ] Add a repository interface independent of HTTP and model calls.

**Acceptance:**

- A multi-item request advances one verified item at a time.
- No later product is searched while the active item awaits a choice.
- Model conversation loss does not delete the structured task.
- Every user-visible response is derived from an allowed transition.

### P0.2 Add local operation IDs and lifecycle registry

**Work:**

- [ ] Generate one operation ID before enqueueing phone work.
- [ ] Register queue, start, progress, mutation-boundary, and terminal events.
- [ ] Bind each operation to one task and optional task item.
- [ ] Expose read-only operation status to the overlay coordinator.
- [ ] Make terminal writes idempotent.
- [ ] Prevent an old request from completing into a newer task.
- [ ] Retain a bounded terminal-operation history for diagnostics.

**Acceptance:**

- Logs for a turn, tool call, Appium action, progress update, and presentation
  share the same operation ID.
- A late completion from an obsolete operation cannot overwrite current UI.
- Repeating a terminal event does not change the result.

### P0.3 Implement mutation-aware cancellation

**Work:**

- [ ] Add a typed `cancel_current_task` command.
- [ ] Publish a cancellation policy with every progress event.
- [ ] Permit immediate cancellation before phone ownership or mutation.
- [ ] Permit `stop_after_current_step` only at declared driver checkpoints.
- [ ] Mark mutation and final-dispatch boundaries explicitly.
- [ ] After a mutation attempt, reconcile provider state rather than claiming
      cancellation.
- [ ] Make cancellation idempotent.
- [ ] Return a verified terminal result.
- [ ] Display cancel only while policy permits it.
- [ ] Keep final order dispatch non-cancellable once attempted.

**Acceptance:**

- Barge-in always stops model audio.
- Barge-in cancels phone execution only when the operation policy permits.
- The UI never reports “cancelled” for an unknown cart or order outcome.
- Cancellation never clears the cart unless the user separately requests that
  exact reversible action.

### P0.4 Make card tap and voice selection atomic

**Work:**

- [ ] Add `clarificationId` to product-choice presentations.
- [ ] Add a one-use `selectionId` to tap and voice resolutions.
- [ ] Atomically accept the first valid answer.
- [ ] Reject stale, expired, unknown, or already-resolved clarifications.
- [ ] Return an explicit accepted/rejected/duplicate acknowledgement.
- [ ] Change the tapped row to `selected`, then `working`, only after server
      acceptance.
- [ ] Disable other rows during resolution.
- [ ] Make duplicate delivery return the original resolution.
- [ ] Preserve voice selection and touch selection equally.
- [ ] Add tap-plus-voice and repeated-tap race tests.

**Acceptance:**

- Near-simultaneous tap and voice input cause one mutation at most.
- A stale card cannot answer a new product question.
- The server response, not local animation, determines whether selection was
  accepted.

### P0.5 Finish exact product verification

**Work:**

- [ ] Include pack size and price in verification wherever Blinkit exposes
      them.
- [ ] Preserve exact duplicate and unavailable offer semantics.
- [ ] Collapse only identical provider offers.
- [ ] Keep title-only variant sheet support.
- [ ] Keep post-mutation reconciliation without repeating the mutation.
- [ ] Record whether success came from direct control verification or cart
      reconciliation.
- [ ] Verify every unaffected cart line remains preserved.

**Acceptance:**

- Same-title, different-size products cannot be confused.
- A successful mutation cannot become a false failure solely because an
  accessibility control appeared late.
- A failed verification cannot silently advance the item queue.

### P0.6 Consolidate checkout in the unified execution service

**Work:**

- [ ] Add and validate `prepare_checkout`.
- [ ] Route checkout preparation through `BlinkitExecutionService`.
- [ ] Capture complete items, quantities, unit prices, fees, total, address
      label, payment mode, ETA, provider fingerprint, and expiry.
- [ ] Keep confirmation separate from preparation.
- [ ] Re-read and compare material provider terms immediately before dispatch.
- [ ] Return typed changed fields when terms differ.
- [ ] Preserve proposal expiry and idempotency.
- [ ] Never automatically retry final dispatch.
- [ ] Reconcile ambiguous dispatch read-only.
- [ ] Delete obsolete grocery and checkout paths only after parity tests pass.

**Acceptance:**

- Checkout always says and displays `NOT ORDERED` before confirmation.
- Any material change invalidates the previous review.
- A prepared checkout cannot place an order.
- An ambiguous final result cannot become success without provider evidence.

## 8. P1 — Realtime, vision, progress, and conversation quality

### P1.1 Refactor the voice route into adapters

Suggested structure:

```text
local/apps/voice/lib/
  speech/
    provider.ts
    sarvam.ts
  realtime/
    session.ts
    events.ts
    tool-adapter.ts
    conversation-bridge.ts
  vision/
    capture.ts
    redact.ts
    observation-registry.ts
    annotate.ts
    grounding.ts
  workflow/
    state.ts
    transitions.ts
    repository.ts
  operations/
    registry.ts
    cancellation.ts
    progress.ts
  execution/
    blinkit-execution.ts
    operation-queue.ts
  presentation/
    overlay-presentation.ts
    voice-response.ts
```

**Work:**

- [ ] Extract Sarvam STT/TTS behind a `SpeechProvider`.
- [ ] Extract OpenAI model client and tool schemas.
- [ ] Extract Realtime session and event handling.
- [ ] Extract workflow transition and repository access.
- [ ] Extract operation lifecycle and progress.
- [ ] Extract screenshot and vision services.
- [ ] Keep API routes as thin coordinators.
- [ ] Add request, operation, and provider deadlines independently.
- [ ] Keep deterministic presentation separate from model prose.

**Acceptance:**

- Speech providers can change without changing phone execution.
- Realtime and bounded HTTP turns call the same workflow and tool adapter.
- Execution, vision grounding, workflow transitions, and presentation are
  independently testable.

### P1.2 Wire structured task progress end to end

**Work:**

- [x] Emit semantic progress from workflow and execution checkpoints.
- [x] Populate `presentation.task.title`.
- [x] Populate `presentation.task.step`.
- [x] Populate bounded progress only for known step counts.
- [x] Parse task fields in `OverlayPresentationParser`.
- [x] Retain them in `OverlayPresentation`.
- [x] Render them in `OverlayCardView`.
- [x] Show task-item position such as `1 of 3`.
- [x] Show cancellation availability from the operation policy.
- [x] Ignore out-of-order progress sequence numbers.
- [x] Prevent terminal results from being overwritten by late progress.

Suggested grocery sequence:

```text
Understanding your request
Opening Blinkit
Searching for milk
Reading visible options
Waiting for your choice
Adding Amul Gold 500 ml
Verifying cart line and quantity
Moving to item 2 of 3
Done
```

**Acceptance:**

- The displayed step is an observed execution state.
- The overlay never says “working” after terminal completion.
- A progress update cannot change transactional state.

### P1.3 Build private screenshot capture and redaction

**Work:**

- [ ] Add screenshot capture to the existing Appium/UI port.
- [ ] Capture within the serialized operation or an explicitly read-only
      observation operation.
- [ ] Capture the provider app content area rather than unrelated phone UI when
      possible.
- [ ] Suppress the attention layer during capture to prevent visual feedback.
- [ ] Detect restricted `login`, `otp`, payment, and other sensitive screens.
- [ ] Crop or redact status notifications, account details, raw addresses,
      phone numbers, payment identifiers, and OTPs.
- [ ] Downscale and encode once according to the selected model path.
- [ ] Keep image bytes memory-only by default.
- [ ] Add a short-lived observation registry.
- [ ] Invalidate observations on navigation, orientation change, new phone
      operation, or screen fingerprint mismatch.
- [ ] Add explicit screenshot-retention and redaction tests.

**Acceptance:**

- Screenshot capture is read-only.
- No screenshot bytes or sensitive visual text enter logs.
- Restricted screens produce a privacy-safe attention card without vision.
- A successful phone action remains successful if optional screenshot capture
  fails.

### P1.4 Ground screenshots to ephemeral semantic elements

Use screenshots for understanding, not direct coordinate authority.

**Work:**

- [ ] Build candidate elements from the fresh semantic UI read.
- [ ] Assign short-lived opaque element references.
- [ ] Keep `elementRef → bounds` only in the local registry.
- [ ] Optionally annotate the screenshot with non-sensitive reference labels.
- [ ] Send the screenshot, user intent, screen kind, and sanitized semantic
      labels to the model.
- [ ] Require a structured `VisionGroundingResultV1`.
- [ ] Reject unrecognized or ambiguous element references.
- [ ] Revalidate package, screen fingerprint, observation ID, and expiry before
      using the target.
- [ ] Fall back to the broad semantic attention subject if grounding fails.
- [ ] Never execute a raw model coordinate or selector.

Initial vision paths to compare:

1. Attach `input_image` to the existing GPT-4.1-mini Responses request.
2. Attach the image to the active `gpt-realtime-2.1` conversation.
3. Keep a separate vision request only when the Realtime turn does not need the
   screenshot in conversational context.

**Acceptance:**

- The model can choose “Amul Gold 500 ml” by ephemeral reference.
- Stale or mismatched observations cannot draw attention or mutate the phone.
- Vision failure never blocks a valid semantic-driver fallback.

### P1.5 Replace approximate attention with verified geometry

**Work:**

- [ ] Resolve the selected element reference inside the local observation
      registry.
- [ ] Transform bounds for screenshot crop, density, rotation, status bar,
      navigation inset, and overlay coordinate space.
- [ ] Deliver a private short-lived spatial-attention command to Android.
- [ ] Bind it to operation ID, observation ID, fingerprint, and expiry.
- [ ] Draw a ring, arrow, underline, or pulse in the existing non-touchable
      attention window.
- [ ] Remove the target after navigation, expiry, operation completion, or
      orientation change.
- [ ] Fall back to broad semantic regions when exact geometry is unavailable.
- [ ] Keep Blinkit fully touchable.

Candidate exact targets:

- selected product card;
- exact variant row;
- quantity stepper;
- cart entry point;
- changed cart line;
- checkout total;
- saved address;
- COD option;
- confirmation evidence.

**Acceptance:**

- The highlight aligns on the test Pixel in portrait mode.
- It cannot intercept provider touches.
- It disappears immediately when stale.
- Raw geometry is absent from model, public tool, and structured log payloads.

### P1.6 Integrate GPT Realtime as the text/image control model

Current candidate model: `gpt-realtime-2.1`.

OpenAI documents that it supports:

- text, audio, and image input;
- text and audio output;
- function calling;
- prompt caching;
- configurable reasoning effort;
- speech interruption.

JaldiAI will use only text and image input plus text and function-call output
from this model. Sarvam remains responsible for STT and TTS. GPT-Live is not
an implementation dependency: as of 2026-07-27 OpenAI describes it as a
ChatGPT voice model and says API availability is planned, while also noting
that screen sharing is not supported at launch.

**Work:**

- [ ] Replace the audio-oriented prototype with a persistent server-side
      Realtime control-session adapter.
- [ ] Submit Sarvam transcripts as `input_text`.
- [ ] Submit a redacted, policy-approved screenshot as `input_image` only when
      the screenshot trigger policy allows it.
- [ ] Request text-only output and validated function calls; never request
      OpenAI audio in the production Sarvam path.
- [ ] Replace the prototype-only tool surface with the shared safe tool
      adapter.
- [ ] Configure the model by environment rather than hardcoded source.
- [ ] Start with low reasoning effort for latency-sensitive control turns.
- [ ] Keep phone mutations disabled in shadow mode.
- [ ] Feed identical Sarvam transcripts, structured task state, and sanitized
      screenshot observations to GPT-4.1-mini/current Responses and Realtime.
- [ ] Compare product entities, quantities, ordinals, negation, cancellation,
      clarification resolution, intended tool, and visual grounding.
- [ ] Record control latency metrics without storing raw audio or screenshots.
- [ ] Keep GPT-4.1-mini/current Responses as the control authority until the
      evaluation gate passes.

Required language corpus:

- English;
- Hindi;
- Hinglish;
- Gujarati;
- Marathi;
- at least one additional supported Indic language;
- brand names, pack sizes, quantities, prices, and code-mixed ordinals.

**Acceptance:**

- Realtime produces no production phone mutation in shadow mode.
- Accuracy and latency reports are available per language, intent, and screen
  class.
- A model/provider decision is based on the evaluation, not anecdotal turns.

### P1.7 Add the persistent Realtime control transport

The native overlay may continue uploading an AAC turn for Sarvam STT. The
backend maintains the low-latency Realtime session after transcription, sends
text/image conversation items, streams text/tool events, and returns final
presentation text to Sarvam TTS.

**Transport decision:**

- Preferred: server-side Realtime WebSocket owned by the local backend.
- Do not embed an OpenAI key or ephemeral Realtime credential in the APK.
- Keep the existing bounded Sarvam/Responses HTTP path as fallback.

**Work:**

- [ ] Add a server-side `RealtimeControlTransport` interface.
- [ ] Add session creation, task correlation, reconnect, and terminal cleanup.
- [ ] Send Sarvam transcript plus bounded authoritative task context.
- [ ] Stream text deltas and tool lifecycle events into structured progress.
- [ ] Send optional redacted image content only through the observation policy.
- [ ] Send final deterministic response text to Sarvam TTS.
- [ ] Stop Sarvam playback immediately on new push-to-talk.
- [ ] Cancel obsolete model responses without automatically cancelling an
      in-flight phone operation.
- [ ] Continue showing task progress while a phone tool runs.
- [ ] Fall back to the bounded Responses control path when Realtime is
      unavailable.

**Acceptance:**

- The Realtime session retains task-control context across Sarvam voice turns.
- Text and tool lifecycle progress begins before the final Sarvam TTS response.
- A Realtime connection failure does not lose the structured task.
- Sarvam audio interruption and model-response cancellation do not imply
  phone-operation cancellation.

### P1.8 Route Realtime tools through the existing safety boundary

**Work:**

- [ ] Give Realtime only narrow typed functions.
- [ ] Validate every function call using the existing command schemas.
- [ ] Bind calls to task and operation IDs.
- [ ] Route calls through the same serialized operation queue.
- [ ] Return structured tool results to the Realtime session.
- [ ] Let deterministic presentation own provider success and safety wording.
- [ ] Prevent Realtime from manufacturing `verified`, `ordered`, or screen
      evidence.
- [ ] Keep final order confirmation unavailable in the initial Realtime
      rollout.
- [ ] Add per-tool deadlines and explicit recoverable errors.
- [ ] Stop irrelevant follow-up model calls after a deterministic waiting or
      terminal presentation is already available.

**Acceptance:**

- Realtime and bounded HTTP turns have identical mutation semantics.
- A Realtime reconnection cannot replay a completed mutation.
- The model cannot bypass checkout confirmation.

### P1.9 Bound conversation history and preserve structured state

**Work:**

- [ ] Add a maximum turn count and/or response-chain length.
- [ ] Truncate prose history deterministically.
- [ ] Preserve active task, active item, pending clarification, selected offer,
      and pending checkout outside prose history.
- [ ] Add `start_over`.
- [ ] Add explicit session close and inactive-client cleanup.
- [ ] Keep a small user-visible recent-turn surface only if research justifies
      it.
- [ ] Map Realtime conversation items to the authoritative task rather than
      treating the Realtime session as the task database.

**Acceptance:**

- History truncation cannot forget the shopping list or selected product.
- A new Realtime session can resume the authoritative structured task.
- Inactive sessions are cleaned without affecting active operations.

### P1.10 Add latency and quality instrumentation

Measure:

- push-to-talk down;
- first audio byte sent;
- final transcript available;
- intent/tool decision available;
- queue wait;
- Appium session acquisition;
- provider search complete;
- clarification shown;
- selection accepted;
- mutation attempted;
- verification complete;
- first output audio byte;
- playback complete;
- total turn duration.

**Work:**

- [ ] Add request, task, operation, clarification, selection, observation, and
      Realtime session IDs to structured context.
- [ ] Emit start/complete/error around every asynchronous boundary.
- [ ] Separate model latency from device automation latency.
- [ ] Record screenshot capture, redaction, encoding, and grounding duration.
- [ ] Record fallback reason.
- [ ] Redact audio, screenshot, transcript, address, payment, and secret data by
      default.
- [ ] Add a local evaluation report generator.

**Acceptance:**

- A timeout can be assigned to the exact stage that consumed the time.
- Realtime improvement is measured by time to transcript and first audio, not
  only total Appium task duration.

## 9. P2 — recovery, polish, and production hardening

### P2.1 Service and server restart recovery

**Work:**

- [ ] Persist the minimum authoritative task and operation metadata.
- [ ] Do not persist raw screenshots or audio.
- [ ] On Android service restart, query the coordinator for current state.
- [ ] Restore pending clarification, progress, and latest safe presentation.
- [ ] On server restart, recover active tasks and terminal operation records.
- [ ] Reconcile any operation that crossed a mutation boundary.
- [ ] Expire stale screenshot observations and Realtime sessions.
- [ ] Never assume an interrupted operation succeeded or failed.

**Acceptance:**

- Restart during a pending choice restores the same exact choices.
- Restart after a possible mutation triggers read-only reconciliation.
- Restart cannot repeat final dispatch.

### P2.2 Audio-reactive speaking and interaction polish

**Work:**

- [ ] Drive speaking motion from actual output audio energy.
- [ ] Preserve reduced-motion behavior.
- [ ] Keep listening waveform driven by actual microphone amplitude.
- [ ] Add selected, accepted, rejected, duplicate, and expired card states.
- [ ] Make long work feel alive through truthful progress rather than repeated
      speech.
- [ ] Keep terminal results readable before collapse.
- [ ] Preserve the user-selected companion position.
- [ ] Ensure card expansion does not obscure the exact provider target.

### P2.3 Native accessibility and lifecycle coverage

**Work:**

- [ ] Add JVM tests where possible for presentation parsing and state mapping.
- [ ] Add instrumentation tests for tap, hold, drag, and tap-plus-voice races.
- [ ] Test TTS barge-in and Realtime output interruption.
- [ ] Test service recreation and WindowManager cleanup.
- [ ] Test screen rotation and display inset transformations.
- [ ] Test accessible descriptions and non-color state differences.
- [ ] Test reduced motion.
- [ ] Test secure lock, doze, overlay policy, and recovery messaging.

### P2.4 Model, cost, and fallback policy

**Work:**

- [ ] Keep model IDs environment-configurable.
- [ ] Define Realtime control → bounded Responses control → safe local error
      fallback order while retaining Sarvam speech.
- [ ] Benchmark GPT-4.1-mini screenshot input versus Realtime image input.
- [ ] Consider a newer original-detail vision model only if representative
      evaluation shows a material grounding improvement.
- [ ] Track image tokens and screenshot frequency.
- [ ] Use screenshots only at decision, ambiguity, failure, and attention
      points—not continuously.
- [ ] Define maximum session duration and reconnect behavior.
- [ ] Preserve a provider kill switch and independent vision/attention flags.

## 10. Recommended delivery sequence

### Delivery A — Freeze and baseline

- Record current test counts and live canary state.
- Add the new contracts without enabling behavior.
- Preserve the bounded voice route and Sarvam fallback.

### Delivery B — P0 authoritative task and operation lifecycle

- Extract workflow state.
- Add task, item, operation, clarification, and selection IDs.
- Add lifecycle registry and structured progress sequence.
- Do not add Realtime mutations yet.

### Delivery C — P0 atomic interaction and cancellation

- Add first-answer-wins product selection.
- Add accepted/rejected card states.
- Add mutation-aware cancellation.
- Add race-condition tests.

### Delivery D — P0 checkout consolidation

- Move checkout preparation into the unified service.
- Recompare terms before final dispatch.
- Preserve expiry, idempotency, ambiguity, and no-retry behavior.

### Delivery E — P1 progress and route decomposition

- Wire `task` presentation end to end.
- Extract speech, workflow, operation, vision, and Realtime adapters.
- Add stage deadlines and latency metrics.

### Delivery F — P1 screenshot understanding

- Add capture, redaction, memory-only observation registry, ephemeral element
  references, and grounding.
- Keep exact spatial attention disabled until alignment tests pass.

### Delivery G — P1 precise attention

- Add private spatial-attention commands.
- Validate geometry, freshness, orientation, and touch-through on the Pixel.

### Delivery H — P1 Realtime control shadow evaluation

- Compare `gpt-realtime-2.1` with the current Responses control path using
  identical Sarvam transcripts and permitted observations.
- Keep mutations disabled.
- Publish language, screen-understanding, tool-intent, and latency results.

### Delivery I — P1 persistent Realtime control and safe tool rollout

- Add the server-side Realtime control transport.
- Enable text/image control and keep Sarvam STT/TTS.
- Route narrow tools through the existing execution service.
- Keep final confirmation unavailable initially.

### Delivery J — P2 recovery and polish

- Add restart recovery, audio-reactive output, native tests, accessibility,
  fallback policy, and cost controls.

Each delivery must be independently revertible. Do not combine operation
cancellation, screenshot grounding, and final-order changes in one slice.

### 10.1 Step-by-step implementation backlog

This is the executable backlog. Work from top to bottom unless a task explicitly
states that it can run in parallel. A checked box means the implementation,
automated tests, logging, and acceptance evidence for that task are complete.
Creating types or empty files alone does not complete a task.

For every task:

1. Start with the smallest failing test that represents the required behavior.
2. Implement behind the named feature flag when the task changes runtime
   behavior.
3. Run the focused tests, then the complete voice-app test suite.
4. Run `git diff --check` on the files in scope.
5. Record the test command and result in the task handoff or test report.
6. Do not claim a phone behavior passed until it is captured on the physical
   Pixel.
7. Do not use cart or checkout mutations for routine unit and integration
   verification.

#### Phase 0 — Baseline and contracts

- [x] **T000 — Freeze the current baseline**
  - **Depends on:** nothing.
  - **Change:** Record the current voice test count, Android build result, APK
    hash, connected-device state, server configuration, and known blocked live
    cases. Update
    `local/apps/android-overlay/test-artifacts/TEST-REPORT.md` without replacing
    previous evidence.
  - **Verify:** Current tests and Android build run without changing behavior.
  - **Done when:** A later delivery can be compared to a dated, reproducible
    baseline.

- [x] **T001 — Add the feature-flag registry**
  - **Depends on:** T000.
  - **Change:** Add typed parsing for every flag in Section 11, default all new
    behavior to `false`, document the variables in
    `local/apps/voice/.env.example`, and expose flags through dependency
    injection instead of reading `process.env` throughout the code.
  - **Tests:** Missing, `true`, `false`, and invalid values; confirm invalid
    values fail safely or use the documented default.
  - **Done when:** Each new subsystem can be enabled independently and disabling
    it restores the existing bounded flow.

- [x] **T002 — Add shared identifiers and contract schemas**
  - **Depends on:** T001.
  - **Change:** Implement the Section 6 contracts for `taskId`, `taskItemId`,
    `operationId`, `clarificationId`, `selectionId`, `observationId`, and
    Realtime session correlation. Add runtime validation, not TypeScript types
    alone.
  - **Candidate files:** `local/apps/voice/lib/workflow/state.ts`,
    `local/apps/voice/lib/operations/registry.ts`, and a shared contract module.
  - **Tests:** Valid examples, missing IDs, malformed IDs, unknown versions, and
    forward-compatible optional fields.
  - **Done when:** API routes, workflow, execution, presentation, and logging
    can use the same validated identifiers.

#### Phase 1 — P0 authoritative task state

- [x] **T010 — Model the authoritative task and item state**
  - **Depends on:** T002.
  - **Change:** Create `LocalPhoneTaskV1` and per-item states. Represent the full
    shopping list, active item, selected offer, pending clarification, pending
    checkout, terminal state, and timestamps outside model prose.
  - **Tests:** One-item and multi-item construction; illegal simultaneous
    clarification and checkout; invalid active index; terminal-state cleanup.
  - **Done when:** A three-item request can be serialized and restored without
    conversation history.

- [x] **T011 — Implement pure workflow transitions**
  - **Depends on:** T010.
  - **Completed (2026-07-27):** The exhaustive pure transition layer now owns
    clarification, selection, execution, verification, recoverable failure,
    skip, cancellation, start-over, unrelated replacement, checkout proposal,
    checkout invalidation, checkout completion, ambiguity, and context updates.
    Allowed and rejected transitions are table-tested, including checkout-only
    tasks and terminal guards.
  - **Change:** Move phase changes out of
    `local/apps/voice/app/api/voice/turn/route.ts` into exhaustive pure
    transition functions. Include `start_over`, unrelated-new-request,
    clarification, selection, verification, failure, cancellation, checkout,
    and terminal transitions.
  - **Tests:** A table test for every allowed transition and every rejected
    transition.
  - **Done when:** The route cannot mutate task state directly.

- [x] **T012 — Add the task repository and bounded retention**
  - **Depends on:** T010.
  - **Change:** Define a repository interface, keep the initial implementation
    local, add TTL and inactive-client cleanup, and use compare-and-set or
    equivalent revision checks for writes.
  - **Tests:** Create/read/update, stale revision, expiry, cleanup, and isolation
    between two overlay clients.
  - **Done when:** Task state is authoritative, bounded, and safe from
    last-writer-wins races.

- [x] **T013 — Move multi-item queue control into the state machine**
  - **Depends on:** T011 and T012.
  - **Completed (2026-07-27):** The authoritative task records the complete
    list, blocks on clarification/failure, and advances only on `added` or
    `already_in_cart`. A paused retry resumes the state-owned item even if the
    model emits a different product call; an unrelated explicit product request
    replaces the old task through `start_over`.
  - **Change:** Make the active task item—not model initiative—the only source
    of the next search. A clarification pauses the queue. Only verified success
    advances the active index. Recoverable failure keeps the same item active.
  - **Candidate files:** Replace or adapt logic in
    `local/apps/voice/lib/product-workflow.ts` and the voice route.
  - **Tests:** Three items with clarification on item one, unavailable item,
    failed add, reconciled add, and resumed follow-up.
  - **Done when:** The original list survives every turn and no item is skipped,
    duplicated, or searched while another item awaits a decision.

- [x] **T014 — Integrate authoritative state into the bounded voice route**
  - **Depends on:** T011–T013.
  - **Completed (2026-07-27):** The opt-in route now loads only structured task
    state while the flag is enabled, persists revision-safe checkpoints,
    routes start-over/replacement/cancellation/checkout through legal
    transitions, supports checkout-only tasks, and cleans cancelled or
    checkout-terminal tasks. Missing, empty, or rejected provider response IDs
    cannot erase the shopping queue.
  - **Change:** Make the route load state, interpret the turn, request a legal
    transition, execute at most the permitted action, persist the result, and
    build deterministic presentation from the saved state.
  - **Tests:** Existing route tests plus follow-up turns with missing or
    truncated provider conversation IDs.
  - **Done when:** Losing `previous_response_id` cannot lose the shopping task.

#### Phase 2 — P0 operation lifecycle and cancellation

- [x] **T020 — Implement the local operation registry**
  - **Depends on:** T002 and T012.
  - **Change:** Add queued, running, waiting, mutation-attempted, reconciling,
    succeeded, failed, cancelled, and ambiguous states; monotonic sequence
    numbers; idempotent terminal writes; and bounded terminal history.
  - **Tests:** Legal lifecycle, illegal reversal, duplicate terminal event,
    sequence ordering, and retention expiry.
  - **Done when:** Every phone action has one queryable lifecycle.

- [x] **T021 — Bind operation ownership to the serialized queue**
  - **Depends on:** T020.
  - **Change:** Generate the operation before enqueueing, bind it to task and
    item, publish queue wait and ownership, and prevent obsolete operations from
    updating a newer task or presentation.
  - **Candidate files:** `local/apps/voice/lib/operation-queue.ts` and
    `local/apps/voice/lib/blinkit-execution.ts`.
  - **Tests:** Two queued operations, obsolete late completion, timeout before
    ownership, and one operation per mutation.
  - **Done when:** Request, task, operation, tool, Appium, and presentation logs
    correlate without ambiguity.

- [x] **T022 — Define mutation-aware cancellation policy**
  - **Depends on:** T020 and T021.
  - **Change:** Implement `cancel_now`, `stop_after_current_step`,
    `reconcile_only`, and `not_cancellable`. Mark phone ownership, mutation, and
    final-dispatch boundaries explicitly.
  - **Tests:** Cancellation before queue ownership, during read-only search,
    immediately before mutation, after mutation attempt, and after order
    dispatch attempt.
  - **Done when:** Policy is derived from operation state and cannot be invented
    by presentation or the model.

- [x] **T023 — Add the cancel command and checkpoint handling**
  - **Depends on:** T022.
  - **Change:** Validate `cancel_current_task`, stop model audio immediately,
    cancel execution only at permitted checkpoints, reconcile after an unknown
    mutation outcome, and make repeat cancellation idempotent.
  - **Tests:** Voice barge-in, card cancel, repeat cancel, mutation race, and
    ambiguous provider result.
  - **Done when:** The assistant never reports cancellation while cart or order
    state is unknown.

#### Phase 3 — P0 atomic interactive product cards

- [x] **T030 — Version product clarification and selection contracts**
  - **Depends on:** T002 and T011.
  - **Change:** Add `clarificationId`, expiry, exact offer data, one-use
    `selectionId`, source (`voice` or `tap`), and accepted/rejected/duplicate
    acknowledgements.
  - **Tests:** Current, expired, stale, unknown, already resolved, and malformed
    selections.
  - **Done when:** A choice is bound to one exact question and one exact offer.

- [x] **T031 — Implement first-valid-answer-wins resolution**
  - **Depends on:** T030 and T012.
  - **Change:** Resolve clarification through one atomic repository operation.
    Return the original resolution for duplicates and reject every conflicting
    later answer.
  - **Tests:** Tap then voice, voice then tap, simultaneous taps, retry with the
    same selection ID, and retry with a different offer.
  - **Done when:** Every race produces at most one selected offer and one phone
    mutation.

- [x] **T032 — Add the card-selection server endpoint**
  - **Depends on:** T031.
  - **Change:** Extend the existing device coordinator route or add a narrow
    selection action. Validate client, task, clarification, selection, offer,
    expiry, and state revision before accepting it.
  - **Tests:** API contract, duplicate delivery, stale task, expired card,
    unknown offer, and disabled feature flag.
  - **Done when:** The Android overlay can submit a choice without synthesizing
    a fake voice turn.

- [x] **T033 — Implement native interactive card states**
  - **Depends on:** T032.
  - **Change:** Update `OverlayPresentation.java`,
    `OverlayPresentationParser.java`, `OverlayCardView.java`, and
    `OverlayService.java` for selectable rows and `idle`, `submitting`,
    `accepted`, `rejected`, `duplicate`, `expired`, and `working` states. Keep
    speaking as an equal input method.
  - **Tests:** Parser fixtures, tap behavior, disabled siblings, retryable
    rejection, accessibility descriptions, and overlay touch-through outside
    the card.
  - **Done when:** A tap is sent as a structured selection, visibly acknowledged
    by the server, and never treated as local-only UI state.

- [x] **T034 — Prove tap-plus-voice race safety**
  - **Depends on:** T031–T033.
  - **Change:** Add integration tests and a physical-Pixel canary using a
    non-destructive selection flow first. Perform one controlled cart mutation
    only after the duplicate-safety test passes.
  - **Done when:** Logs and cart evidence show exactly one accepted selection
    and at most one quantity change.

#### Phase 4 — P0 exact cart verification and queue advancement

- [x] **T040 — Strengthen exact product identity**
  - **Depends on:** T013.
  - **Change:** Normalize and compare offer ID, title, pack size, price, and
    provider-visible variant. Collapse only truly identical offers and preserve
    title-only variant-sheet handling.
  - **Candidate files:** `local/apps/voice/lib/product-choice.ts`,
    `product-label.ts`, and `blinkit-execution.ts`.
  - **Tests:** Same title/different size, same size/different price, duplicate
    provider rows, unavailable offer, and title-only variants.
  - **Done when:** A selected 500 ml item cannot resolve to a 1 L or different
    priced offer.

- [x] **T041 — Separate mutation result from verification result**
  - **Depends on:** T020 and T040.
  - **Change:** Record `mutation_attempted`, direct-control evidence,
    reconciliation evidence, unchanged cart, and ambiguous outcome separately.
    Never repeat mutation merely because direct UI confirmation was late.
  - **Tests:** Control updates immediately, control update times out but cart
    changed, cart unchanged, inspection failure, and unrelated cart change.
  - **Done when:** A real add is no longer reported as failure when read-only
    cart reconciliation proves it succeeded.

- [x] **T042 — Gate task advancement on verified evidence**
  - **Depends on:** T013 and T041.
  - **Change:** Advance exactly one queue item only on verified success. Keep the
    same item active for failure or ambiguity and present the actual recovery
    action.
  - **Tests:** Reproduce the milk and ice-cream log failures described in the
    investigation and assert no repeated search, false failure, skipped item,
    or duplicate add.
  - **Done when:** The user never has to say “you already added it” to unblock
    the next task item.
  - **Regression closure (2026-07-28):** With authoritative task state and
    atomic selection enabled on the physical Pixel, a spoken first-option
    answer was resolved locally, the control model received zero tools, and the
    stored exact offer (ID, title, 500 ml size, and ₹29 price) went directly to
    mutation without another provider search. Post-add cart verification now
    dismisses a focused Blinkit search keyboard before locating `View cart`.
    The task reached `completed`, terminal cleanup ran, and the stable cart
    item fingerprint remained
    `38b16003e49c67be5decff52e0c828034329bfc267dc47c100552500b112346a`.

- [x] **T043 — Add cart preservation assertions**
  - **Depends on:** T041.
  - **Change:** Fingerprint cart lines before and after a controlled mutation
    and assert every unrelated line and quantity is preserved.
  - **Tests:** Existing cart line, duplicate selected item, changed quantity,
    provider reordering, fee-only change, and inspection timeout.
  - **Done when:** Verification detects unintended cart changes without
    confusing harmless provider ordering changes.

#### Phase 5 — P0 unified checkout

- [x] **T050 — Add validated checkout preparation**
  - **Depends on:** T020 and T043.
  - **Change:** Add `prepare_checkout` to the unified command schema and
    `BlinkitExecutionService`. Capture all items, quantities, unit prices, fees,
    total, address label, payment mode, ETA, provider fingerprint, and expiry.
  - **Tests:** Complete proposal, missing terms, changed cart, unsupported
    payment mode, expired proposal, and zero-item cart.
  - **Done when:** Preparation is read-only with respect to final ordering and
    always renders `NOT ORDERED`.

- [x] **T051 — Revalidate terms before explicit dispatch**
  - **Depends on:** T050.
  - **Change:** Bind confirmation to the exact proposal, re-read material terms,
    return typed differences, reject expired or changed proposals, and require a
    new explicit confirmation.
  - **Tests:** Price, fee, address, payment, item, quantity, ETA, expiry, and
    unchanged terms.
  - **Done when:** A confirmation can authorize only the proposal the user
    actually reviewed.

- [x] **T052 — Make final dispatch single-attempt and ambiguity-safe**
  - **Depends on:** T051 and T022.
  - **Change:** Mark the irreversible boundary, prevent automatic retries,
    reconcile read-only when the result is unknown, and preserve ambiguous
    status until provider evidence exists.
  - **Tests:** Success, explicit rejection, transport timeout before dispatch,
    timeout after possible dispatch, duplicate confirmation, and server restart.
  - **Done when:** No code path can dispatch twice or transform uncertainty into
    success.

- [x] **T053 — Remove obsolete checkout paths after parity**
  - **Depends on:** T050–T052.
  - **Change:** Route all callers through the unified service, run parity tests,
    then delete or disable legacy grocery/checkout execution paths.
  - **Done when:** There is exactly one production checkout implementation and
    all safety tests pass through it.

#### Phase 6 — P1 route decomposition and truthful progress

- [x] **T060 — Extract provider and presentation adapters**
  - **Depends on:** P0 tasks T010–T053.
  - **Change:** Extract Sarvam STT/TTS, OpenAI Responses, deterministic voice
    response, and overlay-presentation building behind narrow interfaces. Keep
    existing behavior unchanged.
  - **Tests:** Contract tests using fake providers and regression tests for
    current route output.
  - **Done when:** Provider changes cannot directly change workflow or phone
    execution state.

- [x] **T061 — Convert the voice route to a thin coordinator**
  - **Depends on:** T060.
  - **Change:** The route should validate input, call speech, load authoritative
    state, request transitions/tools, persist results, and return deterministic
    presentation. Remove embedded product-queue and lifecycle logic.
  - **Tests:** Route-level success, clarification, provider error, device error,
    timeout, cancellation, and resume.
  - **Done when:** Workflow, execution, speech, and presentation can be tested
    without invoking the HTTP route.

- [x] **T062 — Emit structured semantic progress**
  - **Depends on:** T020 and T061.
  - **Change:** Emit monotonic progress from observed workflow and driver
    checkpoints, including task-item position and current cancellation policy.
    Do not generate progress from generic timers.
  - **Tests:** Ordered progress, dropped duplicate, late update after terminal,
    unknown total, and provider wait.
  - **Done when:** Every displayed step corresponds to a logged execution
    checkpoint.

- [x] **T063 — Render structured progress on Android**
  - **Depends on:** T062.
  - **Change:** Parse and render `presentation.task` in
    `OverlayPresentationParser`, `OverlayPresentation`, and `OverlayCardView`.
    Keep terminal result visible and support `1 of 3` without inventing a
    percentage.
  - **Tests:** Fixtures for queued, searching, waiting for choice, adding,
    verifying, reconciling, completed, failed, cancelled, and ambiguous.
  - **Done when:** Long work visibly progresses without repeated filler speech.

- [x] **T064 — Add independent stage deadlines**
  - **Depends on:** T061 and T062.
  - **Change:** Separate request, STT, model, queue, Appium acquisition, search,
    mutation, verification, reconciliation, TTS, and total deadlines. Map each
    timeout to a typed result and recovery action.
  - **Tests:** Force each stage to exceed its deadline independently.
  - **Done when:** “Timeout” identifies the exact failed stage and never hides a
    possibly successful mutation.

#### Phase 7 — P1 private screenshots and vision grounding

- [ ] **T070 — Add read-only screenshot capture to the UI port**
  - **Depends on:** T061.
  - **Change:** Capture within serialized device ownership, suppress the
    attention overlay during capture, prefer the provider content area, and
    return an in-memory image plus screen metadata.
  - **Tests:** Capture success, Appium failure, overlay suppression/restoration,
    orientation, and screen-change race.
  - **Done when:** Optional capture cannot mutate the phone or change a
    successful tool result.

- [ ] **T071 — Implement restricted-screen detection and redaction**
  - **Depends on:** T070.
  - **Change:** Block or redact login, OTP, payment credentials, raw address,
    phone number, notification, and account details before any model request.
  - **Tests:** Synthetic fixtures for every restricted class plus false-positive
    controls.
  - **Done when:** Restricted screens produce a safe semantic fallback and no
    sensitive image or text enters logs or the model request.

- [ ] **T072 — Add the ephemeral observation registry**
  - **Depends on:** T070 and T071.
  - **Change:** Store observation metadata and element-reference-to-bounds
    mappings in memory with short expiry. Invalidate on navigation, new
    operation, orientation, package, or fingerprint change.
  - **Tests:** Expiry, wrong package, wrong fingerprint, rotation, replacement,
    cleanup, and two-client isolation.
  - **Done when:** Raw image bytes and geometry never enter durable task or
    conversation state.

- [ ] **T073 — Build sanitized semantic candidates**
  - **Depends on:** T072.
  - **Change:** Convert the fresh Appium accessibility tree into bounded,
    sanitized candidate labels and opaque element references. Keep selectors,
    node IDs, and coordinates local.
  - **Tests:** Duplicate labels, no bounds, nested controls, stale nodes,
    sensitive text, and selected product variants.
  - **Done when:** The model receives enough context to distinguish choices
    without receiving executable device internals.

- [ ] **T074 — Implement structured screenshot grounding**
  - **Depends on:** T073.
  - **Change:** Compare GPT-4.1-mini Responses image input and Realtime image
    input behind one grounding interface. Require `VisionGroundingResultV1`,
    reject unknown or ambiguous references, and fall back to semantic driver
    context.
  - **Tests:** Correct target, ambiguous target, nonexistent reference, stale
    observation, malformed model output, model timeout, and semantic fallback.
  - **Done when:** Vision can select an ephemeral semantic reference but can
    never produce executable coordinates or selectors.

- [ ] **T075 — Define screenshot trigger policy and budgets**
  - **Depends on:** T074.
  - **Change:** Capture only at clarification, ambiguity, verification failure,
    or explicit attention moments. Add maximum image size, frequency, per-task
    count, and timeout.
  - **Tests:** Repeated search does not continuously capture; restricted and
    over-budget cases fall back safely.
  - **Done when:** Screenshot use is deliberate, measurable, and independently
    disableable.

#### Phase 8 — P1 precise screen attention

- [ ] **T080 — Add the private spatial-attention command**
  - **Depends on:** T072 and T074.
  - **Change:** Define a local-only command containing operation, observation,
    screen fingerprint, expiry, display metadata, and normalized rectangle.
    Keep it out of model tools, public APIs, analytics, and durable state.
  - **Tests:** Schema version, missing binding, expiry, and forbidden
    serialization targets.
  - **Done when:** Only the trusted local coordinator can create exact geometry.

- [ ] **T081 — Implement and test coordinate transformation**
  - **Depends on:** T080.
  - **Change:** Convert observation bounds across crop offsets, density,
    rotation, status bar, navigation inset, and overlay space. Add fixture-based
    golden tests for the target Pixel.
  - **Tests:** Portrait, rotation, status/navigation insets, cropped screenshot,
    density changes, and out-of-bounds clamp.
  - **Done when:** Expected geometry is pixel-verifiable before native rollout.

- [ ] **T082 — Render exact attention in the native overlay**
  - **Depends on:** T081.
  - **Change:** Update `SpatialAttentionView.java` and `OverlayService.java` to
    render ring, arrow, underline, or pulse; stay non-touchable; and clear on
    expiry, navigation, operation completion, or orientation.
  - **Tests:** Hidden at rest, touch-through, stale command, replacement,
    orientation, reduced motion, and service recreation.
  - **Done when:** The physical Pixel shows precise alignment without blocking
    Blinkit interaction.

- [ ] **T083 — Add broad-region fallback**
  - **Depends on:** T082.
  - **Change:** If exact grounding is unavailable or stale, render the existing
    semantic region or no attention instead of guessing geometry.
  - **Done when:** Failure degrades safely and never points to an unverified
    target.

#### Phase 9 — P1 GPT Realtime evaluation and rollout

- [x] **T090 — Build the Realtime session abstraction**
  - **Depends on:** T060 and T001.
  - **Change:** Move prototype Realtime code behind environment-configured
    text/image session, event, conversation, and tool-adapter interfaces.
    Sarvam remains the speech provider. Keep all production mutations
    disabled.
  - **Tests:** Session create/close, auth failure, reconnect, event ordering,
    malformed event, and flag-off fallback.
  - **Done when:** Realtime can run without owning workflow or phone state.

- [x] **T091 — Create the multilingual control shadow corpus and scorer**
  - **Depends on:** T090.
  - **Change:** Use fixed Sarvam transcripts for English, Hindi, Hinglish,
    Gujarati, Marathi, another Indic language, brands, quantities, pack sizes,
    ordinals, negation, cancellation, and follow-ups. Pair relevant cases with
    sanitized screenshots and semantic candidates. Score entities, intended
    tool, clarification, grounding, and latency.
  - **Done when:** Current Responses control and GPT Realtime control can be
    compared on identical text/image inputs with a reproducible report.

- [x] **T092 — Run GPT Realtime in shadow mode**
  - **Depends on:** T091.
  - **Change:** Feed the same Sarvam transcript, task state, and permitted
    observation to both control pipelines, suppress Realtime tools, redact raw
    content from metrics, and record tool-intent/grounding disagreement and
    latency.
  - **Done when:** The control-model decision is supported by per-language and
    per-screen quality and latency evidence rather than anecdotal tests.
  - **Evidence (2026-07-28):** A live, tool-suppressed 12-case corpus spanning
    six Indian-language/code-mix groups completed with zero provider failures
    and zero tool executions. Realtime quality was `0.875` versus Responses
    `0.7778`; per-language and product-choice/no-observation screen metrics are
    recorded in
    `local/apps/voice/test-artifacts/realtime-shadow-2026-07-28.md`.

- [x] **T093 — Document the server-side Realtime control transport**
  - **Depends on:** T092.
  - **Change:** Adopt a server-side Realtime WebSocket for persistent text,
    image, and tool events. Document connection time, hotspot reliability,
    secret handling, task/session correlation, response cancellation, and
    bounded Responses fallback.
  - **Done when:** The ADR and a verified text-only prototype prove no OpenAI
    credential or Realtime audio dependency is required in the APK.

- [x] **T094 — Implement `RealtimeControlTransport`**
  - **Depends on:** T093.
  - **Change:** Add persistent server connection, text/image conversation
    items, text deltas, function-call events, reconnect, cleanup, and bounded
    Responses fallback. Send completed response text to Sarvam TTS.
  - **Tests:** Follow-up text, image/no-image turns, malformed event,
    disconnect, reconnect, hotspot change, stale session, and fallback.
  - **Done when:** A Sarvam transcript can drive a correlated Realtime control
    turn without OpenAI audio input or output.

- [x] **T095 — Separate Sarvam playback, model response, and task cancellation**
  - **Depends on:** T094 and T023.
  - **Change:** New push-to-talk immediately stops Sarvam playback and cancels
    an obsolete Realtime response while leaving the phone operation governed
    by its independent cancellation policy.
  - **Tests:** Interrupt while speaking, searching, adding, verifying, and
    waiting for clarification.
  - **Done when:** Sarvam audio and obsolete model output stop promptly while
    phone state is never silently cancelled.

- [x] **T096 — Route Realtime tools through the shared safe adapter**
  - **Depends on:** T090, T094, and all P0 tasks.
  - **Change:** Expose only narrow validated functions, bind task and operation
    IDs, enqueue through the same operation service, and return structured
    results. Keep final-order dispatch unavailable.
  - **Tests:** Schema rejection, duplicate call, reconnect replay, tool timeout,
    obsolete task, clarification, cart mutation, and checkout boundary.
  - **Done when:** Realtime and bounded HTTP have identical mutation semantics.

- [ ] **T097 — Roll out Realtime in guarded stages**
  - **Depends on:** T092 and T096.
  - **Change:** Enable in this order: internal control shadow, text-only
    developer control, screenshot grounding, read-only tools, reversible cart
    tools, broader task cohort. Keep Sarvam STT/TTS and preserve independent
    kill switches and bounded Responses fallback at every stage.
  - **Done when:** Each stage meets the documented accuracy, latency, error, and
    safety thresholds before the next stage begins.

#### Phase 10 — P1 bounded history, telemetry, and evaluation

- [x] **T100 — Bound prose conversation history**
  - **Depends on:** T014 and T090.
  - **Change:** Set maximum turns and response-chain length, truncate prose
    deterministically, keep structured task state separately, add `start_over`,
    and clean inactive sessions.
  - **Tests:** Truncation during multi-item task, pending clarification,
    selected offer, pending checkout, and new Realtime session.
  - **Done when:** History cleanup cannot forget the shopping list or
    transactional state.

- [x] **T101 — Complete end-to-end structured correlation**
  - **Depends on:** T020, T030, T072, and T090.
  - **Change:** Carry request, client, task, item, operation, clarification,
    selection, observation, and Realtime session IDs across logs and results.
  - **Tests:** Assert required context at every async boundary and absence of
    secrets, raw audio, image bytes, addresses, payment data, and unredacted
    transcripts.
  - **Done when:** One user turn can be traced end to end without exposing
    private payloads.

- [x] **T102 — Instrument stage latency and fallback reasons**
  - **Depends on:** T064 and T101.
  - **Change:** Measure every timestamp in P1.10, report queue/device/model
    latency separately, and label the exact fallback path.
  - **Done when:** A timeout or slowdown can be assigned to one stage and
    Realtime benefit is measured by transcript and first-audio latency.

- [x] **T103 — Add a local quality and latency report generator**
  - **Depends on:** T091 and T102.
  - **Change:** Produce a redacted report grouped by language, intent, model,
    fallback, device stage, grounding result, and success classification.
  - **Done when:** Regressions can be compared across dated runs without reading
    raw terminal logs.

#### Phase 11 — P2 restart recovery and native polish

- [ ] **T110 — Persist the minimum recoverable state**
  - **Depends on:** T012 and T020.
  - **Change:** Persist authoritative task, safe presentation, operation
    metadata, mutation boundary, and bounded terminal records. Exclude raw
    screenshots, audio, selectors, geometry, and secrets.
  - **Tests:** Schema migration, corrupt record, expiry, partial write, and
    privacy audit.
  - **Done when:** Restart recovery has enough evidence to resume or reconcile
    without replaying an action.

- [ ] **T111 — Recover coordinator state after server restart**
  - **Depends on:** T110.
  - **Change:** Restore pending clarification and terminal results; reconcile
    operations that may have crossed a mutation boundary; expire observations
    and Realtime sessions.
  - **Tests:** Restart before mutation, during possible mutation, pending card,
    checkout review, and possible final dispatch.
  - **Done when:** Restart never assumes success/failure and never repeats final
    dispatch.

- [x] **T112 — Recover native overlay state after service recreation**
  - **Depends on:** T111.
  - **Change:** On service start, query current coordinator state, restore the
    latest safe card/progress, restore pending choices, and clear stale
    attention.
  - **Tests:** Process death, service restart, device lock/unlock, doze,
    rotation, and server unavailable.
  - **Done when:** The user sees a truthful recoverable state rather than an
    empty or obsolete overlay.

- [x] **T113 — Drive listening and speaking motion from real audio**
  - **Depends on:** T094.
  - **Change:** Use microphone amplitude while listening and playback energy
    while speaking; support reduced motion; preserve drag and tap gestures.
  - **Tests:** Silence, loud/quiet audio, TTS interruption, reduced motion, and
    no-audio fallback.
  - **Done when:** Animation reflects actual audio activity instead of a timer.

- [x] **T114 — Complete native accessibility and lifecycle tests**
  - **Depends on:** T033, T063, T082, T095, T112, and T113.
  - **Change:** Add coverage for parsing, accessible descriptions, non-color
    states, tap/hold/drag races, reduced motion, WindowManager cleanup, secure
    lock, doze, rotation, and overlay policy.
  - **Done when:** Native behavior passes automated coverage where possible and
    a documented physical-Pixel matrix where platform behavior requires it.

- [ ] **T115 — Finalize model, cost, and fallback policy**
  - **Depends on:** T075, T092, T097, and T103.
  - **Change:** Document model choice, screenshot detail and token budget,
    capture frequency, maximum session duration, reconnect rules, provider
    fallback order, and independent kill-switch ownership.
  - **Done when:** Runtime configuration can control cost and disable any remote
    capability without breaking safe bounded voice operation.

#### Phase 12 — Release gates

- [ ] **T120 — Run the complete automated verification matrix**
  - **Depends on:** T000–T115.
  - **Change:** Run all contract, workflow, operation, execution, route,
    presentation, Realtime, vision, privacy, and native tests in Section 12.
  - **Done when:** Results are attached to the test report with no unexplained
    failures or skipped safety tests.

- [ ] **T121 — Run the safe physical-Pixel canary**
  - **Depends on:** T120.
  - **Change:** Verify server identity, APK identity, wireless/USB transport,
    unlocked screen, overlay permission, microphone permission, Appium target,
    and feature flags before testing. Start read-only, then perform one
    controlled cart add and cart-summary verification. Do not enter final order
    dispatch.
  - **Done when:** Screenshots, structured logs, operation lifecycle, and cart
    fingerprints agree on the outcome.
  - **Partial evidence (2026-07-28; task remains open):** USB and wireless
    transports were connected, the Pixel was unlocked, the local server loaded
    `JALDI_AUTHORITATIVE_TASK_STATE_V1=true` and
    `JALDI_ATOMIC_PRODUCT_SELECTION_V1=true`, and one controlled exact milk
    workflow completed successfully. A read-only cart inspection then reported
    one Amul Taaza Toned Milk, quantity 1, subtotal ₹29. The complete T121
    identity/permission/screenshot matrix is still required before checking
    this task.

- [ ] **T122 — Run the complete multi-item acceptance scenario**
  - **Depends on:** T121.
  - **Change:** Request several products, answer one clarification by voice and
    another by card, interrupt speech during long work, exercise one unavailable
    item, and review checkout without ordering.
  - **Done when:** The entire list survives; every verified item advances once;
    progress is truthful; no duplicate mutation occurs; and the checkout card
    remains `NOT ORDERED`.

- [ ] **T123 — Close the final definition-of-done checklist**
  - **Depends on:** T122.
  - **Change:** Check each item in Section 15 only against linked automated or
    physical-device evidence. Document residual limitations and rollback flags.
  - **Done when:** All required evidence exists, the fallback path remains
    tested, and `/hosted/**` is confirmed unchanged.

### 10.2 Immediate starting slice

Start implementation with this exact sequence:

1. T000 — freeze the baseline.
2. T001 — add disabled-by-default feature flags.
3. T002 — add validated IDs and shared contracts.
4. T010 — model authoritative task state.
5. T011 — implement pure transitions.
6. T012 — add the repository with revision safety.
7. T013 — move multi-item advancement into the state machine.
8. T014 — integrate the state machine into the bounded route.

Stop after T014 and run the multi-turn route suite before starting operation
lifecycle work. The first milestone is complete only when the existing
milk/ice-cream failure can be reproduced as a test and the new state machine
prevents repeated search, false advancement, and loss of the remaining list.

## 11. Feature flags

Suggested independent flags:

```text
JALDI_AUTHORITATIVE_TASK_STATE_V1=false
JALDI_OPERATION_LIFECYCLE_V1=false
JALDI_ATOMIC_PRODUCT_SELECTION_V1=false
JALDI_STRUCTURED_PROGRESS_V1=false
JALDI_SCREENSHOT_OBSERVATION_V1=false
JALDI_VISION_GROUNDING_V1=false
JALDI_PRECISE_ATTENTION_V1=false
JALDI_REALTIME_SHADOW_V1=false
JALDI_REALTIME_VOICE_V1=false
JALDI_REALTIME_CONTROL_V1=false
JALDI_REALTIME_PHONE_TOOLS_V1=false
JALDI_TASK_RECOVERY_V1=false
```

Flags must disable independently:

- screenshot capture;
- model vision;
- precise attention;
- Realtime text/image control;
- reserved Realtime voice;
- Realtime phone tools;
- in-flight cancellation.

Turning off a feature must fall back to the existing bounded voice and semantic
driver flow.

## 12. Test plan

### 12.1 Unit tests

- Workflow transition table.
- Task-item progression.
- Operation lifecycle and invalid transitions.
- Cancellation policy and mutation boundaries.
- Clarification expiry and first-answer-wins behavior.
- Tap-plus-voice duplicate suppression.
- Structured progress ordering.
- Screenshot redaction policy.
- Observation invalidation.
- Vision result schema and unknown element rejection.
- Geometry transforms.
- History truncation with task preservation.
- Realtime event parsing and interruption.
- Fallback routing.

### 12.2 Integration tests

- Realtime tool call → validated command → operation queue → fake driver.
- Screenshot → annotated observation → model fixture → element reference.
- Stale observation rejection after navigation.
- Card tap acknowledgement before mutation.
- Delayed quantity control with successful cart reconciliation.
- Failure after first mutation without duplicate retry.
- Server restart with pending clarification.
- Service restart with active progress.
- Checkout term change before confirmation.
- Ambiguous final dispatch reconciliation.

### 12.3 Language evaluation

For each language:

- product search;
- multi-item list;
- quantity;
- size and flavor;
- ordinal choice;
- tap follow-up;
- retry;
- skip;
- cancel;
- start over;
- price question;
- checkout confirmation refusal;
- noisy and interrupted audio.

Score:

- transcript semantic accuracy;
- exact entity preservation;
- intended tool;
- tool arguments;
- clarification correctness;
- first-audio latency;
- fallback rate.

### 12.4 Native tests

- Companion/capsule/card transitions.
- Listening, progress, speaking, waiting, success, error, and ambiguity.
- Tap, drag, hold, quick release, and simultaneous input.
- Accepted/rejected/duplicate/expired rows.
- Non-touchable precise attention.
- Orientation and display insets.
- Reduced motion and accessibility.
- TTS and Realtime barge-in.
- Service destruction and recreation.

### 12.5 Live Pixel canary

Use only reversible operations unless final-order testing is separately
authorized.

1. Confirm USB or wireless identity and installed APK hash.
2. Confirm local backend, Appium, reverse/route, and foreground service.
3. Run harmless Realtime text and image diagnostics without phone tools.
4. Run read-only product search with screenshot observation.
5. Verify precise attention points at a freshly observed product.
6. Let the observation expire and verify that attention falls back safely.
7. Request two products and verify `1 of 2` progression.
8. Resolve the first choice by tap and the second by voice.
9. Run a controlled tap-plus-voice race and prove one accepted selection.
10. Add an authorized item and verify cart reconciliation.
11. Interrupt during a safely cancellable search.
12. Attempt interruption after a mutation boundary and verify read-only
    reconciliation rather than false cancellation.
13. Inspect the cart read-only.
14. Prepare checkout and verify complete `NOT ORDERED` terms.
15. Change a safe term fixture and verify stale review.
16. Stop before final dispatch.

## 13. Logging requirements

Required correlation fields:

```text
requestId
clientId
taskId
itemId
operationId
clarificationId
selectionId
observationId
realtimeSessionId
```

Required event families:

```text
request.*
realtime.session.*
realtime.audio.*
realtime.transcript.*
realtime.response.*
model.*
workflow.*
operation.*
progress.*
product_choice.*
vision.capture.*
vision.redaction.*
vision.grounding.*
phone.*
blinkit.*
presentation.*
tts.*
```

Never log:

- API keys or inherited environment values;
- raw audio or audio base64;
- screenshot bytes or image base64;
- raw transcripts by default in production mode;
- UI XML;
- raw selectors;
- raw element bounds;
- OTPs;
- full addresses;
- payment identifiers.

## 14. Documentation and source references

OpenAI documentation used for the Realtime and vision design:

- [Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/)
- [Introducing gpt-realtime](https://openai.com/index/introducing-gpt-realtime/)
- [Realtime and audio](https://developers.openai.com/api/docs/guides/realtime)
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
- [Voice-agent architecture](https://developers.openai.com/api/docs/guides/voice-agents#choose-the-right-architecture)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)

Repository reference:

- [farzaa/clicky](https://github.com/farzaa/clicky)

## 15. Final definition of done

- [ ] The entire requested multi-item task survives every clarification.
- [ ] Voice and card selection are both exact and duplicate-safe.
- [ ] Every local phone operation has an observable lifecycle.
- [ ] Cancellation follows an explicit mutation-aware policy.
- [ ] Realtime provides demonstrably lower conversational latency on the target
      language corpus.
- [ ] Realtime function calls pass through the same validated serialized
      execution path.
- [ ] Screenshots improve understanding without becoming coordinate authority.
- [ ] Precise attention is bound to a fresh observation and verified element.
- [ ] Screenshot, audio, and device internals remain private and absent from
      logs.
- [ ] Progress reflects actual execution and survives long provider waits.
- [ ] A service or server restart restores or reconciles authoritative state.
- [ ] Cart changes are verified without duplicate mutation.
- [ ] Checkout terms are complete, expiring, and rechecked.
- [ ] No final order is placed without the existing explicit confirmation
      boundary.
- [ ] Ambiguous final outcomes remain ambiguous and are never retried
      automatically.
- [ ] The bounded Sarvam/Responses path remains a tested fallback.
- [ ] Contract, workflow, execution, voice, Realtime, vision, native, and live
      Pixel verification pass.
- [ ] `/hosted/**` remains unchanged.
