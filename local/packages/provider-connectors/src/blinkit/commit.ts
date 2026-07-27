import type { CommitResult } from '@errandos/application';
import type { PrincipalId } from '@errandos/contracts';
import type { DurableProviderState } from '../runtime/provider-state.js';
import type { BlinkitCheckoutReview } from './review.js';

export interface MaterialDifference { field: string }
export interface BlinkitCheckoutPort {
  extractReview(): Promise<BlinkitCheckoutReview>;
  finalActionCount(): Promise<number>;
  clickFinalAction(): Promise<void>;
  waitForOrderReference(): Promise<string | undefined>;
  close(): Promise<void>;
}

export interface BlinkitPersistedCheckout {
  provider: 'blinkit';
  accountKey: string;
  review: BlinkitCheckoutReview;
}

const stable = (value: unknown): string => JSON.stringify(value);
const sortedLines = (review: BlinkitCheckoutReview): BlinkitCheckoutReview['lines'] => [...review.lines].sort((left, right) => left.productId.localeCompare(right.productId));
const sortedFees = (review: BlinkitCheckoutReview): BlinkitCheckoutReview['fees'] => [...review.fees].sort((left, right) => `${left.kind}:${left.label}`.localeCompare(`${right.kind}:${right.label}`));

export function compareMaterialGroceryTerms(expected: BlinkitCheckoutReview, actual: BlinkitCheckoutReview): MaterialDifference[] {
  const comparisons: Array<[string, unknown, unknown]> = [
    ['lines', sortedLines(expected), sortedLines(actual)],
    ['fees', sortedFees(expected), sortedFees(actual)],
    ['total', expected.total, actual.total],
    ['address', { summary: expected.addressSummary, reference: expected.deliveryLocationReference }, { summary: actual.addressSummary, reference: actual.deliveryLocationReference }],
    ['eta', expected.etaMinutes, actual.etaMinutes],
    ['payment', expected.paymentMode, actual.paymentMode],
    ['providerFingerprint', expected.providerFingerprint, actual.providerFingerprint],
  ];
  return comparisons.filter(([, left, right]) => stable(left) !== stable(right)).map(([field]) => ({ field }));
}

function parsePersistedCheckout(value: unknown): BlinkitPersistedCheckout {
  if (!value || typeof value !== 'object') throw new Error('invalid Blinkit provider state');
  const record = value as Partial<BlinkitPersistedCheckout>;
  if (record.provider !== 'blinkit' || typeof record.accountKey !== 'string' || !record.review) throw new Error('invalid Blinkit provider state');
  const review = record.review;
  if (!Array.isArray(review.lines) || !Array.isArray(review.fees) || review.total?.currency !== 'INR' || !review.addressSummary || !Number.isInteger(review.etaMinutes) || review.paymentMode !== 'cod' || !review.providerFingerprint) throw new Error('invalid Blinkit provider state');
  return { provider: 'blinkit', accountKey: record.accountKey, review };
}

export class BlinkitCodCommitAdapter {
  public constructor(
    private readonly state: Pick<DurableProviderState, 'get'>,
    private readonly checkout: (persisted: BlinkitPersistedCheckout) => Promise<BlinkitCheckoutPort>,
    private readonly liveCommitEnabled = false,
  ) {}

  public async commit(owner: PrincipalId, providerStateRef: string): Promise<CommitResult> {
    if (!this.liveCommitEnabled) throw new Error('live commit disabled');
    const persisted = parsePersistedCheckout(await this.state.get(owner, providerStateRef));
    const checkout = await this.checkout(persisted);
    try {
      const actual = await checkout.extractReview();
      if (compareMaterialGroceryTerms(persisted.review, actual).length > 0) return { outcome: 'stale' };
      if (await checkout.finalActionCount() !== 1) throw new Error('Blinkit final action is not unique');
      try { await checkout.clickFinalAction(); }
      catch { return { outcome: 'ambiguous' }; }
      try {
        const providerReference = await checkout.waitForOrderReference();
        return providerReference ? { outcome: 'committed', providerReference } : { outcome: 'ambiguous' };
      } catch { return { outcome: 'ambiguous' }; }
    } finally { await checkout.close().catch(() => undefined); }
  }
}
