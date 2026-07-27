import type { PrincipalId } from '@errandos/contracts';
import { describe, expect, it } from 'vitest';
import { BlinkitReviewExtractionError, normalizeBlinkitReview, toGrocerySnapshot } from '../src/blinkit/review.js';

const completeRawReview = {
  lines: [{ productId: '123', name: 'Milk 500 ml', quantity: 4, unitPrice: 55, lineTotal: 220 }],
  fees: [{ kind: 'handling' as const, label: 'Handling charge', amount: 20 }],
  total: 240,
  addressSummary: 'Home',
  deliveryLocationReference: 'blinkit-home',
  etaMinutes: 12,
  paymentMode: 'cod' as const,
  codAvailable: true,
  providerFingerprint: 'cart-fingerprint-123',
};

describe('exact Blinkit checkout review', () => {
  it('normalizes complete provider terms and builds a snapshot from them', () => {
    const review = normalizeBlinkitReview(completeRawReview);
    expect(review).toMatchObject({
      lines: [{ productId: '123', quantity: 4, lineTotal: { currency: 'INR', amount: 220 } }],
      total: { currency: 'INR', amount: 240 },
      paymentMode: 'cod',
      addressSummary: 'Home',
    });
    const snapshot = toGrocerySnapshot('owner' as PrincipalId, {
      version: 1,
      provider: 'blinkit',
      accountKey: 'main',
      items: [{ query: 'milk', quantity: 4 }],
      deliveryAddressRef: 'home',
      paymentMode: 'cod',
    }, review, new Date('2026-07-14T12:00:00.000Z'));
    expect(snapshot).toMatchObject({ total: { amount: 240 }, deliveryAddress: { reference: 'blinkit-home', summary: 'Home' } });
  });

  it.each([
    ['missing total', { ...completeRawReview, total: undefined }],
    ['missing address', { ...completeRawReview, addressSummary: '' }],
    ['missing ETA', { ...completeRawReview, etaMinutes: undefined }],
    ['COD unavailable', { ...completeRawReview, codAvailable: false }],
    ['inconsistent total', { ...completeRawReview, total: 239 }],
  ])('rejects %s', (message, raw) => {
    expect(() => normalizeBlinkitReview(raw)).toThrow(message);
  });

  it('uses a typed extraction error without leaking raw checkout data', () => {
    try { normalizeBlinkitReview({ ...completeRawReview, providerFingerprint: '' }); }
    catch (error) {
      expect(error).toBeInstanceOf(BlinkitReviewExtractionError);
      expect(JSON.stringify(error)).not.toContain('Milk 500 ml');
    }
  });
});
