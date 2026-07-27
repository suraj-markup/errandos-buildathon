/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import { ApprovalRequiredError, IdempotencyConflictError, InMemoryProposalRepository, LiveCommitDisabledError, ProposalNotFoundError, TransactionService, hashProposalSnapshot, projectProposalSummary, type TransactionProviderPort } from '../src/index.js';
import type { GroceryProposalSnapshotV1, PrincipalId, ProposalSnapshotV1, RideProposalSnapshotV1 } from '@errandos/contracts';
const alice = 'alice' as PrincipalId, bob = 'bob' as PrincipalId;
const grocery: GroceryProposalSnapshotV1 = { version: 1, kind: 'grocery', provider: 'blinkit', principalId: alice, accountReference: 'main', revision: 1, lines: [{ productId: 'sku-42', name: 'Whole Milk', quantity: 1, unitPrice: { currency: 'INR', amount: 220 }, lineTotal: { currency: 'INR', amount: 220 } }], unavailableItems: [{ query: 'Diet cola', reason: 'out_of_stock' }], fees: [{ kind: 'delivery', label: 'Delivery', amount: { currency: 'INR', amount: 30 } }], total: { currency: 'INR', amount: 250 }, deliveryAddress: { reference: 'home', summary: 'Home' }, etaMinutes: 12, paymentMode: 'cod', providerFingerprint: 'a'.repeat(64), preparedAt: '2026-01-01T00:00:00.000Z', quoteExpiresAt: '2026-01-01T00:05:00.000Z' };
function setup(enabled = false, now = () => new Date('2026-01-01T00:00:00Z')) { let commits = 0; const contexts: unknown[] = []; const repo = new InMemoryProposalRepository(); const port: TransactionProviderPort = { prepareGrocery: async () => ({ snapshot: grocery, providerStateRef: 'state-1' }), prepareExistingGrocery: async () => ({ snapshot: grocery, providerStateRef: 'existing-state-1' }), compareGrocery: async () => ({ matches: true, changes: [], currentProviderFingerprint: grocery.providerFingerprint! }), commit: async (_owner, _state, context) => { commits++; contexts.push(context); return { outcome: 'committed', providerReference: 'provider-1' }; }, reconcile: async () => ({ outcome: 'pending' }) }; const service = new TransactionService(repo, { blinkit: port }, { consume: async token => token === 'externally-signed-capability' }, enabled, now); return { service, repo, contexts, get commits() { return commits; } }; }
const input = { version: 1 as const, provider: 'blinkit' as const, accountKey: 'main', items: [{ query: 'milk', quantity: 1 }], deliveryAddressRef: 'home', paymentMode: 'cod' as const };
describe('transaction safety', () => {
  it('stores the exact validated provider snapshot and derives display from it', async () => { const x = setup(); const p = await x.service.prepareGrocery(alice, input); const record = await x.repo.get(p.proposalId); expect(record?.snapshot).toEqual(grocery); expect(p.proposalHash).toBe(hashProposalSnapshot(grocery)); expect(p.summary).toEqual(projectProposalSummary(grocery)); expect(p.summary).toMatchObject({ items: [{ name: 'Whole Milk', quantity: 1, unitPrice: { amount: 220 }, lineTotal: { amount: 220 } }], unavailableItems: [{ query: 'Diet cola', reason: 'out_of_stock' }], fees: [{ kind: 'delivery', amount: { amount: 30 } }], etaMinutes: 12 }); expect(x.commits).toBe(0); await expect(x.service.get(bob, p.proposalId)).rejects.toBeInstanceOf(ProposalNotFoundError); });
  it('stores an existing app cart as an owner-isolated immutable proposal', async () => { const x = setup(); const p = await x.service.prepareExistingGrocery(alice, { version: 1, provider: 'blinkit', accountKey: 'main', paymentMode: 'cod' }); expect(p.proposalHash).toBe(hashProposalSnapshot(grocery)); expect((await x.repo.get(p.proposalId))?.providerStateRef).toBe('existing-state-1'); await expect(x.service.get(bob, p.proposalId)).rejects.toBeInstanceOf(ProposalNotFoundError); });
  it('compares a proposal with an exact live checkout review without committing', async () => {
    const x = setup();
    const proposal = await x.service.prepareGrocery(alice, input);
    await expect(x.service.compareBlinkitProposal(alice, proposal.proposalId, 'main')).resolves.toMatchObject({
      proposalId: proposal.proposalId,
      status: 'unchanged',
      changes: [],
      currentProviderFingerprint: grocery.providerFingerprint,
    });
    expect(x.commits).toBe(0);
    await expect(x.service.compareBlinkitProposal(bob, proposal.proposalId, 'main')).rejects.toBeInstanceOf(ProposalNotFoundError);
    await expect(x.service.compareBlinkitProposal(alice, proposal.proposalId, 'other')).rejects.toThrow(/not comparable/i);
  });
  it('returns changed fields and expiry for proposal comparison', async () => {
    let time = new Date('2026-01-01T00:00:00Z');
    const repo = new InMemoryProposalRepository();
    const changedPort: TransactionProviderPort = {
      prepareGrocery: async () => ({ snapshot: grocery, providerStateRef: 'state-1' }),
      compareGrocery: async () => ({
        matches: false,
        changes: ['items', 'unavailable_items', 'fees', 'total', 'address', 'eta', 'provider_fingerprint'],
        currentProviderFingerprint: 'b'.repeat(64),
      }),
      commit: async () => ({ outcome: 'stale' }),
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const service = new TransactionService(repo, { blinkit: changedPort }, { consume: async () => false }, false, () => time);
    const proposal = await service.prepareGrocery(alice, input);
    await expect(service.compareBlinkitProposal(alice, proposal.proposalId, 'main')).resolves.toMatchObject({
      status: 'changed',
      changes: expect.arrayContaining(['items', 'unavailable_items', 'fees', 'total', 'address', 'eta', 'provider_fingerprint']),
    });
    time = new Date('2026-01-01T00:06:00Z');
    await expect(service.compareBlinkitProposal(alice, proposal.proposalId, 'main')).resolves.toMatchObject({
      status: 'expired',
      proposalStatus: 'stale',
      changes: [],
    });
  });
  it('does not trust a separately persisted display summary', async () => { const x = setup(); const p = await x.service.prepareGrocery(alice, input); const record = (await x.repo.get(p.proposalId))!; record.output.summary = { ...record.output.summary, description: 'TAMPERED' }; await x.repo.save(p.proposalId, record); expect((await x.service.get(alice, p.proposalId)).summary).toEqual(projectProposalSummary(grocery)); });
  it('expires stale proposals', async () => { let time = new Date('2026-01-01T00:00:00Z'); const x = setup(false, () => time); const p = await x.service.prepareGrocery(alice, input); time = new Date('2026-01-01T00:06:00Z'); expect((await x.service.get(alice, p.proposalId)).status).toBe('stale'); });
  it('turns an expired orphaned committing state into ambiguous reconciliation', async () => { let time = new Date('2026-01-01T00:00:00Z'); const x = setup(true, () => time); const p = await x.service.prepareGrocery(alice, input); const record = (await x.repo.get(p.proposalId))!; record.output = { ...record.output, status: 'committing' }; await x.repo.save(p.proposalId, record); time = new Date('2026-01-01T00:06:00Z'); expect((await x.service.get(alice, p.proposalId)).status).toBe('ambiguous'); expect((await x.repo.get(p.proposalId))?.receipt).toEqual({ version: 1, proposalId: p.proposalId, status: 'ambiguous', reconciliationRequired: true }); });
  it('rejects snapshot/hash divergence immediately before commit', async () => { const x = setup(true); const p = await x.service.prepareGrocery(alice, input); const record = (await x.repo.get(p.proposalId))!; record.snapshot = { ...grocery, deliveryAddress: { ...grocery.deliveryAddress, summary: 'Tampered' } }; await x.repo.save(p.proposalId, record); const result = await x.service.commit(alice, { version: 1, proposalId: p.proposalId, approvalCapability: 'externally-signed-capability', idempotencyKey: 'tamper-123456' }); expect(result.status).toBe('stale'); expect(x.commits).toBe(0); expect((await x.repo.get(p.proposalId))?.output.status).toBe('stale'); });
  it('rehashes complete replacement including products, fees, references and expiry', async () => { const x = setup(true); const p = await x.service.prepareGrocery(alice, input); const replacement: GroceryProposalSnapshotV1 = { ...grocery, revision: 2, lines: [{ ...grocery.lines[0]!, productId: 'sku-99', name: 'A2 Milk' }], fees: [{ kind: 'handling', label: 'Handling', amount: { currency: 'INR', amount: 15 } }], deliveryAddress: { reference: 'office', summary: 'Office' }, total: { currency: 'INR', amount: 235 }, quoteExpiresAt: '2026-01-01T00:10:00.000Z' }; const changed = await x.service.markMaterialChange(alice, p.proposalId, { snapshot: replacement, providerStateRef: 'state-2' }); expect(changed.proposalHash).toBe(hashProposalSnapshot(replacement)); expect(changed.proposalHash).not.toBe(p.proposalHash); expect(changed.expiresAt).toBe(replacement.quoteExpiresAt); expect(changed.summary).toEqual(projectProposalSummary(replacement)); await expect(x.service.commit(alice, { version: 1, proposalId: p.proposalId, approvalCapability: 'old-invalid-capability-value', idempotencyKey: 'key-12345678' })).rejects.toBeInstanceOf(ApprovalRequiredError); });
  it('live commit is off by default', async () => { const x = setup(); const p = await x.service.prepareGrocery(alice, input); await expect(x.service.commit(alice, { version: 1, proposalId: p.proposalId, approvalCapability: 'externally-signed-capability', idempotencyKey: 'key-12345678' })).rejects.toBeInstanceOf(LiveCommitDisabledError); });
  it('commit is idempotent and returns original receipt', async () => { const x = setup(true); const p = await x.service.prepareGrocery(alice, input); const c = { version: 1 as const, proposalId: p.proposalId, approvalCapability: 'externally-signed-capability', idempotencyKey: 'key-12345678' }; const one = await x.service.commit(alice, c); const two = await x.service.commit(alice, c); expect(two).toEqual(one); expect(x.commits).toBe(1); });
  it('passes the immutable proposal authority to the provider exactly once', async () => { const x = setup(true); const p = await x.service.prepareGrocery(alice, input); await x.service.commit(alice, { version: 1, proposalId: p.proposalId, approvalCapability: 'externally-signed-capability', idempotencyKey: 'dispatch-key-1' }); expect(x.contexts).toEqual([{ proposalId: p.proposalId, proposalHash: p.proposalHash, providerFingerprint: 'a'.repeat(64), idempotencyKey: 'dispatch-key-1' }]); });
  it('rejects reuse of an idempotency key for a different proposal', async () => { const x = setup(true); const first = await x.service.prepareGrocery(alice, input); const second = await x.service.prepareGrocery(alice, input); const base = { version: 1 as const, approvalCapability: 'externally-signed-capability', idempotencyKey: 'key-conflict-1' }; await x.service.commit(alice, { ...base, proposalId: first.proposalId }); await expect(x.service.commit(alice, { ...base, proposalId: second.proposalId })).rejects.toBeInstanceOf(IdempotencyConflictError); expect(x.commits).toBe(1); });
  it('rejects already-expired provider snapshots during preparation', async () => { const x = setup(false, () => new Date('2026-01-01T00:06:00Z')); await expect(x.service.prepareGrocery(alice, input)).rejects.toThrow('already expired'); });
});

describe('Rapido ride transactions', () => {
  const ride: RideProposalSnapshotV1 = {
    version: 1,
    kind: 'ride',
    provider: 'rapido',
    principalId: alice,
    accountReference: 'main',
    revision: 1,
    route: {
      pickupReference: 'pickup_indiranagar',
      pickupSummary: 'Indiranagar',
      dropoffReference: 'dropoff_airport',
      dropoffSummary: 'Kempegowda Airport',
    },
    rideOption: { id: 'option_prime', name: 'Prime Sedan' },
    fare: {
      minimum: { currency: 'INR', amount: 850 },
      maximum: { currency: 'INR', amount: 920 },
      fees: [],
    },
    paymentMode: 'cash',
    etaMinutes: 6,
    providerFingerprint: 'c'.repeat(64),
    preparedAt: '2026-01-01T00:00:00.000Z',
    quoteExpiresAt: '2026-01-01T00:05:00.000Z',
  };
  const rideInput = {
    version: 1 as const,
    accountKey: 'main',
    pickup: { query: 'Indiranagar' },
    dropoff: { query: 'Kempegowda Airport' },
    rideOptionId: 'option_prime',
    paymentMode: 'cash' as const,
  };

  it('stores an owner-isolated immutable Rapido ride proposal and requires external approval', async () => {
    const repo = new InMemoryProposalRepository();
    const port: TransactionProviderPort = {
      prepareRide: async () => ({ snapshot: ride, providerStateRef: 'rapido-state-1' }),
      compareRide: async () => ({ matches: true, changes: [], currentProviderFingerprint: ride.providerFingerprint }),
      commit: async () => ({ outcome: 'committed', providerReference: 'RAPIDO12345' }),
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const service = new TransactionService(repo, { rapido: port }, { consume: async () => false }, false, () => new Date('2026-01-01T00:00:00Z'));
    const proposal = await service.prepareRapido(alice, rideInput);
    expect(proposal).toMatchObject({
      provider: 'rapido',
      status: 'approval_required',
      requiresExternalApproval: true,
      summary: {
        kind: 'ride',
        pickupSummary: 'Indiranagar',
        dropoffSummary: 'Kempegowda Airport',
        rideType: 'Prime Sedan',
        fareMin: { amount: 850 },
        fareMax: { amount: 920 },
      },
    });
    await expect(service.compareRapidoProposal(alice, proposal.proposalId, 'main')).resolves.toMatchObject({
      status: 'unchanged',
      changes: [],
    });
    await expect(service.get(bob, proposal.proposalId)).rejects.toBeInstanceOf(ProposalNotFoundError);
  });

  it('marks expired Rapido terms and never permits Blinkit owner-autonomous COD for a ride', async () => {
    let time = new Date('2026-01-01T00:00:00Z');
    const port: TransactionProviderPort = {
      prepareRide: async () => ({ snapshot: ride, providerStateRef: 'rapido-state-1' }),
      commit: async () => ({ outcome: 'committed', providerReference: 'RAPIDO12345' }),
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const service = new TransactionService(
      new InMemoryProposalRepository(),
      { rapido: port },
      { consume: async () => true },
      true,
      () => time,
      'owner_autonomous',
      { issue: () => 'internally-minted-capability' },
    );
    const proposal = await service.prepareRapido(alice, rideInput);
    await expect(service.commitAutonomousCod(alice, {
      version: 1,
      proposalId: proposal.proposalId,
      idempotencyKey: 'rapido-autonomous-1',
    })).rejects.toThrow('Blinkit grocery only');
    time = new Date('2026-01-01T00:06:00Z');
    await expect(service.compareRapidoProposal(alice, proposal.proposalId, 'main')).resolves.toMatchObject({
      status: 'expired',
      changes: ['quote_expiry'],
    });
  });
});

describe('owner-autonomous COD transactions', () => {
  function autonomousSetup(snapshot: ProposalSnapshotV1 = grocery, outcome: 'committed' | 'stale' = 'committed') {
    let commits = 0;
    let approvalConsumptions = 0;
    const repo = new InMemoryProposalRepository();
    const port: TransactionProviderPort = {
      prepareGrocery: async () => ({ snapshot, providerStateRef: 'state-autonomous' }),
      commit: async () => { commits++; return outcome === 'stale' ? { outcome } : { outcome, providerReference: 'blinkit-order-1' }; },
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const service = new TransactionService(
      repo,
      { blinkit: port },
      { consume: async (capability) => { approvalConsumptions++; return capability === 'internally-minted-capability'; } },
      true,
      () => new Date('2026-01-01T00:00:00Z'),
      'owner_autonomous',
      { issue: () => 'internally-minted-capability' },
    );
    return { service, repo, get commits() { return commits; }, get approvalConsumptions() { return approvalConsumptions; } };
  }

  it('prepares without external approval and dispatches a duplicate command once', async () => {
    const x = autonomousSetup();
    const proposal = await x.service.prepareGrocery(alice, input);
    expect(proposal).toMatchObject({ status: 'prepared', requiresExternalApproval: false });
    const command = { version: 1 as const, proposalId: proposal.proposalId, idempotencyKey: 'telegram-update-123' };
    const first = await x.service.commitAutonomousCod(alice, command);
    const second = await x.service.commitAutonomousCod(alice, command);
    expect(second).toEqual(first);
    expect(x.commits).toBe(1);
    expect(x.approvalConsumptions).toBe(1);
  });

  it('is unavailable in external-approval mode', async () => {
    const x = setup(true);
    const proposal = await x.service.prepareGrocery(alice, input);
    await expect(x.service.commitAutonomousCod(alice, {
      version: 1,
      proposalId: proposal.proposalId,
      idempotencyKey: 'telegram-update-124',
    })).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('rejects non-COD grocery proposals', async () => {
    const savedPayment = autonomousSetup({ ...grocery, paymentMode: 'provider_saved' });
    const groceryProposal = await savedPayment.service.prepareGrocery(alice, { ...input, paymentMode: 'provider_saved' });
    expect(groceryProposal).toMatchObject({ status: 'approval_required', requiresExternalApproval: true });
    await expect(savedPayment.service.commitAutonomousCod(alice, {
      version: 1,
      proposalId: groceryProposal.proposalId,
      idempotencyKey: 'telegram-update-126',
    })).rejects.toThrow('COD only');
  });

  it('maps provider revalidation failure to stale without reconciliation', async () => {
    const x = autonomousSetup(grocery, 'stale');
    const proposal = await x.service.prepareGrocery(alice, input);
    const result = await x.service.commitAutonomousCod(alice, {
      version: 1,
      proposalId: proposal.proposalId,
      idempotencyKey: 'telegram-update-127',
    });
    expect(result).toEqual({ version: 1, proposalId: proposal.proposalId, status: 'stale', reconciliationRequired: false });
    expect(x.commits).toBe(1);
  });

  it('treats a persisted committing state as ambiguous and never dispatches again', async () => {
    const x = autonomousSetup();
    const proposal = await x.service.prepareGrocery(alice, input);
    const record = (await x.repo.get(proposal.proposalId))!;
    record.output = { ...record.output, status: 'committing' };
    await x.repo.save(proposal.proposalId, record);
    await expect(x.service.commitAutonomousCod(alice, {
      version: 1,
      proposalId: proposal.proposalId,
      idempotencyKey: 'telegram-update-crash-1',
    })).resolves.toEqual({ version: 1, proposalId: proposal.proposalId, status: 'ambiguous', reconciliationRequired: true });
    expect(x.commits).toBe(0);
  });

  it('coalesces concurrent duplicate commands into one provider dispatch', async () => {
    let commits = 0;
    const repo = new InMemoryProposalRepository();
    const port: TransactionProviderPort = {
      prepareGrocery: async () => ({ snapshot: grocery, providerStateRef: 'state-concurrent' }),
      commit: async () => { commits++; await new Promise((resolve) => setTimeout(resolve, 10)); return { outcome: 'committed', providerReference: 'provider-concurrent' }; },
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const approvals = { consume: async (capability: string): Promise<boolean> => capability === 'internally-minted-capability' };
    const service = new TransactionService(repo, { blinkit: port }, approvals, true, () => new Date('2026-01-01T00:00:00Z'), 'owner_autonomous', { issue: () => 'internally-minted-capability' });
    const proposal = await service.prepareGrocery(alice, input);
    const command = { version: 1 as const, proposalId: proposal.proposalId, idempotencyKey: 'telegram-concurrent-1' };
    const [first, second] = await Promise.all([service.commitAutonomousCod(alice, command), service.commitAutonomousCod(alice, command)]);
    expect(second).toEqual(first);
    expect(commits).toBe(1);
  });

  it('coalesces concurrent commands for one proposal even when their idempotency keys differ', async () => {
    let commits = 0;
    const repo = new InMemoryProposalRepository();
    const port: TransactionProviderPort = {
      prepareGrocery: async () => ({ snapshot: grocery, providerStateRef: 'state-concurrent-proposal' }),
      commit: async () => { commits++; await new Promise((resolve) => setTimeout(resolve, 10)); return { outcome: 'committed', providerReference: 'provider-concurrent-proposal' }; },
      reconcile: async () => ({ outcome: 'pending' }),
    };
    const approvals = { consume: async (): Promise<boolean> => true };
    const service = new TransactionService(repo, { blinkit: port }, approvals, true, () => new Date('2026-01-01T00:00:00Z'), 'owner_autonomous', { issue: () => 'internally-minted-capability' });
    const proposal = await service.prepareGrocery(alice, input);
    const first = service.commitAutonomousCod(alice, { version: 1, proposalId: proposal.proposalId, idempotencyKey: 'telegram-concurrent-a' });
    const second = service.commitAutonomousCod(alice, { version: 1, proposalId: proposal.proposalId, idempotencyKey: 'telegram-concurrent-b' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'committed' }),
      expect.objectContaining({ status: 'committed' }),
    ]);
    expect(commits).toBe(1);
  });
});
