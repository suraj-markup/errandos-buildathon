import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrincipalId } from '@errandos/contracts';
import { describe, expect, it } from 'vitest';
import { BlinkitReadOnlyReconciler, extractBlinkitOrderCandidates, findUniqueMatchingOrder, type BlinkitOrderCandidate, type BlinkitOrderExpectation, type BlinkitOrderHistoryPort } from '../src/blinkit/orders.js';

const owner = 'personal-owner' as PrincipalId;
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/blinkit/orders.html');
const expected: BlinkitOrderExpectation = {
  notBefore: '2026-07-14T12:00:00.000Z',
  notAfter: '2026-07-14T12:10:00.000Z',
  total: { currency: 'INR', amount: 120 },
  addressSummary: 'Home',
  deliveryLocationReference: 'home-1',
  lines: [{ productId: '123', quantity: 2 }],
};
const matching: BlinkitOrderCandidate = {
  providerReference: 'BLK123456',
  orderedAt: '2026-07-14T12:04:00.000Z',
  total: { currency: 'INR', amount: 120 },
  addressSummary: 'Home',
  deliveryLocationReference: 'home-1',
  lines: [{ productId: '123', quantity: 2 }],
};

describe('conservative Blinkit order correlation', () => {
  it('extracts complete correlation facts from sanitized order history', async () => {
    expect(extractBlinkitOrderCandidates(await readFile(fixture, 'utf8'))).toEqual([matching]);
  });
  it('returns one exact match and no result when none match', () => {
    expect(findUniqueMatchingOrder(expected, [matching])?.providerReference).toBe('BLK123456');
    expect(findUniqueMatchingOrder(expected, [{ ...matching, total: { currency: 'INR', amount: 121 } }])).toBeUndefined();
  });

  it('uses an existing provider reference as the strongest identity', () => {
    expect(findUniqueMatchingOrder({ ...expected, providerReference: 'BLK999999' }, [matching, { ...matching, providerReference: 'BLK999999' }])?.providerReference).toBe('BLK999999');
  });

  it('refuses multiple equally plausible matches', () => {
    expect(() => findUniqueMatchingOrder(expected, [matching, { ...matching, providerReference: 'BLK654321' }])).toThrow('ambiguous Blinkit order-history match');
  });

  it('reconciliation invokes only read-only order-history methods', async () => {
    const calls: string[] = [];
    const history: BlinkitOrderHistoryPort = {
      openOrderHistory: async (): Promise<void> => { calls.push('openOrderHistory'); },
      extractOrders: async (): Promise<BlinkitOrderCandidate[]> => { calls.push('extractOrders'); return [matching]; },
      close: async (): Promise<void> => { calls.push('close'); },
    };
    const state = { get: async (): Promise<unknown> => ({ provider: 'blinkit', accountKey: 'main', expectation: expected }) };
    const reconciler = new BlinkitReadOnlyReconciler(state, async () => history);
    await expect(reconciler.reconcile(owner, 'state-1')).resolves.toEqual({ outcome: 'committed', providerReference: 'BLK123456' });
    expect(calls).toEqual(['openOrderHistory', 'extractOrders', 'close']);
    expect(calls.join(' ')).not.toMatch(/cart|checkout|click|cancel/i);
  });

  it('returns pending when history has no unique match', async () => {
    const history: BlinkitOrderHistoryPort = { openOrderHistory: async () => undefined, extractOrders: async () => [], close: async () => undefined };
    const state = { get: async (): Promise<unknown> => ({ provider: 'blinkit', accountKey: 'main', expectation: expected }) };
    await expect(new BlinkitReadOnlyReconciler(state, async () => history).reconcile(owner, 'state-1')).resolves.toEqual({ outcome: 'pending' });
  });
});
