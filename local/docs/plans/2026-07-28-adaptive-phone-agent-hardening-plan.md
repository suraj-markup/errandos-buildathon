# JaldiAI adaptive phone-agent hardening implementation plan

> **Status:** In implementation — 45 of 50 tasks have production evidence.
> Isolated foundations remain unchecked until they are on the active path.
> The latest 2026-07-28 implementation checkpoint passes TypeScript, all 97
> voice test files (617 tests), the optimized Next.js build, and
> `git diff --check`.
>
> **Extends:**
>
> - [`../local-phone-agent-implementation-plan.md`](../local-phone-agent-implementation-plan.md)
> - [`2026-07-27-realtime-vision-phone-agent-master-plan.md`](2026-07-27-realtime-vision-phone-agent-master-plan.md)
> - [`2026-07-28-general-mobile-clicky-architecture-audit.md`](2026-07-28-general-mobile-clicky-architecture-audit.md)
>
> This plan preserves model intelligence. It does not replace the model with a
> grocery-specific script. The model owns intent, planning, dialogue, and
> replanning; durable local services own task truth, policy, execution,
> verification, and irreversible-action boundaries.

## 1. Problem statement

The current implementation can understand and execute a multi-item request,
but the supplied logs expose four architectural failures:

1. The initial higher-level goal is reduced to product tool calls. In “add
   milk and ice cream and order it,” the `order it` continuation is not retained
   as structured state.
2. The task becomes terminal immediately after the final product and is cleaned
   up. A later checkout utterance therefore has no structured task to continue.
3. The model can reconstruct old product mutations from prose history. On “Can
   you now place the COD for it?” it proposed two `add_cart_item` calls instead
   of checkout preparation.
4. Progress is returned mainly at the end of a long HTTP turn. The user does
   not promptly hear “milk added; moving to ice cream,” even when that fact is
   already verified.

The system also reports some uncertain mutations as failures even when the cart
changed. That encourages the user or model to retry an operation that may
already have succeeded.

These are not primarily model-quality problems. They are missing task,
context, policy, progress, and reconciliation boundaries.

## 2. Product outcome

For:

```text
Add Amul milk and Amul ice cream and order it.
```

the target interaction is:

```text
Understand the complete goal
→ create a durable task graph
→ search milk
→ wait for one exact voice or card choice
→ add and verify milk once
→ immediately announce “Milk added. Now searching for ice cream.”
→ search ice cream
→ wait for one exact voice or card choice
→ add and verify ice cream once
→ announce “Both requested items are in the cart.”
→ inspect the final cart once
→ prepare checkout because the original goal included ordering
→ show current payment method and available alternatives
→ if requested, select COD for review
→ show exact items, quantities, fees, total, address, ETA, and `NOT ORDERED`
→ require the fresh exact final confirmation
→ attempt final dispatch at most once
→ verify receipt or preserve an ambiguous result
```

For a request that does not include ordering:

```text
Add Amul milk and Amul ice cream.
```

the final interaction is:

```text
Both items are in your cart. Your current payment method is Mastercard.
Would you like to add something else, review checkout with Mastercard,
switch to COD, or stop here?
```

The exact wording may be produced by the model or a localized deterministic
template. The available next actions and transactional facts must come from
structured state.

## 3. Architecture: constrained agency, not a rigid script

```text
Sarvam STT
  ↓ transcript
Context assembler
  ↓ goal + task graph + recent dialogue + verified observations
LLM planner
  ↓ proposed plan patch, next action, or question
Policy and capability controller
  ↓ allow | confirm | block | replan
Serialized phone executor
  ↓ mutation boundary + observable result
Postcondition verifier / reconciler
  ↓ verified | failed | ambiguous | waiting
Task journal and state repository
  ↓ durable truth
Progress and presentation stream
  ↓ Android card + optional Sarvam speech
```

### 3.1 Model authority

The model may:

- infer the user's goal and constraints;
- create and revise a multi-step plan;
- ask clarifying questions;
- choose the next useful action;
- handle corrections, additions, skips, substitutions, and interruptions;
- interpret fresh screenshots and sanitized semantic candidates;
- explain progress and offer relevant next actions;
- replan when the observed screen differs from the expected screen.

### 3.2 Local authority

The local system must own:

- task and step identity;
- completed, pending, and uncertain work;
- accepted product selections;
- operation idempotency and mutation boundaries;
- verified provider facts;
- available tool capabilities for the current task revision;
- confirmation grants;
- final-dispatch at-most-once state;
- reconciliation and recovery.

The model proposes actions. It cannot manufacture `verified`, `ordered`,
fresh screen evidence, a confirmation grant, or permission to repeat a
mutation.

## 4. Required V2 state and context

### 4.1 Domain-neutral task graph

```ts
type PhoneTaskV2 = {
  version: 2;
  taskId: string;
  clientId: string;
  revision: number;
  originalGoal: string;
  goalKind: string;
  status:
    | 'active'
    | 'waiting_for_user'
    | 'waiting_for_phone'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | 'ambiguous';
  activeStepId?: string;
  steps: PhoneTaskStepV2[];
  desiredTerminalOutcome?: {
    kind: 'cart_ready' | 'checkout_reviewed' | 'order_placed' | string;
    paymentPreference?: 'cod' | 'provider_saved' | 'ask_user';
  };
  pendingInteraction?: PendingInteractionV2;
  verifiedFacts: VerifiedFactReferenceV2[];
  journal: TaskJournalEntryV2[];
  budgets: TaskBudgetsV2;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
};

type PhoneTaskStepV2 = {
  stepId: string;
  adapterId: string;
  kind: string;
  status:
    | 'planned'
    | 'ready'
    | 'running'
    | 'waiting_for_user'
    | 'verified'
    | 'skipped'
    | 'failed'
    | 'ambiguous'
    | 'blocked';
  dependsOn: string[];
  input: unknown;
  expectedPostcondition: unknown;
  operationId?: string;
  attempts: number;
  lastResultRef?: string;
};
```

Blinkit product, offer, cart, and checkout details belong in a Blinkit adapter
payload. The core state should not assume that every phone task is shopping.

### 4.2 Goal continuation

The task must retain the difference between:

```text
add products
add products, then ask what to do
add products, then review checkout
add products, then review COD checkout
add products, then place an order after final confirmation
```

Product completion is not necessarily task completion. The final verified
product should activate the next eligible graph step.

### 4.3 Pending interaction

```ts
type PendingInteractionV2 = {
  interactionId: string;
  taskId: string;
  taskRevision: number;
  kind:
    | 'product_choice'
    | 'next_action'
    | 'payment_choice'
    | 'checkout_confirmation'
    | 'recovery_handoff';
  allowedResponses: unknown;
  presentationRef: string;
  status: 'open' | 'resolving' | 'resolved' | 'expired' | 'cancelled';
  createdAt: number;
  expiresAt: number;
};
```

Voice and card answers resolve the same interaction. First valid answer wins.
An unrelated user request is passed to the planner as a possible plan revision,
not forced into a product-selection parser.

### 4.4 Verified facts

Conversation text is not transaction memory. Store bounded references to:

- selected offer and quantity;
- before/after cart fingerprints;
- verified cart lines;
- current payment method;
- checkout proposal and expiry;
- final provider reference;
- an explicit uncertainty or reconciliation requirement.

Facts have an origin operation, observation time, freshness policy, and
provider fingerprint.

### 4.5 Context packet sent to the model

Each model turn receives a bounded, structured packet:

```ts
type PlannerContextV2 = {
  originalGoal: string;
  taskSummary: {
    completedSteps: StepSummary[];
    activeStep?: StepSummary;
    pendingSteps: StepSummary[];
    desiredTerminalOutcome?: string;
  };
  pendingInteraction?: PendingInteractionSummary;
  verifiedFacts: VerifiedFactSummary[];
  latestObservation?: SanitizedObservationSummary;
  recentDialogue: BoundedDialogueTurn[];
  availableCapabilities: CapabilityDescriptor[];
  prohibitedActions: PolicyReason[];
  lastFailure?: StructuredFailure;
};
```

Do not send the complete task journal, raw screenshot, UI XML, selector,
coordinates, secrets, or unbounded response chain.

## 5. Planner protocol

The model returns one of four structured decisions:

```ts
type PlannerDecisionV2 =
  | { type: 'ask_user'; interaction: ProposedInteraction }
  | { type: 'propose_actions'; actions: ProposedPhoneActionV2[] }
  | { type: 'patch_plan'; patch: ProposedTaskPatchV2 }
  | { type: 'finish'; outcome: ProposedTaskOutcomeV2 };
```

Rules:

1. A plan patch may add, replace, skip, or reorder unexecuted steps.
2. A plan patch cannot change a verified step back to executable.
3. Repeating a completed mutation requires a new explicit quantity or correction
   from the current user turn.
4. The planner may suggest checkout after cart completion.
5. The planner may not convert a checkout utterance into historical product
   mutations unless the utterance explicitly adds or changes products.
6. `finish` is accepted only when the desired terminal outcome is satisfied or
   the assistant truthfully asks the user what to do next.
7. Invalid proposals return a structured rejection to the planner for one
   bounded replan attempt.

## 6. Dynamic capability and risk policy

Do not use one static Blinkit phase allowlist for every conversation. Generate
capabilities from the current task, user turn, adapter, observation, and risk.

| Effect | Examples | Default autonomy |
| --- | --- | --- |
| `read_only` | observe, search, inspect cart | autonomous |
| `navigation` | open app, back, scroll | autonomous within app scope |
| `local_edit` | draft text, change a local field | autonomous when requested and reversible |
| `reversible_external` | add/remove cart item | allowed from explicit task; idempotent and verified |
| `external_side_effect` | send a message, submit a form | typed adapter and confirmation policy |
| `financial` | prepare payment or checkout | review may be autonomous; dispatch requires confirmation |
| `irreversible` | final order, delete, publish | explicit bound confirmation and at-most-once execution |

For a checkout-only utterance after verified cart completion, the generated
capabilities can include `inspect_cart` and `prepare_checkout`; completed
`add_cart_item` operations are unavailable. If the same utterance says “also
add bread,” the planner can patch the graph and receive a new bread step.

## 7. Mutation, verification, and idempotency

Every executable action requires:

- `taskId`, `taskRevision`, `stepId`, and `operationId`;
- an adapter-owned typed input;
- source observation where a UI target is used;
- declared effect and cancellation policy;
- expected postcondition;
- idempotency strategy;
- stage and total deadlines.

Result states:

```text
verified
failed_before_mutation
mutation_unverified
ambiguous
waiting_for_user
blocked
```

`mutation_unverified` is not ordinary failure. Before any retry, the adapter
must perform a read-only reconciliation. A model replan cannot override this
rule.

For cart quantity, prefer a desired-state operation:

```text
ensure offer X has quantity 1
```

rather than:

```text
tap ADD once
```

The desired-state operation can safely report that the requested state already
exists without incrementing it.

## 8. Interactive progress transport

The current long-running request must not be the only delivery channel.

### 8.1 Event contract

```ts
type TaskProgressEventV2 = {
  version: 2;
  eventId: string;
  taskId: string;
  taskRevision: number;
  operationId?: string;
  stepId?: string;
  sequence: number;
  kind:
    | 'task_started'
    | 'step_started'
    | 'searching'
    | 'options_ready'
    | 'selection_accepted'
    | 'mutation_started'
    | 'mutation_verified'
    | 'moving_to_next_step'
    | 'reviewing_cart'
    | 'checkout_ready'
    | 'waiting_for_user'
    | 'blocked'
    | 'ambiguous'
    | 'completed';
  title: string;
  detail?: string;
  itemPosition?: { current: number; total: number };
  occurredAt: number;
};
```

### 8.2 Delivery

Implement one of:

1. POST voice turn returns an `operationId` quickly and Android subscribes to
   an SSE/WebSocket event stream; or
2. POST remains open as a streaming response with framed progress events.

Prefer a task event stream because it also supports server and Android
reconnection. Realtime model events may feed the stream, but the stream is
owned by the local task system.

### 8.3 Speech policy

Speak only useful milestones:

- “Amul Taaza Milk added. One of two complete.”
- “Now searching for Amul ice cream.”
- “I need your choice for ice cream.”
- “Both items are in the cart.”

Do not repeatedly speak low-level navigation or verification steps. Render
those visually. Never speak speculative success before verification.

## 9. Checkout continuation

Add explicit graph nodes:

```text
inspect_final_cart
choose_next_action
prepare_checkout
choose_payment_method
review_checkout
await_final_confirmation
dispatch_order
reconcile_order
```

Rules:

1. If the original goal includes ordering, product completion activates
   `inspect_final_cart` and `prepare_checkout`.
2. Otherwise product completion activates `choose_next_action`.
3. The choice should reflect the provider's current payment method:
   keep Mastercard, switch to COD, add something else, or stop.
4. Selecting COD changes the review proposal; it does not place the order.
5. The reviewed proposal always displays `NOT ORDERED`.
6. Final confirmation is bound to task revision, proposal hash, exact terms,
   payment mode, and expiry.
7. A new cart mutation invalidates the checkout proposal.
8. Final dispatch is attempted once. Unknown outcome enters reconciliation.

## 10. General-mobile extension

Build the core loop around registered app adapters:

```ts
type AppAdapterV2 = {
  adapterId: string;
  appAliases: string[];
  allowedPackages: string[];
  classifyScreen(...): ScreenClass;
  capabilities(...): CapabilityDescriptor[];
  proposeSemanticCandidates(...): SanitizedCandidate[];
  validateAction(...): PolicyInput;
  execute(...): OperationResultV2;
  verify(...): VerificationResultV2;
  reconcile(...): ReconciliationResultV2;
};
```

Roll out in this order:

1. Cross-app read-only companion observation.
2. Low-risk navigation in an instrumented test app.
3. Draft-only local edits.
4. One typed real-app adapter at a time.
5. External side effects only with adapter-specific confirmation and recovery.

Do not expose a universal model-generated coordinate clicker. The model selects
fresh opaque semantic references; the local adapter resolves and validates
them.

## 11. Step-by-step implementation backlog

### Phase H0 — Reconcile reality and freeze the regression

- [x] **H000 — Correct roadmap evidence**
  - Recount master-plan tasks.
  - Reopen any checked task whose implementation is test-only, unwired, or
    contradicted by runtime evidence.
  - Link every completed task to code and a passing test or physical artifact.
  - **Done when:** task counts and checkboxes agree, and “complete” means
    production-reachable.
  - **Evidence (2026-07-28):** Reconciled the numbered master backlog to
    44/62 complete, reopened twelve test-only or unwired runtime claims, and
    linked every remaining completed task in
    [`2026-07-28-production-path-evidence-inventory.md`](2026-07-28-production-path-evidence-inventory.md).

- [x] **H001 — Capture the supplied multi-item/COD regression**
  - Add a route fixture for milk, ice cream, two selections, and “place COD.”
  - Assert the final turn produces zero product searches and zero product
    mutations.
  - **Done when:** the test fails on the current terminal-cleanup behavior.
  - **Evidence (2026-07-28):**
    `route.multi-item-checkout-regression.test.ts` proves both exact selections
    and verified mutations. It reproduced the terminal-cleanup failure, then
    became a normal passing regression when the checkout-intent guard landed:
    the model may propose historical adds, but the final turn executes zero
    product calls and one checkout-preparation call.

- [x] **H002 — Record an active-path inventory**
  - Generate a production import graph separately from test/script reachability.
  - Record API and Android callers.
  - Classify code as active, compatibility, feature-flagged, unwired, or dead.
  - **Done when:** deletion candidates have named callers, parity tests, and
    rollback owners.
  - **Evidence (2026-07-28):** The production-only Next import traversal,
    Android API caller inventory, script/test-only graph, compatibility
    surfaces, and convergence owners are recorded in
    [`2026-07-28-production-path-evidence-inventory.md`](2026-07-28-production-path-evidence-inventory.md).

### Phase H1 — Goal and task graph

- [x] **H010 — Add `PhoneTaskV2` and compatibility projection**
  - Add domain-neutral task, step, journal, desired outcome, and interaction
    contracts.
  - Project existing product tasks into V2 during migration.
  - **Depends on:** H000.
  - **Evidence (2026-07-28):** The active coordinator synchronizes V1
    compatibility state into the bounded `PhoneTaskRepositoryV2` and returns
    the authoritative V2 envelope as `taskV2`. Monotonic projection commits
    retain repository events, reject same-revision rewrites, and preserve
    verified-step immutability.

- [x] **H011 — Preserve the complete user goal**
  - Extract products, quantities, constraints, and terminal intent.
  - Preserve “and order it” independently from generated tool calls.
  - **Tests:** cart-only, ask-next, checkout, COD, and explicit order goals.
  - **Evidence (2026-07-28):** `workflow/v2/goal.ts` preserves the original
    goal, quantities, constraints, and terminal outcome. The production
    authoritative task now also retains `originalGoal` and
    `desiredTerminalOutcome` independently of model tool calls. The
    multi-item/COD route regression proves the intent survives both product
    clarifications.

- [x] **H012 — Build pure graph transitions**
  - Add dependency eligibility, verified-node immutability, waiting,
    replacement, skip, correction, cancellation, blocked, and ambiguity
    transitions.
  - **Tests:** exhaustive transition table and invalid transition rejection.
  - **Evidence (2026-07-28):** `workflow/v2/graph.ts` implements dependency
    readiness and every specified transition. Ten focused tests cover graph
    evolution, stale interaction rejection, terminal-task rejection, and
    attempts to rerun or rewrite verified steps.

- [x] **H013 — Add model-proposed plan patches**
  - Define structured planner decisions and bounded replan behavior.
  - Let the model add bread, replace milk, skip an unavailable item, or propose
    checkout without mutating verified history.
  - **Done when:** general reasoning changes future work without resurrecting
    completed work.
  - **Evidence (2026-07-28):** The structured planner can propose bounded
    semantic `add_product`, `replace_product`, `skip_step`, and
    `propose_checkout` patches. Local code compiles and atomically commits them
    with compare-and-swap revision checks, rejects stale/open-interaction/
    recovery edits, preserves verified steps byte-for-byte, and can reactivate
    a completed graph only by appending new future work. Focused and
    production-coordinator tests cover the patch path.

- [x] **H014 — Replace terminal product cleanup**
  - Product completion activates the next graph node.
  - Retain terminal tasks for a bounded period and expose their next actions.
  - **Tests:** checkout continuation after the last item and delayed follow-up.
  - **Evidence (2026-07-28):** Completed product tasks remain in the bounded
    authoritative repository. A preserved COD goal activates one checkout
    review immediately after the final verified item, while a delayed
    checkout-only utterance can continue the retained task without restoring
    historical product mutations.

- [x] **H015 — Wire the production LLM planner**
  - Add one explicit planner adapter between Sarvam transcription and local
    phone policy.
  - Require the model to return structured intent, complete goal, desired
    terminal outcome, dialogue decision, and typed proposed actions.
  - Assemble the bounded `PlannerContextV2` from authoritative V2 state before
    every planner call.
  - Compile capabilities and evaluate every proposed action locally before it
    reaches an executor.
  - Preserve model freedom to ask, plan, patch future work, and finish, while
    preventing it from rewriting verified history or manufacturing execution
    truth.
  - Keep the current typed Blinkit executor only as a bounded migration
    adapter; the planner must not call raw V1 tools directly.
  - **Tests:** multi-item intent, clarification continuation, checkout-only
    containment, addition/correction plan patches, invalid structured output,
    capability rejection, and exact-confirmation gating.
  - **Done when:** production logs and responses expose the V2 planner
    decision and policy outcome, and the direct prose-to-phone-tool path is
    disabled when `JALDI_PHONE_TASK_V2=true`.
  - **Evidence (2026-07-28):** `OpenAILlmPlannerV2` is active when the
    local V2 flag is enabled. It returns structured intent, goal, outcome,
    dialogue decision, and typed actions; receives `PlannerContextV2`; runs
    every action through the compiler and policy engine; and performs at most
    one structured replan after invalid output or complete policy rejection.
    Logs and voice responses expose `plannerV2`, and direct V1 tool prompting
    is bypassed. Multi-item order, checkout containment, exact confirmation,
    invalid output, policy replan, and production graph-patch tests pass.
    Model additions, corrections, skips, and checkout proposals now update the
    authoritative V2 graph rather than resurrecting compatibility history.

### Phase H2 — Durable memory and context

- [x] **H020 — Implement one production task repository**
  - Wire the existing recovery persistence or replace it with a small SQLite
    repository.
  - Use compare-and-swap revisions and atomic event/state writes.
  - **Tests:** restart, corrupt record, expiry, concurrent turns, partial write.
  - **Evidence (2026-07-28):** Non-test V2 runtime state now uses
    `FileBackedPhoneTaskRepositoryV2`. It writes checksummed task/event
    snapshots through a mode-0600 temporary file and atomic rename, restores
    after process restart, preserves corrupt evidence while failing closed,
    serializes mutations, and retains repository compare-and-swap checks.
    Tests cover restart, corruption, expiry, concurrent commits, and injected
    partial-write failure. The V1 repository remains only as the bounded
    executor compatibility adapter until H082.

- [x] **H021 — Wire restart recovery into server startup**
  - Restore safe task state.
  - Reconcile operations that crossed a mutation boundary.
  - Do not replay final dispatch.
  - **Done when:** `JALDI_TASK_RECOVERY_V1` changes real runtime behavior.
  - **Evidence (2026-07-28):** Next server instrumentation now runs the
    durable V2 recovery coordinator once at Node runtime startup when
    `JALDI_TASK_RECOVERY_V1=true`. Pre-mutation operations resume safely;
    attempted cart additions use the executor's read-only `reconcileOnly`
    path; verified unchanged state is retained as not applied; unsupported or
    uncertain state remains ambiguous; and final dispatch always returns
    ambiguous without calling any order action. The local runtime flag is
    enabled, focused restart/reconciler tests pass, and the production build
    succeeds.

- [x] **H022 — Build the bounded planner context assembler**
  - Combine goal, graph summary, pending interaction, verified facts,
    observation, available capabilities, and recent dialogue.
  - **Tests:** history truncation cannot lose the shopping list or checkout
    continuation.
  - **Evidence (2026-07-28):** `assemblePlannerContextV2` is now called on the
    production V2 planner path before every turn with retained goal, graph,
    interaction, facts, bounded dialogue, and capability summaries. Required
    task truth fails closed when it cannot fit the configured context budget.

- [x] **H023 — Add explicit task replacement and start-over semantics**
  - Distinguish a clarification answer, correction, addition, unrelated task,
    and start-over.
  - Never silently discard an active mutation.
  - **Evidence (2026-07-28):** The V2 classifier and production coordinator
    distinguish
    clarification, correction, addition, unrelated replacement, cancellation,
    and start-over, and rejects all replacement while a mutation is
    unresolved. Atomic V2 interaction resolution, cancellation, repository
    replacement, and twelve coordinator tests are wired on the active path.

### Phase H3 — Dynamic capabilities and policy

- [x] **H030 — Add the effect and risk taxonomy**
  - Declare read-only, navigation, local edit, reversible external, external
    side effect, financial, and irreversible effects.
  - **Evidence (2026-07-28):** `policy/v2/types.ts` and
    `policy/v2/capability-catalog.ts` declare all seven effects together with
    freshness, confirmation, and idempotency requirements for each semantic
    capability.

- [x] **H031 — Implement the capability compiler**
  - Derive available actions from task revision, pending interaction, adapter,
    current observation, explicit user turn, and unresolved mutations.
  - **Tests:** checkout-only turn cannot repeat completed adds; “also add bread”
    can patch the task.
  - **Evidence (2026-07-28):** The production LLM planner compiles typed
    Blinkit capabilities from its structured intent and active interaction
    before any proposed action is translated to the compatibility executor.
    Explicit adds, checkout-only containment, pending choices, and unresolved
    mutation cohorts have focused tests.

- [x] **H032 — Implement policy decisions**
  - Return allow, block, require confirmation, handoff, or reconcile.
  - Provide a structured reason to the model for one bounded replan.
  - **Evidence (2026-07-28):** Every structured planner action is evaluated by
    `evaluatePhoneActionPolicyV2`; only `allow` decisions reach the executor.
    Policy outcomes and structured reasons are logged and returned in
    `plannerV2.policy`. Final dispatch remains blocked without a revision-bound
    fresh confirmation grant. Block, confirm, recovery handoff, and unresolved
    mutation reconciliation decisions are production-wired, and rejected
    plans receive at most one structured replan.

- [x] **H033 — Bind confirmation grants**
  - Bind grants to task revision, action digest, proposal hash, terms, payment
    mode, owner, and expiry.
  - Keep final dispatch unavailable to generic Realtime tools.

### Phase H4 — Execution truth and reconciliation

- [x] **H040 — Add operation idempotency records**
  - Bind each mutation to task/step/desired state.
  - Prevent duplicate call IDs and semantic duplicate mutations.
  - **Evidence (2026-07-28):** Every production cart mutation receives a
    canonical protocol version, stable call/step identity, task revision, and
    desired-state fingerprint. The file-backed idempotency ledger survives
    restart, suppresses both exact and semantic duplicates, and advances the
    authoritative task at most once.

- [x] **H041 — Convert cart adds to desired-state operations**
  - Ensure the selected offer reaches a requested final quantity.
  - Do not increment merely because a request or response was retried.

- [x] **H042 — Standardize mutation outcomes**
  - Separate failed-before-mutation, mutation-unverified, verified, and
    ambiguous.
  - Remove presentation strings from executor results.
  - **Evidence (2026-07-28):** The execution bridge maps executor facts into
    verified, waiting-for-user, failed-before-mutation, or ambiguous graph
    transitions. Presentation is built later from those facts, and boundary
    tests cover canonical add, set, and remove outcomes.

- [x] **H043 — Require reconciliation before retry**
  - Compare a fresh cart snapshot with the pre-mutation snapshot.
  - Advance exactly once when reconciliation proves success.
  - Ask for help or stop safely if still ambiguous.
  - **Evidence (2026-07-28):** A failed or ambiguous mutation triggers exactly
    one fresh cart reconciliation before any retry. Verified desired state
    advances once; unresolved state is durably latched and blocks another
    mutation until reconciliation or user help.

- [x] **H044 — Add no-progress and loop detection**
  - Fingerprint screen, task revision, action, and result.
  - Stop repeated search/cart/back loops after a bounded threshold and explain
    the blocker.

### Phase H5 — Interactive progress

- [x] **H050 — Add a retained task event stream**
  - Publish ordered progress independent of model conversation events.
  - Retain a bounded latest sequence for reconnect.
  - **Evidence (2026-07-28):** The production coordinator publishes verified
    item milestones to the bounded monotonic V2 stream. Android clients can
    retrieve ordered retained events with reconnect/reset semantics from
    `GET /api/device/task/events`; the voice response also carries the current
    event snapshot.

- [x] **H051 — Return operation identity quickly**
  - Decouple voice-upload completion from long phone execution where possible.
  - Keep a bounded synchronous compatibility response.
  - **Evidence (2026-07-28):** A single eligible V2 phone action commits its
    authoritative running operation, enters a bounded durable background queue,
    and returns `operationAccepted` with operation ID and retained-event cursor
    before the phone worker completes. The singleton worker validates revision,
    step, and operation identity, persists only an allowlisted versioned
    command, commits terminal task truth before publishing completion, and
    rejects final dispatch. Multi-action or unsupported commands retain the
    bounded synchronous path. Coordinator and background-operation tests pass
    38/38, including a blocked-worker early-response assertion and restart
    replay.

- [x] **H052 — Subscribe from Android**
  - Reconnect by task ID and last sequence.
  - Reject stale/out-of-order events.
  - Restore the latest safe presentation after service recreation.
  - **Evidence (2026-07-28):** Android persists task/operation/revision/event
    cursors, polls retained events, rejects stale, wrong-task, gapped, and
    post-terminal delivery, and restores safe progress after service
    recreation. Server projection and reconnect tests pass.

- [x] **H053 — Add item-completion announcements**
  - Speak verified item completion and the next meaningful step.
  - Show detailed low-level progress visually.
  - **Acceptance:** “Milk added. Now searching for ice cream” arrives before
    the ice-cream search completes.
  - **Evidence (2026-07-28):** Verified retained events drive visual detail,
    accessibility announcements, and native TTS. The cursor is persisted
    before audio to prevent replay; model prose cannot trigger completion.

- [x] **H054 — Add interactive completion choices**
  - Render add-more, review-checkout, current-payment, COD, and stop choices.
  - Accept tap or speech through the same pending interaction.
  - **Evidence (2026-07-28):** Android renders all five choices with
    expiry/disabled state and one-shot tap ownership while push-to-talk remains
    available. The interaction route validates exact client/task/revision/
    interaction/choice/expiry, resolves atomically, and publishes one retained
    acceptance event; concurrent tap tests pass.

### Phase H6 — Checkout continuation

- [x] **H060 — Add checkout graph nodes and transitions**
  - Connect product completion to ask-next or checkout based on the original
    goal.

- [x] **H061 — Add deterministic checkout-intent protection**
  - Treat checkout language as a planner constraint.
  - Reject historical product mutations unless the current turn explicitly
    changes the cart.
  - **Evidence (2026-07-28):** Checkout-only continuations are rerouted to one
    local checkout review. While checkout confirmation is pending, historical
    model-proposed product calls are suppressed. The milk/ice-cream/COD route
    fixture asserts zero repeated product phone calls.

- [x] **H062 — Present current payment and alternatives**
  - Read the selected payment method.
  - Offer current method, COD when available, add more, or stop.

- [x] **H063 — Bind COD review and final confirmation**
  - Selecting COD prepares a new proposal and displays `NOT ORDERED`.
  - Exact final confirmation authorizes only that proposal.

- [x] **H064 — Add checkout regression coverage**
  - Cover Mastercard-to-COD, COD unavailable, changed cart, changed fees,
    expired proposal, duplicate confirmation, disconnect, and ambiguous final
    result.

### Phase H7 — General-mobile intelligence

- [x] **H070 — Add core V2 observation/action/policy contracts**
  - Align with the general-mobile architecture audit.
  - **Partial evidence (2026-07-28):** `general-mobile/v2/contracts.ts` defines
    policy-aligned semantic observations, references, actions, outcomes, and
    cancellation/replan contracts without raw-coordinate authority.

- [x] **H071 — Implement adapter registration and package scope**
  - No action executes outside the selected adapter's allowlisted packages and
    capabilities.
  - **Evidence (2026-07-28):** The adapter registry resolves by package,
    enforces declared capabilities, rejects stale semantic references, and
    refuses raw-coordinate targets before execution.

- [x] **H072 — Ship read-only companion mode**
  - Observe, explain, and point using fresh semantic references.
  - Apply broad sensitive-screen policy.
  - **Evidence (2026-07-28):** Read-only companion mode uses fresh semantic
    references and sensitive-screen restrictions without granting mutation
    authority. The production coordinator exposes an explicit observe/explain
    path with foreground-package verification, cancellation, and a kill switch.

- [x] **H073 — Build an instrumented test adapter**
  - Test navigation, local edits, unexpected dialogs, stale targets, no
    progress, cancellation, and replanning without a real external side effect.
  - **Evidence (2026-07-28):** The fake adapter and bounded runner cover the
    listed scenarios, and the same conformance contract is exercised by the
    production read-only Android Settings adapter. The complete general-mobile
    cohort passes 32 focused tests.

- [x] **H074 — Add one low-risk real-app adapter**
  - Start read-only or draft-only.
  - Require adapter conformance, recovery, privacy, and rollback evidence.

### Phase H8 — Dead-code removal and architecture convergence

- [x] **H080 — Delete confirmed legacy Appium grocery/COD execution**
  - Remove the no-caller `prepareGrocery`, `prepareCodCheckout`, and
    `placeCodOrder` implementations in `lib/appium.ts`.
  - Remove helpers that become unreachable.
  - Preserve only session/status/open-app behavior or move that behavior behind
    the driver.
  - **Gate:** unified checkout and final-dispatch tests pass.
  - **Evidence (2026-07-28):** Removed all three implementations and their
    private element/product/COD helper subtree. Direct voice TypeScript
    validation, 51 focused execution/command tests, the complete 445-test voice
    suite, and the Next production build passed.

- [x] **H081 — Delete unused execution wrappers**
  - Remove no-caller `searchGroceryWithDriver`, `inspectCartWithDriver`,
    `setGroceryQuantityWithDriver`, `removeGroceryFromCartWithDriver`,
    `addGroceryWithDriver`, and `prepareGroceryWithDriver`.
  - **Evidence (2026-07-28):** Removed all six exports. Repository-wide
    reference validation found no remaining declarations or callers, and the
    validation matrix listed under H080 passed.

- [x] **H082 — Remove V1 conversation ownership**
  - After V2 is always on and rollback evidence exists, remove the in-route
    `conversations` map, `PendingGrocery`, dual save paths, and terminal cleanup
    behavior.
  - Keep a deployment rollback at the release level rather than two workflow
    engines in one coordinator.
  - **Evidence (2026-07-28):** Removed the in-route conversation owner,
    V1 task repository/state/transitions, dual saves, compatibility
    projections, and V1 selection ownership. The production ownership gate
    reports zero V1 conversation and zero dual-save occurrences.

- [x] **H083 — Retire compatibility tool aliases**
  - Remove `prepare_grocery`, `prepare_cod_checkout`, and
    `confirm_cod_order` only after all active clients use the canonical typed
    commands and protocol-version negotiation is present.
  - **Evidence (2026-07-28):** Removed all three aliases from command parsing,
    phone execution, mutation safety, recovery, Realtime tests, and production
    types. The compatibility ownership report now enforces zero occurrences;
    42 focused tests, strict TypeScript, and the dead-code gate pass.

- [x] **H084 — Decide the old Realtime audio endpoint**
  - The native app does not call `/api/realtime/session`.
  - Either remove the prototype and `JALDI_REALTIME_VOICE_V1`, or assign it a
    tested future owner. Sarvam remains the production speech path.
  - **Evidence (2026-07-28):** Removed the unused
    `/api/realtime/session` WebRTC-audio endpoint, its test, and the
    `JALDI_REALTIME_VOICE_V1` configuration. Sarvam remains the sole
    production speech provider; the production route manifest no longer
    includes the endpoint.

- [x] **H085 — Remove or wire ineffective feature flags**
  - `JALDI_OPERATION_LIFECYCLE_V1`, `JALDI_PRECISE_ATTENTION_V1`, and
    `JALDI_TASK_RECOVERY_V1` currently lack production consumers.
  - A flag must either control an active boundary or be deleted.
  - **Evidence (2026-07-28):** Removed the ineffective operation-lifecycle and
    precise-attention flags. `JALDI_TASK_RECOVERY_V1` now controls the real
    Next startup recovery boundary. Focused flag/instrumentation tests and the
    production build pass.

- [x] **H086 — Add a dead-code gate**
  - Run a TypeScript reachability/unused-export tool in CI with separate
    application, test, and script entry points.
  - Treat feature-flagged and compatibility code as declared exceptions with
    owners and removal dates.
  - **Evidence (2026-07-28):** The deterministic analyzer includes Next root
    entrypoints, separated entry classes, and exact grouped exceptions with
    owner, reason, removal date, and a hard 90-day maximum. Root `pnpm test`
    runs the gate. Current result is zero violations, 62 reviewed expiring
    findings, and zero manifest errors; five analyzer tests and strict
    TypeScript pass.

### Phase H9 — Verification and rollout

- [x] **H090 — Run automated correctness matrix**
  - Task graph, plan patches, context truncation, capability policy,
    idempotency, reconciliation, progress ordering, card/voice races, checkout,
    privacy, Realtime fallback, and restart recovery.
  - **Evidence (2026-07-28):** A dedicated 18-case correctness matrix covers
    every listed cohort, with adversarial fixtures and an explicit manifest.
    The matrix passed 18/18; the serialized complete voice suite passed
    105 files and 699 tests; strict TypeScript and diff validation passed.

- [x] **H091 — Run adversarial model tests**
  - Model repeats a completed add, claims success, requests raw coordinates,
    skips confirmation, responds late, or proposes a stale action.
  - Local policy must contain every case while allowing a useful replan.
  - **Evidence (2026-07-28):** Transactional success prose is accepted only
    with current verified facts or matching terminal graph evidence. Unsupported
    cart, checkout, and order claims receive one bounded corrective replan and
    then a truthful deterministic response. Planner, presentation, and the
    18-case H090/H091 matrix pass, including stale, late, raw-coordinate,
    duplicate-action, and skipped-confirmation cases.

- [x] **H092 — Run the physical-Pixel shopping canary**
  - Read-only baseline, two items, one voice choice, one card choice, item
    completion announcements, final cart inspection, and checkout review.
  - Stop before final dispatch in the normal canary.
  - **Evidence (2026-07-28):** Pixel 9 `55221VDAQ000J1` completed the clean
    reversible canary from an empty cart. A spoken choice selected Amul Taaza
    Toned Milk 500 ml; a card tap selected Amul Vanilla Magic Ice Cream Tub.
    The card route acknowledged `accepted/enqueued_once`; an immediate
    identical tap returned `duplicate/none`. Both authoritative mutations
    completed once, ordered progress announced the item transition, and
    read-only inspection proved exactly two quantity-one lines with a ₹224
    subtotal. Checkout review reported COD, Home, ₹12 fees, ₹236 total,
    eight-minute ETA, and `NOT ORDERED`. No final action was issued. Verified
    cleanup restored the empty cart.

- [ ] **H093 — Run one separately authorized low-value COD canary**
  - Verify exact terms, exact confirmation, at-most-once dispatch, receipt, and
    reconciliation behavior.
  - Never combine this with exploratory testing.

- [x] **H094 — Run the general-mobile test cohort**
  - Read-only companion, instrumented navigation/editing, unsupported app,
    sensitive screen, stale observation, and recovery.
  - **Evidence (2026-07-28):** The package-scoped registry, read-only
    companion, instrumented adapter, and Android Settings adapter pass the
    complete 32-test conformance cohort, including cancellation, stale
    references, unsupported packages, sensitive screens, no-progress recovery,
    and rollback controls. A physical read-only Settings observation was not
    claimed: the connected Pixel foregrounded Instagram, and the canary
    correctly refused to launch or mutate another app.

- [ ] **H095 — Remove migration flags and close the evidence audit**
  - One authoritative workflow, one execution path, one active checkout path,
    and documented model/fallback policy remain.

## 12. Current dead-code and wiring audit

This is a static repository audit, not proof that an undocumented external
client never calls an HTTP endpoint.

### 12.1 Removed no-caller production code

Repository-wide call-site searches found no callers for, and the 2026-07-28
cleanup removed:

- `prepareGrocery`, `prepareCodCheckout`, and `placeCodOrder` in
  `local/apps/voice/lib/appium.ts`;
- the six compatibility driver wrapper exports at the bottom of
  `local/apps/voice/lib/blinkit-execution.ts`.

Only `readPhoneStatus` and `openBlinkit` are imported from `appium.ts` by the
active phone tool. The file now retains only Appium status, Blinkit session
activation/recovery, and open-app behavior. The unified
`BlinkitExecutionService` remains the only grocery, cart, checkout, and final
dispatch implementation.

Validation after deletion:

- direct voice TypeScript validation passed;
- 51 focused phone-tool, execution, and command tests passed;
- all 61 voice test files and 445 tests passed;
- the Next production build passed;
- repository-wide searches found no remaining deleted symbol references;
- scoped `git diff --check` passed.

### 12.2 Compatibility code that is still active

Do not classify these as dead yet:

- the non-authoritative in-memory conversation path is still selected when
  `JALDI_AUTHORITATIVE_TASK_STATE_V1=false`;
- `prepare_grocery`, `prepare_cod_checkout`, and `confirm_cod_order` remain in
  command unions, normalization, tests, UI labels, or the legacy Realtime route;
- Android legacy presentation parsing is used as a safe fallback for missing
  or unsupported presentation payloads;
- the bounded Responses path is the required Realtime fallback.

Remove these only after client migration, protocol-version checks, and rollback
evidence.

### 12.3 Implemented but not production-wired

A production import-graph traversal from Next application entry points found
the following libraries unreachable from the active app runtime:

- the screenshot/grounding module family under
  `local/apps/voice/lib/grounding`;
- `workflow/recovery-persistence.ts`;
- `workflow/recovery-coordinator.ts`;
- Realtime shadow evaluators/runtime, which are currently script/test
  facilities rather than request-path code.

These modules may be useful and tested, but they do not yet prove runtime
completion. In particular:

- `JALDI_TASK_RECOVERY_V1` is loaded but has no production consumer;
- `JALDI_OPERATION_LIFECYCLE_V1` is loaded but has no production consumer;
- `JALDI_PRECISE_ATTENTION_V1` is loaded but has no production consumer.

The operation lifecycle itself is active through the phone tool, and precise
attention exists in native/server modules, but those named flags do not govern
the active behavior. This is configuration drift.

### 12.4 Dormant or externally uncertain surfaces

- Android calls `/api/voice/turn` and `/api/device/selection`; it does not call
  `/api/realtime/session`.
- `/api/device/task` is not called by the native overlay or the local web page,
  but it may be an intentional external/manual tool surface.
- `/api/realtime/session` is a feature-flagged legacy audio prototype.
- `hosted-blinkit.ts` and its test are already deleted in the current worktree;
  retain that deletion only if the full local test suite confirms no hidden
  dependency.

### 12.5 Roadmap status reconciliation

Before H000, the master-plan header said 52 of 62 tasks were complete while
the numbered backlog contained 56 checked tasks and 6 unchecked tasks.
Several checked tasks also had runtime evidence gaps:

- T053 was contradicted by no-caller legacy Appium grocery/COD implementations
  at audit time. H080/H081 have now removed that residue and passed the
  execution and production-build gates.
- T061 says the voice route is a thin coordinator, but
  `lib/voice-turn/coordinator.ts` still owns substantial legacy and
  authoritative workflow branching.
- T110/T111 describe persistent recovery and startup recovery, but the
  recovery modules are not reachable from production app entry points.

H000 reconciled those claims on 2026-07-28. The master plan now reports 44 of
62 production-reachable tasks complete and 18 open. T070–T075, T080–T083,
T110, and T111 were reopened. The complete evidence and active-path ledger is
[`2026-07-28-production-path-evidence-inventory.md`](2026-07-28-production-path-evidence-inventory.md).

## 13. Delivery slices

### Slice 1 — Stop forgetting and repeating

H000–H014, H031, H040–H044, H060–H061.

Exit criteria:

- the supplied COD regression passes;
- product completion does not delete checkout continuation;
- no completed mutation can be replayed by prose history;
- uncertain mutation triggers reconciliation.

### Slice 2 — Make the experience interactive

H020–H023 and H050–H054.

Exit criteria:

- task survives a server restart;
- Android receives retained progress;
- each verified item announces completion and the next step;
- cart completion presents meaningful next-action choices.

### Slice 3 — Complete checkout hardening

H030–H033 and H062–H064.

Exit criteria:

- current payment method is shown;
- COD selection prepares but does not dispatch;
- exact terms and confirmation are bound;
- final action remains at most once and ambiguity-safe.

### Slice 4 — Generalize safely

H070–H074.

Exit criteria:

- core task/action types are commerce-neutral;
- read-only companion works across allowlisted apps;
- a test adapter demonstrates model replanning without raw coordinate
  authority.

### Slice 5 — Remove migration residue and release

H080–H095.

Exit criteria:

- one workflow owns task state;
- one execution service owns Blinkit;
- no ineffective feature flags remain;
- automated, Pixel, COD, and general-mobile evidence is linked.

## 14. Final definition of done

- [ ] The complete original goal survives every clarification and restart.
- [ ] The model can revise future steps without rewriting verified history.
- [ ] The application, not conversation prose, owns transactional truth.
- [ ] Every phone action is policy-checked, idempotent where necessary, and
      verified or explicitly ambiguous.
- [ ] A checkout utterance cannot repeat completed product mutations.
- [ ] Every verified item produces timely progress and a meaningful next step.
- [ ] Product completion leads to checkout continuation or an interactive
      next-action question.
- [ ] Voice and card responses resolve one pending interaction atomically.
- [ ] COD selection is distinct from final order confirmation.
- [ ] Final dispatch is confirmation-bound, at most once, and reconcilable.
- [ ] Realtime and bounded Responses share the same planner, policy, task, and
      execution boundaries.
- [ ] Sarvam remains the production STT/TTS provider.
- [ ] General-mobile operation uses typed adapters and fresh semantic
      references rather than raw model coordinates.
- [ ] Restart, timeout, disconnect, late response, and no-progress loops have
      tested safe outcomes.
- [ ] One production workflow, one Blinkit execution path, and one checkout
      implementation remain.
- [ ] Dead, dormant, compatibility, and feature-flagged code have explicit
      classifications and owners.
- [ ] Roadmap status is backed by automated or physical-device evidence.
