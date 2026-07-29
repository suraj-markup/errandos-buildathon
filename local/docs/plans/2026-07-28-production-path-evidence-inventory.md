# JaldiAI production-path evidence inventory

> **Audit date:** 2026-07-28
> **Scope:** H000–H002
> **Method:** Static production import traversal, explicit Android caller
> search, numbered-roadmap recount, focused regression execution, and existing
> physical/test-artifact review. Test files and scripts were excluded from the
> production traversal and classified separately.

## 1. Reconciled roadmap count

Before this audit:

- the master-plan header claimed **52 of 62** complete;
- its numbered checkboxes claimed **56 of 62** complete;
- twelve checked tasks described runtime behavior whose implementation graph
  had no production entry-point caller.

After this audit:

- the numbered backlog contains exactly **62** tasks;
- **44 are checked** and **18 are open**;
- the header and checkboxes agree;
- T070–T075, T080–T083, T110, and T111 were reopened.

Those tasks retain useful implementations and tests. They were reopened
because checked means production-reachable in this roadmap:

| Reopened tasks | Evidence gap |
| --- | --- |
| T070–T075 | The complete screenshot/privacy/observation/grounding graph is unreachable from every Next production entry point. |
| T080–T083 | Native parsing/rendering exists, but the server grounding and spatial-attention producers are not on an active request path. No production request can produce a fresh verified exact-attention command. |
| T110–T111 | Recovery persistence and coordinator recovery are imported only by each other and tests. No server startup or request entry point restores them. |

T092 remains complete because it is explicitly an evaluation task, and its
script-owned live shadow report is the required artifact rather than a
production request path.

## 2. Production entry points and callers

### Next.js entry points

| Entry point | Direct purpose | Principal production dependencies |
| --- | --- | --- |
| [`app/api/voice/turn/route.ts`](../../apps/voice/app/api/voice/turn/route.ts) | Sarvam voice turn | voice coordinator, authoritative workflow, operation queue, Blinkit execution, bounded Responses/guarded Realtime control, deterministic presentation |
| [`app/api/voice/cancel-response/route.ts`](../../apps/voice/app/api/voice/cancel-response/route.ts) | Stop obsolete model output | active Realtime response registry; phone operation remains independent |
| [`app/api/device/selection/route.ts`](../../apps/voice/app/api/device/selection/route.ts) | Atomic card selection | selection resolver, authoritative repository, shared phone executor |
| [`app/api/device/task/route.ts`](../../apps/voice/app/api/device/task/route.ts) | Manual/external narrow phone tool surface | command validation, shared phone executor, deterministic presentation |
| [`app/page.tsx`](../../apps/voice/app/page.tsx) | Local browser microphone client | `/api/voice/turn` only |

### Android entry points

The manifest exposes only
[`MainActivity`](../../apps/android-overlay/src/ai/errandos/overlay/MainActivity.java)
and the non-exported foreground
[`OverlayService`](../../apps/android-overlay/src/ai/errandos/overlay/OverlayService.java).
The service has exactly these backend callers:

- `POST /api/voice/turn`;
- `POST /api/voice/cancel-response`;
- `POST /api/device/selection`.

It does not call `/api/device/task`. The unused `/api/realtime/session`
prototype was removed under H084.

The native presentation/parser/card/recovery/motion classes are active through
`OverlayService`. `SpatialAttentionCommand` and `SpatialAttentionView` are
reachable native consumers, but no active server request path currently emits
their verified exact-target payload.

## 3. Production import graph

The traversal started from all non-test `app/**/{route,page,layout}.ts(x)`
entries and followed relative static imports. It found **46 active voice
library modules**:

| Runtime group | Active modules |
| --- | --- |
| Voice coordination | `voice-turn/coordinator`, `voice-turn/provider-adapters`, `voice-turn/presentation-adapter`, `voice-presentation`, `overlay-presentation-builder`, `screen-presentation` |
| Workflow/state | `workflow/state`, `workflow/transitions`, `workflow/repository`, `workflow/product-task`, `workflow/selection`, `workflow/selection-consumer`, `workflow/product-selection-presentation`, `workflow/identifiers`, `product-workflow`, `product-choice`, `bounded-history` |
| Phone execution | `phone-command`, `phone-tool`, `blinkit-execution`, `appium`, `operation-queue`, `operations/registry`, `cod`, `product-label` |
| Realtime control | `realtime/control-session`, `realtime/websocket-transport`, `realtime/node-websocket-factory`, `realtime/provider-adapter`, `realtime/tool-bridge`, `realtime/safe-phone-tools`, `realtime/cancellation-domains`, `realtime/active-response-registry`, `realtime/rollout-controller` |
| Realtime evaluation types | `realtime/shadow-coordinator`, `realtime/shadow-corpus`, `realtime/shadow-scorer`, `realtime/quality-report` |
| Progress/telemetry/configuration | `overlay`, `semantic-progress`, `stage-deadlines`, `stage-metrics`, `structured-logger`, `correlation`, `feature-flags`, `runtime-policy` |

### Script/test reachability, excluded from production

| Classification | Modules | Caller/owner |
| --- | --- | --- |
| Unwired planned runtime | `grounding/observation-registry`, `grounding/observe-screen`, `grounding/privacy`, `grounding/screenshot-capture`, `grounding/semantic-candidates`, `grounding/spatial-attention`, `grounding/structured-grounding`, `grounding/trigger-policy` | Unit tests only. Retain for H070–H075; do not count as production-complete. |
| Unwired planned runtime | `workflow/recovery-persistence`, `workflow/recovery-coordinator` | Unit tests and each other only. Retain for H020–H021 or replace with the chosen production repository. |
| Script-owned evaluation | `realtime/live-shadow-evaluators`, `realtime/shadow-runtime` | [`scripts/run-realtime-shadow.ts`](../../apps/voice/scripts/run-realtime-shadow.ts); retain as T092/T103 evaluation tooling. |

## 4. Runtime classification and convergence ownership

| Surface | Classification | Named callers | Parity evidence | Rollback/convergence owner |
| --- | --- | --- | --- | --- |
| Authoritative V1 task path | Active | voice coordinator, device selection route | route/workflow/selection suites | H010–H014, then H082 |
| Non-authoritative conversation map | Compatibility | voice coordinator when `JALDI_AUTHORITATIVE_TASK_STATE_V1=false` | route regression suite | H082; retain flag rollback until V2 parity |
| Shared Blinkit execution | Active | voice coordinator, selection route, device task route, Realtime safe adapter | Blinkit execution, phone-tool, provider connector suites | H040–H044 |
| `prepare_grocery`, `prepare_cod_checkout`, `confirm_cod_order` aliases | Compatibility | command normalization and UI labels | command and execution parity tests | H083 |
| Bounded Responses control | Active fallback | voice coordinator | coordinator/route and runtime-policy suites | T097/H095; must remain rollback path during Realtime rollout |
| Server Realtime text/image control | Feature-flagged active | voice coordinator through rollout controller/provider adapter | Realtime transport/tool/cancellation suites and shadow report | T097 |
| `/api/realtime/session` OpenAI-audio endpoint | Removed | none; Android and web caller audits were empty | focused tests, typecheck, and production route build | H084 complete; Sarvam owns speech |
| `/api/device/task` | Externally uncertain/manual | no Android/web caller | command/phone-tool route coverage | H086 inventory gate before deletion |
| Android legacy presentation parsing | Compatibility active | `OverlayService` parser fallback | native source/parser fixtures | H082/H095 after protocol migration |
| Grounding and exact-attention producer graph | Unwired | no production entry point | grounding unit tests and native fixtures | H070–H075; retain, do not delete |
| Recovery persistence/coordinator | Unwired | no production entry point | recovery persistence/coordinator tests | H020–H021; retain or replace after parity |
| Shadow evaluators/runtime | Script-only | `run-realtime-shadow.ts` | dated live shadow artifact | T103; retain as evaluation tooling |

### H085 feature-flag reachability update

| Setting | Decision | Production boundary |
| --- | --- | --- |
| `JALDI_OPERATION_LIFECYCLE_V1` | Removed | None existed. |
| `JALDI_PRECISE_ATTENTION_V1` | Removed | None existed; planned exact-attention work remains owned by H070–H075 without advertising an effective switch. |
| `JALDI_REALTIME_VOICE_V1` | Removed | Its only boundary was the removed H084 prototype. |
| `JALDI_TASK_RECOVERY_V1` | Retained | Next.js `instrumentation.ts` calls the V2 startup recovery boundary, which requires both this flag and `JALDI_PHONE_TASK_V2`. |

No module in the unwired table is approved for immediate deletion. Each has a
named backlog owner and either planned wiring or an explicit replace/delete
decision. Future deletion requires the listed parity suite and a documented
rollback path.

## 5. Completed-task evidence ledger

Every task left checked in the master plan has code plus a passing automated or
physical artifact:

| Task | Production evidence | Test or physical evidence |
| --- | --- | --- |
| T000 | Baseline captured in the native report | [`TEST-REPORT.md`](../../apps/android-overlay/test-artifacts/TEST-REPORT.md) |
| T001 | [`feature-flags.ts`](../../apps/voice/lib/feature-flags.ts) | [`feature-flags.test.ts`](../../apps/voice/lib/feature-flags.test.ts) |
| T002 | [`workflow/identifiers.ts`](../../apps/voice/lib/workflow/identifiers.ts), shared overlay contracts | identifier and contract tests |
| T010 | [`workflow/state.ts`](../../apps/voice/lib/workflow/state.ts) | [`product-task.test.ts`](../../apps/voice/lib/workflow/product-task.test.ts) |
| T011 | [`workflow/transitions.ts`](../../apps/voice/lib/workflow/transitions.ts) | [`transitions.test.ts`](../../apps/voice/lib/workflow/transitions.test.ts) |
| T012 | [`workflow/repository.ts`](../../apps/voice/lib/workflow/repository.ts) | [`repository.test.ts`](../../apps/voice/lib/workflow/repository.test.ts) |
| T013 | [`workflow/product-task.ts`](../../apps/voice/lib/workflow/product-task.ts) | product-task and product-workflow tests |
| T014 | [`voice-turn/coordinator.ts`](../../apps/voice/lib/voice-turn/coordinator.ts) | route authoritative-state regression suite |
| T020 | [`operations/registry.ts`](../../apps/voice/lib/operations/registry.ts) | [`registry.test.ts`](../../apps/voice/lib/operations/registry.test.ts) |
| T021 | [`operation-queue.ts`](../../apps/voice/lib/operation-queue.ts) | [`operation-queue.test.ts`](../../apps/voice/lib/operation-queue.test.ts) |
| T022 | operation registry mutation/cancellation policy | registry and operation-queue cancellation cases |
| T023 | cancel command plus coordinator checkpoints | operation-queue and route cancellation tests |
| T030 | product-selection binding in shared overlay contracts | contract and selection tests |
| T031 | [`workflow/selection.ts`](../../apps/voice/lib/workflow/selection.ts) | [`selection.test.ts`](../../apps/voice/lib/workflow/selection.test.ts) |
| T032 | [`device/selection/route.ts`](../../apps/voice/app/api/device/selection/route.ts) | native product-selection and selection-consumer tests |
| T033 | [`OverlayCardView.java`](../../apps/android-overlay/src/ai/errandos/overlay/OverlayCardView.java) | `ProductSelectionStateTest` in the native build |
| T034 | selection resolver/consumer atomic claim | native-product-selection and selection-consumer race tests |
| T040 | exact offer propagation through Blinkit execution | Blinkit execution and Android driver exact-identity tests |
| T041 | mutation/verification result contract in Blinkit execution | Blinkit execution result matrix |
| T042 | verified advancement in product-task transitions | product-task and authoritative route regressions |
| T043 | unrelated-line fingerprint preservation in Android driver | provider connector Android-driver suite |
| T050 | unified checkout preparation in Blinkit execution | COD and Blinkit execution proposal tests |
| T051 | checkout proposal/hash revalidation | [`cod.test.ts`](../../apps/voice/lib/cod.test.ts) and execution tests |
| T052 | at-most-once dispatch and ambiguity handling | COD/operation/execution timeout and duplicate tests |
| T053 | one production checkout implementation after H080/H081 cleanup | 445-test voice suite and production build recorded in the hardening plan |
| T060 | typed provider/presentation adapters | provider and presentation adapter contract tests |
| T061 | thin 28-line route plus injectable coordinator | coordinator and route suites |
| T062 | [`semantic-progress.ts`](../../apps/voice/lib/semantic-progress.ts) on active phone/overlay checkpoints | semantic-progress and Blinkit execution progress tests |
| T063 | native task parsing/rendering through `OverlayService` | native `OverlayTaskProgressTest` and `SemanticProgressStateTest` |
| T064 | [`stage-deadlines.ts`](../../apps/voice/lib/stage-deadlines.ts) | [`stage-deadlines.test.ts`](../../apps/voice/lib/stage-deadlines.test.ts) |
| T090 | Realtime control-session/transport interfaces | control-session and websocket-transport suites |
| T091 | shadow corpus/scorer/report types | shadow corpus/scorer/quality tests |
| T092 | tool-suppressed live shadow run | [`realtime-shadow-2026-07-28.md`](../../apps/voice/test-artifacts/realtime-shadow-2026-07-28.md) |
| T093 | server WebSocket transport decision | [`2026-07-27-sarvam-realtime-control-adr.md`](../2026-07-27-sarvam-realtime-control-adr.md) |
| T094 | active provider adapter and WebSocket transport | provider/transport reconnect and fallback suites |
| T095 | independent response/playback/phone cancellation domains | cancellation-domain and cancel-response route suites |
| T096 | shared safe Realtime phone-tool bridge | safe-phone-tools and tool-bridge suites |
| T100 | [`bounded-history.ts`](../../apps/voice/lib/bounded-history.ts) | bounded-history and route truncation tests |
| T101 | [`correlation.ts`](../../apps/voice/lib/correlation.ts) plus structured logger | correlation and structured-logger privacy tests |
| T102 | [`stage-metrics.ts`](../../apps/voice/lib/stage-metrics.ts) | stage-metrics and timeout suites |
| T103 | Realtime quality report generator | quality-report tests and dated shadow artifact |
| T112 | active native local recovery snapshot through `OverlayService` | `OverlayRecoverySnapshotTest` in the signed native build |
| T113 | active native microphone/playback energy and motion policy | `MotionPolicyTest` and native build |
| T114 | native accessibility/lifecycle policies and source contracts | seven native test programs plus signed APK evidence in `TEST-REPORT.md` |

## 6. H001 frozen regression

[`route.multi-item-checkout-regression.test.ts`](../../apps/voice/app/api/voice/turn/route.multi-item-checkout-regression.test.ts)
uses the production route with fake providers/executor and establishes:

1. milk options are shown;
2. exact milk offer is selected and verified;
3. ice-cream options are shown;
4. exact ice-cream offer is selected and verified;
5. the later COD-only utterance must make zero `search_products` and
   `add_cart_item` calls and exactly one `prepare_checkout` call.

The fixture was first introduced with `it.fails` and reproduced terminal
cleanup allowing the model to resurrect two completed adds from prose history.
During validation, the checkout-intent guard landed and caused the expected
failure to report an unexpected pass. The test is now a normal required
regression: the model still proposes the two stale adds, while the production
coordinator must suppress them and execute exactly one checkout preparation.

Focused result on 2026-07-28 after promotion: **2/2 Vitest cases passed**. No
phone, cart, checkout, or order action was performed.
