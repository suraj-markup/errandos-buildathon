# JaldiAI multi-item companion UI implementation plan

> **Status:** Offline implementation and verification were refreshed on
> 2026-07-29. UX003, UX036, and UX042 are complete in code and automated
> coverage. UX060 remains partial for the exact metadata/UI reasons recorded
> below. Physical-Pixel acceptance remains open for UX052, UX054, UX063,
> UX064, and UX080.
>
> **Priority:** P0 product hardening before another multi-item or checkout demo.
>
> **Extends:**
>
> - [`../local-phone-agent-implementation-plan.md`](../local-phone-agent-implementation-plan.md)
> - [`2026-07-27-screen-aware-companion-interface.md`](2026-07-27-screen-aware-companion-interface.md)
> - [`2026-07-28-adaptive-phone-agent-hardening-plan.md`](2026-07-28-adaptive-phone-agent-hardening-plan.md)
> - [`2026-07-27-realtime-vision-phone-agent-master-plan.md`](2026-07-27-realtime-vision-phone-agent-master-plan.md)
>
> This plan is deliberately interface-focused, but it includes the server,
> workflow, event, and recovery changes required to make the interface
> truthful. A polished card cannot compensate for missing task continuation or
> incorrect mutation truth.

## 1. Why this plan exists

The physical-Pixel workflow requested:

```text
Add potato, paneer, chicken, and one 10 kg bag of rice to my cart.
Do not place the order.
```

The final read-only cart inspection proved:

| Item | Quantity | Price |
| --- | ---: | ---: |
| Potato | 1 | ₹27 |
| Amul Fresh Malai Paneer, 200 g | 1 | ₹105 |
| Abis Pro Chicken Curry Cut, 500 g | 1 | ₹129 |
| Anand Boiled Rice, 10 kg | 1 | ₹619 |
| **Subtotal** |  | **₹880** |

The three-item V2 continuation task reached `completed`, with all three steps
`verified` and no active operation. No checkout, payment, or order action was
attempted.

The underlying transaction result was correct, but the interaction was not yet
good enough:

1. The initial plural query `potatoes` returned a false `not_found`; singular
   `potato` found the expected offers.
2. Potato was actually added, but recovery compared
   `Potato (Alugadde)` too strictly with the cart label `Potato` and incorrectly
   classified it as not applied.
3. After each verified background add, the user had to say
   `Continue with the next item.` The task remembered the queue, but did not
   automatically dispatch the next eligible step.
4. The UI spent long periods in a generic working state while selected-product
   mutations took approximately 63–85 seconds.
5. Broad product searches could not use the background adapter until an exact
   `offerId` existed, producing an internal fallback rather than a clean
   user-facing search phase.
6. Product-choice cards worked, but the transition from tap to selection,
   adding, verification, and next-item progress was not expressed as one
   continuous interaction.
7. The final cart summary existed only after an explicit inspection rather than
   appearing automatically when the task completed.

The primary product problem is therefore:

> The user cannot see and trust one continuous task moving from the original
> list to verified completion.

## 2. Product outcome

The intended experience for the same request is:

```text
User speaks one list
  → JaldiAI immediately shows the four-item task
  → JaldiAI searches potato
  → the user chooses only when the request is materially ambiguous
  → JaldiAI adds and verifies the exact selection once
  → “Potato added. Now looking for paneer.”
  → the checklist advances automatically
  → the same pattern continues for paneer, chicken, and rice
  → JaldiAI automatically reads the final cart
  → one editable, verified cart summary appears
  → JaldiAI asks whether to keep shopping, review checkout, or stop
```

The user should not have to:

- repeat the original list;
- remember which item comes next;
- say `continue`;
- wonder whether a tap was accepted;
- distinguish a real failure from a verification delay;
- watch a generic `Understanding…` state for over a minute;
- inspect terminal logs to understand task progress;
- re-authorize an ordinary add after selecting an exact product;
- manually request a final cart summary.

## 3. Product principles

### 3.1 One task, one visible story

All turns, taps, searches, mutations, recoveries, and results for the same goal
must project into one retained task surface. A new HTTP request must not look
like a new task when it is a continuation.

### 3.2 Transaction truth is local

The model can explain and personalize progress, but only authoritative task
state and verified provider observations may drive:

- checkmarks;
- success colors;
- `added to cart` speech;
- cart totals;
- checkout readiness;
- order confirmation.

### 3.3 Progress must name the real phase

The interface must prefer:

```text
Searching for chicken
Waiting for your chicken choice
Adding Abis Pro Chicken Curry Cut
Checking the updated cart
```

over:

```text
Understanding and doing the task
```

### 3.4 Uncertainty must be visible without encouraging a duplicate

An uncertain mutation is not a failure. The interface must say that JaldiAI is
checking the existing result and will not repeat the add until it knows what
happened.

### 3.5 User input should advance, not restart

A voice answer or card tap resolves the currently open interaction. It must
carry forward the selected offer and remaining queue. It must not trigger a new
broad search for the same item.

### 3.6 Use the smallest sufficient overlay

The Blinkit screen remains the provider surface. JaldiAI expands only as much
as needed:

- companion at rest;
- capsule for routine progress;
- task card for a multi-step overview;
- choice card for a decision;
- recovery card for ambiguity;
- cart card for final review.

### 3.7 Safety remains explicit

Improving continuity must not weaken:

- exact offer identity;
- duplicate-tap protection;
- mutation idempotency;
- reconciliation-before-retry;
- checkout `NOT ORDERED` status;
- fresh final confirmation;
- final-dispatch at-most-once behavior.

## 4. Target interaction

### 4.1 Initial acknowledgement

Within the first bounded response, show:

```text
Adding 4 items

○ Potato
○ Paneer
○ Chicken
○ Rice — 10 kg

Starting with potato…

[Pause]  [Cancel task]
```

The assistant may say:

> “I’ll add four items, starting with potato. I’ll pause only when I need a
> product choice.”

### 4.2 Search and choice

When an exact product is not known:

```text
Choose paneer                                      1 of 4

┌───────────────────────────────────────────────┐
│ Amul Fresh Malai Paneer                       │
│ 200 g · ₹105                         Suggested│
└───────────────────────────────────────────────┘

┌───────────────────────────────────────────────┐
│ Heritage Fresh Paneer                         │
│ 200 g · ₹101                      Lowest price│
└───────────────────────────────────────────────┘

┌───────────────────────────────────────────────┐
│ Milky Mist Paneer                             │
│ 200 g · ₹105                                  │
└───────────────────────────────────────────────┘

You can tap an option or say its name.
```

The user may:

- tap one option;
- say an option number;
- say the product or brand;
- ask for more options;
- refine the request;
- skip the item;
- cancel the task.

### 4.3 Tap acknowledgement

Immediately after a valid tap:

```text
✓ Amul Fresh Malai Paneer selected
  200 g · ₹105

Adding to cart…
```

Required behavior:

- highlight the selected row;
- disable every option;
- show a progress indicator on the selected row;
- persist the selection locally before network retry;
- reject a different late winner;
- treat an identical late tap as a harmless duplicate;
- retain push-to-talk for correction or cancellation.

The selected option is sufficient authorization for a normal cart add. Do not
ask an additional `Do you confirm?`.

### 4.4 Mutation and verification

Use two distinct phases:

```text
Adding Amul Fresh Malai Paneer…
```

then:

```text
Checking your cart…
```

If the provider operation exceeds ten seconds:

```text
Still adding Amul Fresh Malai Paneer
Blinkit is taking longer than usual.
You can keep using your phone; I’ll update this card.
```

Do not use a generic user-visible timeout while the durable operation remains
`queued` or `running`.

### 4.5 Verified item transition

As soon as the background operation is authoritatively verified:

```text
✓ Amul Fresh Malai Paneer added
  200 g · ₹105

Now looking for chicken…
```

The corresponding task card becomes:

```text
Adding 4 items                                      2 of 4

✓ Potato — 1 kg
✓ Amul Fresh Malai Paneer — 200 g
● Chicken — searching
○ Rice — 10 kg

[Pause after this item]  [Cancel task]
```

The next eligible step starts automatically. There is no `continue` prompt.

### 4.6 Waiting for a material choice

Automatic continuation stops only when:

- the next product has materially different valid offers;
- a requested pack size is unavailable;
- a provider login, address, or constraint needs attention;
- the user paused the task;
- a mutation is ambiguous;
- policy requires a user decision;
- the task reaches checkout review or final confirmation.

### 4.7 Final cart summary

After the final item is verified, JaldiAI automatically performs one read-only
cart inspection and shows:

```text
Your cart is ready

✓ Potato ×1                                  ₹27
✓ Amul Fresh Malai Paneer, 200 g ×1         ₹105
✓ Abis Pro Chicken Curry Cut, 500 g ×1      ₹129
✓ Anand Boiled Rice, 10 kg ×1               ₹619

Subtotal                                    ₹880

[Review cart]  [Keep shopping]  [Stop here]
```

If checkout is available, it may additionally show:

```text
[Review checkout]
```

It must not show `Place order` at this stage. Checkout review and final order
confirmation remain separate interactions.

Suggested speech:

> “All four items are in your cart. The subtotal is ₹880. Would you like to
> keep shopping, review checkout, or stop here?”

## 5. Information architecture

### 5.1 Companion

The 52–64 dp companion is always the re-entry point.

States:

| State | Visual | Label/accessibility |
| --- | --- | --- |
| Idle | calm face | `JaldiAI, ready` |
| Listening | audio-reactive mouth/ring | `Listening while you hold` |
| Understanding | short thinking motion | `Understanding your request` |
| Operating | directional activity | exact current phase |
| Waiting | attention pulse | exact question |
| Success | one brief success motion | exact verified result |
| Ambiguous | neutral warning, not red failure | `Checking what happened` |
| Paused | pause mark | `Task paused` |
| Disconnected | small offline badge | exact missing connection |

Color may support these states but cannot be the only distinction.

### 5.2 Progress capsule

Use for a single routine phase:

```text
Adding chicken · 2 of 4
Checking the cart…
```

Properties:

- remains non-modal;
- remains visible during speech;
- can expand into the full task card;
- does not cover the active Blinkit control;
- shows safe pause/cancel only when available;
- survives overlay service recreation.

### 5.3 Persistent task card

The task card is the canonical user-facing projection of `PhoneTaskV2`.

It shows:

- goal summary;
- completed and total item count;
- every item in original order;
- selected product identity when known;
- pack size and quantity;
- current state for the active item;
- one concise issue for a blocked item;
- remaining safe actions.

Item row states:

```ts
type TaskItemVisualState =
  | 'pending'
  | 'searching'
  | 'waiting_for_choice'
  | 'selected'
  | 'adding'
  | 'verifying'
  | 'verified'
  | 'paused'
  | 'skipped'
  | 'blocked'
  | 'ambiguous';
```

Do not expose internal `planned`, `ready`, revision numbers, operation IDs, or
provider fingerprints in the normal interface.

### 5.4 Product-choice card

Each option should include, when available:

- product image;
- full title;
- concise spoken label;
- pack size;
- price;
- unit price;
- relevant availability constraint;
- `Suggested`, `Lowest price`, or another deterministic label;
- large tap target;
- TalkBack description.

The server must provide recommendation reasons as structured fields. Android
must not infer `best`, `popular`, or `lowest price` from display order.

### 5.5 Recovery card

Use for mutation ambiguity:

```text
Checking the cart

The add action finished, but I’m confirming whether
Potato was added. I won’t add it again until this is verified.

[Check cart again]  [Stop task]
```

Rules:

- no red failure state until `verified_not_applied`;
- no `Retry add` while outcome is ambiguous;
- show the exact item being reconciled;
- show that remaining items are paused;
- automatically resolve if fresh evidence arrives;
- explain whether the task will resume or stop.

### 5.6 Connection indicator

Expose a small diagnostic surface:

```text
JaldiAI connected
Phone connected
Blinkit ready
```

On failure:

```text
Phone connection lost
Your task is paused. No new cart action will run.

[Reconnect]
```

Differentiate:

- Jaldi server unreachable;
- phone transport unavailable;
- Appium unavailable;
- phone locked;
- Blinkit login required;
- provider screen unavailable;
- speech provider unavailable.

Do not show a generic `timeout` when a more precise state is known.

## 6. Automatic continuation

### 6.1 Required behavior

When a background operation reaches a verified terminal state:

1. Commit the current step as `verified`.
2. Publish exactly one `mutation_verified` event.
3. Publish or project the exact item name, pack, quantity, and price if known.
4. Compute the next eligible step from authoritative task state.
5. If a next step is `ready`, enqueue its non-mutating search/observation phase.
6. Publish `step_started` for the next item.
7. Update the task card and optionally speak:
   `<item> added. Now looking for <next item>.`
8. Stop automatic progression when a choice, policy decision, block, or
   ambiguity occurs.
9. When no steps remain, perform the final read-only cart inspection and
   publish `task_completed`.

The continuation trigger belongs to the durable workflow/application layer,
not Android and not conversational prose.

### 6.2 Required safeguards

- Continuation uses the committed task revision.
- Only one dispatcher may claim a ready step.
- A duplicate terminal event cannot schedule the next step twice.
- A restarted server resumes from durable task truth.
- Android polling cannot cause execution.
- A late voice turn cannot re-run a verified step.
- Ambiguous, blocked, failed, cancelled, and paused tasks do not auto-advance.
- Checkout and final-dispatch steps remain governed by their policy boundaries.

### 6.3 Search versus mutation

The background adapter currently requires an exact `offerId` for
`add_cart_item`. The UI should represent the earlier work as a search step,
not as a failed or fallback add.

Recommended split:

```text
search_products(request)
  → exact match available
      → create selected offer
      → enqueue add_cart_item
  → multiple material matches
      → open product_choice
  → no match
      → show refine/skip choices
```

The server log should not describe a normal broad search as
`background_phone_enqueue_fallback`.

## 7. Truthful progress model

### 7.1 Event contract

Extend or project retained task events into a UI-stable contract:

```ts
type CompanionTaskEventV2 = {
  version: 2;
  eventId: string;
  sequence: number;
  taskId: string;
  taskRevision: number;
  operationId?: string;
  stepId?: string;
  occurredAt: number;
  kind:
    | 'task_accepted'
    | 'step_started'
    | 'search_started'
    | 'choice_required'
    | 'choice_accepted'
    | 'mutation_started'
    | 'verification_started'
    | 'mutation_verified'
    | 'reconciliation_started'
    | 'reconciliation_resolved'
    | 'step_skipped'
    | 'task_paused'
    | 'task_resumed'
    | 'task_blocked'
    | 'task_completed'
    | 'task_cancelled';
  item?: {
    title: string;
    requestedLabel: string;
    packSize?: string;
    quantity?: number;
    price?: string;
    index: number;
    total: number;
  };
  progress?: {
    completed: number;
    total: number;
    nextLabel?: string;
  };
  announcement: {
    channel: 'visual_only' | 'speech_and_visual';
    text: string;
  };
  actions?: CompanionActionV2[];
};
```

### 7.2 Ordering and replay

- Sequences are monotonic per task.
- Android persists the last applied sequence before speech.
- Duplicate events are ignored.
- Gaps trigger a retained snapshot refresh.
- A terminal event cannot be followed by a non-terminal event for the same
  revision.
- Service recreation restores the card without replaying old speech.
- A task snapshot is sufficient to reconstruct the current card even when old
  events have expired.

### 7.3 Speech policy

Speak only meaningful boundaries:

- task accepted;
- a user choice is required;
- an item was verified;
- reconciliation needs attention;
- the task completed;
- checkout review is ready;
- final order truth is known.

Do not speak:

- polling heartbeats;
- internal retries;
- every device session;
- intermediate provider selectors;
- duplicate terminal events.

## 8. Error and recovery presentation

### 8.1 Error taxonomy

| Authoritative state | User-facing treatment | Queue behavior |
| --- | --- | --- |
| Search found no match | refine/skip card | pause current item |
| Choice expired | refresh choices | pause current item |
| Device locked | unlock-phone card | pause task |
| Phone disconnected | reconnect card | pause task |
| Mutation verified applied | success | auto-advance |
| Mutation verified not applied | safe failure with retry choices | pause |
| Mutation ambiguous | reconciliation card | stop queue |
| Provider login required | attention card | pause task |
| Task cancelled | neutral terminal card | stop |
| Final dispatch ambiguous | persistent high-attention card | never replay |

### 8.2 Product alias reconciliation

The potato run demonstrated that provider search titles and cart titles may
differ:

```text
Selected: Potato (Alugadde)
Observed: Potato
```

UI and recovery must use a provider-aware normalized identity:

- exact `offerId` when observable;
- stable product ID when available;
- normalized brand/product tokens;
- parenthetical regional aliases treated as optional;
- pack size;
- quantity;
- price as supporting evidence, not sole identity.

The UI may display the concise cart label after verification while retaining
the exact selected offer in task details:

```text
✓ Potato — 1 kg
```

It must not expose a false `not added` result simply because the provider
shortened the label.

### 8.3 Slow operation behavior

Suggested thresholds:

| Elapsed | UI behavior |
| ---: | --- |
| 0–3 s | normal phase label |
| 3–10 s | indeterminate progress |
| 10–30 s | `Blinkit is taking longer than usual` |
| 30–90 s | persistent background status and safe pause-after-item |
| operation deadline reached | exact recovery/ambiguity state |

Elapsed time is informative, not transactional evidence.

## 9. Task editing

The persistent task card should support:

- change quantity for a future item;
- refine a future item;
- remove a future item;
- add another future item;
- skip the current search result;
- reorder future items when safe;
- pause after the current mutation;
- resume a paused task;
- cancel the entire task.

Rules:

- Verified steps are immutable task history.
- Editing a verified cart item creates a new explicit cart mutation step.
- A running mutation is never silently cancelled.
- Edits use the latest task revision.
- A stale edit is rejected and refreshed.
- Removing a future item cannot remove an already verified cart line.

## 10. Default product selection

Some users will want fewer interruptions. Add an optional task-level
preference:

```text
[Use suggested choices for remaining items]
```

Possible deterministic policies:

- `ask_every_time`;
- `lowest_price_matching_pack`;
- `known_brand_then_lowest_price`;
- `repeat_previous_preference`;
- `suggested_with_price_limit`.

Requirements:

- default is `ask_every_time`;
- policy is visible while active;
- materially different product forms still pause;
- a price ceiling can force a pause;
- meat cuts, dietary variants, medicine, age-restricted goods, and other
  sensitive categories must not be silently substituted;
- the model may recommend, but local policy determines whether automatic
  selection is allowed.

## 11. Language and copy

### 11.1 Language behavior

- Sarvam remains the speech provider.
- Preserve the user's language across task events.
- Product names may remain in their provider form.
- System status should not unexpectedly switch languages.
- Hinglish is acceptable when it matches the user's turn.
- Deterministic transactional facts are localized from structured data.

Example:

> “Amul Fresh Malai Paneer cart mein add ho gaya. Ab chicken dekh raha hoon.”

### 11.2 Copy rules

Prefer:

```text
Chicken added. Now looking for rice.
```

Avoid:

```text
Your request has been processed successfully.
```

Prefer:

```text
The cart may have changed. I’m checking it and won’t add potato again yet.
```

Avoid:

```text
Cart update failed. Retry.
```

Prefer:

```text
Phone connection lost. Your task is paused.
```

Avoid:

```text
Timeout.
```

## 12. Spatial attention and overlay layout

### 12.1 Attention cue rules

Only point to the provider screen when:

- Blinkit is foregrounded;
- the relevant screen was observed after the operation;
- the semantic subject is present;
- the cue geometry is fresh;
- the cue does not cover the relevant control.

Subjects:

- product options;
- selected product;
- updated cart line;
- cart subtotal;
- checkout summary;
- payment choice;
- address choice;
- order confirmation.

Hide the cue when the overlay card itself contains the complete required
choice.

### 12.2 Layout modes

| Mode | Suggested size | Use |
| --- | --- | --- |
| Companion | 52–64 dp | idle/listening entry |
| Capsule | approximately 292 dp wide | routine progress |
| Task card | up to 336 dp wide | multi-item checklist |
| Choice card | up to 336 dp wide, scrollable | product decision |
| Recovery card | up to 336 dp wide | ambiguity/attention |
| Cart card | up to 336 dp wide, expandable | final summary |

The card should:

- respect display cutouts and system bars;
- avoid keyboard overlap;
- remain draggable from a dedicated handle;
- not steal provider touches outside its bounds;
- remain visible while TTS plays;
- restore position after service recreation;
- collapse only when no response is required.

## 13. Accessibility and feedback

### 13.1 Accessibility

- Minimum 48 dp tap targets.
- TalkBack option labels include name, size, price, recommendation, and
  selection state.
- Dynamic text scaling without clipped prices or buttons.
- High-contrast text and focus indicators.
- State changes are not represented by color alone.
- Reduced-motion mode.
- Logical focus order.
- Live regions announce only meaningful changes.
- The persistent task card can be reopened without speech.

### 13.2 Haptics and sound

- One light haptic when listening starts.
- One acknowledgement haptic when a tap wins an interaction.
- One short success cue for verified item completion.
- One attention cue when a choice is required.
- No repeated vibration during polling or long operations.
- Push-to-talk immediately stops local TTS without cancelling phone work.

## 14. Observability and product metrics

Record structured, privacy-safe metrics:

- time to initial acknowledgement;
- time to first search result;
- time waiting for user choice;
- tap-to-accepted latency;
- accepted-to-mutation-start latency;
- mutation duration;
- verification duration;
- item-to-next-item transition latency;
- task completion latency;
- number of repeated searches for the same step;
- number of user `continue` utterances;
- false failure corrected by reconciliation;
- stale or duplicate card interactions;
- task abandonment by phase;
- automatic-selection usage and correction rate;
- connection interruptions;
- final summary engagement.

P0 target metrics:

- verified item to next search start: under 1 second at the workflow layer;
- valid card tap acknowledgement: under 250 ms locally;
- no repeated search after an exact accepted offer;
- no user `continue` turn for an ordinary multi-item queue;
- no false failure presentation for an ambiguous mutation;
- exactly one audible item-completion announcement per verified mutation.

## 15. Tool and task latency improvement

### 15.1 Physical-run baseline and target budget

The 2026-07-28 physical-Pixel evidence shows that queue/state persistence is
not the latency bottleneck. Most elapsed time is inside repeated Android
automation, navigation, and verification.

| Stage | Observed duration | Target duration | Priority |
| --- | ---: | ---: | --- |
| Sarvam speech-to-text | 0.6–0.9 s | 0.5–0.9 s | Maintain |
| Initial LLM planning | 3–13 s | 2–5 s | P0 |
| Deterministic continuation or card choice | 3–8 s when routed through the model | No model call; under 250 ms acknowledgement | P0 |
| Blinkit product search | 13–14 s | 4–8 s | P0 |
| Selected-product add and verification | 63–85 s | 10–25 s | P0 |
| Sarvam synthesis | 2–5 s | Non-blocking; under 1 s perceived | P1 |
| Queue/state ownership transition | 0.13–0.16 s | Under 250 ms | Maintain |

These targets are budgets rather than guarantees about third-party provider
latency. If Blinkit or Android is slower, JaldiAI must still acknowledge the
operation immediately and show the exact retained phase.

### 15.2 Separate perceived latency from execution latency

The voice request must not remain open until the physical phone operation
finishes. The intended boundary is:

```text
speech recognized
  → authoritative operation is accepted
  → HTTP response and operation cursor return immediately
  → Android shows “Adding Amul milk…”
  → the durable worker operates the phone
  → retained progress events update the card
  → verified completion announces the exact item
  → the next eligible queue item starts automatically
```

Target budgets:

- transcript-to-operation acknowledgement: under 1 second after planning;
- local card-tap acknowledgement: under 250 ms;
- accepted operation to first retained phase event: under 500 ms;
- verified item to next-item search start: under 1 second;
- progress heartbeat after 10 seconds without a phase change;
- no generic client timeout while a durable operation is still running.

### 15.3 Persistent Android automation session

Maintain one health-checked Appium session for the connected Pixel rather than
opening or recovering several sessions during one item operation.

- Reuse the session across search, selection, mutation, and local verification.
- Run a cheap health check before reuse.
- Recreate the session only after a failed health check or transport error.
- Serialize physical UI mutations for one device.
- Record `session_reused`, `session_recreated`, and session creation duration.

Physical phone navigation must not be parallelized. Read-only preparation,
speech synthesis, and server-side planning may run concurrently only when they
cannot race with authoritative phone state.

### 15.4 Replace fixed sleeps with condition-based waits

The Android driver previously accumulated fixed waits while entering search,
finding controls, changing quantity, and checking the result. The current
driver uses bounded semantic polling for those paths and contains no direct
`await this.wait(...)` call. Preserve the following implementation rules:

1. Capture one hierarchy snapshot per polling cycle.
2. Check the expected semantic condition from that snapshot.
3. Return immediately when the condition is satisfied.
4. Begin with a short polling interval and back off gradually.
5. Preserve an overall phase deadline and a precise timeout reason.

Do not shorten timeouts blindly. Remove redundant waiting and observation while
preserving a sufficiently large deadline for legitimately slow provider UI.

### 15.5 Exact-offer fast path

After a product card or spoken choice resolves an interaction, persist the
exact executable selection:

- provider offer/product ID;
- normalized title and known provider aliases;
- pack size;
- quantity;
- price;
- stable semantic locator or screen-card identity when safe;
- task, item, clarification, operation, and step identity.

The add operation must consume this selection directly from the current screen.
It must not ask the model to reinterpret the choice, perform another broad
search, or request another ordinary confirmation.

Transient Android element handles must not be persisted across sessions. If
the current screen has changed, recover through the stable offer identity and
authoritative task state.

### 15.6 Local-first verification

Preserve mutation safety while avoiding repeated full-cart navigation:

```text
tap Add
  → observe the selected card quantity or cart badge
  → if the expected delta is conclusive, commit verified success
  → otherwise perform one fresh read-only cart inspection
  → if still inconclusive, enter reconciliation and stop the queue
```

Verification identity should combine:

- exact offer or product ID when available;
- normalized title and known aliases;
- pack size;
- expected price;
- requested quantity;
- observed quantity delta.

Strict title equality alone is insufficient. For example,
`Potato (Alugadde)` and `Potato` may represent the same verified line when the
remaining identity evidence agrees.

There must be at most one normal cart inspection after a mutation. A later
inspection belongs to an explicit reconciliation operation, never an
automatic replay of the mutation.

### 15.7 Remove the model from mechanical transitions

The LLM retains freedom for initial intent understanding, genuine ambiguity,
unexpected screen interpretation, and bounded replanning. It is not required
for transitions whose next state is already determined by authoritative task
truth:

- card tap or exact spoken option;
- “yes, add this” after an open product choice;
- advancing after verified completion;
- choosing the next ready queue item;
- emitting deterministic progress copy;
- producing the final verified cart summary.

This removes 3–8 seconds from ordinary follow-ups and prevents the model from
restarting a resolved search or losing the remaining queue.

Initial planning must use a strict structured schema. Trivially recoverable
omissions, such as a product `request` derivable from the item label, should be
repaired and validated locally rather than triggering a second model request.
A genuinely invalid or unsafe plan may use one bounded replan.

### 15.8 Make synthesis non-blocking

Text and structured presentation state should reach Android before synthesized
audio completes.

- Cache common localized phrases such as `Searching for milk`, `Milk added`,
  and `I need your choice`.
- Keep progress speech short and use structured card content for details.
- Synthesize the next safe phrase concurrently with non-mutating preparation.
- Cancel obsolete playback when a newer authoritative phase supersedes it.
- Never let synthesis delay operation acknowledgement or task-state commit.

### 15.9 Reduce event transport and server overhead

- Replace one-second event polling with long polling, server-sent events, or a
  socket transport with cursor-based replay.
- Stop subscriptions for terminal or superseded tasks.
- Use bounded backoff while disconnected.
- Do not let an old task continue polling with an initial cursor.
- For demos and release evidence, use a production build/server instead of
  the Next development server so compilation and HMR do not add variance.
- Reuse HTTP connections to Sarvam, OpenAI, Appium, and local server routes
  where supported.

### 15.10 Latency safety constraints

Latency work must not:

- remove authoritative post-mutation verification;
- run two physical UI mutations concurrently on one phone;
- retry an ambiguous mutation blindly;
- reuse a stale card interaction, task revision, operation, or Android element;
- mark an item complete from optimistic UI alone when identity is uncertain;
- allow TTS or presentation state to become transaction truth;
- bypass checkout review, payment selection, final confirmation, or
  final-dispatch idempotency.

The optimization principle is:

> Verify once, close to the action, and reconcile explicitly only when that
> evidence is inconclusive.

## 16. Implementation backlog

Checklist meaning:

- `[x]` means the implementation exists and has current offline
  contract/unit/integration/build evidence. It does **not** claim that a
  physical Pixel acceptance scenario has passed.
- `[~]` means a bounded part is implemented, but another named layer or
  production lifecycle boundary is still missing. The unchecked work is
  stated directly under the task.
- `[ ]` means required implementation or physical-device evidence has not yet
  been completed.

This distinction closes the earlier roadmap conflict without turning a
server-only route or display-only Android row into a completed interaction.
Retained-event and Android foundations are implemented, while the partial
items below and the five explicit physical tasks remain open.

### 16.1 Current evidence snapshot

The following gates were rerun against the current shared tree on 2026-07-28:

- focused voice UX suite: 9 files, 144/144 tests passed, covering the issue
  taxonomy, UX timing collector, diagnostics, authoritative queue edits,
  product-choice policy and corrections, UX062, and the selected-offer
  mutation baseline;
- focused provider wait/driver suite: 3 files, 123/123 tests passed;
- 26 Android JVM/fixture/source-contract test programs and the signed APK
  build passed;
- current APK:
  `ce2ddaaa169998cfd8db75b561a19f5af7a3b98d8bf825410e409d21ac53c6f7`,
  111,019 bytes.

No newer full-workspace aggregate is claimed here because other integration
slices were still changing the shared tree. Historical full-suite totals have
therefore been removed rather than presented as current evidence.

The current APK was built successfully, but installation on the Pixel was not
completed because the Codex desktop approval execution allowance had been
exhausted. That is an environment/approval blocker, not an APK or application
failure. No unlock, voice turn, cart mutation, checkout, or order action was
performed as part of this documentation audit.

### 16.2 H050–H054 evidence reconciliation

The H5 roadmap checkmarks record implemented foundations, not physical
end-user acceptance:

| Foundation | What its existing checkmark proves | Physical evidence still required |
| --- | --- | --- |
| H050 retained task event stream | Ordered bounded events, cursor replay, and offline reconnect/reset tests | UX063 and UX064 |
| H051 operation identity/background handoff | Durable operation acceptance and offline restart/idempotency tests | UX080 acknowledgement and latency canary |
| H052 Android subscription | Parser/reducer persistence, stale/gap rejection, and offline recreation tests | UX064 screen, lock, rotation, and service-recreation matrix |
| H053 item-completion announcements | Authoritative completion event/copy and no-replay tests | UX063 audible four-item flow |
| H054 interactive completion choices | Shared voice/card interaction contract and one-shot ownership tests | UX054 accessibility and UX063 physical voice/card choice |

Consequently, H050–H054 may remain checked as foundation work, but they must
not be cited as proof that automatic continuation, accessibility, or the
physical four-item experience has passed. Those claims close only when their
explicit UX tasks below are completed.

### Phase UX0 — Capture truth and contracts

- [x] **UX000 — Add the four-item Pixel regression fixture**
  - Preserve the potato, paneer, chicken, and 10 kg rice task.
  - Include exact choice, background completion, recovery, and final cart
    evidence.
  - Assert that no checkout or order action occurs.

- [x] **UX001 — Define the companion task projection**
  - Add versioned task, item, progress, and action fields.
  - Validate at the server and Android boundaries.
  - Define upgrade and unsupported-version fallback.

- [x] **UX002 — Define the user-facing error taxonomy**
  - Map search, connection, device, mutation, reconciliation, checkout, and
    final-dispatch states to stable UI treatments.
  - Remove generic timeout/failure text when a precise state is available.
  - Evidence: the closed server taxonomy and safe recovery-action policy live
    in `lib/progress/v2/companion-issue.ts`; Android validates the same codes in
    `CompanionIssueV2.java`, parses them through
    `RetainedTaskEventParser.java`, and renders precise issue copy through
    `OverlayCardView.java`.

- [x] **UX003 — Add UX timing instrumentation**
  - Measure acknowledgement, choice, mutation, verification, continuation, and
    completion phases using task and operation correlation.
  - Implemented: the bounded privacy-safe collector records correlated p50/p95
    summaries; interaction, background-operation, and retained-event routes
    emit choice acknowledgement, worker start, mutation start, mutation,
    verification, continuation, and event-delivery timings.
  - Android independently records tap/voice local acknowledgement and server
    outcome through `InteractionLatencyTracker`.
  - Production emitters now cover `initial_acknowledgement`,
    accepted-to-first-event, choice wait/acknowledgement, background worker,
    mutation, verification, continuation, event delivery, and
    `task_completion`.
  - Physical p50/p95 evidence remains tracked separately by UX080.

### Phase UX1 — Automatic continuation

- [x] **UX010 — Add a durable next-step dispatcher**
  - Claim the next eligible `ready` step after a verified terminal mutation.
  - Run independently of Android polling and conversational prose.

- [x] **UX011 — Make continuation idempotent**
  - Duplicate completion events, restart recovery, and late responses cannot
    enqueue the same step twice.

- [x] **UX012 — Separate search work from exact mutation work**
  - Do not route broad product requests through an exact-offer background-add
    contract.
  - Model search as visible progress rather than fallback failure.

- [x] **UX013 — Stop continuation at interaction boundaries**
  - Pause on product choice, policy decision, connection block, ambiguity,
    checkout review, or cancellation.

- [x] **UX014 — Complete the task automatically**
  - After the final verified step, run one read-only cart inspection.
  - Commit `task_completed` and publish the final summary.

- [x] **UX015 — Remove the ordinary `continue` requirement**
  - Add an acceptance test proving a multi-item list moves from one verified
    item to the next without a new voice turn.

### Phase UX2 — Truthful retained progress

- [x] **UX020 — Emit semantic search/mutation/verification events**
  - Replace generic progress with the exact phase and item identity.

- [x] **UX021 — Include structured item details**
  - Title, requested label, pack size, quantity, price, index, and total.

- [x] **UX022 — Publish one exact completion announcement**
  - `<item> added to cart. Now looking for <next item>.`
  - The last item instead transitions to final summary.

- [x] **UX023 — Add long-operation heartbeat projection**
  - Visual-only elapsed state without event spam or false timeout.

- [x] **UX024 — Persist and restore task snapshots**
  - Android service recreation restores the current task card without
    replaying old TTS.

- [x] **UX025 — Add task-event ordering tests**
  - Duplicate, gap, stale revision, post-terminal, and restart cases.

### Phase UX3 — Android task and choice surfaces

- [x] **UX030 — Render the persistent task checklist**
  - Original order, verified count, active phase, future items, and controls.

- [x] **UX031 — Render explicit companion/capsule states**
  - Listening, understanding, searching, adding, verifying, waiting, success,
    ambiguous, paused, disconnected.

- [x] **UX032 — Upgrade product-choice rows**
  - Image, title, size, price, unit price, deterministic recommendation, and
    TalkBack label.

- [x] **UX033 — Add immediate tap acknowledgement**
  - Highlight, disable, persist, and show selected-to-adding transition.

- [x] **UX034 — Unify voice and tap selection rendering**
  - Both inputs resolve the same interaction and produce the same selected
    state.

- [x] **UX035 — Add the final cart summary card**
  - Verified lines, quantities, prices, subtotal, and safe next actions.

- [x] **UX036 — Add queue editing controls**
  - Refine, remove, skip, reorder future items, pause, resume, and cancel.
  - Implemented server seam: `workflow/v2/queue-editing.ts` and
    `/api/device/task/queue` apply revision-checked, idempotent edits and
    preserve active-mutation/history boundaries. Focused route tests cover
    refine, remove, skip, reorder, pause, resume, cancel, stale revisions, and
    concurrent winners.
  - Android now restores the authoritative queue projection and binds
    refine/remove/skip/reorder/pause/resume/cancel controls through
    `QueueCommandState`, `QueueActionPolicy`, and the task-card service flow.
    Paused tasks reject ordinary interaction until explicitly resumed.

### Phase UX4 — Recovery and connectivity

- [x] **UX040 — Fix provider-aware product identity reconciliation**
  - Cover `Potato (Alugadde)` versus `Potato`.
  - Use IDs, normalized aliases, pack, quantity, and supporting price evidence.

- [x] **UX041 — Render ambiguity as reconciliation**
  - Never present ambiguous mutation as definite failure.
  - Stop the queue and explain duplicate prevention.

- [x] **UX042 — Add safe read-only recovery actions**
  - Check cart again, reconnect, unlock phone, refresh choices, or stop task.
  - Do not expose blind retry while mutation truth is uncertain.
  - The server persists a revision-bound `recovery_handoff`, publishes the
    repository-derived `recoveryInteraction`, and accepts only check-cart,
    reconnect diagnostics, unlock guidance, refresh-search, or stop.
  - Android validates that exact binding and submits through
    `RecoveryActionState`/`RecoveryActionResponse`; ambiguity never exposes a
    blind mutation retry.

- [x] **UX043 — Add connection diagnostics**
  - Distinguish server, phone, Appium, lock state, Blinkit, and provider issues.
  - Evidence: `/api/device/diagnostics` runs bounded independent probes for the
    Jaldi server, ADB transport/authorization, Appium, lock state, Blinkit
    foreground/auth/screen state, and Sarvam; results project stable
    `CompanionIssueV2` codes without raw provider errors. Android renders those
    exact issue codes rather than a generic timeout.

- [x] **UX044 — Resume safely after reconnection**
  - Restore the task card, reconcile active work, and continue only from
    authoritative state.

### Phase UX5 — Language, attention, and accessibility

- [x] **UX050 — Localize deterministic progress copy**
  - English, Hindi, and Hinglish fixtures with provider product names intact.

- [x] **UX051 — Implement meaningful speech boundaries**
  - No polling or low-level device narration.

- [ ] **UX052 — Verify spatial attention geometry**
  - Fresh semantic subject, no occlusion, rotation/inset handling, hidden at
    rest.

- [x] **UX053 — Add adaptive overlay sizing**
  - Companion, capsule, task, choice, recovery, and cart layouts.

- [ ] **UX054 — Complete accessibility verification**
  - TalkBack, font scale, contrast, focus, reduced motion, and large tap
    targets.

- [x] **UX055 — Add haptic and audio feedback policy**
  - Listening, accepted selection, verified completion, and attention only.

### Phase UX6 — Defaults, rollout, and proof

- [~] **UX060 — Add optional default-choice policy**
  - Visible, bounded, category-aware, and reversible.
  - Implemented server seam: the task-scoped policy endpoint and deterministic
    evaluator support `ask_every_time`, exact-pack lowest price, known brand,
    previous preference, and one suggested choice under a price ceiling. The
    policy fails closed for sensitive/materially different or incomplete
    metadata and persists the exact selected offer before continuation.
  - Remaining Android seam: there is no visible control to enable, inspect, or
    clear the policy. Automatic selection is therefore conditional on trusted
    category/form/pack/price metadata supplied to the server, and unavailable
    metadata falls back to asking.

- [x] **UX061 — Add correction and preference tests**
  - User changes suggested product, price limit, pack size, or future item.
  - Evidence: policy tests cover corrected offers, changed pack size, changed
    price ceiling, exact-form previous preferences, malformed/PII-shaped
    inputs, and persistence of the corrected exact offer without re-search.

- [x] **UX062 — Run the automated multi-item UI matrix**
  - Exact match, multiple choices, voice choice, card choice, duplicate tap,
    slow mutation, ambiguity, disconnect, restart, skip, edit, and completion.
  - Evidence: `scripts/verification/ux062-multi-item-ui-matrix.test.ts`
    contains 12 named acceptance cases for every listed branch, including a
    strict verified-cart completion that cannot continue to checkout. It
    passed 12/12 in the current matrix and remains covered by the full
    1,050-test voice gate.

- [ ] **UX063 — Run a physical-Pixel four-item canary**
  - One spoken list.
  - At least one voice choice and one card choice.
  - No `continue` utterance.
  - Exact item announcements.
  - Final cart summary.
  - Stop before checkout.

- [ ] **UX064 — Run the screen and accessibility matrix**
  - Lock/unlock, rotation, overlay drag, TalkBack, font scale, and TTS
    persistence.

- [x] **UX065 — Close the roadmap evidence conflict**
  - Update H050–H054 evidence to distinguish retained-event foundations from
    proven automatic continuation and end-user UI completion.

### Phase UX7 — Latency and execution efficiency

- [x] **UX070 — Add per-substage latency instrumentation**
  - Measure session acquisition, screen recognition, search entry, candidate
    extraction, add-control discovery, mutation, local verification, cart
    inspection, reconciliation, model planning, synthesis, and event delivery.
  - Correlate every measurement by task, item, step, and operation.

- [x] **UX071 — Reuse a health-checked Appium session**
  - Maintain one session per connected physical device.
  - Add recovery, serialization, expiry, and transport-loss tests.

- [x] **UX072 — Replace fixed driver sleeps**
  - Introduce adaptive semantic condition waits with one hierarchy snapshot per
    cycle and precise phase deadlines.
  - Evidence: the Blinkit driver contains no direct `await this.wait(...)`;
    adaptive-wait, screen-recovery, and Android-driver tests passed 123/123 and
    cover immediate semantic success, bounded stalled transitions, delayed
    cart/search fields, checkout, quantity, COD, and navigation paths.

- [x] **UX073 — Implement the exact-offer add fast path**
  - Carry the accepted offer directly into mutation without another model turn
    or broad product search.
  - Reject stale task revision, choice, or screen identity.
  - Evidence: the selected-offer baseline composition restores the accepted
    visible offer and mutates that exact offer once; it never substitutes a
    second broad discovery pass.

- [x] **UX074 — Implement local-first mutation verification**
  - Verify the expected quantity delta on the current product card first.
  - Fall back to at most one ordinary cart inspection.
  - Route remaining uncertainty into explicit reconciliation without replay.
  - Evidence: `phone-tool-mutation-baseline.test.ts` proves the pre-mutation
    cart baseline/visible-offer restoration path and proves restoration failure
    exits before mutation. Driver tests retain one stale observation without a
    second inspection or mutation and route inconclusive results to
    reconciliation.

- [x] **UX075 — Make deterministic transitions model-free**
  - Handle exact choice resolution, next-item dispatch, item-completion copy,
    and final-summary transition from authoritative state.
  - Add an assertion that these transitions make no OpenAI request.

- [x] **UX076 — Eliminate avoidable planner replans**
  - Enforce strict structured output.
  - Locally repair safe derivable omissions.
  - Record the exact invalidity reason for every genuine replan.

- [x] **UX077 — Decouple and cache synthesis**
  - Return text and retained progress before audio is ready.
  - Cache deterministic English, Hindi, and Hinglish phrases.
  - Cancel obsolete playback safely.

- [x] **UX078 — Replace continuous event polling**
  - Add cursor-based long polling, SSE, or socket delivery.
  - Stop stale and terminal task subscriptions and verify reconnect replay.

- [x] **UX079 — Add production-mode demo profile**
  - Document and test the production build/start flow, provider keep-alive, and
    required environment validation.

- [ ] **UX080 — Run the physical-Pixel latency canary**
  - Capture p50/p95 timings for at least ten search and exact-add operations.
  - Prove acknowledgement remains responsive during a deliberately slow
    operation.
  - Prove no verification, idempotency, or checkout safety boundary regresses.

## 17. Recommended delivery sequence

### Slice A — Remove the broken interaction

UX000–UX015, UX040–UX042, and UX070.

Exit criteria:

- potato alias reconciliation no longer reports false failure;
- each verified item automatically starts the next search;
- no ordinary `continue` turn;
- ambiguity stops and explains the queue;
- every slow phase has correlated timing evidence.

### Slice B — Remove the largest latency sources

UX071–UX076.

Exit criteria:

- a healthy Appium session is reused across one item operation;
- an accepted exact offer is not searched or interpreted again;
- mutation verification uses the local UI before one optional cart read;
- deterministic continuation produces no model request;
- no safe derivable planner omission causes a second model call.

### Slice C — Make progress legible

UX020–UX025 and UX030–UX035.

Exit criteria:

- one persistent task card tells the complete story;
- choice taps acknowledge immediately;
- exact item completion appears before next-item work;
- final cart summary is automatic.

### Slice D — Make it resilient

UX036 and UX043–UX044.

Exit criteria:

- server-side future-work edits and Android queue controls are authoritative;
- connection and lock failures are precise and expose only revision-bound safe
  recovery actions;
- restart/reconnect restores task truth and UI.

### Slice E — Polish, transport, and release

UX050–UX065 and UX077–UX080.

Exit criteria:

- localized speech, attention, accessibility, defaults, non-blocking audio,
  efficient event delivery, metrics, automated tests, and physical-Pixel
  evidence are complete.

## 18. Acceptance scenarios

### Scenario A — Four broad items

```gherkin
Given the cart is empty
When the user asks for potato, paneer, chicken, and rice 10 kg
Then one four-item task card appears
And JaldiAI searches each item in order
And each exact choice is accepted once by voice or tap
And every verified item is announced by name
And the next item starts without the user saying continue
And the final card shows four lines and the verified subtotal
And no checkout or order action occurs
```

### Scenario B — Duplicate card tap

```gherkin
Given a product choice is open
When the same option is tapped twice
Then the first tap is accepted
And the second tap is acknowledged as a harmless duplicate
And exactly one add operation is enqueued
And the card remains on the selected product
```

### Scenario C — Voice and tap race

```gherkin
Given a product choice is open
When a voice answer and a card tap arrive concurrently
Then exactly one valid answer wins
And the losing answer cannot replace it
And the UI shows the authoritative winner
And exactly one mutation may execute
```

### Scenario D — Mutation applied but initial verification uncertain

```gherkin
Given an add action may have changed the cart
And initial verification is inconclusive
When the task enters reconciliation
Then the queue stops
And the UI says it is checking the cart
And it says the add will not be repeated yet
And a fresh read-only inspection is performed
And verified presence becomes success without another add
```

### Scenario E — Slow selected-product add

```gherkin
Given a selected add takes 85 seconds
When the durable operation remains running
Then the interface shows adding and verifying phases
And after ten seconds it explains that Blinkit is taking longer
And it does not show a generic timeout
And the final verified event produces exactly one success announcement
```

### Scenario F — Reconnection

```gherkin
Given a multi-item task is active
When the phone connection is lost
Then no new mutation starts
And the task card says the phone connection was lost
When the connection returns
Then JaldiAI reconciles active work
And restores the current task card
And resumes only from authoritative task state
```

### Scenario G — Task completion

```gherkin
Given every requested add step is verified
When the final step completes
Then JaldiAI performs one read-only cart inspection
And publishes task_completed
And shows exact lines, quantities, prices, and subtotal
And offers keep shopping, review cart, review checkout, or stop
And does not place an order
```

### Scenario H — Latency fast path

```gherkin
Given the phone, server, Appium session, and Blinkit are healthy
And an exact product choice is visible
When the user taps the choice or speaks its exact name
Then the selection is acknowledged locally within 250 milliseconds
And no additional LLM request or broad product search occurs
And the same healthy Appium session is reused
And the add is verified from the current product card when possible
And no more than one ordinary cart inspection occurs
And the HTTP request is not held open for the complete phone operation
And retained events continue updating the task card
And an inconclusive result enters reconciliation without repeating the add
```

Performance evidence for this scenario must report p50 and p95 rather than
only one best-case run. A missed duration target is a performance failure, but
it must not be “fixed” by weakening verification or transaction safety.

## 19. Definition of done

- [x] One spoken multi-item request remains one visible durable task.
- [x] The full original queue is always available from the companion.
- [x] Every item has an accurate user-facing phase.
- [x] Broad search is distinct from exact mutation.
- [x] A valid card tap acknowledges locally and cannot duplicate execution.
- [x] Voice and tap resolve one pending interaction.
- [x] Product selection does not cause a redundant confirmation.
- [x] A verified item automatically advances to the next ready step.
- [x] The user never needs to say `continue` for ordinary queue progression.
- [x] Exact completion speech names the verified product.
- [x] Long operations show truthful retained progress.
- [x] Ambiguous mutations never appear as definite failures.
- [x] Reconciliation cannot blindly repeat a mutation.
- [x] Provider aliases such as `Potato (Alugadde)` and `Potato` reconcile
      correctly when the remaining evidence matches.
- [x] The final cart summary appears automatically.
- [x] Cart summary values come from a fresh read-only provider observation.
- [x] Checkout and ordering remain separate, explicit safety boundaries.
- [~] Connection failures are precisely diagnosed and rendered; Android
      recovery-action rows are not yet executable.
- [x] Android restores progress after service recreation without replaying
      speech.
- [ ] Task cards, choices, recovery, and summary layouts pass TalkBack and
      large-font testing.
- [x] Exact voice/card choices do not trigger another broad search or model
      interpretation.
- [x] A healthy Appium session is reused through search, mutation, and
      verification for one item.
- [x] Normal mutation verification performs at most one full cart inspection.
- [x] Deterministic queue transitions make no OpenAI request.
- [x] Text acknowledgement and retained progress are not blocked by Sarvam
      synthesis.
- [x] Terminal and superseded Android task subscriptions stop polling.
- [ ] Physical-Pixel latency evidence records p50 and p95 for acknowledgement,
      search, mutation, verification, and item-to-next-item transition.
- [x] Latency improvements preserve idempotency, ambiguity handling, checkout
      review, and final-dispatch safety.
- [ ] A physical Pixel completes the four-item canary with no `continue`
      utterance and no false status.

## 20. Immediate next tasks

The remaining implementation seam and physical evidence should be completed in
this order:

1. UX060: add a visible Android policy control/status/clear path, and continue
   asking whenever trusted category/form/pack/price metadata is unavailable.
2. With explicit user authorization, install the current APK on
   `55221VDAQ000J1`; have the user unlock the secure keyguard. The prior install
   attempt was blocked by the Codex desktop approval usage limit, not by an APK
   or application failure.
3. UX052: verify attention geometry, insets, rotation behavior, and hidden-at-
   rest behavior on the current build.
4. UX054: run TalkBack, font scale, contrast, focus, reduced-motion, and tap-
   target checks.
5. UX063: run the four-item voice/card canary, stop before checkout, and prove
   automatic continuation plus final cart summary.
6. UX064: run lock/unlock, rotation, drag, service-recreation, reconnect, and
   TTS non-replay scenarios.
7. UX080: collect at least ten physical search/exact-add samples and report
    p50/p95 without weakening verification or mutation safety.

The first releasable checkpoint is not “the next step can be resumed.” It is:

> A user gives one list, makes required product choices, watches every item
> advance automatically, and receives a verified final cart summary without
> repeating the list or saying `continue`; every interaction acknowledges
> immediately even while the durable phone operation is still running.
