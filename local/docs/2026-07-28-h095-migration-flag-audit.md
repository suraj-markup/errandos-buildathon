# H095 migration and convergence audit

Audit date: 2026-07-28

Result: **source convergence is complete; release closure remains blocked only
by the physical H092 canary and separately authorized H093 COD canary.**

## Authoritative production owners

| Domain | Production owner |
| --- | --- |
| Task, queue, clarification, cancellation, and terminal truth | Durable `PhoneTaskV2` repository |
| Planning and dialogue | Structured V2 LLM planner plus local policy |
| Product selection | Revision-bound V2 pending interaction and exact `offerId` |
| Phone execution | Canonical typed phone action service |
| Cart mutation truth | V2 desired-state/idempotency/reconciliation layer |
| Checkout and final confirmation | V2 checkout orchestration service |
| Android task progress | Retained V2 task event stream |
| Speech | Sarvam transcription and synthesis |

V1 conversation ownership, dual saves, compatibility projections, and legacy
command aliases all have zero production occurrences. Rollback means deploying
the previous release; two workflow engines are not retained in one process.

## Removed migration switches

The following settings and disabled branches are no longer production
configuration:

- `JALDI_AUTHORITATIVE_TASK_STATE_V1`
- `JALDI_PHONE_TASK_V2`
- `JALDI_ATOMIC_PRODUCT_SELECTION_V1`
- `JALDI_STRUCTURED_PROGRESS_V1`
- `JALDI_TASK_RECOVERY_V1`
- `JALDI_OPERATION_LIFECYCLE_V1`
- `JALDI_PRECISE_ATTENTION_V1`
- `JALDI_REALTIME_VOICE_V1`

`JALDI_PHONE_TASK_V2_STATE_PATH` remains a storage-path setting; it does not
select a workflow.

Recovery is mandatory and fail-closed before the voice route coordinates any
phone action. The process-global recovery promise prevents duplicate recovery
work. The unused Next instrumentation shim was removed because importing the
Appium graph there broke webpack development compilation.

The duplicate V1 semantic-progress broadcast and flag were removed. Retained
V2 events now own task progress, interactive prompts, cursor replay, and
completion announcements. Plain overlay status transport remains presentation
only and does not own task state.

## Retained operational safety and rollout controls

These controls are not workflow migration switches and remain intentionally:

- Realtime shadow/control/safe-tool rollout flags;
- screenshot and vision-grounding rollout flags;
- `JALDI_LOG_CONTENT_V1` privacy control;
- `ERRANDOS_LIVE_COMMIT` final-dispatch safety switch.

Sarvam remains production speech. Bounded Responses remains the control-path
fallback. No audit result grants final-order authority.

## H083 canonical command cutover

Only canonical commands remain:

- `add_cart_item`
- `prepare_checkout`
- `confirm_checkout`

The former grocery-preparation and COD aliases were removed from parsing,
execution, recovery, Realtime coverage, mutation safety, tests, and types. The
compatibility ownership gate enforces zero occurrences in production.

## Validation snapshot

Validated on the shared 2026-07-28 tree:

- complete voice suite: **109 files, 703 tests passed**;
- strict TypeScript: passed;
- compatibility ownership gate: zero V1 owners, dual saves, and aliases;
- dead-code gate: **0 violations, 55 reviewed time-bounded exceptions,
  0 manifest errors**;
- focused alias/recovery/Realtime suite: **42 tests passed**;
- focused retained-progress and coordinator suite: **84 tests passed**;
- Android overlay build: passed.

The lower test count reflects removal of the retired V1 route-compatibility,
instrumentation, and duplicate semantic-progress suites. Their active V2
replacement coverage remains in the coordinator, retained-event, checkout,
execution, selection, recovery, and multi-item regression suites.

The final rerun also found one file-local cancellation-policy type that was
still exported without a production consumer. Its export visibility was
removed; the strict dead-code gate then returned zero violations.

The removed V1 route-compatibility test suite asserted the deleted `task`
response, retired environment switches, and compatibility planner fixture.
Its active behaviors are covered by the V2 coordinator, device-selection,
multi-item checkout, checkout orchestration, execution-safety, and H090/H091
matrices.

## Remaining release evidence

1. **H092 — passed 2026-07-28:** unlocked physical Pixel; empty read-only
   baseline; two items; one voice choice; one card choice; duplicate tap
   suppression; completion announcements; exact final cart inspection; COD
   checkout review explicitly marked `NOT ORDERED`; verified empty-cart
   restoration.
2. **H093:** separate fresh authorization; exact low-value COD terms; one
   at-most-once dispatch; receipt/order-history evidence; reconciliation.
3. Freeze the artifact identities and link both canary reports into the final
   evidence index.

H092 passed after the Pixel 9 reconnected over USB as `55221VDAQ000J1`. The
machine preflight returned `RESULT h092_preflight=ALLOWED blocked=0` with live
commit disabled. The canary selected Amul Taaza Toned Milk 500 ml by voice and
Amul Vanilla Magic Ice Cream Tub by card. The first card request was accepted
and enqueued once; an immediate identical request was a duplicate with no
mutation. Both item operations reached verified terminal truth. Checkout
review showed COD to Home, ₹12 in provider charges, ₹236 total, eight-minute
ETA, and `NOT ORDERED`. No confirmation grant or final-dispatch action was
issued. Verified cleanup restored the empty cart.

The five retired migration environment variables were removed from the local
runtime configuration after this parity canary. H093 has not started because
it requires a separate fresh, exact, time-bounded authorization immediately
before the one allowed COD dispatch.
