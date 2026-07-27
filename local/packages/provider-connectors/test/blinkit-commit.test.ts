import type { PrincipalId } from '@errandos/contracts';
import { describe, expect, it } from 'vitest';
import { BlinkitCodCommitAdapter, compareMaterialGroceryTerms, type BlinkitCheckoutPort } from '../src/blinkit/commit.js';
import type { BlinkitCheckoutReview } from '../src/blinkit/review.js';

const owner = 'personal-owner' as PrincipalId;
const expected: BlinkitCheckoutReview = {
  lines: [{ productId: '123', name: 'Milk 500 ml', quantity: 2, unitPrice: { currency: 'INR', amount: 55 }, lineTotal: { currency: 'INR', amount: 110 } }],
  fees: [{ kind: 'handling', label: 'Handling charge', amount: { currency: 'INR', amount: 10 } }],
  total: { currency: 'INR', amount: 120 },
  addressSummary: 'Home',
  deliveryLocationReference: 'home-1',
  etaMinutes: 12,
  paymentMode: 'cod',
  providerFingerprint: 'fingerprint-1',
};

class FakeCheckout implements BlinkitCheckoutPort {
  public finalActionCountValue = 1;
  public finalActionClicks = 0;
  public reference: string | undefined = 'BLK123456';
  public review: BlinkitCheckoutReview = expected;
  public async extractReview(): Promise<BlinkitCheckoutReview> { return this.review; }
  public async finalActionCount(): Promise<number> { return this.finalActionCountValue; }
  public async clickFinalAction(): Promise<void> { this.finalActionClicks++; }
  public async waitForOrderReference(): Promise<string | undefined> { return this.reference; }
  public async close(): Promise<void> {}
}

function setup(page = new FakeCheckout()): { adapter: BlinkitCodCommitAdapter; page: FakeCheckout } {
  const state = { get: async (): Promise<unknown> => ({ provider: 'blinkit', accountKey: 'main', review: expected }) };
  return { adapter: new BlinkitCodCommitAdapter(state, async () => page, true), page };
}

describe('Blinkit material revalidation', () => {
  it.each([
    ['quantity', { ...expected, lines: [{ ...expected.lines[0]!, quantity: 3, lineTotal: { currency: 'INR' as const, amount: 165 } }], total: { currency: 'INR' as const, amount: 175 } }],
    ['unit price', { ...expected, lines: [{ ...expected.lines[0]!, unitPrice: { currency: 'INR' as const, amount: 60 }, lineTotal: { currency: 'INR' as const, amount: 120 } }], total: { currency: 'INR' as const, amount: 130 } }],
    ['fee', { ...expected, fees: [{ ...expected.fees[0]!, amount: { currency: 'INR' as const, amount: 12 } }], total: { currency: 'INR' as const, amount: 122 } }],
    ['total', { ...expected, total: { currency: 'INR' as const, amount: 121 } }],
    ['address', { ...expected, addressSummary: 'Office' }],
    ['ETA', { ...expected, etaMinutes: 18 }],
    ['payment', { ...expected, paymentMode: 'provider_saved' as never }],
  ])('detects changed %s', (_name, actual) => {
    expect(compareMaterialGroceryTerms(expected, actual)).not.toEqual([]);
  });
});

describe('one-shot Blinkit COD commit', () => {
  it('clicks exactly once and returns the verified provider reference', async () => {
    const { adapter, page } = setup();
    await expect(adapter.commit(owner, 'state-1')).resolves.toEqual({ outcome: 'committed', providerReference: 'BLK123456' });
    expect(page.finalActionClicks).toBe(1);
  });

  it('returns stale without clicking when live terms changed', async () => {
    const { adapter, page } = setup();
    page.review = { ...expected, etaMinutes: 20 };
    await expect(adapter.commit(owner, 'state-1')).resolves.toEqual({ outcome: 'stale' });
    expect(page.finalActionClicks).toBe(0);
  });

  it('refuses a non-unique final action without clicking', async () => {
    const { adapter, page } = setup();
    page.finalActionCountValue = 2;
    await expect(adapter.commit(owner, 'state-1')).rejects.toThrow('final action is not unique');
    expect(page.finalActionClicks).toBe(0);
  });

  it('returns ambiguous after one click when confirmation times out', async () => {
    const { adapter, page } = setup();
    page.waitForOrderReference = async (): Promise<string> => { throw new Error('timeout'); };
    await expect(adapter.commit(owner, 'state-1')).resolves.toEqual({ outcome: 'ambiguous' });
    expect(page.finalActionClicks).toBe(1);
  });
});
