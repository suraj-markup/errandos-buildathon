# JaldiAI model, cost, and fallback policy

Status: implementation policy for T115
Owner: local voice runtime
Last reviewed: 2026-07-28

## Decision

JaldiAI keeps speech and phone control as separate domains:

1. Sarvam owns Indian-language speech recognition and speech synthesis.
2. `gpt-realtime-2.1` is the preferred persistent text/image control model
   after its guarded rollout gates pass.
3. The bounded Responses path remains available as the first operational
   fallback.
4. Deterministic semantic handling is the terminal fallback. It may ask the
   user for clarification or report that an action could not be verified, but
   it must never invent success.

OpenAI describes Realtime sessions as appropriate for low-latency open
connections and request-based APIs as appropriate for bounded requests. The
Realtime model supports text, audio, and image input plus function calling, but
JaldiAI deliberately disables OpenAI audio so Sarvam remains the speech
provider. Sources:

- <https://developers.openai.com/api/docs/guides/realtime>
- <https://developers.openai.com/api/docs/models/gpt-realtime-2.1>
- <https://developers.openai.com/api/docs/guides/realtime-costs>
- <https://developers.openai.com/api/docs/guides/images-vision>

## Runtime configuration

All settings are loaded and bounded by
`local/apps/voice/lib/runtime-policy.ts`. Invalid values fall back to safe
defaults or are clamped to a documented maximum.

| Concern | Environment setting | Default | Runtime bound |
| --- | --- | ---: | ---: |
| Realtime model | `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | validated model ID |
| Responses model | `OPENAI_BOUNDED_CONTROL_MODEL` | `gpt-4.1-mini` | validated model ID |
| Provider order | `JALDI_CONTROL_FALLBACK_ORDER` | Realtime, Responses, semantic | semantic fallback is mandatory |
| Realtime reasoning | `JALDI_REALTIME_REASONING_EFFORT` | `low` | `low` or `medium` |
| Conversation budget | `JALDI_REALTIME_CONTEXT_TOKEN_LIMIT` | 8,000 | 1,000–64,000 tokens |
| Session lifetime | `JALDI_REALTIME_MAX_SESSION_MS` | 15 minutes | 1–55 minutes |
| Reconnect attempts | `JALDI_REALTIME_RECONNECT_ATTEMPTS` | 2 | 0–5 |
| Reconnect base delay | `JALDI_REALTIME_RECONNECT_BASE_DELAY_MS` | 500 ms | 100–10,000 ms |
| Reconnect max delay | `JALDI_REALTIME_RECONNECT_MAX_DELAY_MS` | 2 seconds | 100–30,000 ms |
| Screenshot detail | `JALDI_SCREENSHOT_DETAIL` | `low` | `low`, `high`, or `auto` |
| Captures per task | `JALDI_SCREENSHOT_MAX_CAPTURES_PER_TASK` | 4 | 1–20 |
| Capture interval | `JALDI_SCREENSHOT_MIN_CAPTURE_INTERVAL_MS` | 5 seconds | 0–60 seconds |
| Encoded image size | `JALDI_SCREENSHOT_MAX_IMAGE_BYTES` | 1.5 MB | 32 KB–5 MB |
| Grounding deadline | `JALDI_SCREENSHOT_GROUNDING_TIMEOUT_MS` | 3.5 seconds | 250 ms–15 seconds |
| Task budget retention | `JALDI_SCREENSHOT_TASK_RETENTION_MS` | 15 minutes | 1–60 minutes |

The 15-minute application lifetime is intentionally shorter than any provider
limit. A task that outlives it receives a fresh control session containing only
the authoritative task summary, current item, pending clarification, and safe
operation state.

## Screenshot policy

Screenshots are not streamed continuously. Capture is allowed only at an
ambiguity, clarification, decision, explicit-attention request, or verification
failure. The default is `low` detail because OpenAI documents it as the
fast/low-cost option and JaldiAI binds actions to locally observed semantic
elements rather than trusting model-generated coordinates.

Use `high` only for a measured case where small text or visual distinctions
cannot be resolved semantically. `auto` is an operator override, not the
production default. Every image counts toward model tokens, so the byte limit,
capture interval, per-task count, and grounding deadline apply together.

Raw screenshots, Appium node IDs, and raw coordinates remain ephemeral.
Persistent logs contain correlation IDs, trigger, byte count, detail level,
latency, and a reason code—not image content.

## Reconnect and fallback behavior

1. A normal disconnect may reconnect twice with bounded exponential backoff
   from 500 ms to 2 seconds.
2. Authentication, permission, malformed-event, explicit cancellation, and
   safety failures do not reconnect.
3. A reconnect restores an authoritative summary; it does not replay a phone
   mutation.
4. If Realtime fails before a mutation, the current turn may fall back to the
   bounded Responses coordinator.
5. If failure happens at or after a mutation boundary, the runtime reconciles
   device state before deciding whether any provider may continue.
6. If both remote control paths fail, semantic fallback returns a truthful
   recoverable state. It never retries an uncertain mutation.

OpenAI notes that every Realtime response receives the current conversation and
later turns therefore become more expensive. JaldiAI caps the post-instruction
context and periodically starts a summarized session rather than keeping
unbounded history. Usage from `response.done` must be logged as aggregate text,
image, cached, and output token counts.

## Operational model and observation kill switches

The following operational flags are deliberately independent:

- `JALDI_REALTIME_SHADOW_V1`
- `JALDI_REALTIME_CONTROL_V1`
- `JALDI_REALTIME_PHONE_TOOLS_V1`
- `JALDI_SCREENSHOT_OBSERVATION_V1`
- `JALDI_VISION_GROUNDING_V1`

The unused OpenAI Realtime audio endpoint and `JALDI_REALTIME_VOICE_V1` were
removed; speech is not a Realtime rollout option. The ineffective
`JALDI_PRECISE_ATTENTION_V1` and `JALDI_OPERATION_LIFECYCLE_V1` switches were
also removed rather than advertising boundaries they did not control.

Disabling Realtime control or screenshot grounding must not disable Sarvam
transcription/synthesis, the bounded Responses path, authoritative task state,
operation reconciliation, cart safety, or final-order confirmation.

These switches change provider or observation capability, not task authority.
The local task repository, operation state, and verified provider result remain
authoritative across Realtime, Responses, and deterministic semantic fallback.

## Workflow release invariant

Workflow V2 is chosen by the release artifact, not by process environment.
Rollback deploys the prior version rather than enabling a second workflow
engine in the same process. The remaining hard-coded compatibility fields exist
only while H082 deletes V1 owners and disabled branches; they are not operator
controls.

`JALDI_PHONE_TASK_V2_STATE_PATH` configures durable repository storage only. It
does not select the workflow engine.

## Remaining migration switches

The following settings still select production compatibility paths and are
therefore tracked by H095 rather than treated as model kill switches:

| Setting | Compatibility boundary |
| --- | --- |
| `JALDI_ATOMIC_PRODUCT_SELECTION_V1` | Selects atomic selection enforcement. |
| `JALDI_STRUCTURED_PROGRESS_V1` | Selects structured progress production and overlay publication. |
| `JALDI_TASK_RECOVERY_V1` | Enables V2 startup recovery. |

None may be removed while both values still select production behavior.
Rollback becomes a prior versioned deployment only after the old path is
deleted and the H095 parity evidence passes. The exact current blockers are
recorded in `local/docs/2026-07-28-h095-migration-flag-audit.md`.

## Rollout and cost gates

Realtime phone tools remain off until shadow reports meet the quality thresholds
in T092/T097. Rollout order is shadow, read-only tools, reversible navigation,
cart mutation, and only then checkout review. Final order dispatch has a
separate live-commit gate and is not enabled by any Realtime flag.

For each rollout cohort record:

- per-stage p50/p95 latency;
- Realtime/Responses fallback rate;
- reconnect and cancellation rate;
- input text/image/cached tokens and output tokens;
- screenshots per task and image bytes;
- tool proposal acceptance/rejection;
- duplicate-mutation and unverifiable-outcome counts.

Any duplicate mutation, unsafe replay, false success, or cancellation-domain
violation immediately disables Realtime phone tools while leaving bounded voice
available.

## Offline enforcement

`pnpm release:offline:test` runs the runtime-policy bounds, single bounded
Responses fallback, quality-report, disabled-final-dispatch, read-only
reconciliation, adapter rollback, and provider at-most-once regressions without
contacting a device or provider.

`pnpm release:offline:report` compares those declared controls with the
H092–H095 evidence. It intentionally reports
`aggregate_model_usage_telemetry_present` as blocked until production-reachable
telemetry records aggregate input text, input image, cached, and output token
counts. Documentation alone is not cost evidence, and this blocker must not be
waived in the final release check.
