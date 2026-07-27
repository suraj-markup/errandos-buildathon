# Sarvam + Hermes voice interface

JaldiAI Voice adds a multilingual speech boundary around the existing Hermes-to-JaldiAI flow:

```text
Browser microphone
  -> Sarvam Saaras v3 (speech to English + detected language)
  -> Hermes API server (conversation, clarification, JaldiAI skill)
  -> JaldiAI typed MCP tools (search, prepare, status, guarded commit)
  -> Hermes response with immutable facts marked
  -> Sarvam Translate (prose only) + Bulbul v3 (speech)
  -> localized text and audio in the browser
```

Sarvam does not receive provider sessions, Android state, proposal capabilities, cookies, or raw JaldiAI tools. Hermes remains the intelligence layer. JaldiAI remains the transaction authority.

## 1. Configure Hermes

Copy the `mcp_servers.errandos` entry from `hermes/mcp.example.yaml` into the active Hermes `~/.hermes/config.yaml`. Replace the repository path and secret placeholders with deployment-specific values.

Enable the Hermes API server in the active Hermes profile's `.env`:

```text
API_SERVER_ENABLED=true
API_SERVER_KEY=<strong-random-server-key>
```

Start Hermes:

```bash
hermes gateway
```

The default API address is `http://127.0.0.1:8642`. Keep it on loopback for a local deployment. The Next.js server calls Hermes server-to-server; the browser never receives `API_SERVER_KEY`.

## 2. Configure the web app

Create a local, uncommitted `.env.local` in `apps/web`:

```text
SARVAM_API_KEY=<sarvam-key>
SARVAM_API_BASE_URL=https://api.sarvam.ai
HERMES_API_URL=http://127.0.0.1:8642
HERMES_API_KEY=<same-api-server-key>
HERMES_MODEL=hermes-agent
```

Do not use a `NEXT_PUBLIC_` prefix for either credential. Do not paste real values into documentation, commits, screenshots, or chat.

## 3. Run locally

```bash
pnpm install
pnpm --filter @errandos/web dev
```

Open the URL printed by Next.js. Use the microphone button or the text fallback. The browser keeps a private Hermes session cookie for eight hours so clarification and confirmation turns remain connected.

## Exact-fact localization

The voice interface instructs Hermes to wrap provider-sourced terms in `[[fact:...]]` markers. The server splits the response into prose and fact segments, translates only prose in parallel, and reassembles the result before TTS.

Protected values include:

- product titles and pack sizes
- quantities and prices
- fees and totals
- ETA and delivery address
- payment mode and expiry
- proposal IDs, statuses, and provider references

The marker is never shown to the user. Tests verify that protected bytes are not sent to the translation endpoint.

## Transaction safety

Keep both gates disabled for normal development and the prepare-only demo:

```text
ERRANDOS_LIVE_BROWSER_ACTIONS=false
ERRANDOS_LIVE_COMMIT=false
```

Voice input is not itself a commit capability. Hermes must prepare and render the exact proposal, state that nothing has been ordered, and wait for explicit confirmation of those terms. JaldiAI still enforces proposal ownership, proposal hashes, idempotency, exact-term revalidation, at-most-once final action, and read-only reconciliation.

Do not ask users to speak phone numbers or OTPs into the Sarvam voice path. Use the private typed login flow and never echo or persist those values.

## Verification

Run the web package gates:

```bash
pnpm --filter @errandos/web test
pnpm --filter @errandos/web typecheck
pnpm --filter @errandos/web lint
pnpm --filter @errandos/web build
```

Before any live canary:

1. Verify Hermes lists the JaldiAI MCP tools.
2. Complete one search-only voice turn in each demo language.
3. Complete a multi-turn product clarification.
4. Prepare a cart and verify every displayed fact against JaldiAI output.
5. Confirm duplicate requests reuse one idempotency key.
6. Confirm an ambiguous result reconciles read-only and never triggers another final action.
7. Enable reversible actions only for a supervised test.
8. Enable live commit only for one deliberately approved, low-value COD canary.

## Hackathon demo cut line

The required demo is voice -> search -> exact prepared proposal -> localized playback. A live order is a stretch goal, not a requirement. Never substitute a fake success screen for a missing receipt.
