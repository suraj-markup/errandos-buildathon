# Browser Grocery End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-safe Playwright path that searches Blinkit and Zepto, prepares exact COD grocery proposals, obtains independent approval, performs one revalidated final order action, and persists a verified receipt or read-only reconciliation state.

**Architecture:** Typed provider adapters run inside a shared principal-isolated browser runtime. PostgreSQL owns session state, proposals, approval binding, dispatch reservation, receipts, and reconciliation. Workers own final provider actions; Hermes sees typed redacted MCP results only.

**Tech Stack:** TypeScript ESM, Node.js 22+, pnpm 10+, Playwright 1.61+, Zod 3.25+, PostgreSQL, Fastify, Next.js 15, Vitest, JOSE with Ed25519.

## Global Constraints

- Every Blinkit and Zepto provider interaction, including search, runs through a provider-specific Playwright adapter.
- Authenticated work uses a supervised persistent Chromium profile isolated by principal, provider, and account key.
- Hermes and MCP never receive cookies, OTPs, passwords, selectors, raw DOM, browser paths, page handles, signing keys, or approval capabilities.
- Preparation may mutate a cart but stops before the final order action.
- COD requires trusted approval bound to the exact canonical proposal.
- The final provider action is invoked at most once. An unverified result is `ambiguous` and is reconciled read-only.
- Live browser actions and live commits remain separate gates and default false.
- Automated tests use sanitized fixtures and never place live orders.

## File Responsibility Map

- `packages/contracts/src/provider-sessions.ts` — redacted session states and typed provider errors.
- `packages/contracts/src/search.ts` — browser-search contracts and stable offer identity.
- `packages/browser-runtime/src/*` — profiles, leases, contexts, and supervised login.
- `packages/persistence/src/provider-session-repository.ts` — durable redacted session state.
- `packages/product-search/src/orchestrator.ts` — concurrent provider search under one deadline.
- `packages/provider-connectors/src/browser/*` — selector uniqueness, extraction, and redaction.
- `packages/provider-connectors/src/providers/{blinkit,zepto}/*` — independent provider logic.
- `packages/application/src/transactions/*` — prepare, commit, and reconcile state machines.
- `apps/approval-issuer/*` — independent human approval and authorization issuance.
- `apps/worker/src/*` — outbox, commit, and reconciliation workers.
- `apps/control-plane/src/*` — typed MCP wiring and presentation.

---

### Task 1: Browser-provider contracts

**Files:**
- Create: `packages/contracts/src/provider-sessions.ts`
- Create: `packages/contracts/src/search.ts`
- Modify: `packages/contracts/src/proposals.ts`
- Modify: `packages/contracts/src/transactions.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/provider-sessions.test.ts`
- Test: `packages/contracts/test/search.test.ts`

**Interfaces:**
- Consumes: existing `PrincipalId`, `MoneySchema`, and proposal snapshots.
- Produces: `BrowserProviderSchema`, `ProviderSessionStatusSchemaV1`, `BrowserProductSearchInputSchemaV1`, `BrowserProductSearchOutputSchemaV1`, and `PrepareRideInputSchemaV1`.

- [ ] **Step 1: Write strict schema tests**

```ts
it('rejects browser secrets from session status', () => {
  expect(() => ProviderSessionStatusSchemaV1.parse({
    version: 1, provider: 'zepto', accountKey: 'primary', status: 'active', cookie: 'secret',
  })).toThrow();
});

it('requires stable grounded offers', () => {
  const result = BrowserProductSearchOutputSchemaV1.parse({
    version: 1, status: 'completed', searchedProviders: ['zepto'], failedProviders: [],
    offers: [{ offerId: 'zepto:sku-1', provider: 'zepto', productId: 'sku-1', title: 'Blanket', variant: 'Single', price: { currency: 'INR', amount: 499 }, availability: 'available', url: 'https://www.zeptonow.com/pn/x/pvid/sku-1' }],
  });
  expect(result.offers).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/contracts test -- provider-sessions.test.ts search.test.ts`

Expected: FAIL because the schemas are not exported.

- [ ] **Step 3: Implement strict contracts**

```ts
export const BrowserProviderSchema = z.enum(['blinkit', 'zepto', 'rapido']);
export const ProviderSessionStatusSchemaV1 = z.object({
  version: z.literal(1), provider: BrowserProviderSchema, accountKey: z.string().min(1).max(200),
  status: z.enum(['missing', 'authenticating', 'challenge_required', 'active', 'expired', 'revoked', 'error']),
  expiresAt: z.string().datetime().optional(), errorCode: z.string().max(80).optional(),
}).strict();
```

Add stable offer identity, availability, exact optional price/delivery/image fields, partial/unavailable states, `rapido` proposal support, and a provider-neutral ride preparation input.

Split the public commit request from internal authorization attachment: the MCP-facing input contains only proposal ID and idempotency key; authorization is looked up server-side after the approval issuer attaches it.

- [ ] **Step 4: Verify contracts and dependent application tests**

Run: `pnpm --filter @errandos/contracts test && pnpm --filter @errandos/contracts typecheck && pnpm --filter @errandos/application test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/application/test
git commit -m "feat: define browser provider contracts"
```

### Task 2: Shared Playwright session runtime

**Files:**
- Create: `packages/browser-runtime/src/types.ts`
- Create: `packages/browser-runtime/src/profile-store.ts`
- Create: `packages/browser-runtime/src/profile-references.ts`
- Create: `packages/browser-runtime/src/profile-leases.ts`
- Create: `packages/browser-runtime/src/runtime.ts`
- Create: `packages/browser-runtime/src/supervised-login.ts`
- Modify: `packages/browser-runtime/src/index.ts`
- Modify: `packages/browser-runtime/package.json`
- Test: `packages/browser-runtime/test/runtime.test.ts`
- Test: `packages/browser-runtime/test/profile-leases.test.ts`

**Interfaces:**
- Consumes: `BrowserProvider`, `PrincipalId`, Playwright `BrowserContext` and `Page`.
- Produces: `ProviderSessionKey`, `ProviderBrowserRuntime`, `ProfileLeasePort`, and `SupervisedSession`.

- [ ] **Step 1: Write cleanup and isolation tests**

```ts
it('releases a profile after an operation throws', async () => {
  await expect(runtime.withAuthenticatedPage(key, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  await expect(runtime.withAuthenticatedPage(key, async () => 'reused')).resolves.toBe('reused');
});

it('isolates principals', async () => {
  expect(await references.resolve({ ...key, principalId: 'a' })).not.toBe(await references.resolve({ ...key, principalId: 'b' }));
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/browser-runtime test`

Expected: FAIL because the runtime API is missing.

- [ ] **Step 3: Implement the narrow runtime**

```ts
export interface ProviderBrowserRuntime {
  withAnonymousPage<T>(provider: BrowserProvider, operation: (page: Page) => Promise<T>): Promise<T>;
  withAuthenticatedPage<T>(key: ProviderSessionKey, operation: (page: Page) => Promise<T>): Promise<T>;
  beginSupervisedLogin(key: ProviderSessionKey): Promise<SupervisedSession>;
}
```

Use `try/finally` for every context and lease. Store opaque lease metadata containing PID, process start marker, owner UUID, issued time, and expiry. Recover only an expired lease whose process/start marker is no longer live.

Add `playwright` as a runtime dependency of `@errandos/browser-runtime`; provider connectors depend on the runtime package instead of launching persistent contexts directly.

- [ ] **Step 4: Verify runtime behavior**

Run: `pnpm --filter @errandos/browser-runtime test && pnpm --filter @errandos/browser-runtime typecheck && pnpm --filter @errandos/browser-runtime lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/browser-runtime
git commit -m "feat: add isolated provider browser runtime"
```

### Task 3: Durable provider-session lifecycle

**Files:**
- Create: `packages/persistence/src/provider-session-repository.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/provider-session-repository.test.ts`
- Create: `apps/control-plane/src/provider-runtime.ts`
- Create: `apps/control-plane/src/supervised-login.ts`
- Test: `apps/control-plane/test/provider-runtime.test.ts`

**Interfaces:**
- Consumes: `ProviderSessionKey` and `ProviderSessionStatusV1`.
- Produces: `PostgresProviderSessionRepository` and `ProviderLoginCoordinator`.

- [ ] **Step 1: Write owner-isolation and expiry tests**

```ts
it('does not return another principal session', async () => {
  await repo.upsertStatus('a', 'zepto', 'primary', 'active');
  await expect(repo.getStatus('b', 'zepto', 'primary')).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run PostgreSQL tests and confirm failure**

Run: `TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/persistence test -- provider-session-repository.test.ts`

Expected: FAIL until repository methods exist. PostgreSQL tests must run rather than skip.

- [ ] **Step 3: Implement persistence and login coordination**

```ts
export interface ProviderSessionRepository {
  upsertStatus(principalId: string, provider: BrowserProvider, accountKey: string, status: ProviderSessionState, expiresAt?: Date): Promise<void>;
  getStatus(principalId: string, provider: BrowserProvider, accountKey: string, now?: Date): Promise<ProviderSessionStatusV1 | undefined>;
}
```

Open visible provider URLs, persist `authenticating`, inspect only provider-specific visible account markers, record `challenge_required` or `active`, and close on success or bounded timeout.

- [ ] **Step 4: Verify persistence and control-plane tests**

Run: `TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/persistence test && pnpm --filter @errandos/control-plane test -- provider-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/persistence apps/control-plane
git commit -m "feat: persist supervised provider sessions"
```

### Task 4: Browser search orchestration

**Files:**
- Create: `packages/product-search/src/types.ts`
- Create: `packages/product-search/src/orchestrator.ts`
- Create: `packages/product-search/src/deduplicate.ts`
- Modify: `packages/product-search/src/index.ts`
- Modify: `packages/product-search/package.json`
- Test: `packages/product-search/test/orchestrator.test.ts`

**Interfaces:**
- Consumes: browser search input and grounded offers.
- Produces: `BrowserSearchProviderPort.search` and `BrowserProductSearchOrchestrator.search`.

- [ ] **Step 1: Write partial-result and deadline tests**

```ts
it('returns Zepto offers when Blinkit fails', async () => {
  const result = await createOrchestrator({ blinkit: failing('layout_changed'), zepto: succeeding(zeptoOffer) }).search(input);
  expect(result).toMatchObject({ status: 'partial', searchedProviders: ['zepto'] });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/product-search test`

Expected: FAIL because orchestration is missing.

- [ ] **Step 3: Implement one-deadline concurrency**

```ts
export interface BrowserSearchProviderPort {
  readonly provider: 'blinkit' | 'zepto';
  search(input: BrowserProductSearchInputV1, signal: AbortSignal): Promise<readonly BrowserOfferV1[]>;
}
```

Use one abort controller, `Promise.allSettled`, typed failures, and deterministic sorting. Deduplicate only equal provider/product IDs.

- [ ] **Step 4: Verify search package**

Run: `pnpm --filter @errandos/product-search test && pnpm --filter @errandos/product-search typecheck && pnpm --filter @errandos/product-search lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/product-search
git commit -m "feat: orchestrate browser product search"
```

### Task 5: Selector uniqueness and sanitized fixtures

**Files:**
- Create: `packages/provider-connectors/src/browser/page-port.ts`
- Create: `packages/provider-connectors/src/browser/selector-engine.ts`
- Create: `packages/provider-connectors/src/browser/redaction.ts`
- Create: `scripts/provider-fixtures/capture.ts`
- Create: `scripts/provider-fixtures/sanitize.ts`
- Test: `packages/provider-connectors/test/selector-engine.test.ts`
- Test: `packages/provider-connectors/test/redaction.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit/.gitkeep`
- Create: `packages/provider-connectors/test/fixtures/zepto/.gitkeep`

**Interfaces:**
- Consumes: Playwright pages and locators internally.
- Produces: `resolveUnique`, `sanitizeProviderFixture`, and fixture capture commands.

- [ ] **Step 1: Write ambiguity and redaction tests**

```ts
it('rejects an ambiguous final action', async () => {
  await expect(resolveUnique(page, candidates, 'final_order')).rejects.toMatchObject({ code: 'selector_ambiguous' });
});

it('removes credential-equivalent data', () => {
  expect(sanitizeProviderFixture('<div>+91 98765 43210</div><script>token="abc"</script>')).not.toMatch(/98765|token|abc/);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/provider-connectors test -- selector-engine.test.ts redaction.test.ts`

Expected: FAIL because the modules are absent.

- [ ] **Step 3: Implement scoped resolution and sanitization**

Count matches and return a locator only for exactly one match. Throw `selector_missing` or `selector_ambiguous` otherwise. Strip scripts, form values, phone numbers, emails, long token-like strings, order IDs, address blocks, and payment data before fixture writes.

- [ ] **Step 4: Capture and review supervised fixtures**

Run:

```bash
ERRANDOS_LIVE_BROWSER_ACTIONS=true pnpm tsx scripts/provider-fixtures/capture.ts --provider blinkit --flows search,cart,review,history
ERRANDOS_LIVE_BROWSER_ACTIONS=true pnpm tsx scripts/provider-fixtures/capture.ts --provider zepto --flows search,cart,review,history
```

Expected: sanitized fixtures plus a report with zero detected PII or token patterns. Review every fixture diff before commit.

- [ ] **Step 5: Verify and commit**

Run: `pnpm --filter @errandos/provider-connectors test && git diff --check`

Expected: PASS.

```bash
git add packages/provider-connectors scripts/provider-fixtures
git commit -m "test: add sanitized provider fixture harness"
```

### Task 6: Blinkit and Zepto browser search adapters

**Files:**
- Create: `packages/provider-connectors/src/providers/blinkit/selectors.ts`
- Create: `packages/provider-connectors/src/providers/blinkit/search.ts`
- Create: `packages/provider-connectors/src/providers/blinkit/extractors.ts`
- Create: `packages/provider-connectors/src/providers/zepto/selectors.ts`
- Create: `packages/provider-connectors/src/providers/zepto/search.ts`
- Create: `packages/provider-connectors/src/providers/zepto/extractors.ts`
- Modify: `packages/provider-connectors/src/index.ts`
- Test: `packages/provider-connectors/test/blinkit-search.test.ts`
- Test: `packages/provider-connectors/test/zepto-search.test.ts`

**Interfaces:**
- Consumes: shared runtime, search port, and sanitized fixtures.
- Produces: `BlinkitSearchAdapter` and `ZeptoSearchAdapter`.

- [ ] **Step 1: Write exact fixture extraction tests**

```ts
it('extracts only visible offer facts', async () => {
  const offers = await adapter.search(input, AbortSignal.timeout(2_000));
  expect(offers[0]).toMatchObject({ provider: 'blinkit', productId: 'product-123', title: 'Blanket', availability: 'available' });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-search.test.ts zepto-search.test.ts`

Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement provider-specific navigation and extraction**

Establish the pincode through visible UI, resolve one search input, wait for the provider-specific results container, and extract exact cards. Use selector candidates derived only from reviewed Task 5 fixtures.

- [ ] **Step 4: Verify fixtures and supervised live search**

Run: `pnpm --filter @errandos/provider-connectors test`

Then run live search with browser actions enabled and commits disabled. Expected: price, availability, delivery text, and URL match visible provider pages.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-connectors
git commit -m "feat: search Blinkit and Zepto through Playwright"
```

### Task 7: Exact Blinkit and Zepto COD preparation

**Files:**
- Create: `packages/provider-connectors/src/providers/blinkit/cart.ts`
- Create: `packages/provider-connectors/src/providers/blinkit/login.ts`
- Create: `packages/provider-connectors/src/providers/zepto/cart.ts`
- Create: `packages/provider-connectors/src/providers/zepto/login.ts`
- Create: `packages/provider-connectors/src/state/fingerprints.ts`
- Create: `packages/application/src/transactions/prepare-service.ts`
- Modify: `packages/application/src/transactions.ts`
- Test: `packages/provider-connectors/test/blinkit-cart.test.ts`
- Test: `packages/provider-connectors/test/zepto-cart.test.ts`
- Test: `packages/application/test/prepare-service.test.ts`

**Interfaces:**
- Consumes: grocery preparation input, authenticated runtime, and canonical hashing.
- Produces: `PreparedGroceryState` and `GroceryPreparationService.prepare`.

- [ ] **Step 1: Write exact-cart and COD tests**

```ts
it('stops at review with COD selected', async () => {
  const prepared = await adapter.prepare(owner, input);
  expect(prepared.snapshot).toMatchObject({ provider: 'zepto', paymentMode: 'cod' });
  expect(page.actionCount('final_order')).toBe(0);
});

it('rejects unavailable COD before proposal creation', async () => {
  await expect(adapter.prepare(owner, input)).rejects.toMatchObject({ code: 'payment_mode_unavailable' });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-cart.test.ts zepto-cart.test.ts && pnpm --filter @errandos/application test -- prepare-service.test.ts`

Expected: FAIL because the cart adapters and preparation service are missing.

- [ ] **Step 3: Implement preparation and fingerprints**

```ts
export interface GroceryProviderFingerprintV1 {
  version: 1;
  provider: 'blinkit' | 'zepto';
  accountReference: string;
  deliveryLocationReference: string;
  lines: readonly { productId: string; variantId?: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }[];
  fees: readonly { kind: string; amountPaise: number }[];
  totalPaise: number;
  etaText?: string;
  paymentMode: 'cod' | 'provider_saved';
  providerCartReference?: string;
}
```

Verify authentication and delivery location, select exact product IDs, set quantities, open review, select COD, extract every material term, persist opaque provider state, and return without resolving or touching the final order control.

- [ ] **Step 4: Verify material-change behavior**

Run: `pnpm --filter @errandos/provider-connectors test && pnpm --filter @errandos/application test && pnpm --filter @errandos/application typecheck`

Expected: PASS, including fingerprint changes for product, variant, quantity, price, fee, total, location, ETA, and payment mode.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-connectors packages/application
git commit -m "feat: prepare exact Blinkit and Zepto COD proposals"
```

### Task 8: Independent approval issuer and portal

**Files:**
- Create: `apps/approval-issuer/package.json`
- Create: `apps/approval-issuer/src/app.ts`
- Create: `apps/approval-issuer/src/signing/authorization-signer.ts`
- Create: `apps/approval-issuer/src/routes/approval.ts`
- Create: `apps/approval-issuer/test/approval.test.ts`
- Create: `packages/application/src/approvals/capability-verifier.ts`
- Create: `packages/application/test/capability-verification.test.ts`
- Create: `apps/web/app/r/[requestToken]/page.tsx`
- Create: `apps/web/app/r/[requestToken]/actions.ts`
- Create: `apps/web/middleware.ts`
- Test: `apps/web/app/r/approval.test.tsx`

**Interfaces:**
- Consumes: exact approval binding and PostgreSQL approval repositories.
- Produces: Ed25519 authorization and server-to-server attachment.

- [ ] **Step 1: Write security-negative tests**

Test wrong issuer, audience, algorithm, key ID, subject, principal, proposal, revision, hash, action, expiry, replay, CSRF origin, and browser claim override. Assert the authorization is absent from URLs, HTML, logs, and browser responses.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/application test -- capability-verification.test.ts && pnpm --filter @errandos/approval-issuer test && pnpm --filter @errandos/web test`

Expected: FAIL until issuer, verifier, and portal exist.

- [ ] **Step 3: Implement exact authorization claims**

```ts
export interface CommitAuthorizationClaims {
  iss: string; aud: 'errandos-control-plane'; sub: string; jti: string;
  iat: number; nbf: number; exp: number; kid: string;
  principal_id: string; proposal_id: string; proposal_revision: number; proposal_hash: string;
  approval_request_id: string; action: 'commit';
}
```

Use Ed25519 through a signer port. The portal reads proposal facts server-side, accepts POST-only approve/reject with CSRF and Origin/Host checks, and delivers authorization directly to the control plane.

Create the issuer package with this minimum manifest shape and add `jose` to the workspace lockfile:

```json
{
  "name": "@errandos/approval-issuer",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit", "lint": "eslint src test", "test": "vitest run" },
  "dependencies": { "@errandos/contracts": "workspace:*", "@errandos/persistence": "workspace:*", "fastify": "^5.0.0", "jose": "^6.0.0" }
}
```

- [ ] **Step 4: Verify security suites**

Run: `pnpm --filter @errandos/application test && pnpm --filter @errandos/approval-issuer test && pnpm --filter @errandos/web test && pnpm --filter @errandos/web build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/approval-issuer apps/web packages/application pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: add independent transaction approval"
```

### Task 9: Durable commit and crash-safe workers

**Files:**
- Create: `packages/application/src/transactions/commit-service.ts`
- Create: `packages/application/src/transactions/reconciliation-service.ts`
- Create: `apps/worker/src/outbox-worker.ts`
- Create: `apps/worker/src/commit-worker.ts`
- Create: `apps/worker/src/reconciliation-worker.ts`
- Modify: `apps/worker/package.json`
- Test: `packages/application/test/commit-service.test.ts`
- Test: `apps/worker/test/commit-worker.test.ts`

**Interfaces:**
- Consumes: authorization verifier, transaction/outbox repositories, and provider commit port.
- Produces: `CommitService.reserve`, `CommitWorker.dispatch`, and `ReconciliationWorker.reconcile`.

- [ ] **Step 1: Write concurrency and crash tests**

```ts
it('allows one winner for twenty reservations', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => service.reserve(input)));
  expect(results.filter(result => result.status === 'reserved')).toHaveLength(1);
});

it('recovers dispatching as ambiguous without another action', async () => {
  await repository.seedAttempt({ ...attempt, status: 'dispatching' });
  await worker.recover(attempt.id);
  expect(provider.finalActionCalls).toBe(0);
  expect(await repository.getAttempt(owner, attempt.id)).toMatchObject({ status: 'ambiguous' });
});
```

- [ ] **Step 2: Run PostgreSQL tests and confirm failure**

Run: `TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/application test -- commit-service.test.ts && TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/worker test`

Expected: FAIL until services and workers exist.

- [ ] **Step 3: Implement the commit state machine**

Consume authorization, reserve the attempt, and enqueue outbox work in one transaction. Transition `reserved → dispatching` before provider invocation. Persist a receipt only with a verified reference. Persist `ambiguous` and enqueue reconciliation for exceptions, timeouts, missing references, or recovery from `dispatching`.

- [ ] **Step 4: Verify concurrency and crash recovery**

Run: `TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/persistence test && TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/application test && TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm --filter @errandos/worker test`

Expected: PASS with exactly one winner and zero duplicate final actions.

- [ ] **Step 5: Commit**

```bash
git add packages/application packages/persistence apps/worker
git commit -m "feat: dispatch approved transactions exactly once"
```

### Task 10: Blinkit and Zepto final action and reconciliation

**Files:**
- Create: `packages/provider-connectors/src/providers/blinkit/commit.ts`
- Create: `packages/provider-connectors/src/providers/blinkit/reconcile.ts`
- Create: `packages/provider-connectors/src/providers/zepto/commit.ts`
- Create: `packages/provider-connectors/src/providers/zepto/reconcile.ts`
- Test: `packages/provider-connectors/test/blinkit-commit.test.ts`
- Test: `packages/provider-connectors/test/zepto-commit.test.ts`

**Interfaces:**
- Consumes: authorized dispatch, provider-state reference, approved fingerprint, and authenticated runtime.
- Produces: `ProviderCommitResult` and `ProviderReconciliationResult`.

- [ ] **Step 1: Write revalidation and one-action tests**

```ts
it('does not act when provider total changed', async () => {
  await expect(adapter.commit(dispatch)).resolves.toMatchObject({ outcome: 'stale' });
  expect(page.actionCount('final_order')).toBe(0);
});

it('returns ambiguous after one action without a reference', async () => {
  await expect(adapter.commit(dispatch)).resolves.toEqual({ outcome: 'ambiguous' });
  expect(page.actionCount('final_order')).toBe(1);
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-commit.test.ts zepto-commit.test.ts`

Expected: FAIL until commit and reconciliation adapters exist.

- [ ] **Step 3: Implement revalidation and one invocation**

Reopen review, extract a new fingerprint, compare hashes, and return `stale` before resolving the final control on mismatch. On match, uniquely resolve the final control inside the review container, invoke once, and accept success only from a provider-specific confirmation extractor returning a non-empty order reference. Reconciliation reads order history without mutation.

- [ ] **Step 4: Verify adapter suites**

Run: `pnpm --filter @errandos/provider-connectors test && pnpm --filter @errandos/provider-connectors typecheck && pnpm --filter @errandos/provider-connectors lint`

Expected: PASS with zero or one final invocation on every path.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-connectors
git commit -m "feat: commit and reconcile grocery orders safely"
```

### Task 11: MCP integration and deterministic rendering

**Files:**
- Create: `packages/presentation/package.json`
- Create: `packages/presentation/src/search.ts`
- Create: `packages/presentation/src/proposal.ts`
- Create: `packages/presentation/src/status.ts`
- Create: `packages/presentation/src/index.ts`
- Test: `packages/presentation/test/rendering.test.ts`
- Modify: `apps/control-plane/src/mcp.ts`
- Modify: `apps/control-plane/package.json`
- Test: `apps/control-plane/test/mcp.test.ts`
- Modify: `hermes/skills/errandos/SKILL.md`

**Interfaces:**
- Consumes: search, proposal, lifecycle, and receipt outputs.
- Produces: typed MCP tools with readable text plus unchanged structured content.

- [ ] **Step 1: Write tool and rendering tests**

Assert browser-backed search wiring, explicit “no order placed” proposal text, approval URLs without capabilities, committed output requiring a provider reference, and ambiguous output requiring reconciliation.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @errandos/control-plane test && pnpm --filter @errandos/presentation test`

Expected: FAIL until presentation and wiring exist.

- [ ] **Step 3: Wire browser providers and presentation**

Remove the HTTP recommendation connector from the default path. Construct the runtime, Blinkit/Zepto search adapters, orchestrator, preparation service, PostgreSQL transaction services, and commit reservation. Do not add browser primitive or secret-bearing MCP fields.

Create `@errandos/presentation` as an ESM workspace package depending only on `@errandos/contracts`; its renderers are deterministic pure functions with no provider or browser imports.

- [ ] **Step 4: Verify control-plane behavior**

Run: `pnpm --filter @errandos/presentation test && pnpm --filter @errandos/control-plane test && pnpm --filter @errandos/control-plane typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/presentation apps/control-plane hermes/skills/errandos/SKILL.md pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: expose browser grocery workflows to Hermes"
```

### Task 12: Full gates and supervised live ladder

**Files:**
- Create: `docs/live-provider-verification.md`
- Create: `docs/provider-fixture-redaction.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/provider-adapter-scope.md`

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces: reproducible verification evidence and operator instructions.

- [ ] **Step 1: Run all non-live gates**

Run each command separately:

```bash
pnpm typecheck
pnpm lint
TEST_DATABASE_URL=postgresql:///errandos_test?host=/var/run/postgresql pnpm test
pnpm build
git diff --check
```

Expected: every command exits `0`, and PostgreSQL integration tests execute rather than skip.

- [ ] **Step 2: Verify supervised login and read-only search**

With browser actions true and live commit false, complete dedicated-account logins and compare every returned search fact to visible Blinkit and Zepto pages. Record redacted pass/fail evidence only.

- [ ] **Step 3: Verify prepare-only behavior**

Prepare one low-value COD cart per provider with commits disabled. Confirm exact proposal rendering and verify in provider order history that no order exists.

- [ ] **Step 4: Execute independently approved canaries**

For each provider separately, use an approved proposal under the documented spending ceiling, enable live commit, and allow one final action. Record proposal ID, redacted provider-reference hash, receipt status, action-count evidence, and reconciliation result without PII or secrets.

Expected: a committed receipt with verified provider reference, or an ambiguous state followed by read-only reconciliation. Any other result keeps that provider incomplete.

- [ ] **Step 5: Record evidence and commit**

Update the scope map only for evidenced items and add exact commands and dates to the verification document.

```bash
git add docs README.md .env.example
git commit -m "docs: record grocery provider verification"
```

## Progress Log

After each completed task append:

```text
2026-07-13 — Task 1 — commit abc1234 — tests: pnpm --filter @errandos/contracts test (PASS), pnpm --filter @errandos/contracts typecheck (PASS) — external gates: none
```

Never record provider account identifiers, addresses, order references, screenshots with PII, or approval capabilities.
