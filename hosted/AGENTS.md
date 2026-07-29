# AGENTS.md

Guidance for AI agents working in this repository.

## Product identity

This repository is ErrandOS: a Hermes-first personal operations control plane for daily-life errands in India.

The product is not a generic chatbot. It is a transaction-safe tool layer that lets Hermes search products, prepare grocery carts, render exact terms, place owner-authorized Blinkit COD orders at most once, reconcile uncertain outcomes, and return receipts/status.

## Canonical implementation roadmap

The owner-approved Blinkit Step 1–8 sequence, definitions of done, and current status are maintained in [`docs/blinkit-implementation-roadmap.md`](docs/blinkit-implementation-roadmap.md). Read that file before describing step status or starting the next roadmap step. Do not infer step numbers from older plans or rename/reorder steps without an explicit owner decision. Update its status table and evidence whenever a step materially advances.

## Architecture boundary

Hermes is the intelligence layer. ErrandOS is the durable transaction layer.

Hermes should own:

- conversation and intent understanding
- asking for missing information
- deciding which typed ErrandOS tool to call
- rendering structured results clearly
- follow-up orchestration

ErrandOS should own:

- provider account/session custody
- provider sessions, emulator state, and provider state
- proposal snapshots and hashes
- approval verification
- idempotency and duplicate-action prevention
- final provider actions
- receipts, lifecycle, audit, and reconciliation state

Do not move long-term intelligence, memory, or general chat orchestration into the web app or provider connectors.

## Target provider adapter policy

Every Blinkit interaction must go through the provider-specific `AndroidBlinkitAdapter`, including product discovery, authentication, cart preparation, checkout review, COD selection, commit, status, and reconciliation. The adapter controls the official Blinkit Android app through local-only Appium and a principal-isolated persistent emulator. Playwright is not an active Blinkit runtime. Do not expose raw Appium, ADB, selectors, coordinates, UI XML, arbitrary device commands, OTPs, cookies, or emulator state through MCP. Screenshots are internal by default; the only user-visible exception is the personal owner-only post-order evidence flow defined below, and that exception must not become a generic MCP screenshot or device-control tool.

Blinkit and Rapido are the active Android providers. Rapido ride quotes, preparation, comparison, request, status, history, and reconciliation must go through the provider-specific `AndroidRapidoAdapter` and the official Rapido Android app. Do not add or activate another provider runtime unless the owner explicitly reopens it. Do not substitute third-party provider APIs, reverse-engineer private provider/mobile APIs, intercept provider traffic, bypass device integrity, or misrepresent the emulator.

The Android adapter may prepare a provider cart only when the legacy provider-action gate `ERRANDOS_LIVE_BROWSER_ACTIONS=true`; the variable name does not activate Playwright. Preparation must stop before the final order action. The adapter must persist exact extracted terms and a provider fingerprint, bind trusted approval to the immutable proposal hash, revalidate exact terms before commit, and attempt the final provider action at most once. COD is a paid external action and follows the same gate. A timeout, device failure, or any unverified result is `ambiguous`; reconciliation is read-only and must never repeat the final action.

## Safety rules

These rules are mandatory:

1. Search and status reads are safe.
2. Grocery preparation may interact with the official provider app but must stop before the final order action.
3. COD and cash are still paid external actions.
4. External-approval mode does not treat chat text as approval. In personal owner-autonomous mode, explicit ordering intent permits `place_cod_order` for Blinkit COD only.
5. Every commit requires an idempotency key. External-approval mode additionally requires a valid approval capability.
6. Final provider action may be attempted at most once.
7. Ambiguous provider results must enter reconciliation; never blindly retry a final click.
8. Personal mode may accept phone and OTP through typed MCP login tools. Never echo, log, persist, trace, or screenshot those values. Do not expose raw Appium or ADB commands, clicks, coordinates, selectors, UI XML, cookies, passwords, emulator state, or provider-session paths. Outside the personal owner-only post-order evidence flow below, do not expose emulator screenshots.
9. Do not commit secrets, `.env` files, provider sessions, screenshots with PII, traces with tokens, or generated emulator state.
10. Never claim an order/ride succeeded unless a committed receipt or verified provider reference exists.

## Live-action gates

Reversible provider actions are disabled unless:

```text
ERRANDOS_LIVE_BROWSER_ACTIONS=true
```

Final order/booking actions are separately disabled unless:

```text
ERRANDOS_LIVE_COMMIT=true
```

Keep both false by default. Tests should not require live external provider actions.

## Personal owner-autonomous COD mode

For one trusted owner on their own VPC, enable:

```text
ERRANDOS_DEPLOYMENT_PROFILE=personal
ERRANDOS_TRUSTED_AUTONOMOUS_COD=true
```

This removes the external approval capability only for Blinkit grocery proposals paid by COD. It does not remove exact-term revalidation, proposal hashing, idempotency, the unique final-action check, at-most-once dispatch, verified receipts, or read-only reconciliation. Turning either live-action gate off is the immediate kill switch.

## Personal owner-only post-order evidence

For one trusted owner on their own VPC, ErrandOS may send a raw Blinkit order confirmation, tracking, or delivered-screen image to that owner's configured private Telegram DM when:

```text
ERRANDOS_DEPLOYMENT_PROFILE=personal
ERRANDOS_OWNER_ORDER_EVIDENCE=true
```

This exception is deliberately narrow:

- The durable transaction must already be `committed` with a verified provider reference. A screenshot is supporting evidence, never the source of transaction truth.
- Delivery is restricted to the single configured owner identity and is denied in groups, shared channels, or any other recipient.
- The image may contain that owner's delivery address and masked contact details because the owner explicitly opted into this personal evidence flow.
- Capture happens just in time, the temporary file is owner-readable only, and it must be deleted after delivery. It must not enter source control, logs, traces, backups, proposal data, or long-term application storage.
- Login, OTP, password, payment credential, bank challenge, and authentication screens remain prohibited.
- This does not permit a generic screenshot, Appium, ADB, coordinate, selector, XML, or arbitrary device-control MCP tool.
- The feature is off by default. Turning `ERRANDOS_OWNER_ORDER_EVIDENCE` off is its immediate kill switch.

## Commands

Use pnpm workspaces.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run a package-specific command with:

```bash
pnpm --filter <package-name> <script>
```

Examples:

```bash
pnpm --filter @errandos/control-plane dev
pnpm --filter @errandos/web dev
pnpm --filter @errandos/contracts test
pnpm --filter @errandos/persistence test
```

## PostgreSQL tests

Persistence integration tests require PostgreSQL. Do not silently skip them and then claim full durability is verified.

Default local test URL:

```text
postgresql:///errandos_test?host=/var/run/postgresql
```

If using the provided test harness, follow the README instructions for `TEST_DATABASE_URL` and Docker Compose.

## Development workflow

For behavior changes:

1. Add or identify a failing test first when practical.
2. Implement the smallest safe change.
3. Run the narrow package test.
4. Run broader gates before finishing:
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm test`
   - `pnpm build`
5. Check `git diff --check` before committing.

For transaction or provider changes, include tests for:

- principal/owner isolation
- stale proposal rejection
- material-change hash changes
- idempotent duplicate handling
- single-use approval consumption
- ambiguous outcome handling
- no secret/PII leakage in returned data

## Coding conventions

- TypeScript ESM throughout.
- Zod contracts define MCP/API boundaries.
- Keep provider-specific behavior behind typed ports.
- Keep domain models vertical-specific; do not force groceries, rides, courier, and products into one generic product type.
- Prefer deterministic presentation helpers over prompt-only formatting.
- Preserve exact provider facts; never invent price, ETA, delivery terms, or URLs.
- Keep files small and modules focused.

## MCP tool expectations

MCP tools should be narrow and typed. They should return structured content that Hermes can render.

Expected classes of tools:

- health/readiness
- provider auth status
- supervised provider login
- product search
- grocery preparation
- provider-specific ride preparation
- proposal/status reads
- approval-gated commit
- read-only reconciliation

Never add a generic `browser_click`, `run_javascript`, `use_provider_session`, or `raw_checkout` tool.

## Rendering expectations

When rendering ErrandOS output to users:

- Convert JSON into readable text/cards.
- Show exact provider, item, quantity, price/fare, ETA, address/route, payment mode, expiry, and status when present.
- Say clearly when nothing has been ordered or booked.
- If status is `approval_required`, direct the user to the trusted approval flow; do not ask them to paste capabilities into chat.
- If status is `ambiguous`, say reconciliation is required and do not claim success.

## Buildathon scope guidance

For a same-day MVP, focus on one reliable vertical slice instead of many fragile provider automations.

Priority:

1. Product search through Hermes/ErrandOS.
2. Grocery cart proposal preparation.
3. Exact proposal rendering.
4. Approval boundary.
5. Receipt/status UI.
6. Paid beta CTA.

Stretch:

- supervised Blinkit login
- live cart preparation with commits disabled
- one low-value approved COD canary
- one provider-specific quote/prepare flow after an explicit owner decision

Avoid:

- full auth/subscription systems
- fragile multi-provider checkout automation
- fake successful bookings
- multi-book-and-cancel courier races
- unbounded scraping or provider interaction

## Git hygiene

- Do not commit generated build directories such as `dist/` or `.next/`.
- Do not commit dependencies such as `node_modules/`.
- Do not commit `.env`, `.env.local`, emulator profiles, provider state, traces, or logs.
- Keep public commits clean and scoped.
- Before pushing, verify the repo does not contain secrets or credential-equivalent files.

## If unsure

Choose the safer path:

- prepare instead of commit
- read-only status instead of mutation
- explicit proposal instead of inferred action
- reconciliation instead of retry
- trusted approval instead of chat confirmation
