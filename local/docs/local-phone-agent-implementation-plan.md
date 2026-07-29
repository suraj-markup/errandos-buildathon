# Local HeyClicky-Style Phone Agent Implementation Plan

> **Extension plan:** Realtime voice, screenshot grounding, precise attention,
> operation-aware cancellation, restart recovery, and the reconciled P0–P2
> delivery sequence are tracked in
> [`plans/2026-07-27-realtime-vision-phone-agent-master-plan.md`](plans/2026-07-27-realtime-vision-phone-agent-master-plan.md).
>
> The next architecture-hardening sequence—durable goal continuation,
> model-proposed task graphs, dynamic safety capabilities, interactive
> item-to-item progress, checkout continuation, general-mobile adapters, and
> legacy-code removal—is tracked in
> [`plans/2026-07-28-adaptive-phone-agent-hardening-plan.md`](plans/2026-07-28-adaptive-phone-agent-hardening-plan.md).

## Goal

Improve the local JaldiAI phone agent's execution reliability, product
interaction, voice responses, and overlay experience.

The implementation should follow the separation described in
[`../HEYCLICKY.md`](../HEYCLICKY.md):

- the speech layer handles voice input, voice output, and language;
- the agent layer understands intent and manages the workflow;
- the execution layer controls Blinkit through narrow semantic operations;
- the presentation layer turns structured results into concise voice and
  visual responses.

## Scope

### Included

- `local/apps/voice`
- `local/apps/android-overlay`
- `local/packages/provider-connectors`
- `local/packages/contracts` where local command contracts are needed
- `local/packages/application` where local execution coordination is needed
- local tests and documentation

### Deferred

- all changes under `/hosted`
- authentication and device enrollment
- approval portals
- remote deployment architecture
- Rapido and additional providers
- live final-order testing during the refactor

## Guiding principles

1. A read-only request must not mutate the cart.
2. Product selection must use an exact opaque provider offer ID.
3. Product verification must include identity, pack size, price, and quantity.
4. The user should hear the shortest product label that remains unambiguous.
5. Complete provider titles must remain available internally for verification.
6. Checkout must retain all material facts even when ordinary cart responses
   are shortened.
7. Only one operation may control the phone at a time.
8. Execution results must be structured and independent of conversational
   prose.
9. Unknown final-order outcomes must remain ambiguous and must never trigger
   an automatic retry.
10. `/hosted` must remain unchanged.

## Implementation progress — 2026-07-27

The first product-workflow slice is implemented:

- [x] Read-only `search_products` is separate from cart mutation.
- [x] `add_cart_item` carries an exact offer ID and validated quantity.
- [x] Tool arguments receive runtime validation before Appium execution.
- [x] Access to the connected phone is serialized through a local operation
      queue.
- [x] Exact provider titles and concise spoken labels are separate fields.
- [x] Product choices and cart results use deterministic concise presentation.
- [x] Read-only cart inspection returns concise lines, subtotal, the provider
      fingerprint, and a stable item-only fingerprint.
- [x] Exact-ID cart quantity and removal commands are implemented with
      post-mutation verification and preservation checks for every other line.
- [x] Multi-product requests use an ordered queue and stop on the first item
      that needs user input; later products are not searched prematurely.
- [x] After the active product is completed, execution advances to the next
      queued product and stops again if that product needs clarification.
- [x] The local UI renders the active clarification result and only a compact
      remaining-product count with the next queued product.
- [x] Price is spoken only for an explicit price or cost question.
- [x] Pending product choice and checkout confirmation are mutually exclusive
      conversation phases.
- [x] Ordinal, flavor, and size follow-ups are resolved deterministically from
      the stored visible options.
- [x] “Skip,” “retry,” and “cancel” have deterministic product-workflow
      behavior, including Hindi and common code-mixed phrases.
- [x] Reversible Blinkit operations use one execution service with typed
      stage-specific failure details and one session-recovery policy.
- [x] The visual client renders concise product labels and no longer reports a
      static “Blinkit ready” state.
- [x] Focused tests cover command validation, operation serialization, product
      labels, workflow recovery, execution failures, and voice presentation.

Live verification completed so far:

- [x] A broad “Find Lay’s” voice turn invoked only `search_products`.
- [x] The cart retained the same item, quantity, and subtotal after search.
- [x] The result asked the user to choose from concise options without adding
      anything.
- [ ] Repeat the canary against the new stable item-only fingerprint after the
      test phone is unlocked.

Still pending in Delivery 1:

- moving conversation transitions into a standalone tested state-machine
  module;
- persisting conversation and multi-item state outside the current in-memory
  repository;
- live phone verification of quantity-aware addition.

---

## Milestone 1: Define the local command model

Replace the overloaded `prepare_grocery` action with explicit commands.

### Tasks

- [x] Add `search_products`.
- [x] Add `add_cart_item`.
- [x] Add `inspect_cart`.
- [x] Add `set_cart_item_quantity`.
- [x] Add `remove_cart_item`.
- [ ] Add `prepare_checkout`.
- [x] Keep `confirm_order` separate from normal execution.
- [x] Add runtime validation for the active local voice commands.
- [x] Add quantity support to `add_cart_item`.
- [x] Add sequential multiple-item support.

Suggested command shapes:

```ts
type SearchProductsCommand = {
  type: 'search_products';
  query: string;
};

type AddCartItemCommand = {
  type: 'add_cart_item';
  query: string;
  offerId: string;
  quantity: number;
};
```

### Acceptance criteria

- “Find milk” never modifies the cart.
- “Add two packets of milk” carries quantity `2`.
- Unknown commands fail before reaching Appium.
- Product choice always uses an opaque `offerId`.

---

## Milestone 2: Build one unified execution service

Unify reversible execution first. Checkout remains at a documented migration
seam in `appium.ts` until its state-machine and term-verification slice.

### Tasks

- [x] Create a local `BlinkitExecutionService`.
- [x] Route search, cart inspection, exact-ID addition, quantity changes, and
      removal through the semantic driver.
- [x] Route checkout preparation and final confirmation through the unified
      service.
- [x] Move reversible-operation session recovery into the execution layer.
- [x] Return structured results with typed operation, stage, reason, and
      recoverability instead of conversational message strings.
- [x] Add a per-device operation queue or mutex.
- [x] Prevent concurrent local voice Appium operations.
- [x] Replace broad reversible-operation `automation_failed` responses with
      search, matching, mutation, verification, inspection, device, and
      recovery failure reasons.
- [x] Remove obsolete grocery automation from the legacy file after migration.

Suggested result model:

```ts
type ExecutionResult =
  | { status: 'search_results'; offers: ProductOffer[] }
  | { status: 'cart_updated'; cart: CartSnapshot }
  | { status: 'needs_product_choice'; offers: ProductOffer[] }
  | { status: 'checkout_ready'; checkout: CheckoutSnapshot }
  | { status: 'not_found'; query: string }
  | { status: 'failed'; reason: FailureReason };
```

### Acceptance criteria

- Every reversible operation follows one driver and recovery strategy.
- Only one operation controls Blinkit at a time.
- Failures identify whether search, matching, cart mutation, verification, or
  checkout failed.
- No execution method generates conversational prose.

### Checkout execution consolidation — completed 2026-07-28

- `phone-tool.ts` normalizes checkout preparation and confirmation through the
  unified `BlinkitExecutionService`.
- The compatibility command names remain at the command boundary, but they no
  longer select a second execution implementation.
- The no-caller `prepareGrocery()`, `prepareCodCheckout()`, and
  `placeCodOrder()` implementations and their private helper subtree were
  removed from `appium.ts`.
- The six no-caller driver wrapper exports, including
  `prepareGroceryWithDriver()`, were removed.
- Focused execution tests, the complete voice suite, TypeScript validation,
  and the Next production build passed after removal.

---

## Milestone 3: Make product selection exact

### Tasks

- [x] Match existing cart lines using exact cart product identity and exact
      selected title plus price where the provider exposes no shared ID.
- [ ] Include pack size and price in verification.
- [x] Verify the requested final quantity.
- [x] Handle identical titles with different sizes by retaining the opaque
      offer ID and pack size in stored options.
- [ ] Collapse only exact duplicate provider results.
- [ ] Preserve unavailable offers as unavailable.
- [x] Add deterministic ordinal selection such as “first,” “second,” and
      “third.”
- [x] Support follow-ups using brand, flavor, size, or option number.
- [x] Add tested Hindi and common code-mixed ordinal, retry, skip, and cancel
      normalization. Broader language coverage remains incremental.

### Acceptance criteria

- Two products with the same title but different pack sizes cannot be confused.
- An invented or stale `offerId` is rejected.
- “The second one” selects the second stored option rather than running a new
  ranked search.
- Verification proves that the exact line and quantity changed.

---

## Milestone 4: Add an explicit conversation state machine

Replace the optional `pendingGrocery` and `pendingCod` properties with explicit
workflow states.

```text
idle
  → searching
  → awaiting_product_choice
  → adding
  → cart_updated
  → preparing_checkout
  → awaiting_checkout_confirmation
  → ordering
  → completed | ambiguous | failed
```

### Tasks

- [ ] Define conversation states and allowed transitions.
- [x] Store the original request and visible offers.
- [x] Store the selected offer and requested quantity.
- [x] Add deterministic “cancel” and “never mind” handling.
- [ ] Add an explicit “start over” transition.
- [ ] Allow unrelated new requests to replace a pending clarification.
- [x] Preserve the current product and later queue after a retryable execution
      failure.
- [ ] Clear terminal state predictably.
- [x] Stop relying only on the first tool result for multiple-item requests;
      queue later products instead of presenting several clarifications
      together.
- [ ] Add a local conversation repository interface.

The first repository implementation may remain memory-backed. Persistence can
be introduced later without changing the state machine.

### Acceptance criteria

- Pending choices cannot leak into a new task.
- The user can cancel or switch products.
- Multiple-item requests track every item independently.
- A list never searches or presents options for a later product while the
  current product is awaiting a choice.
- Every response is derived from a known workflow state.

---

## Milestone 5: Implement concise deterministic presentation

This milestone addresses verbose and difficult-to-follow product narration.

### Tasks

- [x] Preserve the exact provider title separately from its spoken label.
- [x] Generate a separate `spokenLabel`.
- [x] Find compact uniquely distinguishing product words.
- [x] Remove words common across all visible options.
- [x] Include pack size only when relevant.
- [x] Speak price only when requested or needed for comparison.
- [x] Speak quantity when greater than one.
- [x] Limit spoken clarification to three options.
- [x] Keep complete details available in structured tool results.
- [x] Generate replies from deterministic templates instead of a second
      unconstrained model response.

### Response rules

| Situation | Example spoken response |
| --- | --- |
| Searching | “Searching for Lay’s.” |
| Clarification | “Magic Masala 58 grams or Classic Salted 52 grams?” |
| Added one | “Added Magic Masala, 58 grams.” |
| Added multiple | “Added two Magic Masala packs.” |
| Already present | “Magic Masala is already in your cart.” |
| Not found | “I couldn’t find that. Try another name.” |
| Checkout | Speak the complete total, address, payment mode, and confirmation requirement. |

### Product-label algorithm

1. Keep the full provider title internally.
2. Tokenize the visible option titles.
3. Remove words shared by all visible options.
4. Retain the smallest set of words that uniquely identifies each option.
5. Append pack size when sizes differ or the user requested a size.
6. Append price only if otherwise identical options remain.
7. Fall back to the canonical title if shortening would create ambiguity.

### Acceptance criteria

- Reversible cart actions use one short sentence.
- Product labels are normally two or three meaningful words.
- Shortening never makes two options indistinguishable.
- Exact provider titles remain available for verification.
- Checkout retains every material fact.

---

## Milestone 6: Refactor the voice route

The current voice route handles transcription, prompting, state, tool
execution, response generation, and speech synthesis. Separate these
responsibilities.

### Proposed structure

```text
local/apps/voice/lib/
  speech/
    provider.ts
    sarvam.ts
  agent/
    intent.ts
    tools.ts
  conversation/
    state.ts
    repository.ts
    transitions.ts
  execution/
    blinkit-execution.ts
    operation-queue.ts
  presentation/
    product-label.ts
    voice-response.ts
    visual-response.ts
```

### Tasks

- [ ] Extract Sarvam STT and TTS behind a `SpeechProvider` interface.
- [ ] Extract model instructions and tool schemas.
- [ ] Extract conversation transition logic.
- [x] Extract reversible command execution.
- [x] Extract deterministic response presentation.
- [ ] Keep the route as a thin request coordinator.
- [ ] Put a total deadline around the voice turn.
- [ ] Remove the obsolete Realtime path after confirming that it has no active
      client.

### Acceptance criteria

- The route primarily coordinates services.
- Sarvam can be replaced without changing Blinkit execution.
- Execution can be tested without audio or model calls.
- Presentation can be tested using static structured results.

---

## Milestone 7: Improve overlay progress and interaction

### Tasks

- [x] Use short progress events from the execution service.
- [ ] Distinguish listening, interpreting, searching, adding, verifying, and
      replying.
- [x] Keep full product titles out of the 292 dp activity capsule and use
      concise labels in the bounded product-choice card.
- [x] Keep the result visible while TTS is playing.
- [x] Keep “waiting for your choice” persistent until the user answers.
- [ ] Allow speech interruption of playback.
- [x] Make clarification visually distinct from errors in the structured
      presentation modes.
- [x] Replace static readiness claims with actual state.
- [x] Correct microphone-processing copy.

Example progress sequence:

```text
Listening…
Understanding…
Searching for Lay’s…
Checking 3 options…
Waiting for your choice
```

### Acceptance criteria

- Status reflects the actual execution stage.
- The overlay never says “working” after execution is complete.
- Long provider titles do not overflow the pill.
- Clarification remains visible long enough for the user to answer.

---

## Milestone 8: Consolidate checkout execution

Improve checkout reliability without implementing the deferred authentication
layer.

### Tasks

- [ ] Prepare checkout using the same semantic driver.
- [ ] Capture complete cart lines and quantities.
- [ ] Capture unit prices, fees, total, address, payment mode, and ETA.
- [ ] Add proposal expiry.
- [ ] Compare live checkout terms before final execution.
- [ ] Keep confirmation separate from cart preparation.
- [ ] Return `checkout_changed` with the changed fields.
- [ ] Preserve `ambiguous` when the final provider result cannot be verified.
- [ ] Never automatically retry a final provider action.

### Acceptance criteria

- Checkout review contains complete material terms.
- A quantity, price, fee, address, or payment change invalidates the review.
- Preparation never places an order.
- An uncertain result never becomes a false success.
- Live final ordering remains excluded from normal verification.

---

## Milestone 9: Tests and live verification

### Automated workflow tests

- [x] Read-only search does not change the cart.
- [x] Exact product adds quantity one.
- [x] Requested quantity greater than one is respected.
- [x] Broad search asks for clarification.
- [x] Ordinal follow-up selects the stored option.
- [x] Flavor or size follow-up selects the correct option.
- [ ] Cancel clears pending state.
- [ ] A new request replaces stale clarification.
- [x] A duplicate request is idempotent.
- [x] Duplicate titles with different sizes remain distinct.
- [x] Existing cart quantity can be changed.
- [x] Multiple items produce independent results.
- [x] Concurrent commands are serialized.
- [x] Execution failure preserves retryable state.
- [x] Concise product labels remain unique.
- [x] Tested native-language and code-mixed product-choice phrases are
      preserved.
- [ ] Changed checkout terms block confirmation.

### Live canary sequence

1. Search broadly for Lay’s and confirm that the cart does not change.
2. Select one option by ordinal.
3. Add quantity two and inspect the exact cart line.
4. Search for another product without adding it.
5. Change the existing quantity.
6. Remove one item.
7. Prepare checkout and compare every returned fact with Blinkit.
8. Stop before the final Place Order action.

---

## Recommended delivery sequence

### Delivery 1: Product workflow

Implement Milestones 1–5:

- explicit search versus add;
- quantity support;
- exact offer selection;
- conversation state machine;
- concise deterministic speech.

This delivery provides the largest user-experience improvement without
changing checkout.

### Delivery 2: Execution reliability

Implement Milestones 6–7:

- refactored voice architecture;
- operation serialization;
- improved overlay progress;
- removal of obsolete voice paths.

### Delivery 3: Checkout correctness

Implement Milestones 8–9:

- unified checkout driver;
- complete term comparison;
- ambiguous-result handling;
- end-to-end workflow verification.

---

## Definition of done

- [x] `/hosted/**` has no changes.
- [x] “Find” is read-only.
- [x] “Add” respects the exact offer and requested quantity.
- [x] Product speech is short, natural, and uniquely understandable.
- [x] All reversible Blinkit operations use one execution service.
- [ ] Conversation state has explicit transitions and cancellation.
- [x] Overlay presentation is driven by real execution and workflow results.
- [ ] Checkout uses complete verified terms.
- [x] Local tests pass.
- [x] Local typechecking passes.
- [x] Local build passes.
- [x] No live order is placed during verification.
