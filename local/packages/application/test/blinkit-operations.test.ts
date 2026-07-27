import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlinkitCheckoutBlockedOutputV1, BlinkitStartPrepareCodOrderInputV1, PrincipalId, ProposalOutput } from '@errandos/contracts';
import { describe, expect, it } from 'vitest';
import {
  BlinkitOperationService,
  FileBlinkitOperationRepository,
  InMemoryBlinkitOperationRepository,
} from '../src/blinkit-operations.js';

const owner = 'owner' as PrincipalId;
const otherOwner = 'other-owner' as PrincipalId;
const input = (key = 'telegram-message-123'): BlinkitStartPrepareCodOrderInputV1 => ({
  version: 1,
  accountKey: 'main',
  items: [{ query: 'brown bread', quantity: 1, offerId: 'offer_abc' }],
  deliveryAddressRef: 'saved:home',
  deliveryAddressLabel: 'Home',
  idempotencyKey: key,
});
const proposal: ProposalOutput = {
  version: 1,
  proposalId: 'proposal_async',
  provider: 'blinkit',
  status: 'prepared',
  proposalHash: 'a'.repeat(64),
  summary: { kind: 'grocery', description: 'Brown Bread x1', items: [{ name: 'Brown Bread', quantity: 1 }], paymentMode: 'cod', addressSummary: 'Home' },
  expiresAt: '2026-07-23T10:06:00.000Z',
  requiresExternalApproval: false,
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
  }
  await assertion();
}

describe('durable Blinkit operations', () => {
  it('returns immediately and later exposes the completed proposal', async () => {
    const work = deferred<ProposalOutput>();
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => work.promise, {
      now: (): Date => new Date('2026-07-23T10:00:00.000Z'),
    });

    const started = await service.startPrepareCodOrder(owner, input());
    expect(started).toMatchObject({ status: 'running', operationId: expect.stringMatching(/^operation_/) });
    await expect(service.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId }))
      .resolves.toMatchObject({ status: 'running' });

    work.resolve(proposal);
    await eventually(async () => {
      expect(await service.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId }))
        .toMatchObject({ status: 'completed', proposal: { proposalId: 'proposal_async' } });
    });
  });

  it('deduplicates the same request key and rejects conflicting reuse', async () => {
    let calls = 0;
    const work = deferred<ProposalOutput>();
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => { calls += 1; return work.promise; });

    const first = await service.startPrepareCodOrder(owner, input());
    const duplicate = await service.startPrepareCodOrder(owner, input());
    expect(duplicate.operationId).toBe(first.operationId);
    await eventually(() => expect(calls).toBe(1));
    await expect(service.startPrepareCodOrder(owner, { ...input(), items: [{ query: 'milk', quantity: 1 }] }))
      .rejects.toThrow(/idempotency/i);
    work.resolve(proposal);
  });

  it('serializes operations for one emulator', async () => {
    const first = deferred<ProposalOutput>();
    const second = deferred<ProposalOutput>();
    const work = [first, second];
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => {
      const current = work[calls++]!;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try { return await current.promise; } finally { active -= 1; }
    });

    await service.startPrepareCodOrder(owner, input('telegram-message-123'));
    await service.startPrepareCodOrder(owner, input('telegram-message-456'));
    await eventually(() => expect(calls).toBe(1));
    first.resolve(proposal);
    await eventually(() => expect(calls).toBe(2));
    second.resolve({ ...proposal, proposalId: 'proposal_second' });
    await eventually(() => expect(active).toBe(0));
    expect(maximumActive).toBe(1);
  });

  it('persists running state across a service restart and expires an orphan', async () => {
    let now = new Date('2026-07-23T10:00:00.000Z');
    const root = await mkdtemp(join(tmpdir(), 'errandos-operations-'));
    const repository = new FileBlinkitOperationRepository(root);
    const firstService = new BlinkitOperationService(repository, async () => new Promise<ProposalOutput>(() => undefined), {
      now: (): Date => now,
      ttlMs: 60_000,
    });
    const started = await firstService.startPrepareCodOrder(owner, input());

    const restarted = new BlinkitOperationService(new FileBlinkitOperationRepository(root), async () => proposal, {
      now: (): Date => now,
      ttlMs: 60_000,
    });
    await expect(restarted.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId }))
      .resolves.toMatchObject({ status: 'running' });
    now = new Date('2026-07-23T10:01:01.000Z');
    await expect(restarted.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId }))
      .resolves.toMatchObject({ status: 'expired' });
  });

  it('lists recent owner/account operations in update order without request terms', async () => {
    let now = new Date('2026-07-23T10:00:00.000Z');
    const repository = new InMemoryBlinkitOperationRepository();
    const service = new BlinkitOperationService(repository, async () => proposal, { now: (): Date => now });
    const first = await service.startPrepareCodOrder(owner, input('telegram-message-123'));
    await eventually(async () => expect((await service.getStatus(owner, {
      version: 1,
      accountKey: 'main',
      operationId: first.operationId,
    })).status).toBe('completed'));
    now = new Date('2026-07-23T10:01:00.000Z');
    const second = await service.startPrepareCodOrder(owner, input('telegram-message-456'));
    await eventually(async () => expect((await service.getStatus(owner, {
      version: 1,
      accountKey: 'main',
      operationId: second.operationId,
    })).status).toBe('completed'));

    const recent = await service.listRecent(owner, { version: 1, accountKey: 'main', limit: 2 });
    expect(recent).toMatchObject({
      status: 'completed',
      operations: [
        { operationId: second.operationId, proposalId: 'proposal_async' },
        { operationId: first.operationId, proposalId: 'proposal_async' },
      ],
    });
    expect(JSON.stringify(recent)).not.toMatch(/items|deliveryAddress|idempotency|requestFingerprint/i);
    await expect(service.listRecent(otherOwner, { version: 1, accountKey: 'main', limit: 5 }))
      .resolves.toEqual({ version: 1, status: 'empty', operations: [] });
  });

  it('lists durable file operations after a service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'errandos-operation-list-'));
    const first = new BlinkitOperationService(new FileBlinkitOperationRepository(root), async () => proposal);
    const started = await first.startPrepareCodOrder(owner, input());
    await eventually(async () => expect((await first.getStatus(owner, {
      version: 1,
      accountKey: 'main',
      operationId: started.operationId,
    })).status).toBe('completed'));
    const restarted = new BlinkitOperationService(new FileBlinkitOperationRepository(root), async () => proposal);
    await expect(restarted.listRecent(owner, { version: 1, accountKey: 'main', limit: 5 }))
      .resolves.toMatchObject({ operations: [{ operationId: started.operationId, status: 'completed' }] });
  });

  it('isolates operation status by principal and account', async () => {
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => proposal);
    const started = await service.startPrepareCodOrder(owner, input());
    await expect(service.getStatus(otherOwner, { version: 1, accountKey: 'main', operationId: started.operationId })).rejects.toThrow(/not found/i);
    await expect(service.getStatus(owner, { version: 1, accountKey: 'other', operationId: started.operationId })).rejects.toThrow(/not found/i);
  });

  it('stores only an allowlisted failure reason', async () => {
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => {
      throw new Error('selector #secret contained a raw address');
    });
    const started = await service.startPrepareCodOrder(owner, input());
    await eventually(async () => {
      const status = await service.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId });
      expect(status).toMatchObject({ status: 'failed', reason: 'operation_failed' });
      expect(JSON.stringify(status)).not.toMatch(/selector|secret|address/i);
    });
  });

  it('persists a typed provider constraint as a terminal blocked result', async () => {
    const blocked: BlinkitCheckoutBlockedOutputV1 = {
      version: 1,
      provider: 'blinkit',
      status: 'blocked',
      reason: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    };
    const service = new BlinkitOperationService(new InMemoryBlinkitOperationRepository(), async () => {
      throw new Error('raw provider screen with a private address');
    }, { blockedResult: (): BlinkitCheckoutBlockedOutputV1 => blocked });
    const started = await service.startPrepareCodOrder(owner, input());

    await eventually(async () => {
      const status = await service.getStatus(owner, { version: 1, accountKey: 'main', operationId: started.operationId });
      expect(status).toMatchObject({ status: 'blocked', reason: 'cod_minimum_not_met', itemSubtotal: 25, requiredSubtotal: 50 });
      expect(JSON.stringify(status)).not.toMatch(/raw provider|private address/i);
    });
  });
});
