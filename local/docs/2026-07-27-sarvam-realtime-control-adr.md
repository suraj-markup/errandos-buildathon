# ADR: Sarvam Speech with GPT Realtime Control

**Status:** Accepted. Text-only transport contract and deterministic prototype
verified; provider shadow evidence remains required before promotion.

## Context

JaldiAI needs strong Indian-language speech, persistent task reasoning,
screen-aware context, low-latency tool decisions, and strict local authority
over phone mutations.

OpenAI's GPT-Live announcement describes a full-duplex conversational model
that powers ChatGPT Voice. API access is planned rather than currently
available, and screen sharing is not supported at launch. It is therefore not
an implementation dependency for JaldiAI.

The generally available Realtime API supports text, audio, and image input,
text and audio output, and function calling. A screenshot is submitted as a
discrete conversation image rather than a live video stream.

## Decision

1. Sarvam remains the production STT and TTS provider.
2. `gpt-realtime-2.1` is evaluated as a persistent text/image control model.
3. The local Next.js backend owns the Realtime connection and OpenAI
   credential.
4. Android continues sending recorded speech to the bounded voice endpoint.
5. After Sarvam transcription, the backend sends:
   - the transcript as `input_text`;
   - bounded authoritative task state;
   - an optional redacted `input_image` selected by screenshot policy;
   - narrow validated function tools.
6. Realtime output is text and function calls only. Final deterministic text
   is synthesized by Sarvam.
7. Realtime tool calls are proposals. They must pass the shared schemas,
   operation registry, serialized queue, cancellation policy, and
   post-mutation verification.
8. GPT-4.1-mini/current Responses remains the bounded control fallback.
9. The unused OpenAI Realtime WebRTC audio prototype and its rollout flag are
   removed. Sarvam is the sole production speech provider.

## Transport

Use a server-side Realtime WebSocket for the production control session. This
avoids adding WebRTC and OpenAI credentials to the APK, keeps task/session
correlation on the authoritative backend, and allows the existing Android
audio path to remain unchanged.

The transport must support:

- connect, reconnect, cancellation, and bounded cleanup;
- text and optional image conversation items;
- text deltas and function-call lifecycle events;
- task, operation, observation, and response correlation;
- fall back to the bounded Responses control path without losing task state.

The backend connects directly to
`wss://api.openai.com/v1/realtime?model=<configured-model>` and authenticates
with the server-owned `OPENAI_API_KEY`. The APK continues to know only the
local JaldiAI backend URL. It receives neither the OpenAI key nor an ephemeral
Realtime credential. Every session is configured with
`output_modalities: ["text"]`; audio events and audio-shaped configuration are
rejected by the transport.

The app also applies `reasoning.effort` from runtime policy and bounds
conversation cost with `truncation.type="retention_ratio"`,
`retention_ratio=0.8`, and
`token_limits.post_instructions=JALDI_REALTIME_CONTEXT_TOKEN_LIMIT`.

The GA Realtime image content item does not expose the Responses API `detail`
control. Therefore `JALDI_SCREENSHOT_DETAIL=low|high` is enforced at the
adapter boundary by routing that grounded turn to Responses, which can honor
the requested detail. Realtime accepts an image only when detail is `auto`; it
never invents or sends an unsupported image-detail field.

### Connection and hotspot behavior

- Start timing before the socket factory is called and record the first
  successful `session.update` send as connection-ready.
- Reconnect only for an unexpected transport close. Authentication failures
  fail closed and never retry.
- Use bounded exponential backoff from `voiceRuntimePolicy.realtime`; queued
  control events remain serialized while reconnecting.
- A Wi-Fi/hotspot address change affects Android → local-backend reachability,
  not the backend → OpenAI WebSocket identity. Android retries a new voice turn;
  the authoritative task remains local and a Realtime reconnect cannot replay
  a completed phone call.
- Sessions are capped by `voiceRuntimePolicy.realtime.maxSessionDurationMs`.
  The session owner closes and recreates an expired transport while retaining
  authoritative task state outside the Realtime conversation.

### Correlation and state authority

The server binds each transport to `clientId`, `requestId`, `taskId`, and
`realtimeSessionId`, with optional item, clarification, selection, observation,
and operation identifiers. Received events add a local monotonic sequence and
connection-attempt number. Realtime conversation history is context only; the
authoritative task repository and local operation registry remain the source
of truth.

Phone calls are bound to the server's current task and item, not IDs proposed
by the model. The local adapter creates the operation ID before enqueueing,
validates the same command schema used by bounded HTTP control, serializes it
through the shared device queue, and caches the OpenAI `call_id`. Replaying the
same call after reconnect returns the prior result; reusing it with different
arguments fails closed. Final order dispatch is never exposed to Realtime.

### Cancellation domains

New push-to-talk performs two actions immediately and concurrently:

1. stop current Sarvam playback;
2. send `response.cancel` for obsolete Realtime output.

It does **not** cancel phone automation. Phone cancellation is a separate,
explicit task command governed by the operation's mutation boundary:
pre-mutation work can stop at a checkpoint, while a mutation that may have
occurred must finish read-only reconciliation.

Android stops its MediaPlayer and posts to
`/api/voice/cancel-response` when the 260 ms hold threshold is crossed, before
recording begins. The endpoint indexes only the active model response by
client and optional task. It has no phone-operation controller and returns
`phoneOperation: "unchanged"`.

### Bounded fallback

The active control order is Realtime → one bounded Responses attempt → a safe
local semantic error. Shadow mode is different: Responses remains the only
authority and Realtime runs beside it with no phone tools. A Realtime timeout
aborts only model generation. Tool execution happens after control selection
through the replay-safe local adapter, so fallback cannot independently repeat
a mutation.

### Verified prototype evidence

The local test suite verifies:

- server-only authentication and text-only `session.update`;
- ordered text/image events and text deltas;
- malformed-event rejection, auth failure, reconnect, and queued send order;
- response cancellation without task cancellation;
- identical sanitized inputs to Responses and Realtime shadow evaluators;
- zero shadow tool execution and redacted per-language/per-screen reports;
- schema rejection, obsolete task rejection, exact task/operation binding,
  duplicate call suppression, and reconnect replay safety;
- staged kill switches and one bounded Responses fallback.

A live no-phone text-only connectivity check completed successfully with
`gpt-realtime-2.1` and returned a message output. The first full 12-case,
six-language provider shadow run did not qualify for promotion: the redacted
report evaluated five Responses decisions but normalized zero Realtime
decisions. The transport remained healthy; the harness failed to extract a
scorable decision from completed Realtime output. A text-delta accumulator was
then added and verified against the live event sequence. The single post-fix
rerun improved Responses coverage to nine cases but still normalized zero
Realtime decisions. T092 and rollout promotion therefore remain open.

This is transport and safety evidence, not a provider-quality promotion. A
real GPT Realtime shadow corpus report must pass the rollout gate before
Realtime becomes the control authority.

## Feature flags

```env
JALDI_REALTIME_SHADOW_V1=false
JALDI_REALTIME_CONTROL_V1=false
JALDI_REALTIME_PHONE_TOOLS_V1=false
JALDI_REALTIME_ROLLOUT_STAGE=shadow
JALDI_REALTIME_ROLLOUT_APPROVED_V1=false
```

Rollout order:

1. deterministic offline corpus;
2. provider shadow with no tool execution;
3. developer text/image control;
4. read-only tools;
5. reversible cart tools;
6. broader task classes.

Promotion is fail-closed. Each stage requires a versioned report with a minimum
case count, Realtime quality floor, maximum quality regression against
Responses, p95 latency ceiling, failure-rate ceiling, and zero phone execution
in shadow. The independent control, screenshot/vision, and phone-tool flags can
lower the effective stage at runtime. No flag can raise it above the requested
and evaluated cohort.

## Consequences

- Sarvam preserves the intended Indian-language voice quality.
- Realtime can retain low-latency control context and accept screenshots.
- Phone automation latency remains bounded by Appium/provider behavior.
- General phone capability still requires explicit tools; a model change does
  not create arbitrary safe phone actions.
- Screenshot privacy, stale observations, mutation idempotency, and checkout
  confirmation remain local responsibilities.
- Realtime rollout changes control latency and context handling only; it does
  not replace Sarvam speech or grant general untyped device access.

## Official references

- [Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/)
- [Introducing gpt-realtime](https://openai.com/index/introducing-gpt-realtime/)
- [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime tools](https://developers.openai.com/api/docs/guides/realtime-mcp)
- [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
