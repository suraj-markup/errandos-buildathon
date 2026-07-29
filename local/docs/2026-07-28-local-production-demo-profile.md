# Local voice production-mode demo profile

Date: 2026-07-28

This operator profile runs the local voice server as a compiled Next.js
production build. It is a UI, presentation, connectivity, and latency demo
only. It does not authorize live shopping, an Appium session, a phone action,
a task submission, a cart mutation, checkout, confirmation, or ordering.

## Non-negotiable boundary

For this profile:

- do not press push-to-talk or submit audio;
- do not call any task, selection, interaction, operation, phone, cart,
  checkout, confirmation, or order endpoint;
- do not open Blinkit through automation or create an Appium session;
- do not run a provider inference, transcription, or synthesis request;
- do not change an ADB reverse mapping, install an APK, change a feature flag,
  or unlock the phone through automation;
- keep `ERRANDOS_LIVE_BROWSER_ACTIONS=false` and
  `ERRANDOS_LIVE_COMMIT=false`.

The connectivity preflight and keep-alive described below are bounded,
read-only health checks. A green result proves reachability only. It is not
permission to start a shopping flow.

## 1. Pin the workspace and device

Run all commands from `local/` in the frozen worktree that will be demonstrated.
Record `git rev-parse HEAD` and `git status --short`; do not print environment
files.

List connected transports:

```bash
adb devices -l
```

Choose exactly one complete value from the first column whose state is
`device`. A USB serial such as `55221VDAQ000J1` and a wireless serial such as
`192.168.88.7:5555` are different transports even when they identify the same
Pixel. Never rely on adb's implicit device selection and never shorten the
wireless serial to its IP address.

Verify the chosen literal before putting that same literal in `.env.local`:

```bash
adb -s '55221VDAQ000J1' get-state
adb -s '55221VDAQ000J1' shell getprop ro.serialno
```

Both commands must succeed for the intended phone. If more than one adb row
could match, the state is `offline`/`unauthorized`, or the identity is not the
expected device, stop.

## 2. Create an isolated server environment

The server-managed secrets belong only in
`apps/voice/.env.local`. That file is git-ignored and must remain mode `0600`.
Create it once from the example; do not overwrite an existing file:

```bash
test ! -e apps/voice/.env.local
umask 077
cp apps/voice/.env.example apps/voice/.env.local
chmod 600 apps/voice/.env.local
```

Edit it without shell tracing. Do not `source` it, pass secrets as command-line
arguments, paste it into a report, or use `cat`, `env`, `printenv`, or
`set -x` while handling it. At minimum, set:

```dotenv
OPENAI_API_KEY=<server-managed value>
SARVAM_API_KEY=<server-managed value>
APPIUM_URL=http://127.0.0.1:4723
ANDROID_DEVICE_UDID=55221VDAQ000J1
ERRANDOS_LIVE_BROWSER_ACTIONS=false
ERRANDOS_LIVE_COMMIT=false
JALDI_LOG_CONTENT_V1=false
JALDI_SCREENSHOT_OBSERVATION_V1=false
JALDI_VISION_GROUNDING_V1=false
JALDI_REALTIME_SHADOW_V1=false
JALDI_REALTIME_CONTROL_V1=false
JALDI_REALTIME_PHONE_TOOLS_V1=false
```

Use the exact serial selected in step 1, not the example serial above.
`OPENAI_API_KEY` and `SARVAM_API_KEY` must be non-placeholder server values,
but this no-live-shopping profile does not make a provider request.

Every command below starts with `env -i`. This removes stale inherited keys,
including an old live-commit value, before Next.js loads the reviewed
`apps/voice/.env.local`. Only the named process variables cross the boundary.
Do not replace these commands with a shell that already has secrets or rollout
flags exported.

## 3. Validate before building

From `local/apps/voice/`, run the offline profile validator:

```bash
env -i \
  PATH="$PATH" \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  node --env-file=.env.local --no-warnings --experimental-strip-types \
  scripts/validate-production-profile.ts
```

Validation must fail closed for a missing or placeholder provider key, a
non-loopback Appium URL, a missing/ambiguous device serial, enabled live
actions or commit, content logging, screenshots, or rollout flags that are not
part of this profile. It must report field names and reasons only—never secret
values.

Stop on any validation failure. Do not repair it by exporting a value in the
parent shell; update the reviewed `.env.local`, then rerun the isolated
validator.

## 4. Build once and start the frozen artifact

From `local/`, build the voice package and its declared prerequisites:

```bash
env -i \
  PATH="$PATH" \
  CI=1 \
  NEXT_TELEMETRY_DISABLED=1 \
  pnpm --filter @errandos/voice build
```

Do not use `next dev` or `pnpm --filter @errandos/voice dev` for latency
evidence. After the build succeeds, start that artifact on the overlay's
expected port:

```bash
env -i \
  PATH="$PATH" \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  pnpm --filter @errandos/voice start -- --port 3100
```

Keep this terminal dedicated to the server. Do not rebuild, edit `.env.local`,
or switch commits while collecting one evidence set. Record the Git commit,
dirty-state marker, start time, and HTTP status; do not record request bodies,
transcripts, UI trees, environment dumps, or secret-bearing headers.

## 5. Read-only connectivity preflight and keep-alive

Use the UX079 connectivity helper, not ad-hoc provider calls. Its contract is:

- require the exact `ANDROID_DEVICE_UDID` and reject missing, partial,
  ambiguous, offline, or unauthorized matches;
- use adb only to list devices and read the selected device state;
- use bounded GET or HEAD health probes for the local server, Appium, and
  provider connectivity;
- never create an Appium session, open an app, invoke inference, transcribe,
  synthesize, post a task, or touch phone/cart/checkout/order state;
- redact credentials, query values, response bodies, and headers;
- run keep-alive probes sequentially with a timeout, bounded interval/count,
  and abort support—never as an unbounded background loop.

Run its one-shot preflight first. Then, only while the production server is
running, use its bounded keep-alive mode. Stop if any target fails; do not
retry through a mutating route or a provider model/speech endpoint.

From `local/apps/voice/`, run exactly one read-only connectivity pass:

```bash
env -i \
  PATH="$PATH" \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  JALDI_PREFLIGHT_VOICE_URL=http://127.0.0.1:3100 \
  node --env-file=.env.local --no-warnings --experimental-strip-types \
  scripts/run-ux079-connectivity-preflight.ts
```

If the one-shot result is ready for every target, the server supports a
bounded keep-alive sample. This example performs at most ten passes, thirty
seconds apart, and can be cancelled earlier with `Ctrl-C`:

```bash
env -i \
  PATH="$PATH" \
  NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  JALDI_PREFLIGHT_VOICE_URL=http://127.0.0.1:3100 \
  node --env-file=.env.local --no-warnings --experimental-strip-types \
  scripts/run-ux079-connectivity-preflight.ts \
  --keep-alive --interval-ms=30000 --max-iterations=10
```

The existing H092 probe is an additional read-only gate:

```bash
ANDROID_DEVICE_UDID='55221VDAQ000J1' \
JALDI_READINESS_VOICE_URL='http://127.0.0.1:3100' \
JALDI_READINESS_APPIUM_URL='http://127.0.0.1:4723' \
local/scripts/h092-h095-readiness-canary.sh --h092-preflight
```

Replace the example serial with the exact selected literal. This probe reads
an existing reverse mapping but does not create one. For the current overlay,
`adb -s '<exact-serial>' reverse --list` must already show
`tcp:3100 tcp:3100`; changing that mapping is outside this profile.

An H092 result other than the exact
`RESULT h092_preflight=ALLOWED blocked=0` is a stop. Even an allowed result does
not widen this demo profile: no live shopping action is permitted.

## 6. Safe demo and shutdown

The allowed demo surface is:

- load `http://127.0.0.1:3100/` and verify the compiled UI;
- observe existing non-sensitive retained presentation state;
- inspect redacted server timing/health logs;
- run the one-shot and bounded keep-alive health checks.

Do not prove the profile by speaking a request, selecting a product, posting a
fixture to a live route, opening Blinkit, reading a live cart, or approaching
checkout. Automated tests use fakes and fixtures; this operator profile does
not.

Stop the keep-alive helper first, then stop `next start` with `Ctrl-C`. Confirm
no helper remains. Preserve only redacted evidence: commit/artifact identity,
the exact non-secret serial, command exit status, health status, and timing
summary. Never preserve `.env.local`, provider payloads, audio, screenshots,
addresses, phone numbers, OTPs, cart contents, or credentials.
