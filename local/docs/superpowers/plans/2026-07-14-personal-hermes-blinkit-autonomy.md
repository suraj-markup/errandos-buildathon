# Personal Hermes Blinkit Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one owner's Hermes deployment log into Blinkit through Telegram phone/OTP prompts, prepare an exact real cart, and autonomously place and verify a COD order from an explicit ordering request.

**Architecture:** A single VPC-local MCP process owns one encrypted filesystem-backed Chromium profile and transaction store. Hermes orchestrates typed tools; focused Blinkit modules perform login, preparation, exact live revalidation, one final action, receipt verification, and read-only reconciliation. External approval and spending caps are absent in owner-autonomous mode, while idempotency, material-term comparison, and at-most-once dispatch remain correctness invariants.

**Tech Stack:** TypeScript ESM, Node.js 22+, pnpm workspaces, Zod, Playwright Chromium, MCP SDK, Vitest, filesystem persistence, Hermes skill Markdown.

## Global Constraints

- First release supports one configured owner, one Blinkit account, grocery orders, and COD only.
- Preserve all existing uncommitted changes; inspect `git diff` before each overlapping edit and stage only task-owned files.
- Use `apply_patch` for edits and test-first development for every behavior change.
- Phone and OTP may traverse Telegram, Hermes, and MCP, but must not be echoed, logged, traced, screenshotted, or persisted.
- Do not expose cookies, selectors, raw HTML, arbitrary JavaScript, browser profile paths, or browser objects through MCP.
- Search never mutates the cart; preparation may mutate the cart but never invokes the final order action.
- Explicit order intent may autonomously place COD without external approval, per-order confirmation, or a spending cap.
- Revalidate product identity, variant, quantity, prices, fees, total, address, ETA, COD, and expiry immediately before dispatch.
- Invoke the final Blinkit action at most once; uncertainty after invocation becomes `ambiguous` and reconciliation is read-only.
- Never report success without a verified Blinkit order reference.
- Card, UPI, wallet, bank-challenge, Zepto, Rapido rides, distributed workers, and PostgreSQL live dispatch are outside this plan.

---

## File map

### New focused provider files

- `packages/provider-connectors/src/runtime/profile-store.ts` — secure profile paths and exclusive lock lifecycle.
- `packages/provider-connectors/src/runtime/provider-state.ts` — owner-scoped filesystem provider-state storage.
- `packages/provider-connectors/src/blinkit/types.ts` — internal extracted review, persisted state, and order-candidate types.
- `packages/provider-connectors/src/blinkit/login.ts` — phone/OTP browser flow and redacted auth detection.
- `packages/provider-connectors/src/blinkit/product-match.ts` — deterministic product candidate scoring and refusal rules.
- `packages/provider-connectors/src/blinkit/review.ts` — normalize and validate exact checkout facts and compare material terms.
- `packages/provider-connectors/src/blinkit/orders.ts` — provider-reference extraction and unique reconciliation correlation.
- `packages/provider-connectors/src/blinkit/adapter.ts` — orchestration across focused Blinkit modules.
- `packages/provider-connectors/test/fixtures/blinkit/*.html` — sanitized logged-out, logged-in, checkout, confirmation, and order-history fixtures.
- `hermes/skills/errandos/references/architecture.md` — approved Mermaid system and transaction flow.

### Existing files to modify

- `packages/contracts/src/index.ts` — login status contracts and Telegram-supplied phone/OTP schemas.
- `packages/contracts/src/transactions.ts` — autonomous proposal semantics and COD tool input.
- `packages/application/src/transactions.ts` — explicit owner-autonomous commit path and stale provider result.
- `packages/application/test/transactions.test.ts` — autonomous authorization and idempotency behavior.
- `packages/provider-connectors/src/transactions.ts` — retain compatibility exports; delegate Blinkit to focused modules.
- `packages/provider-connectors/src/index.ts` — export new runtime and Blinkit adapter surfaces.
- `packages/provider-connectors/test/transactions.test.ts` — profile runtime compatibility tests.
- `apps/control-plane/src/mcp.ts` — single-owner profile, real auth status, autonomous COD tool, and startup validation.
- `apps/control-plane/test/mcp.test.ts` — MCP discovery, OTP redaction, autonomous COD, and personal production profile.
- `apps/control-plane/src/order-cli.ts` — use the same adapter and autonomous service path as MCP.
- `.env.example`, `README.md`, `docs/agent-driven-login.md`, `hermes/mcp.example.yaml`, `AGENTS.md` — approved single-owner deployment and OTP policy.
- `hermes/skills/errandos/SKILL.md` — find/prepare/order intent, Telegram login, autonomous COD, and reconciliation behavior.

---

### Task 1: Single-owner deployment and public contract semantics

**Files:**
- Modify: `packages/contracts/src/transactions.ts`
- Modify: `packages/contracts/test/proposals.test.ts`
- Modify: `apps/control-plane/src/mcp.ts`
- Modify: `apps/control-plane/test/mcp.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `ERRANDOS_DEPLOYMENT_PROFILE=personal` as the explicit filesystem-in-production profile.
- Produces: `ProposalOutput.requiresExternalApproval: boolean` and owner-autonomous proposals with `status: 'prepared'`.
- Produces: `PlaceCodOrderInputSchemaV1` with a required idempotency key.

- [ ] **Step 1: Write failing contract tests**

Add assertions that both authorization modes parse and that autonomous COD requires a caller-supplied idempotency key:

```ts
expect(ProposalOutputSchemaV1.parse({ ...base, status: 'prepared', requiresExternalApproval: false }))
  .toMatchObject({ status: 'prepared', requiresExternalApproval: false });
expect(() => PlaceCodOrderInputSchemaV1.parse({ version: 1, proposalId: 'proposal_1' })).toThrow();
expect(PlaceCodOrderInputSchemaV1.parse({
  version: 1,
  proposalId: 'proposal_1',
  idempotencyKey: 'telegram-update-123',
})).toMatchObject({ idempotencyKey: 'telegram-update-123' });
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `pnpm --filter @errandos/contracts test`

Expected: FAIL because `requiresExternalApproval` is literal `true` and the idempotency key is optional.

- [ ] **Step 3: Implement the contract change**

Change the schemas to:

```ts
export const ProposalOutputSchemaV1 = z.object({
  version: z.literal(1),
  proposalId: OpaqueId,
  provider: TransactionProviderSchema,
  status: ProposalStatusSchema,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: ProposalSummarySchemaV1,
  expiresAt: z.string().datetime(),
  requiresExternalApproval: z.boolean(),
}).strict();

export const PlaceCodOrderInputSchemaV1 = ProposalRefInputSchemaV1.extend({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();
```

- [ ] **Step 4: Write a failing startup test for personal production mode**

Add a startup test proving `NODE_ENV=production`, `ERRANDOS_DEPLOYMENT_PROFILE=personal`, and filesystem persistence are accepted, while production filesystem without the profile remains rejected.

```ts
expect(() => validateDeploymentEnvironment({
  NODE_ENV: 'production',
  ERRANDOS_DEPLOYMENT_PROFILE: 'personal',
  ERRANDOS_PERSISTENCE_MODE: 'filesystem',
  ...requiredPersonalEnvironment,
})).not.toThrow();
```

- [ ] **Step 5: Run the control-plane test and verify RED**

Run: `pnpm --filter @errandos/control-plane test -- mcp.test.ts`

Expected: FAIL with `production requires PostgreSQL persistence`.

- [ ] **Step 6: Implement explicit personal-profile validation**

Centralize startup policy in a small exported function:

```ts
export function validateDeploymentEnvironment(environment: NodeJS.ProcessEnv): void {
  const personal = environment['ERRANDOS_DEPLOYMENT_PROFILE'] === 'personal';
  const filesystem = environment['ERRANDOS_PERSISTENCE_MODE'] === 'filesystem';
  if (environment['NODE_ENV'] === 'production' && filesystem && !personal) {
    throw new Error('production filesystem persistence requires ERRANDOS_DEPLOYMENT_PROFILE=personal');
  }
}
```

Call it from HTTP and MCP startup. Document that `personal` means one trusted owner and one persistent encrypted volume.

- [ ] **Step 7: Verify Task 1**

Run:

```bash
pnpm --filter @errandos/contracts test
pnpm --filter @errandos/control-plane test -- mcp.test.ts
pnpm typecheck
```

Expected: all selected tests and typecheck pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/contracts/src/transactions.ts packages/contracts/test/proposals.test.ts apps/control-plane/src/mcp.ts apps/control-plane/test/mcp.test.ts .env.example
git commit -m "feat: define personal autonomous deployment"
```

---

### Task 2: Owner-autonomous application transaction path

**Files:**
- Modify: `packages/application/src/transactions.ts`
- Modify: `packages/application/test/transactions.test.ts`

**Interfaces:**
- Produces: `TransactionAuthorizationMode = 'external' | 'owner_autonomous'`.
- Produces: `TransactionService.commitAutonomousCod(owner, input)`.
- Changes: `CommitResult.outcome` includes `stale`.

- [ ] **Step 1: Write failing autonomous-path tests**

Add tests showing that autonomous preparation is `prepared`, explicit COD dispatch needs no capability, duplicate calls invoke the provider once, and non-COD/non-Blinkit proposals are rejected.

```ts
const x = setup({ enabled: true, authorizationMode: 'owner_autonomous' });
const proposal = await x.service.prepareGrocery(alice, input);
expect(proposal).toMatchObject({ status: 'prepared', requiresExternalApproval: false });

const command = {
  version: 1 as const,
  proposalId: proposal.proposalId,
  idempotencyKey: 'telegram-update-123',
};
const first = await x.service.commitAutonomousCod(alice, command);
const second = await x.service.commitAutonomousCod(alice, command);
expect(second).toEqual(first);
expect(x.commits).toBe(1);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @errandos/application test -- transactions.test.ts`

Expected: FAIL because autonomous mode and `commitAutonomousCod` do not exist.

- [ ] **Step 3: Implement the minimal autonomous API**

Introduce:

```ts
export type TransactionAuthorizationMode = 'external' | 'owner_autonomous';

export interface AutonomousCodInput {
  version: 1;
  proposalId: string;
  idempotencyKey: string;
}

public async commitAutonomousCod(
  owner: PrincipalId,
  input: AutonomousCodInput,
): Promise<CommitOutput> {
  if (this.authorizationMode !== 'owner_autonomous') throw new ApprovalRequiredError();
  const record = await this.owned(owner, input.proposalId);
  if (record.snapshot.kind !== 'grocery' || record.snapshot.provider !== 'blinkit') {
    throw new Error('owner-autonomous commit supports Blinkit grocery only');
  }
  if (record.snapshot.paymentMode !== 'cod') throw new Error('owner-autonomous commit supports COD only');
  return this.commitAuthorized(owner, input, record);
}
```

Extract shared hash, expiry, provider-call, receipt, and idempotency logic into `commitAuthorized`. Keep external approval consumption exclusively in `commit`.

Map provider `{ outcome: 'stale' }` to a stale receipt with no reconciliation requirement and no second provider call.

- [ ] **Step 4: Verify Task 2**

Run:

```bash
pnpm --filter @errandos/application test
pnpm --filter @errandos/application typecheck
```

Expected: all application tests pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/application/src/transactions.ts packages/application/test/transactions.test.ts
git commit -m "feat: add owner autonomous COD transactions"
```

---

### Task 3: Focused secure browser runtime

**Files:**
- Create: `packages/provider-connectors/src/runtime/profile-store.ts`
- Create: `packages/provider-connectors/src/runtime/provider-state.ts`
- Create: `packages/provider-connectors/test/runtime.test.ts`
- Modify: `packages/provider-connectors/src/transactions.ts`
- Modify: `packages/provider-connectors/src/index.ts`
- Modify: `packages/provider-connectors/test/transactions.test.ts`

**Interfaces:**
- Produces: `SecureProfileStore.resolveOpaque`, `SecureProfileStore.withLock`, and `FileProviderState` without changing their root exports.
- Guarantees: cleanup on success and thrown errors; lock contents contain bounded owner/start metadata but no principal or raw path.

- [ ] **Step 1: Write failing runtime cleanup tests**

```ts
await expect(store.withLock(ref, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
await expect(store.withLock(ref, async () => 'reacquired')).resolves.toBe('reacquired');
expect(await state.get(bob, aliceRef)).rejects.toThrow('provider state not found');
```

Also test `0700/0600` permissions and path rejection.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @errandos/provider-connectors test -- runtime.test.ts`

Expected: FAIL because `withLock` and the focused runtime modules do not exist.

- [ ] **Step 3: Move existing runtime code without behavior drift**

Implement `withLock` as the only high-level lock API:

```ts
public async withLock<T>(reference: string, work: (directory: string) => Promise<T>): Promise<T> {
  const release = await this.lock(reference);
  try { return await work(await this.resolveOpaque(reference)); }
  finally { await release(); }
}
```

Keep legacy exports from `transactions.ts` during the refactor. Do not add distributed lease behavior to the personal release.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
pnpm --filter @errandos/provider-connectors test
pnpm --filter @errandos/provider-connectors typecheck
```

Expected: runtime and existing connector tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add packages/provider-connectors/src/runtime packages/provider-connectors/src/transactions.ts packages/provider-connectors/src/index.ts packages/provider-connectors/test/runtime.test.ts packages/provider-connectors/test/transactions.test.ts
git commit -m "refactor: isolate provider browser runtime"
```

---

### Task 4: Blinkit login lifecycle and truthful auth status

**Files:**
- Create: `packages/provider-connectors/src/blinkit/types.ts`
- Create: `packages/provider-connectors/src/blinkit/login.ts`
- Create: `packages/provider-connectors/test/blinkit-login.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit/logged-out.html`
- Create: `packages/provider-connectors/test/fixtures/blinkit/logged-in.html`
- Create: `packages/provider-connectors/src/blinkit/adapter.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `BlinkitLoginCoordinator.begin`, `submitOtp`, `status`, and `closeAll`.
- Produces: redacted `SessionStatus` only; phone/OTP never appear in output or persisted state.

- [ ] **Step 1: Capture sanitized fixtures**

Create minimal fixture HTML containing only stable accessible login/account markers. Remove phone, name, full address, cookies, tokens, and order data.

- [ ] **Step 2: Write failing auth-detection and cleanup tests**

Use a small injected page/session port so tests do not need live Blinkit:

```ts
expect(await detectBlinkitAuth(fixturePage('logged-out.html'))).toBe('login_required');
expect(await detectBlinkitAuth(fixturePage('logged-in.html'))).toBe('active');
expect(JSON.stringify(await coordinator.submitOtp(owner, 'main', '123456'))).not.toContain('123456');
await coordinator.closeAll();
expect(session.closed).toBe(true);
expect(lock.released).toBe(true);
```

Add tests for invalid OTP retaining a live bounded challenge and timeout releasing the session.

- [ ] **Step 3: Run and verify RED**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-login.test.ts`

Expected: FAIL because the focused coordinator and real status detection do not exist.

- [ ] **Step 4: Implement login coordinator**

Define a narrow port:

```ts
export interface BlinkitLoginBrowser {
  open(profileDirectory: string): Promise<BlinkitLoginSession>;
}

export interface BlinkitLoginSession {
  submitPhone(phone: string): Promise<void>;
  submitOtp(otp: string): Promise<void>;
  authStatus(): Promise<'login_required' | 'active' | 'challenge_required'>;
  close(): Promise<void>;
}
```

The Playwright implementation owns all selectors. The coordinator owns timeout, in-process session identity, and cleanup. `status` opens the saved profile briefly, detects visible auth state, closes it, and returns redacted status.

- [ ] **Step 5: Verify Task 4**

Run:

```bash
pnpm --filter @errandos/provider-connectors test -- blinkit-login.test.ts
pnpm --filter @errandos/provider-connectors typecheck
```

Expected: login tests pass without a real OTP or network action.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/provider-connectors/src/blinkit packages/provider-connectors/test/blinkit-login.test.ts packages/provider-connectors/test/fixtures/blinkit/logged-out.html packages/provider-connectors/test/fixtures/blinkit/logged-in.html packages/contracts/src/index.ts
git commit -m "feat: add Blinkit login lifecycle"
```

---

### Task 5: Exact product matching and cart review extraction

**Files:**
- Create: `packages/provider-connectors/src/blinkit/product-match.ts`
- Create: `packages/provider-connectors/src/blinkit/review.ts`
- Create: `packages/provider-connectors/test/blinkit-product-match.test.ts`
- Create: `packages/provider-connectors/test/blinkit-review.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit/checkout.html`
- Modify: `packages/provider-connectors/src/blinkit/adapter.ts`

**Interfaces:**
- Produces: `selectUniqueProductCandidate(query, candidates)`.
- Produces: `normalizeBlinkitReview(raw)` returning a complete `BlinkitCheckoutReview` or throwing a typed extraction error.
- Produces: `toGrocerySnapshot(owner, input, review)` using provider facts rather than listing-price arithmetic.

- [ ] **Step 1: Write failing product-match tests**

Cover apostrophes, variants, zero-token matches, and ambiguous top scores:

```ts
expect(selectUniqueProductCandidate("Lay's Classic", candidates).productId).toBe('lays-classic-52g');
expect(() => selectUniqueProductCandidate('lays', unrelatedCandidates)).toThrow('no Blinkit result matches');
expect(() => selectUniqueProductCandidate('milk', tiedMilkCandidates)).toThrow('ambiguous Blinkit product match');
```

- [ ] **Step 2: Write failing complete-review tests**

```ts
const review = normalizeBlinkitReview(completeRawReview);
expect(review).toMatchObject({
  lines: [{ productId: '123', quantity: 4 }],
  total: { currency: 'INR', amount: 240 },
  paymentMode: 'cod',
  addressSummary: 'Home',
});
expect(() => normalizeBlinkitReview({ ...completeRawReview, total: undefined })).toThrow('missing total');
expect(() => normalizeBlinkitReview({ ...completeRawReview, codAvailable: false })).toThrow('COD unavailable');
```

- [ ] **Step 3: Run and verify RED**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-product-match.test.ts blinkit-review.test.ts`

Expected: FAIL because matching and exact review normalization do not exist.

- [ ] **Step 4: Implement deterministic product matching**

Score normalized query tokens only inside each product-card candidate. Require a positive score and unique best candidate; prefer exact variant/title evidence over card position. Return the stable `/prid/<id>` identity or reject the candidate.

- [ ] **Step 5: Implement exact review normalization**

Define:

```ts
export interface BlinkitCheckoutReview {
  lines: BlinkitLine[];
  fees: BlinkitFee[];
  total: Money;
  addressSummary: string;
  deliveryLocationReference?: string;
  etaMinutes: number;
  paymentMode: 'cod';
  providerFingerprint: string;
}
```

The Playwright extractor gathers scoped text/attributes; `normalizeBlinkitReview` validates completeness, arithmetic consistency, COD selection, and non-empty location before proposal creation.

- [ ] **Step 6: Verify Task 5**

Run:

```bash
pnpm --filter @errandos/provider-connectors test
pnpm --filter @errandos/provider-connectors typecheck
```

Expected: all connector tests pass.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/provider-connectors/src/blinkit packages/provider-connectors/test/blinkit-product-match.test.ts packages/provider-connectors/test/blinkit-review.test.ts packages/provider-connectors/test/fixtures/blinkit/checkout.html
git commit -m "feat: extract exact Blinkit checkout terms"
```

---

### Task 6: Live revalidation and at-most-once final action

**Files:**
- Modify: `packages/provider-connectors/src/blinkit/types.ts`
- Modify: `packages/provider-connectors/src/blinkit/review.ts`
- Modify: `packages/provider-connectors/src/blinkit/adapter.ts`
- Create: `packages/provider-connectors/test/blinkit-commit.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit/confirmation.html`
- Modify: `packages/application/src/transactions.ts`
- Modify: `packages/application/test/transactions.test.ts`

**Interfaces:**
- Produces: `compareMaterialGroceryTerms(expected, actual): MaterialDifference[]`.
- Produces: provider commit outcomes `committed | stale | ambiguous`.
- Guarantees: final locator count equals one and `click()` is invoked no more than once.

- [ ] **Step 1: Write failing material-comparison tests**

Parameterize every material field:

```ts
it.each([
  ['quantity', changedQuantity],
  ['unit price', changedUnitPrice],
  ['fee', changedFee],
  ['total', changedTotal],
  ['address', changedAddress],
  ['ETA', changedEta],
  ['payment', changedPayment],
])('rejects changed %s', (_name, actual) => {
  expect(compareMaterialGroceryTerms(expected, actual)).not.toEqual([]);
});
```

- [ ] **Step 2: Write failing single-click tests**

Use an injected checkout page port:

```ts
const result = await adapter.commit(owner, stateRef);
expect(result).toEqual({ outcome: 'committed', providerReference: 'BLK123456' });
expect(page.finalActionClicks).toBe(1);

page.finalActionCount = 2;
await expect(adapter.commit(owner, anotherStateRef)).rejects.toThrow('final action is not unique');
expect(page.finalActionClicks).toBe(0);
```

Add timeout-after-click coverage that returns `ambiguous` with exactly one click.

- [ ] **Step 3: Run and verify RED**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-commit.test.ts`

Expected: FAIL because live revalidation and the page port do not exist.

- [ ] **Step 4: Implement commit sequencing**

The adapter must execute exactly:

```ts
const persisted = BlinkitProviderStateSchema.parse(await state.get(owner, providerStateRef));
const actual = await checkout.extractReview();
if (compareMaterialGroceryTerms(persisted.snapshot, actual).length > 0) return { outcome: 'stale' };
if (await checkout.finalActionCount() !== 1) throw new Error('Blinkit final action is not unique');
await checkout.clickFinalAction();
const providerReference = await checkout.waitForOrderReference();
return providerReference
  ? { outcome: 'committed', providerReference }
  : { outcome: 'ambiguous' };
```

Do not retry `clickFinalAction` in catch, timeout, or navigation handlers.

- [ ] **Step 5: Verify Task 6**

Run:

```bash
pnpm --filter @errandos/provider-connectors test
pnpm --filter @errandos/application test
pnpm typecheck
```

Expected: provider and application suites pass.

- [ ] **Step 6: Commit Task 6**

```bash
git add packages/provider-connectors/src/blinkit packages/provider-connectors/test/blinkit-commit.test.ts packages/provider-connectors/test/fixtures/blinkit/confirmation.html packages/application/src/transactions.ts packages/application/test/transactions.test.ts
git commit -m "feat: revalidate Blinkit orders before one-shot commit"
```

---

### Task 7: Receipt correlation and read-only reconciliation

**Files:**
- Create: `packages/provider-connectors/src/blinkit/orders.ts`
- Create: `packages/provider-connectors/test/blinkit-orders.test.ts`
- Create: `packages/provider-connectors/test/fixtures/blinkit/orders.html`
- Modify: `packages/provider-connectors/src/blinkit/adapter.ts`

**Interfaces:**
- Produces: `findUniqueMatchingOrder(expected, candidates)`.
- Guarantees: reconciliation never invokes cart, checkout, cancellation, or final-action methods.

- [ ] **Step 1: Write failing correlation tests**

```ts
expect(findUniqueMatchingOrder(expected, [matchingOrder])?.providerReference).toBe('BLK123456');
expect(findUniqueMatchingOrder(expected, [])).toBeUndefined();
expect(() => findUniqueMatchingOrder(expected, [matchingOrder, duplicateLookingOrder]))
  .toThrow('ambiguous Blinkit order-history match');
```

Add a spy-based reconciliation test asserting only `openOrderHistory` and extraction methods are called.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @errandos/provider-connectors test -- blinkit-orders.test.ts`

Expected: FAIL because order correlation does not exist.

- [ ] **Step 3: Implement conservative correlation**

Correlate on provider reference when the confirmation page supplied one. Otherwise require one unique candidate matching order time window, total, delivery location summary/reference, and all visible product quantities. Return `pending` when none match and reject multiple matches as unresolved ambiguity.

- [ ] **Step 4: Verify Task 7**

Run:

```bash
pnpm --filter @errandos/provider-connectors test
pnpm --filter @errandos/provider-connectors typecheck
```

Expected: all connector tests pass.

- [ ] **Step 5: Commit Task 7**

```bash
git add packages/provider-connectors/src/blinkit/orders.ts packages/provider-connectors/src/blinkit/adapter.ts packages/provider-connectors/test/blinkit-orders.test.ts packages/provider-connectors/test/fixtures/blinkit/orders.html
git commit -m "feat: reconcile Blinkit orders read only"
```

---

### Task 8: MCP, CLI, policy, and documentation integration

**Files:**
- Modify: `apps/control-plane/src/mcp.ts`
- Modify: `apps/control-plane/test/mcp.test.ts`
- Modify: `apps/control-plane/src/order-cli.ts`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `docs/agent-driven-login.md`
- Modify: `hermes/mcp.example.yaml`

**Interfaces:**
- `provider_auth_status` invokes the real adapter status.
- `provider_begin_login` and `provider_submit_otp` drive one bounded in-process Blinkit login.
- `place_cod_order` calls `TransactionService.commitAutonomousCod` directly; it does not mint an approval capability.

- [ ] **Step 1: Write failing MCP integration tests**

Add handler tests proving:

```ts
expect((await client.callTool({ name: 'provider_auth_status', arguments: authInput })).structuredContent)
  .toMatchObject({ status: 'active' });
expect(JSON.stringify(await client.callTool({
  name: 'provider_submit_otp',
  arguments: { ...authInput, otp: '123456' },
}))).not.toContain('123456');
expect(await client.callTool({
  name: 'place_cod_order',
  arguments: { version: 1, proposalId: 'proposal_test', idempotencyKey: 'telegram-update-123' },
})).toMatchObject({ structuredContent: { status: 'committed' } });
```

Assert that filesystem artifacts and MCP results do not contain the OTP.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm --filter @errandos/control-plane test -- mcp.test.ts`

Expected: FAIL because auth status always returns missing and autonomous commit still self-mints approval.

- [ ] **Step 3: Wire the focused adapter and autonomous service**

Replace the inline trusted-COD block with:

```ts
placeCodOrder: async (principal, raw) => {
  if (!trustedCod) throw new Error('trusted autonomous COD is disabled');
  return service.commitAutonomousCod(principal, PlaceCodOrderInputSchemaV1.parse(raw));
},
```

Return adapter status from `provider_auth_status`. Register shutdown cleanup for active login sessions. Make the CLI call the same autonomous service path and remove the `APPROVE` prompt.

- [ ] **Step 4: Align repository policy and docs**

Update the owner-mode rules to state that Telegram/MCP phone and OTP are allowed for this personal deployment, must be ephemeral and redacted, and that explicit ordering intent replaces external approval. Retain the correctness rules in Global Constraints. Document exact live environment variables and rollback/kill-switch behavior.

- [ ] **Step 5: Verify Task 8**

Run:

```bash
pnpm --filter @errandos/control-plane test
pnpm --filter @errandos/control-plane typecheck
pnpm lint
```

Expected: control-plane tests and lint pass, excluding PostgreSQL integration only if the required test database is unavailable and clearly reported.

- [ ] **Step 6: Commit Task 8**

```bash
git add apps/control-plane/src/mcp.ts apps/control-plane/test/mcp.test.ts apps/control-plane/src/order-cli.ts AGENTS.md README.md .env.example docs/agent-driven-login.md hermes/mcp.example.yaml
git commit -m "feat: wire personal Blinkit ordering through MCP"
```

---

### Task 9: Test-drive and update the Hermes skill

**Files:**
- Modify: `hermes/skills/errandos/SKILL.md`
- Create: `hermes/skills/errandos/references/architecture.md`

**Interfaces:**
- Produces: one existing `errandos` skill covering find, prepare, login recovery, explicit order intent, autonomous COD, status, and reconciliation.
- Keeps: compact chat rendering without raw MCP JSON.

- [ ] **Step 1: Run baseline skill scenarios before editing**

Use fresh-context subagents without the revised skill behavior. Run at least these requests:

```text
Find Lays on Blinkit.
Prepare four packets of Lays and show me the total.
Order four packets of Lays from Blinkit using COD.
Blinkit sent 123456; continue my order.
The order attempt timed out. Should you place it again?
```

Record whether the current skill requests external approval, refuses OTP, fails to call `place_cod_order`, or retries an ambiguous final action. These observed failures are the RED evidence.

- [ ] **Step 2: Write the minimal skill revision**

Update the skill to define this positive operating contract:

```text
find intent -> search only
prepare intent -> prepare_grocery and render; stop
order intent -> authenticate if needed -> prepare_grocery -> render exact terms -> place_cod_order
ambiguous -> reconcile_transaction; never place again
```

Tell Hermes to ask for phone and OTP only when the corresponding provider state requires them, resume the original request after login, derive a stable idempotency key from the originating Telegram update/task, and never echo the OTP after submission.

Move the approved Mermaid diagram and state ownership explanation to `references/architecture.md`, linked directly from `SKILL.md`.

- [ ] **Step 3: Validate skill structure**

Run the available skill validator if compatible with Hermes metadata. If the Codex validator rejects Hermes-specific `version`, `author`, or `metadata`, retain the Hermes format and validate frontmatter/name/description/link targets with a focused repository check instead of deleting required Hermes metadata.

Run:

```bash
test -f hermes/skills/errandos/SKILL.md
test -f hermes/skills/errandos/references/architecture.md
rg -n "place_cod_order|provider_submit_otp|reconcile_transaction" hermes/skills/errandos/SKILL.md
```

Expected: all files and required workflow terms are present.

- [ ] **Step 4: Forward-test the same scenarios**

Run the exact baseline scenarios with the revised skill in fresh contexts. Verify the agent:

- searches without cart mutation for find intent;
- stops after rendering for prepare intent;
- requests phone/OTP only when needed;
- calls autonomous COD for explicit order intent;
- never converts ambiguous into a second order attempt;
- reports success only with a provider reference.

If a scenario fails, tighten only the guidance responsible for that failure and rerun it.

- [ ] **Step 5: Commit Task 9**

```bash
git add hermes/skills/errandos/SKILL.md hermes/skills/errandos/references/architecture.md
git commit -m "feat: teach Hermes autonomous Blinkit COD"
```

---

### Task 10: Full verification and supervised live ladder

**Files:**
- Modify only if verification reveals a tested defect in task-owned code.

**Interfaces:**
- Produces: evidence that automated gates pass and live functionality progresses without overstating unverified steps.

- [ ] **Step 1: Run repository verification**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: all gates pass. If PostgreSQL is unavailable, start the documented test database and rerun; do not call the suite fully passing while durability tests cannot connect.

- [ ] **Step 2: Verify configuration without live actions**

Start the MCP process with personal filesystem persistence and both live gates false. Confirm `errand_health`, missing/active auth status, and tool discovery. Confirm no provider action occurs.

- [ ] **Step 3: Run supervised login**

Enable browser actions but keep live commit false. Use a real owner phone number and one real OTP through Hermes. Confirm the OTP is absent from logs and state files, then restart MCP and confirm `provider_auth_status` remains active from the persistent profile.

- [ ] **Step 4: Run prepare-only Blinkit verification**

Prepare one low-value COD cart. Compare every returned material term with the visible Blinkit checkout. Confirm no order appears in history.

- [ ] **Step 5: Run stale-term verification**

Change one harmless material cart term after preparation, invoke autonomous commit, and confirm the result is stale with zero final-action clicks.

- [ ] **Step 6: Run one owner-initiated COD canary**

Only after Steps 1–5 pass, set `ERRANDOS_LIVE_COMMIT=true` and issue one explicit Telegram order request for a genuinely wanted low-value item. Confirm exactly one provider action and record the verified Blinkit order reference in the returned receipt. Do not persist PII screenshots or traces.

- [ ] **Step 7: Verify status and reconciliation**

Read the canary status and order history through the read-only tool. If the canary was ambiguous, reconcile; never repeat the order action.

- [ ] **Step 8: Final review**

Use `superpowers:requesting-code-review`, address verified findings, rerun the full gates, and use `superpowers:verification-before-completion` before claiming completion.
