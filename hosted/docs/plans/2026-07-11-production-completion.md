# JaldiAI Production Completion Implementation Plan

> **For Hermes:** Use subagent-driven-development to execute this plan task-by-task with spec review, code-quality review, and verification after each milestone.

**Goal:** Turn the existing JaldiAI foundation into a safe, production-capable Telegram-first system that can search products, prepare Blinkit/Zepto carts, obtain independent human approval, commit exactly once, reconcile uncertain outcomes, and render every lifecycle state clearly.

**Architecture:** Hermes remains the conversational orchestrator. A durable transaction control plane owns proposals, state transitions, idempotency, receipts, and reconciliation. A separately deployed approval issuer authenticates the human and signs exact immutable proposal revisions; Hermes never receives the signing key or bearer authorization. Provider-specific Playwright adapters perform visible preparation and one guarded final action, with PostgreSQL and an outbox worker providing atomicity and crash recovery.

**Tech stack:** TypeScript, Node.js, Fastify, Next.js, Zod, PostgreSQL, Playwright, JOSE with Ed25519/ES256, pnpm workspaces, Vitest, Playwright Test, Docker/Compose for local integration.

---

## Non-negotiable invariants

1. Chat text such as “yes” is conversational intent, never transaction authorization.
2. Hermes/MCP never receives signing private keys, OTPs, cookies, provider profile paths, or raw approval capabilities.
3. The portal displays and approves the same versioned canonical bytes checked immediately before commit.
4. Any material change to cart, total, fees, address, route, ride type, payment method, or expiry invalidates approval.
5. A final provider action is clicked at most once. Unknown outcomes enter reconciliation and are never blindly retried.
6. Grocery preparation may mutate a cart but cannot place an order.
7. Every externally visible state is durable, principal-scoped, timestamped, redacted, and renderable.
8. Live browser actions and live commits remain off by default and require separate gates.

## Target flow

`request → prepare provider state → persist immutable proposal → render in chat → open trusted approval URL → authenticate/step-up → approve exact revision → attach authorization server-to-server → reserve dispatch atomically → revalidate provider terms → click once → persist receipt or ambiguous state → reconcile read-only → render final status`

---

# Milestone 1 — Canonical proposal and lifecycle contracts

## Task 1.1: Split transaction contracts into focused modules

**Files**
- Create: `packages/contracts/src/proposals.ts`
- Create: `packages/contracts/src/approvals.ts`
- Create: `packages/contracts/src/lifecycle.ts`
- Create: `packages/contracts/src/transactions.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/proposals.test.ts`
- Test: `packages/contracts/test/lifecycle.test.ts`

**Steps**
1. Add failing schema round-trip and strict-rejection tests.
2. Introduce versioned grocery and ride proposal snapshots containing provider, principal-bound references, selected lines/ride option, fee/fare breakdown, address/route summaries, payment mode, prepared timestamp, and quote expiry.
3. Add lifecycle envelope with operation ID, event ID, monotonic sequence, occurred-at, kind, phase, terminal/retryable flags, and redacted display payload.
4. Keep V1 exports working during migration.
5. Run `pnpm --filter @errandos/contracts test && pnpm --filter @errandos/contracts typecheck`.
6. Commit: `feat: define canonical proposal and lifecycle contracts`.

**Acceptance criteria**
- Schemas reject unknown fields and secret-bearing fields.
- Existing V1 tests remain green.
- Search, login, preparation, approval, commit, and reconciliation phases have explicit meanings.

## Task 1.2: Implement versioned canonicalization and hashing

**Files**
- Create: `packages/application/src/proposals/canonicalize.ts`
- Test: `packages/application/test/proposal-canonicalization.test.ts`
- Modify: `packages/application/src/transactions.ts`

**Steps**
1. Write failing tests proving key-order independence and deterministic UTF-8 bytes.
2. Write tests proving the hash changes for provider, product ID, quantity, amount, fee, address, route, ride type, payment mode, expiry, and revision.
3. Implement explicit canonical field ordering; do not rely on arbitrary `JSON.stringify` insertion order.
4. Prefix bytes with a schema/version domain separator.
5. Replace summary-only hashing in proposal creation.
6. Run narrow tests, then full application tests.
7. Commit: `feat: canonicalize immutable proposal revisions`.

**Acceptance criteria**
- Portal display model and commit verifier derive from the same snapshot.
- Material-field mutation always changes the hash.

---

# Milestone 2 — PostgreSQL durability and atomic transaction state

## Task 2.1: Add transaction authorization migration

**Files**
- Create: `packages/persistence/migrations/003_transaction_authorization.sql`
- Create: `packages/persistence/test/migrations.test.ts`
- Modify: `packages/persistence/package.json`

**Tables**
- `proposal_revisions`
- `approval_requests`
- `approval_decisions`
- `authorization_capabilities`
- `commit_attempts`
- `transaction_receipts`
- `transaction_outbox`
- `reconciliation_attempts`
- `lifecycle_events`
- `audit_events`

**Required constraints**
- Unique `(principal_id, idempotency_key)`.
- Unique capability JTI.
- One active dispatch reservation per proposal revision.
- Approval references exact proposal ID, revision, principal, and hash.
- Append-only proposal revisions and audit events.

**Verification**
- Run migrations against ephemeral PostgreSQL.
- Roll back/reapply in test.
- Commit: `feat: add durable transaction authorization schema`.

## Task 2.2: Implement PostgreSQL repositories

**Files**
- Create: `packages/persistence/src/postgres.ts`
- Create: `packages/persistence/src/proposal-repository.ts`
- Create: `packages/persistence/src/approval-repository.ts`
- Create: `packages/persistence/src/transaction-repository.ts`
- Create: `packages/persistence/src/outbox-repository.ts`
- Create: `packages/persistence/src/lifecycle-repository.ts`
- Create: `packages/persistence/src/audit-repository.ts`
- Modify: `packages/persistence/src/index.ts`

**TDD cases**
- Owner isolation.
- Append-only revision behavior.
- Atomic authorization consume + commit reservation + outbox insert.
- Rollback leaves authorization unconsumed.
- Twenty concurrent requests produce exactly one winner.
- Duplicate outbox delivery is idempotent.

**Acceptance criteria**
- Filesystem persistence remains only as a local/test adapter.
- Production wiring fails readiness when PostgreSQL is unavailable.

---

# Milestone 3 — Independent approval boundary

## Task 3.1: Add approval request lifecycle

**Files**
- Create: `packages/application/src/approvals/approval-service.ts`
- Create: `packages/application/test/approval-policy.test.ts`
- Modify: `packages/contracts/src/approvals.ts`

**States**
- `pending → approved | rejected | expired`
- Terminal decisions cannot change.
- Revised proposal invalidates old requests and authorizations.
- Portal request token is 256-bit random and only its hash is stored.

## Task 3.2: Add asymmetric authorization verification

**Files**
- Create: `packages/application/src/approvals/capability-verifier.ts`
- Test: `packages/application/test/capability-verification.test.ts`

**Claims**
- `iss`, `aud`, `sub`, `jti`, `iat`, `nbf`, `exp`, `kid`
- `principal_id`, `proposal_id`, `proposal_revision`, `proposal_hash`
- `approval_request_id`, `action`

**Negative tests**
- Wrong algorithm, issuer, audience, key ID, action, principal, revision, or hash.
- Expired/not-yet-valid/excessive-TTL authorization.
- Replay and malformed claims.
- Verifier possesses public keys only.

## Task 3.3: Build separately deployable approval issuer

**Files**
- Create app: `apps/approval-issuer/`
- Add `src/app.ts`, `src/index.ts`, `src/auth/*`, `src/policy/*`, `src/signing/*`, `src/routes/*`
- Add route/security tests under `apps/approval-issuer/test/`

**Behavior**
- OIDC login with recent step-up requirement.
- CSRF and Origin/Host validation.
- POST-only approve/reject.
- Browser cannot override proposal claims.
- Signing through a KMS/HSM interface; local Ed25519 signer only for development.
- Signed authorization delivered server-to-server, never rendered to the browser.

## Task 3.4: Build mobile approval portal

**Files**
- Create: `apps/web/app/r/[requestToken]/page.tsx`
- Create: `apps/web/app/r/[requestToken]/approval-form.tsx`
- Create: `apps/web/app/r/[requestToken]/actions.ts`
- Create: `apps/web/app/r/[requestToken]/result/page.tsx`
- Create: `apps/web/lib/approval-api.ts`
- Create: `apps/web/middleware.ts`
- Add component and Playwright E2E tests.

**Security headers**
- CSP with no third-party scripts.
- HSTS, `Referrer-Policy: no-referrer`, frame denial.
- Secure HttpOnly SameSite cookies.
- No analytics on approval pages.

**Acceptance criteria**
- Works in Telegram in-app browser at mobile widths.
- Displays exact grocery/ride terms and explicit final action language.
- No capability appears in URL, HTML, logs, or client network response.

---

# Milestone 4 — Durable commit worker and lifecycle rendering

## Task 4.1: Implement durable commit state machine

**Files**
- Create: `packages/application/src/transactions/commit-service.ts`
- Create: `packages/application/src/transactions/reconciliation-service.ts`
- Create: `apps/worker/src/commit-worker.ts`
- Create: `apps/worker/src/reconciliation-worker.ts`
- Create: `apps/worker/src/outbox-worker.ts`
- Add crash/concurrency tests.

**States**
- `approval_required`, `authorized`, `dispatch_reserved`, `dispatching`, `committed`, `ambiguous`, `reconciling`, `failed_terminal`, `rejected`, `stale`.

**Crash tests**
- Before provider action.
- During click/navigation.
- After provider success before receipt persistence.
- Lease expiry and duplicate outbox delivery.

**Acceptance criteria**
- No recovery path repeats a final click.
- Restart from `dispatching` becomes `ambiguous` and queues reconciliation.

## Task 4.2: Add deterministic presentation package

**Files**
- Create package: `packages/presentation/`
- Add `src/search.ts`, `src/proposal.ts`, `src/status.ts`, `src/auth.ts`, `src/index.ts`
- Add rendering/escaping/splitting tests.
- Modify: `apps/control-plane/src/mcp.ts`
- Modify: `hermes/skills/errandos/SKILL.md`

**Acceptance criteria**
- MCP returns readable text plus unchanged structured content.
- Telegram/Discord Markdown, CLI text, and web view models share facts.
- Long results split at complete blocks.
- No values are invented.

---

# Milestone 5 — Provider-specific live adapters

## Task 5.1: Extract shared browser runtime

**Files**
- Create `packages/provider-connectors/src/browser/{runtime,profile-store,login,selector-engine,extraction,types}.ts`
- Create `packages/provider-connectors/src/state/{provider-state,fingerprints}.ts`
- Add lease, selector uniqueness, redaction, and fingerprint tests.

**Rules**
- Ordered selector candidates: test ID → exact role/name → label/name → scoped structure → text fallback.
- Every candidate must resolve uniquely inside the intended card/dialog.
- No global `.first()` for products or final actions.
- Redacted screenshots/DOM excerpts/traces only on drift.

## Task 5.2: Implement real supervised login

**Files**
- Create: `apps/control-plane/src/provider-runtime.ts`
- Create: `apps/control-plane/src/supervised-login.ts`
- Create: `packages/persistence/src/provider-sessions.ts`
- Modify: `apps/control-plane/src/mcp.ts`

**Acceptance criteria**
- `provider_auth_status` reflects persisted `authenticating`, `challenge_required`, `active`, `expired`, `revoked`, or `error`.
- OTP/password/CAPTCHA are entered only in provider browser.
- Stale locks are recoverable using PID/start-time/lease metadata.

## Task 5.3: Capture sanitized provider fixtures

**Files**
- Add sanitized HTML and JSON under `packages/provider-connectors/test/fixtures/{blinkit,zepto}/`
- Add capture/redaction script under `scripts/provider-fixtures/`.

**Gate**
- Exact selectors must be derived from supervised authenticated captures, never guessed.
- Fixture review confirms no phone numbers, addresses, cookies, tokens, or payment data.

## Task 5.4: Blinkit end-to-end adapter

**Files**
- Create `providers/blinkit/{adapter,selectors,extractors,login}.ts`
- Add fixture Playwright tests.

**Prepare**
- Verify account/address, require safe cart policy, select exact products/variants, set quantities, extract fees/total/ETA/payment, persist cart fingerprint, stop before final action.

**Commit**
- Restore exact review state, re-extract, compare approved fingerprint, require unique final control, click once, capture confirmation/order ID or return ambiguous.

**Reconcile**
- Read order history; correlate ID or unique time/amount/address/cart fingerprint; never mutate.

## Task 5.5: Zepto end-to-end adapter

Repeat Blinkit contract with separate selectors/extractors and provider fixtures. No shared selector assumptions.

# Milestone 6 — Search reliability, monitoring, deployment, and live trials

## Task 6.1: Harden search

**Files**
- Create: `packages/provider-connectors/src/product-search.ts`
- Create: `packages/provider-connectors/src/retry.ts`
- Create: `packages/provider-connectors/src/circuit-breaker.ts`
- Create: `packages/product-search/src/{aggregation,deduplication}.ts`
- Modify contracts and MCP wiring.

**Behavior**
- Bounded retry with jitter and one total deadline.
- Retry only transient failures; honor bounded `Retry-After`.
- Response size/array limits, cancellation, stable offer IDs, deduplication, provider diversity.
- Truthful `completed`, `partial`, `no_results`, and `unavailable` states.
- Short-TTL cache with clearly marked stale fallback.

## Task 6.2: Add operational health

**Files**
- Implement `packages/observability/src/{metrics,provider-health}.ts`
- Add `/health/live`, `/health/ready`, `/providers/health`, `/metrics`.

**Acceptance criteria**
- Readiness checks DB, verifier keys, and required runtime configuration.
- Metrics/logs have bounded labels and contain no secrets/PII.

## Task 6.3: Add deployment artifacts

**Files**
- Add `Dockerfile.control-plane`, `Dockerfile.approval-issuer`, `Dockerfile.web`, `Dockerfile.worker`
- Add `compose.yaml`
- Add `deploy/k8s/*`
- Add `.github/workflows/ci.yml` and security scan workflow
- Add `docs/deployment.md`, `docs/key-rotation.md`, `docs/incident-response.md`

## Task 6.4: Execute supervised test ladder

1. Tier 0: fixture tests in CI; no external access.
2. Tier 1: live read-only login/status/search/history on dedicated accounts.
3. Tier 2: live preparation with commits disabled; verify no order/ride exists afterward.
4. Tier 3A: one low-value grocery canary with spending ceiling and independent approval.
5. Tier 3B: Any future live ride request only for a genuine needed ride, never as routine automated regression.

**Go-live gate**
- PostgreSQL atomicity proven.
- Issuer private key absent from control plane/Hermes.
- Provider-specific pre-click term verification proven.
- Ambiguous reconciliation proven without retry.
- Approval portal security/E2E tests green.
- Backup/restore and incident runbook exercised.

---

## External decisions required before production deployment

- OIDC provider and step-up method (passkey/WebAuthn recommended).
- KMS/HSM provider and public approval domain.
- PostgreSQL host and backup/retention policy.
- Single-tenant versus multi-tenant identity model.
- Plain HTTPS approval link versus Telegram Web App wrapper.
- Legal/ToS review for automated interaction with Blinkit, Zepto, and any future provider.

## Verification commands after every milestone

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Provider fixture suites run in CI. Live tests require explicit opt-in variables and are never part of ordinary CI.

## Definition of done

A Telegram request can produce grounded results, prepare a cart or ride without committing, display exact immutable terms, open a secure independently authenticated approval page, attach authorization without exposing it to Hermes, perform one revalidated final action, persist a receipt or ambiguous state, reconcile safely, and render the complete lifecycle—while all negative, concurrency, crash-recovery, security, and live canary gates pass.
