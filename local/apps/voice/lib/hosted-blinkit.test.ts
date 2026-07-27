import { describe, expect, it } from 'vitest';
import type { AndroidSearchOffer } from '@errandos/provider-connectors';
import { selectExactHostedOffer } from './hosted-blinkit';

const offers: AndroidSearchOffer[] = [
  {
    available: true,
    offerId: 'offer_500',
    packSize: '500 ml',
    price: { amount: 28, currency: 'INR' },
    title: 'Amul Taaza Toned Milk',
  },
  {
    available: true,
    offerId: 'offer_1l',
    packSize: '1 l',
    price: { amount: 56, currency: 'INR' },
    title: 'Amul Taaza Toned Milk',
  },
];

describe('hosted Blinkit voice selection', () => {
  it('does not guess when a product name has multiple sizes', () => {
    expect(selectExactHostedOffer('Amul Taaza doodh', offers)).toBeUndefined();
  });

  it('selects one exact product and size', () => {
    expect(selectExactHostedOffer('Amul Taaza doodh 500 ml', offers)?.offerId)
      .toBe('offer_500');
  });

  it('uses a pending opaque offer ID without rematching by rank', () => {
    expect(selectExactHostedOffer('add to cart', offers, 'offer_1l')?.offerId)
      .toBe('offer_1l');
  });

  it('rejects an unavailable or invented offer ID', () => {
    expect(selectExactHostedOffer('add to cart', offers, 'offer_missing'))
      .toBeUndefined();
  });
});
