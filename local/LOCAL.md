# Local JaldiAI

`local/` is a self-contained phone-first JaldiAI workspace. It contains the
full hosted execution stack plus the buildathon-specific Android overlay and
voice server.

## What is included

- `apps/voice`: Sarvam STT/TTS, OpenAI tool planning, follow-up state, and the
  phone-facing API.
- `apps/android-overlay`: the thin push-to-talk and status surface installed on
  the phone.
- `apps/control-plane`, `apps/worker`, and `apps/web`: the copied control plane,
  worker, and hosted web client.
- `packages/provider-connectors`: the semantic Blinkit/Appium driver, bounded
  screen recovery, exact offer selection, cart verification, COD review, and
  guarded commit logic.
- `packages/contracts`, `application`, `domain`, `persistence`, and supporting
  packages: the typed and durable execution foundation.
- `hermes`, `infra`, `scripts`, and `docs`: the corresponding skills,
  deployment assets, utilities, tests, and design records.

The sibling `hosted/` directory remains unchanged and independently runnable.
No runtime dependency points from `local/` back to `hosted/`.

## Prototype flow

```text
hold overlay
  → Sarvam speech-to-text
  → OpenAI tool planning
  → local semantic Blinkit driver
  → search visible offers
  → ask a spoken follow-up when ambiguous
  → continue with the selected opaque offerId
  → mutate and verify the cart
  → Sarvam speaks the verified result
```

The overlay is intentionally only a voice-and-status interface. Product
matching, screen recovery, cart correctness, and transaction safety live in
the execution stack rather than in UI code.

## Run

The current demo needs the Android phone and Mac on the same network,
wireless ADB, Appium on the Mac, and server-managed OpenAI and Sarvam keys.
Copy `apps/voice/.env.example` to `apps/voice/.env.local`; never place keys in
the Android client or commit the local env file.

From `local/`:

```bash
pnpm install
pnpm --filter @errandos/voice dev
```

In another terminal, start Appium. Keep the real values only in
`apps/voice/.env.local`; use `apps/voice/.env.example` as the template.

The Android device serial may be a USB serial or a wireless ADB address:

```dotenv
APPIUM_URL=http://127.0.0.1:4723
ANDROID_DEVICE_UDID=192.168.1.100:5555
```

## Verify

```bash
pnpm --filter @errandos/provider-connectors test
pnpm --filter @errandos/voice test
pnpm --filter @errandos/voice typecheck
```

Live verification should begin with a broad search, which must return
`needs_clarification` without changing the cart. Only then test a selected
`offerId`. Never exercise the final Place Order action against a real cart
unless the user has explicitly reviewed and authorized the exact terms.
