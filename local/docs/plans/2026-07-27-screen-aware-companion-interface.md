# JaldiAI Screen-Aware Companion Interface Implementation Plan

> **Status:** Proposed on 2026-07-27. This plan complements
> [`../local-phone-agent-implementation-plan.md`](../local-phone-agent-implementation-plan.md);
> it does not replace the active execution, command-model, conversation-state,
> or checkout work tracked there.

## Goal

Turn the existing JaldiAI Android overlay into a screen-aware companion that
uses Blinkit as the primary visual surface whenever the relevant information is
already visible, while retaining a compact native card for progress, safety
boundaries, clarification, fallback details, and verified outcomes.

The intended experience is:

```text
Hold the companion and speak
  → JaldiAI understands the request
  → Blinkit opens or updates visibly
  → JaldiAI verifies the current Blinkit screen
  → the overlay points the user to the current screen when it contains the answer
  → the overlay expands only when the user must decide, review, or recover
```

Examples:

- “I found three matching options. Check them on the current screen.”
- “Your cart summary is open. Check the cart on the current screen.”
- “The checkout summary is visible on the current screen. Review the total and
  delivery address there. Nothing has been ordered.”
- “Blinkit’s order confirmation is visible on the current screen.”

## Product principle

The provider screen is the primary interface when—and only when—JaldiAI has
freshly verified that it contains the relevant information.

The overlay is the companion layer:

- at rest, it is a small draggable JaldiAI presence;
- while working, it is a compact progress capsule;
- when attention is required, it points the user to the verified provider
  screen;
- when information is not visible or a choice is required, it expands into a
  structured context card;
- for paid actions, it always preserves the explicit review and confirmation
  boundary even when Blinkit itself shows the checkout.

The assistant must never say “check the current screen,” “you can see it on
screen,” or equivalent language from model inference alone.

## Relationship to the active local-phone plan

This plan assumes and extends the following work already tracked in
`local/docs/local-phone-agent-implementation-plan.md`:

- explicit semantic commands such as `search_products` and `add_cart_item`;
- one serialized execution path for the connected phone;
- structured execution results independent of conversational prose;
- deterministic concise product labels;
- an explicit conversation state machine;
- semantic-driver checkout consolidation;
- progress events that distinguish searching, acting, and verification.

Dependencies:

1. Delivery 1 in this plan can land alongside the current refactor because it
   adds typed presentation metadata without replacing execution commands.
2. Checkout screen-awareness should use the semantic driver after the active
   checkout-consolidation milestone. An interim legacy bridge may classify the
   final checkout source, but it must be deleted after migration.
3. Interactive product-choice cards depend on deterministic pending-choice
   state and exact opaque `offerId` handling.
4. Spatial highlights are a later enhancement and must not delay the
   screen-aware speech and compact-card deliveries.

## Non-goals

- Do not modify `/hosted`.
- Do not add generic device control, raw taps, coordinates, screenshots, UI XML,
  selectors, or Appium sessions to the public tool surface.
- Do not make JaldiAI continuously observe the phone.
- Do not replace the official Blinkit UI with a cloned cart or checkout UI.
- Do not enable live final-order testing as part of the interface refactor.
- Do not treat a visible provider screen as transaction approval.
- Do not silently retry an ambiguous final order action.
- Do not require the full-screen Next.js voice page for the native overlay
  experience.

## Existing foundations

The repository already provides:

- `BlinkitAndroidDriver.currentScreen()` for a fresh sanitized semantic screen
  read;
- `classifyBlinkitAndroidScreen()` with kinds including `home`, `search`,
  `search_results`, `product_detail`, `cart`, `checkout`, `payment`,
  `address_selection`, `order_confirmation`, and `order_history`;
- exact product offers and opaque `offerId` values;
- verified cart results and provider fingerprints;
- a draggable 64 dp native overlay that expands to a 292 dp status pill;
- Sarvam STT/TTS and preserved conversation language;
- deterministic voice presentation under active development;
- explicit COD review, fingerprint comparison, at-most-once dispatch, and
  ambiguous-result handling.

The missing boundary is a typed presentation model connecting those provider
facts to the native overlay.

---

## Target experience model

### Level 1: Companion

The collapsed overlay is a 52–64 dp branded JaldiAI control.

- Hold: begin push-to-talk.
- Release: submit the turn.
- Drag: reposition without recording.
- Tap: reveal or hide the latest result.
- Long work: remain visible without taking over the provider app.

The companion should use a custom JaldiAI visual identity instead of generic
Android framework icons.

### Level 2: Agent capsule

The compact capsule shows:

- task title;
- current semantic step;
- small progress or indeterminate activity indicator;
- mode: listening, understanding, reading, acting, verifying, waiting, done,
  or error;
- a visible interruption/cancel affordance only where cancellation is safe.

Example:

```text
Adding Amul Taaza milk
Verifying 500 ml in your cart…
```

### Level 3: Context card

The context card appears only when additional information or a decision is
required.

Card types:

- product choices;
- cart summary fallback;
- checkout review;
- changed checkout terms;
- authentication or device-attention request;
- provider constraint;
- ambiguous outcome and reconciliation state;
- verified receipt.

When the same information is already verified on the Blinkit screen, the card
uses an attention treatment instead of duplicating every row.

---

## Screen-aware response policy

### Required conditions

JaldiAI may direct the user to the current screen only when all conditions hold:

1. The current provider package is Blinkit.
2. The screen was classified after the relevant operation or immediately before
   presentation.
3. The classified kind is one of the expected kinds for that result.
4. The result and screen belong to the same serialized phone operation.
5. No subsequent navigation or operation invalidated the read.
6. The screen contains the semantic subject referenced by the response.

If any condition fails, the overlay becomes the primary presentation surface.

### Screen-to-presentation mapping

| Verified screen | Relevant result | Spoken direction | Overlay behavior |
| --- | --- | --- | --- |
| `search_results` | available offers | “I found three options. Check them on the current screen.” | Compact attention capsule; expandable fallback choices |
| `product_detail` | exact product | “The exact pack is open. Check its details on the current screen.” | Compact product identity and state |
| `cart` | cart read or mutation | “Your cart is open. Check the updated quantity on the current screen.” | Verified-change capsule; expandable cart summary |
| `checkout` | prepared checkout | “The checkout summary is visible on the current screen.” | Persistent `NOT ORDERED` review capsule |
| `payment` | COD selection | “Cash on Delivery is selected on the current screen.” | Persistent payment and review boundary |
| `address_selection` | address choice required | “Your saved address choices are on the current screen.” | Waiting-for-choice card |
| `order_confirmation` | verified order | “Blinkit’s confirmation is visible on the current screen.” | Verified receipt capsule |
| `order_history` | reconciliation evidence | “The matching order is visible in recent orders on the current screen.” | Reconciliation result card |
| `login` or `otp` | authentication required | “Blinkit needs your attention on the current screen.” | Privacy-safe attention card; never echo secrets |
| `unknown` | any result | No screen claim | Full overlay fallback or safe error |

### Safety-critical exceptions

Even when the provider screen is primary:

- checkout must say `Nothing has been ordered` or `NOT ORDERED`;
- the exact final confirmation requirement remains visible or spoken;
- changed terms must identify that the previous review is stale;
- an ambiguous final outcome must not use success styling;
- a committed order requires verified provider evidence;
- the overlay must not disappear while the user is expected to respond.

---

## Proposed typed presentation boundary

Add a versioned, runtime-validated model shared by the voice server and Android
overlay.

Suggested shape:

```ts
type OverlayPresentationV1 = {
  version: 1;
  mode:
    | 'idle'
    | 'listening'
    | 'understanding'
    | 'reading'
    | 'acting'
    | 'verifying'
    | 'waiting_for_user'
    | 'success'
    | 'error'
    | 'ambiguous';
  task?: {
    title: string;
    step?: string;
    progress?: number;
  };
  primarySurface: 'provider_screen' | 'overlay_card';
  currentScreen?: {
    kind: AndroidScreenKindV1;
    relevance:
      | 'product_options'
      | 'product_detail'
      | 'cart_summary'
      | 'checkout_summary'
      | 'payment_selection'
      | 'address_choices'
      | 'order_confirmation'
      | 'order_history';
    verified: true;
  };
  attentionCue?: {
    instruction: 'check_current_screen';
    subject:
      | 'options'
      | 'product'
      | 'cart'
      | 'checkout'
      | 'payment'
      | 'address'
      | 'confirmation'
      | 'recent_orders';
  };
  card:
    | { type: 'compact_status'; tone: OverlayToneV1 }
    | { type: 'product_choices'; options: ProductChoiceV1[] }
    | { type: 'cart_summary'; cart: CartSummaryV1 }
    | { type: 'checkout_review'; checkout: CheckoutReviewV1; ordered: false }
    | { type: 'changed_terms'; changes: CheckoutChangeV1[] }
    | { type: 'provider_constraint'; reason: string }
    | { type: 'receipt'; providerReference: string }
    | { type: 'ambiguous'; reconciliationId?: string };
  spoken: {
    text: string;
    languageCode: string;
  };
  behavior: {
    autoCollapse: boolean;
    collapseAfterMs?: number;
    keepVisibleWhileSpeaking: boolean;
  };
};
```

Rules:

- The schema carries semantic facts, not raw device internals.
- `currentScreen.verified` is only constructed by deterministic server code.
- The model may choose a semantic command but may not manufacture presentation
  verification.
- Exact provider names, sizes, quantities, prices, totals, address labels,
  proposal IDs, and references remain unchanged.
- Android treats unrecognized versions or card types as a safe compact fallback.

---

## Delivery 1: Verified screen context and spoken cues

This delivery adds screen awareness without redesigning the Android card.

### Task 1.1: Define presentation contracts

**Files:**

- Create: `local/packages/contracts/src/overlay-presentation.ts`
- Modify: `local/packages/contracts/src/index.ts`
- Test: `local/packages/contracts/test/overlay-presentation.test.ts`

- [ ] Add `OverlayModeSchemaV1`.
- [ ] Reuse the existing sanitized Android screen-kind schema.
- [ ] Add `OverlayPrimarySurfaceSchemaV1`.
- [ ] Add semantic attention subjects.
- [ ] Add a discriminated union for card types.
- [ ] Add visibility and auto-collapse behavior.
- [ ] Reject screenshots, XML, selectors, coordinates, raw addresses, phone
      numbers, and OTP fields.
- [ ] Add forward-compatible safe parsing behavior in the Android client.

**Acceptance criteria:**

- A verified checkout presentation parses.
- A provider-screen presentation without a verified recognized screen fails.
- An `order_confirmation` card without a provider reference cannot claim
  committed success.
- Serialized presentation contains no raw device-control fields.

### Task 1.2: Add a deterministic screen-relevance policy

**Files:**

- Create: `local/apps/voice/lib/screen-presentation.ts`
- Test: `local/apps/voice/lib/screen-presentation.test.ts`

Suggested interface:

```ts
export function selectPrimarySurface(input: {
  result: PresentableToolResult;
  currentScreen?: AndroidCurrentScreenV1;
}): {
  primarySurface: 'provider_screen' | 'overlay_card';
  relevance?: ScreenRelevanceV1;
  attentionCue?: AttentionCueV1;
};
```

- [ ] Map each structured result status to expected screen kinds.
- [ ] Require exact expected-kind matches for provider-screen presentation.
- [ ] Default unknown, missing, stale, or irrelevant screens to overlay cards.
- [ ] Preserve the checkout and ambiguous-result safety exceptions.
- [ ] Add tests for every row in the screen-to-presentation mapping.
- [ ] Add negative tests proving that a `cart` screen cannot support an
      `order_confirmation` claim.

**Acceptance criteria:**

- Screen wording is selected by pure deterministic logic.
- The policy never trusts arbitrary model prose.
- Every unsupported combination falls back safely.

### Task 1.3: Return a fresh screen read with execution results

**Files:**

- Modify: `local/apps/voice/lib/blinkit-execution.ts`
- Modify: the unified execution service introduced by the active local plan
- Test: `local/apps/voice/lib/blinkit-execution.test.ts`

- [ ] Keep one driver/session open through action, verification, and current
      screen read.
- [ ] Read `driver.currentScreen()` after search completes.
- [ ] Read it after a cart mutation is independently verified.
- [ ] Read it after cart inspection.
- [ ] Read it after checkout preparation.
- [ ] Read it after final confirmation or reconciliation.
- [ ] Attach only the sanitized screen result.
- [ ] Do not open a second unsynchronized Appium session solely for
      presentation.
- [ ] Treat a screen-read failure as “screen unavailable,” not as failure of an
      already verified reversible operation.

**Acceptance criteria:**

- The returned screen belongs to the same serialized operation.
- A successful cart mutation remains successful if the optional presentation
  read fails, but the response does not claim that the cart is visible.
- No phone operation overlaps another operation.

### Task 1.4: Make deterministic speech screen-aware

**Files:**

- Modify: `local/apps/voice/lib/voice-presentation.ts`
- Modify: `local/apps/voice/lib/voice-presentation.test.ts`
- Create or modify: language-aware presentation helper selected by the active
  voice refactor

- [ ] Pass structured screen relevance into `presentToolResult`.
- [ ] Add screen-direction templates for search, product, cart, checkout,
      payment, address, confirmation, and recent orders.
- [ ] Avoid reading every visible product when the user can see the search
      results.
- [ ] Preserve exact safety-critical checkout facts.
- [ ] Keep spoken replies under three short sentences where possible.
- [ ] Generate the cue in the user’s retained language.
- [ ] Preserve exact provider facts while localizing connective prose.
- [ ] Never append a screen cue to an unverified fallback response.

**Acceptance criteria:**

- A verified cart result says that the cart is on the current screen.
- The same result without screen verification includes the necessary cart
  summary in the response instead.
- A verified checkout response says where to look and that nothing has been
  ordered.
- Hindi, Hinglish, and English smoke cases retain the correct screen cue.

### Task 1.5: Include the presentation payload in the voice response

**Files:**

- Modify: `local/apps/voice/app/api/voice/turn/route.ts`
- Modify: `local/apps/voice/app/api/device/task/route.ts`
- Test: route or coordinator tests in `local/apps/voice/test/` or
  `local/apps/voice/lib/`

- [ ] Build presentation only after tool execution and fresh screen
      classification.
- [ ] Return `presentation` alongside the existing compatibility fields.
- [ ] Keep `reply`, `assistantState`, and audio temporarily for the installed
      overlay.
- [ ] Derive legacy `assistantState` from the new presentation mode.
- [ ] Ensure the browser/PWA client ignores unknown presentation fields safely.
- [ ] Add response fixtures for search, clarification, cart, checkout, success,
      failure, and ambiguous states.

**Acceptance criteria:**

- Existing clients continue functioning.
- New clients receive one authoritative structured presentation object.
- Screen verification cannot be supplied in a model tool-call argument.

---

## Delivery 2: Native progressive overlay

### Task 2.1: Separate native presentation code from the service

**Files:**

- Create: `local/apps/android-overlay/src/ai/errandos/overlay/OverlayPresentation.java`
- Create: `local/apps/android-overlay/src/ai/errandos/overlay/OverlayPresentationParser.java`
- Create: `local/apps/android-overlay/src/ai/errandos/overlay/OverlayCardView.java`
- Modify: `local/apps/android-overlay/src/ai/errandos/overlay/OverlayService.java`
- Modify: `local/apps/android-overlay/build.sh`

- [ ] Parse `presentation.version`.
- [ ] Fall back to `reply` and `assistantState` for older server responses.
- [ ] Move view construction and rendering out of networking code.
- [ ] Compile every overlay Java source deterministically.
- [ ] Keep service destruction, media cleanup, and window cleanup safe.

**Acceptance criteria:**

- The existing APK still builds and installs.
- An unknown presentation version renders a compact safe message.
- Malformed card data cannot crash the foreground service.

### Task 2.2: Implement companion, capsule, and context-card sizes

**Files:**

- Modify: `OverlayCardView.java`
- Modify: `OverlayService.java`

- [ ] Preserve the draggable collapsed companion.
- [ ] Retain separate drag, tap, and hold gestures.
- [ ] Render an active capsule for listening, understanding, acting, and
      verifying.
- [ ] Render a bounded context card for clarification and checkout.
- [ ] Anchor expansion left or right based on current screen position.
- [ ] Clamp every size to the visible display and safe margins.
- [ ] Preserve the last user-chosen position.
- [ ] Prevent the context card from covering the complete provider summary.
- [ ] Keep the active state visible while TTS is playing.

**Acceptance criteria:**

- All three presentation levels work from every screen edge.
- Dragging never triggers recording or card actions.
- Expanding never places content outside the display.
- The provider app remains visible and interactive outside the overlay.

### Task 2.3: Add branded visual states

- [ ] Replace framework icons with JaldiAI vector or programmatic assets.
- [ ] Give listening, reading, acting, waiting, success, error, and ambiguous
      states distinct shapes or motion in addition to color.
- [ ] Support reduced-motion behavior.
- [ ] Add accessible content descriptions for state and action.
- [ ] Avoid using success colors for merely prepared or ambiguous states.

**Acceptance criteria:**

- State remains understandable without color.
- The collapsed control is recognizable as JaldiAI rather than a generic mic.
- Accessibility services receive the concise semantic state.

### Task 2.4: Render current-screen attention cues

- [ ] Add a compact “Check current screen” treatment.
- [ ] Include a semantic subject such as options, cart, checkout, or
      confirmation.
- [ ] Use a subtle directional notch, arrow, or pulse without claiming a
      specific coordinate.
- [ ] Allow tap-to-expand fallback details.
- [ ] Keep checkout’s `NOT ORDERED` label visible until confirmation or
      cancellation.

**Acceptance criteria:**

- A provider-screen response is visually smaller than a fallback card.
- The user can still retrieve exact details without leaving Blinkit.
- Attention cues never appear for an unverified screen.

---

## Delivery 3: Structured product and checkout cards

### Task 3.1: Product-choice card

- [ ] Show up to three exact options with concise unique labels.
- [ ] Show pack size whenever necessary to distinguish options.
- [ ] Show price when requested or needed to disambiguate.
- [ ] If `search_results` is verified, default to the compact current-screen cue.
- [ ] If the screen is unavailable, render the choices in the overlay.
- [ ] Keep waiting state visible until the user answers, cancels, or starts a
      new task.
- [ ] Add an expandable “more” path without speaking every option.

### Task 3.2: Cart-change card

- [ ] Show the changed product, requested final quantity, and verification
      result.
- [ ] Use “Check the updated cart on the current screen” only when verified.
- [ ] State that no order was placed.
- [ ] Provide full cart fallback when the cart is not visible.

### Task 3.3: Checkout-review card

- [ ] Display `NOT ORDERED`.
- [ ] Display total, address label, payment mode, item count, and expiry.
- [ ] Keep item, price, fee, quantity, ETA, and fingerprint-backed facts
      available through expansion.
- [ ] Direct the user to the checkout screen when verified.
- [ ] Retain the exact confirmation instruction.
- [ ] Change to a stale-terms card when comparison detects a material change.
- [ ] Never auto-collapse while awaiting confirmation.

### Task 3.4: Outcome and reconciliation cards

- [ ] Verified commit: receipt styling and provider reference.
- [ ] Blocked: exact safe constraint and next allowed action.
- [ ] Ambiguous: neutral warning styling, no success language, no retry button.
- [ ] Reconciling: visible read-only state.
- [ ] Reconciled: verified receipt or still-uncertain result.

---

## Delivery 4: Direct interaction and cancellation

This delivery depends on the explicit conversation state machine.

### Task 4.1: Safe cancellation

- [ ] Add a typed `cancel_current_task` command.
- [ ] Cancel only operations that have not entered at-most-once final dispatch.
- [ ] Stop TTS playback on new push-to-talk.
- [ ] Make unsafe-to-cancel stages visibly non-interruptible.
- [ ] Never translate “cancel” into cart clearing.

### Task 4.2: Optional touch selection

- [ ] Let a product-choice card submit one stored opaque `offerId`.
- [ ] Bind the click to the active conversation and original search.
- [ ] Reject expired, stale, or unknown choice IDs.
- [ ] Keep voice selection available.
- [ ] Confirm the exact option visually before mutation begins.

### Task 4.3: Checkout interaction

- [ ] Keep explicit voice confirmation as the initial path.
- [ ] Evaluate a press-and-hold confirmation control only if it binds to the
      exact reviewed proposal and meets the existing approval policy.
- [ ] Never make a normal tap sufficient for a paid final action.
- [ ] Recompare provider terms immediately before dispatch.

---

## Delivery 5: Spatial provider-screen guidance

This is optional polish after screen-aware cues are stable.

### Architecture

Use a second transparent, non-focusable, non-touchable overlay window for
short-lived visual highlights. Keep the companion/card in its existing
touchable window.

### Tasks

- [ ] Define internal-only semantic highlight targets.
- [ ] Obtain element bounds only inside the local execution process.
- [ ] Never include raw bounds in MCP, public contracts, logs, model prompts, or
      durable state.
- [ ] Transform Appium bounds for density, rotation, status-bar inset, and
      navigation inset.
- [ ] Draw a short-lived ring, arrow, or underline.
- [ ] Remove the highlight after navigation or timeout.
- [ ] Make the highlight non-touchable so Blinkit remains interactive.
- [ ] Disable highlights when the screen kind or orientation changes.

Candidate highlights:

- selected product card;
- updated quantity control;
- cart entry point;
- bill total;
- saved address label;
- COD option;
- provider confirmation evidence.

**Acceptance criteria:**

- The highlight aligns on the test Pixel in portrait mode.
- It cannot intercept Blinkit touches.
- It disappears on screen transition.
- No coordinate or selector crosses the semantic safety boundary.

---

## Lifecycle and collapse rules

| Mode | Default visibility | Collapse behavior |
| --- | --- | --- |
| `idle` | companion | stays collapsed |
| `listening` | capsule | never auto-collapse |
| `understanding` | capsule | never auto-collapse |
| `reading` | capsule | never auto-collapse |
| `acting` | capsule | never auto-collapse |
| `verifying` | capsule | never auto-collapse |
| `waiting_for_user` | context card or attention capsule | never auto-collapse |
| `success` | result capsule/card | collapse after TTS and a readable delay |
| `error` | recovery card | collapse only after a longer readable delay |
| `ambiguous` | persistent warning card | never auto-collapse automatically |

Additional rules:

- A new press interrupts TTS before recording begins.
- Manual tap can reopen the latest terminal result.
- Auto-collapse must not erase pending product-choice or checkout state.
- Card state is presentation only; the conversation state machine remains
  authoritative.

---

## Test strategy

### Contract tests

- [ ] Parse each presentation card type.
- [ ] Reject forbidden raw device fields.
- [ ] Reject provider-screen claims without verified recognized screens.
- [ ] Reject committed styling without provider evidence.
- [ ] Preserve exact money, product, address-label, and reference facts.

### Screen-policy tests

- [ ] Every supported result/screen pairing chooses the provider screen.
- [ ] Every mismatched pairing chooses the overlay card.
- [ ] `unknown`, missing, or failed screen reads never generate a screen cue.
- [ ] Checkout and ambiguous-result exceptions remain visible.
- [ ] A stale screen read cannot be reused across another queued operation.

### Voice-presentation tests

- [ ] Search results use “current screen” only when verified.
- [ ] Cart summary uses the correct subject.
- [ ] Checkout mentions the current screen and `nothing has been ordered`.
- [ ] Confirmation uses verified provider evidence.
- [ ] Multilingual templates preserve exact provider facts.
- [ ] Replies remain concise and do not duplicate every visible row.

### Route/coordinator tests

- [ ] The voice response includes `presentation.version = 1`.
- [ ] Legacy fields are derived consistently.
- [ ] Model output cannot set `currentScreen.verified`.
- [ ] Screen-read failure falls back without losing a verified cart mutation.
- [ ] Concurrent turns remain serialized.

### Native build and parser checks

- [ ] Build the APK after every native delivery.
- [ ] Parse representative JSON fixtures for every card type.
- [ ] Verify malformed JSON falls back safely.
- [ ] Verify the service survives orientation and app changes.

### Live Pixel canary

Use reversible operations only unless separately authorized.

1. Unlock the Pixel and open Blinkit.
2. Hold JaldiAI and ask for a broad product search.
3. Verify Blinkit shows search results.
4. Verify JaldiAI says to check the current screen.
5. Verify the overlay does not duplicate all products by default.
6. Choose one exact option and add it at a requested quantity.
7. Verify the quantity is visible and JaldiAI refers to the current screen.
8. Open the cart through a read-only command.
9. Verify the cart-summary cue and expandable fallback.
10. Prepare COD checkout without placing an order.
11. Verify `NOT ORDERED`, exact review facts, and current-screen direction.
12. Background Blinkit before presentation and verify JaldiAI falls back to a
    full overlay card without claiming the provider screen is visible.
13. Lock the phone and verify the device-attention response.
14. Exercise an ambiguous fixture only; do not create a live ambiguous order.

### Verification commands

```bash
pnpm --dir local --filter @errandos/contracts test
pnpm --dir local --filter @errandos/provider-connectors test
pnpm --dir local --filter @errandos/voice test
pnpm --dir local typecheck
pnpm --dir local test
local/apps/android-overlay/build.sh
git diff --check
```

---

## Rollout plan

### Phase A: Compatibility payload

- Return `presentation` while preserving the current native fields.
- Log only presentation type, mode, screen kind, and fallback reason.
- Do not log speech, screenshots, exact provider UI, or secrets.

### Phase B: Native capsule

- Install the new overlay on the test Pixel.
- Keep interactive choices and spatial highlights disabled.
- Compare current-screen claims against live visible screens.

### Phase C: Structured cards

- Enable product-choice and checkout-review cards.
- Keep final-order live testing disabled.
- Validate persistence and collapse behavior.

### Phase D: Interaction

- Enable safe cancel and product selection after conversation-state work lands.
- Keep paid confirmation policy unchanged.

### Phase E: Spatial cues

- Enable only after alignment and touch-through canaries pass.
- Keep a runtime flag to disable the highlight layer independently.

Suggested flags:

```text
JALDI_OVERLAY_PRESENTATION_V1=true
JALDI_OVERLAY_INTERACTIVE_CHOICES=false
JALDI_OVERLAY_SPATIAL_CUES=false
```

---

## Definition of done

- JaldiAI directs the user to Blinkit only from a fresh verified current-screen
  read.
- Search, product, cart, checkout, payment, confirmation, and recent-order
  screens have deterministic presentation policies.
- The Android overlay supports companion, agent capsule, and context-card
  levels.
- Relevant information is not unnecessarily duplicated when Blinkit already
  shows it.
- A full fallback remains available when the provider screen is unavailable.
- Checkout visibly and audibly states that nothing has been ordered.
- Ambiguous outcomes remain visually distinct from success and are never
  retried automatically.
- Voice cues follow the user’s language while exact provider facts remain
  unchanged.
- No raw device-control detail crosses the semantic boundary.
- Existing local command, execution, queue, conversation, and transaction
  safety invariants continue to pass.
