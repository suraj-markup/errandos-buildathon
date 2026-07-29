# Jaldi AI general-mobile / Clicky architecture audit

Date: 2026-07-28

Scope: read-only comparison of the current Jaldi tree with public
[`farzaa/clicky`](https://github.com/farzaa/clicky/tree/a80fa80721a8aebe51a170a7780705024ebc6e46).
No Pixel, cart, checkout, or order operation was performed.

## Evidence boundary

Public Clicky is evidence for an interaction pattern, not for the current
closed-source HeyClicky architecture. Its repository states that new work is
private. Claims that HeyClicky uses GPT Realtime, phone tools, or a persistent
task engine therefore remain unverified.

The public loop is:

```text
push to talk
→ cancel prior response and speech
→ capture current screens
→ send utterance, images, and bounded history
→ receive a short answer plus optional [POINT:x,y:label]
→ render attention and speak
```

The public implementation does not click, type, navigate, verify, recover, or
own a multi-step task. Its pointer coordinate is presentation-only. Jaldi
should adopt that companion interaction envelope, not expose raw coordinates
as executable phone tools.

Official OpenAI Realtime documentation establishes stateful text/image
conversation items, text events, function calls, function-call outputs, and
`response.cancel`. It does not supply device authority, task truth,
idempotency, observation freshness, or safe phone-operation cancellation.
Those remain local Jaldi responsibilities.

## Target architecture

Jaldi should provide two explicitly different lanes.

### Companion mode

```text
fresh allowlisted foreground-screen observation
→ explain what is visible
→ optionally point using an observation-bound opaque element reference
→ speak through Sarvam
```

This lane is cross-app and read-only.

### Operate mode

```text
goal
→ sanitized observation
→ propose one typed action
→ local policy / confirmation
→ serialized execution
→ fresh observation
→ verify postcondition
→ journal task
→ repeat, ask, stop, or complete
```

Operate mode must never accept model-generated coordinates, selectors,
resource IDs, package names, shell commands, or arbitrary Android intents.

## Reusable Jaldi foundations

- revisioned authoritative task state and bounded prose history;
- operation IDs, serialized device ownership, mutation boundaries,
  reconciliation, and independent cancellation policy;
- ephemeral screenshots with restricted-screen handling and capture budgets;
- sanitized semantic candidates and opaque locally resolved element refs;
- structured grounding with stale/unknown/ambiguous-reference rejection;
- correlated Realtime text/image transport and bounded Responses fallback;
- typed Blinkit and Rapido drivers with post-action verification;
- structured semantic progress and the non-touchable Android attention layer.

## Blinkit-specific blockers

- core task items, phases, prompts, and persistence encode products, offers,
  quantities, carts, INR, checkout, and COD;
- the active phone tool and command unions are Blinkit-shaped;
- operation effects are inferred from grocery operation names rather than a
  domain-neutral risk declaration;
- Appium attachment defaults to Blinkit/Rapido package ownership;
- choice, review, receipt, and attention presentation types are
  commerce-specific;
- vision roles and intents still include product-choice vocabulary;
- the privacy policy needs general coverage for messages, email, documents,
  photos, health, banking, passwords, system permissions, notifications, and
  keyboard text.

## Required V2 contracts

### `PhoneTaskV2`

Task ID/revision, user goal, status, active step, app context, waiting reason,
bounded journal, terminal reason, and execution budgets. Domain payloads belong
to registered adapters rather than the core task type.

### `ScreenObservationV2`

Observation ID, package/activity, fingerprint, orientation, viewport, capture
time, expiry, screen class, and sanitized candidates. Pixels, XML, selectors,
node IDs, and bounds remain private and short-lived. Invalidate on app,
activity, fingerprint, orientation, task, or operation change.

### `PhoneActionV2`

Minimum proposals:

- `observe`;
- `launch_app(appAlias)`;
- `activate(elementRef)`;
- `set_text(elementRef, text)` and `clear_text(elementRef)`;
- `submit(elementRef?)`;
- `scroll(containerRef?, direction)`;
- `back`, `home`, and `wait_for_change`;
- `show_attention(elementRef)` for companion presentation.

Every action carries its source observation, expected postcondition, app scope,
idempotency rule, and declared effect: `read_only`, `navigation`, `local_edit`,
`external_side_effect`, `financial`, or `irreversible`.

### `AppAdapterV2`

Each adapter owns its stable app alias, allowed packages/activities,
capabilities, action/effect allowlist, screen classification, candidate
enrichment, sensitive-screen policy, semantic commands, pre/postconditions,
verification, reconciliation, recovery, confirmation rules, and kill switch.

Sending a message, booking, submitting a form, changing a setting, deleting,
sharing, granting permissions, entering an OTP, paying, or final dispatch must
require a typed domain adapter and risk-specific policy.

### `PolicyDecisionV2`

The local policy engine—not the model—returns allow, block, confirm, or handoff
from app capability, observation freshness, action effect, confirmation grant,
privacy state, lock/auth state, and idempotency history. A confirmation grant
is bound to the task revision, action digest, reviewed terms, and expiry.

### `OperationResultV2` and `InteractionPresentationV2`

Operation results are `verified`, `failed`, `ambiguous`, `waiting_for_user`, or
`blocked`, with a fresh observation ref, postcondition evidence, mutation
boundary, and safe recovery. Generic presentation supports status/progress,
choice, confirmation/review, form review, attention, result, ambiguity, and
handoff without pretending unverified work is complete.

## Cancellation and latency

Keep three cancellation domains independent:

1. Stop Sarvam playback immediately on new push-to-talk.
2. Cancel/ignore the obsolete model response by task revision.
3. Cancel a phone operation only before its mutation boundary; otherwise stop
   at a safe checkpoint or reconcile.

Realtime may expose control deltas earlier, but Appium, provider UI,
verification, and Sarvam remain in the critical path. Measure transcript-final,
first model delta, tool decision, device ownership, verified result, TTS start,
fallback, and cancellation latency. Never stream speculative success.

## Staged tasks

### P0 — safe cross-app kernel

1. Add the V2 contracts with V1 compatibility adapters.
2. Extend the extracted coordinator ports to app adapter, policy, observation,
   executor, and generic presentation.
3. Attach read-only observation to the foreground allowlisted app without
   defaulting to Blinkit.
4. Ship companion mode before any generic mutation.
5. Build one-action operate mode against an instrumented test app.
6. Generalize operation effect/risk taxonomy and route both model transports
   through the same policy and queue.
7. Add loop limits, no-progress detection, app-switch invalidation, and human
   stop states.

### P1 — adapters and guarded evidence

1. Expand cross-app privacy and prohibited-action tests.
2. Extend the shadow corpus beyond groceries to observe/explain, navigation,
   local edits, ambiguity, stale refs, and policy blocks.
3. Add adapter conformance tests and an instrumented test adapter.
4. Add one read-only real-app companion adapter and one draft-only local-edit
   adapter.
5. Run a read-only Pixel companion canary before low-risk navigation.

### P2 — performance and release policy

1. Finalize cost/fallback policy from cross-app quality and latency.
2. Stream safe transcript/model/TTS presentation at sentence boundaries.
3. Add typed adapters based on demand and risk, never a universal clicker.
4. Complete revised release gates with per-app rollback flags.

## Definition of “general mobile”

Jaldi is general enough for a release cohort only when the core contracts are
commerce-neutral, apps are registered by alias/capability, every executable
target is fresh-observation-bound, every action has a declared effect and
verified postcondition, high-risk actions are blocked/confirmed/handed off by
typed policy, interruption cannot duplicate a side effect, no-progress loops
stop safely, unsupported apps retain read-only companion mode, and Blinkit and
Rapido remain isolated typed adapters.
