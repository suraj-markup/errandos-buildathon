import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AndroidExpectedCheckoutV1 } from '@errandos/contracts';
import {
  FileAndroidCommitStore,
  commitOnce,
  reconcileFromOrderHistory,
  type AndroidCommitRecord,
  type AndroidCommitStore,
} from '../src/blinkit/android-commit.js';

const checkout: AndroidExpectedCheckoutV1['checkout'] = {
  lines: [{
    productId: 'crapido-1',
    name: 'Diet Coke',
    quantity: 1,
    unitPrice: { currency: 'INR', amount: 40 },
    lineTotal: { currency: 'INR', amount: 40 },
  }],
  unavailableItems: [],
  fees: [{ kind: 'handling', label: 'Handling charge', amount: { currency: 'INR', amount: 5 } }],
  total: { currency: 'INR', amount: 45 },
  addressReference: 'home',
  addressLabel: 'Home',
  paymentMode: 'cod',
  etaMinutes: 9,
  providerFingerprint: 'a'.repeat(64),
};

const expected: AndroidExpectedCheckoutV1 = {
  proposalId: 'proposal-1',
  proposalHash: 'b'.repeat(64),
  idempotencyKey: 'message-1:proposal-1',
  preparedAt: '2026-07-19T10:00:00.000Z',
  expiresAt: '2026-07-19T10:05:00.000Z',
  checkout,
};

class MemoryStore implements AndroidCommitStore {
  public record?: AndroidCommitRecord;

  public async get(): Promise<AndroidCommitRecord | undefined> { return this.record; }
  public async recordDispatch(value: AndroidCommitRecord): Promise<{ created: boolean; record: AndroidCommitRecord }> {
    if (this.record) return { created: false, record: this.record };
    this.record = value;
    return { created: true, record: value };
  }
  public async recordOutcome(_key: string, state: 'committed' | 'ambiguous', providerReference?: string): Promise<void> {
    if (!this.record) throw new Error('missing dispatch');
    this.record = { ...this.record, state, ...(providerReference ? { providerReference } : {}) };
  }
}

describe('Android Blinkit final action', () => {
  it('persists dispatch before the final click', async () => {
    const sequence: string[] = [];
    const store = new MemoryStore();
    const result = await commitOnce(expected, {
      store: {
        get: () => store.get(),
        recordDispatch: async (record) => { sequence.push('persist'); return store.recordDispatch(record); },
        recordOutcome: (key, state, reference) => store.recordOutcome(key, state, reference),
      },
      readCheckout: async () => checkout,
      clickFinal: async () => { sequence.push('click'); },
      readConfirmation: async () => ({ status: 'committed', providerReference: 'order-1' }),
      now: () => new Date('2026-07-19T10:01:00.000Z'),
    });

    expect(sequence).toEqual(['persist', 'click']);
    expect(result).toEqual({ outcome: 'committed', providerReference: 'order-1' });
  });

  it('returns stale without clicking when terms changed', async () => {
    let clicks = 0;
    const result = await commitOnce(expected, {
      store: new MemoryStore(),
      readCheckout: async () => ({ ...checkout, total: { currency: 'INR', amount: 46 } }),
      clickFinal: async () => { clicks += 1; },
      readConfirmation: async () => ({ status: 'unverified' }),
    });

    expect(result).toEqual({ outcome: 'stale' });
    expect(clicks).toBe(0);
  });

  it('returns ambiguous and never retries after a post-click disconnect', async () => {
    const store = new MemoryStore();
    let clicks = 0;
    const dependencies = {
      store,
      readCheckout: async (): Promise<typeof checkout> => checkout,
      clickFinal: async (): Promise<void> => { clicks += 1; },
      readConfirmation: async (): Promise<never> => { throw new Error('disconnected'); },
      now: (): Date => new Date('2026-07-19T10:01:00.000Z'),
    };

    expect(await commitOnce(expected, dependencies)).toEqual({ outcome: 'ambiguous' });
    expect(await commitOnce(expected, dependencies)).toEqual({ outcome: 'ambiguous' });
    expect(clicks).toBe(1);
  });

  it('returns the stored committed result for a duplicate idempotency key', async () => {
    const store = new MemoryStore();
    let clicks = 0;
    const dependencies = {
      store,
      readCheckout: async (): Promise<typeof checkout> => checkout,
      clickFinal: async (): Promise<void> => { clicks += 1; },
      readConfirmation: async (): Promise<{ status: 'committed'; providerReference: string }> => ({ status: 'committed', providerReference: 'order-1' }),
      now: (): Date => new Date('2026-07-19T10:01:00.000Z'),
    };

    expect(await commitOnce(expected, dependencies)).toEqual({ outcome: 'committed', providerReference: 'order-1' });
    expect(await commitOnce(expected, dependencies)).toEqual({ outcome: 'committed', providerReference: 'order-1' });
    expect(clicks).toBe(1);
  });

  it('reconciles from history without any final action', async () => {
    let reads = 0;
    const result = await reconcileFromOrderHistory(expected, {
      readOrders: async () => {
        reads += 1;
        return [{ providerReference: 'order-1', orderedAt: '2026-07-19T10:02:00.000Z', checkout }];
      },
    });

    expect(result).toEqual({ outcome: 'committed', providerReference: 'order-1' });
    expect(reads).toBe(1);
  });

  it('keeps reconciliation pending when matching history is not unique', async () => {
    const candidate = { providerReference: 'order-1', orderedAt: '2026-07-19T10:02:00.000Z', checkout };
    expect(await reconcileFromOrderHistory(expected, { readOrders: async () => [candidate, { ...candidate, providerReference: 'order-2' }] }))
      .toEqual({ outcome: 'pending' });
  });

  it('stores only hashes, state, timestamps, and a provider reference in owner-only files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'errandos-android-commit-'));
    const store = new FileAndroidCommitStore(root);
    const keyHash = createHash('sha256').update(expected.idempotencyKey).digest('hex');
    await store.recordDispatch({
      idempotencyKeyHash: keyHash,
      proposalHash: expected.proposalHash,
      providerFingerprint: checkout.providerFingerprint,
      state: 'dispatching',
      dispatchedAt: '2026-07-19T10:01:00.000Z',
    });
    await store.recordOutcome(expected.idempotencyKey, 'committed', 'order-1');

    const directory = await stat(root);
    const serialized = await readFile(join(root, `${keyHash}.json`), 'utf8');
    expect(directory.mode & 0o777).toBe(0o700);
    expect(serialized).not.toMatch(/Diet Coke|Home|message-1|phone|otp/i);
    expect(serialized).toContain('order-1');
  });
});
