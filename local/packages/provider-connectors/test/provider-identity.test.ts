import { describe, expect, it } from 'vitest';
import {
  reconcileProviderProductIdentity,
  type ProviderProductIdentity,
} from '../src/android/provider-identity.js';

describe('provider-aware product identity reconciliation', () => {
  it('reconciles the Blinkit Potato (Alugadde) offer with its concise cart label', () => {
    const result = reconcileProviderProductIdentity(
      {
        provider: 'Blinkit',
        offerId: 'potato-1kg',
        title: 'Potato (Alugadde)',
        packSize: '1 kg',
        price: { currency: 'INR', amount: 27 },
      },
      [{
        provider: 'blinkit',
        title: 'Potato',
        packSize: '1000 g',
        price: '₹27.00',
      }],
    );

    expect(result.status).toBe('unique');
    if (result.status !== 'unique') throw new Error('expected a unique identity');
    expect(result.match.candidate.title).toBe('Potato');
    expect(result.match.evidence).toMatchObject({
      compatible: true,
      anchors: ['title_or_alias'],
      blockingConflicts: [],
    });
    expect(result.match.evidence.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', outcome: 'match' }),
      expect.objectContaining({ field: 'packSize', outcome: 'match' }),
      expect.objectContaining({ field: 'price', outcome: 'match' }),
    ]));
  });

  it('uses the known Alugadde alias only for Blinkit identities', () => {
    const observed = [{ provider: 'blinkit', title: 'Potato', packSize: '1 kg', price: 27 }];
    expect(reconcileProviderProductIdentity(
      { provider: 'blinkit', title: 'Alugadde', packSize: '1 kg', price: 27 },
      observed,
    ).status).toBe('unique');

    expect(reconcileProviderProductIdentity(
      { provider: 'another-store', title: 'Alugadde', packSize: '1 kg', price: 27 },
      [{ ...observed[0]!, provider: 'another-store' }],
    ).status).toBe('none');
  });

  it('accepts explicit aliases and an exact stable product ID as identity anchors', () => {
    const aliasResult = reconcileProviderProductIdentity(
      { provider: 'blinkit', title: 'Coriander', aliases: ['Dhaniya'], packSize: '100 g', price: 12 },
      [{ provider: 'blinkit', title: 'Dhaniya', packSize: '0.1 kg', price: 12 }],
    );
    expect(aliasResult.status).toBe('unique');

    const idResult = reconcileProviderProductIdentity(
      { provider: 'blinkit', productId: 'product-42', title: 'Amul Taaza Milk', packSize: '1 L', price: 74 },
      [{ provider: 'blinkit', productId: 'product-42', title: 'Fresh Milk', packSize: '1000 ml', price: 74 }],
    );
    expect(idResult.status).toBe('unique');
    if (idResult.status !== 'unique') throw new Error('expected a unique identity');
    expect(idResult.match.evidence.anchors).toContain('product_id');
  });

  it('hard-rejects pack, expected-price, provider, and comparable-ID conflicts', () => {
    const expected: ProviderProductIdentity = {
      provider: 'blinkit',
      offerId: 'offer-potato-1kg',
      productId: 'product-potato',
      title: 'Potato',
      packSize: '1 kg',
      price: 27,
    };
    const cases: Array<[ProviderProductIdentity, string]> = [
      [{ ...expected, packSize: '500 g' }, 'packSize'],
      [{ ...expected, price: 31 }, 'price'],
      [{ ...expected, provider: 'another-store' }, 'provider'],
      [{ ...expected, offerId: 'offer-potato-2kg' }, 'offerId'],
      [{ ...expected, productId: 'another-product' }, 'productId'],
    ];

    for (const [candidate, conflict] of cases) {
      const result = reconcileProviderProductIdentity(expected, [candidate]);
      expect(result.status, conflict).toBe('none');
      expect(result.evidence[0]?.blockingConflicts, conflict).toContain(conflict);
    }
  });

  it('does not treat an equal price as product identity', () => {
    const result = reconcileProviderProductIdentity(
      { provider: 'blinkit', title: 'Potato', packSize: '1 kg', price: 27 },
      [{ provider: 'blinkit', title: 'Tomato', packSize: '1 kg', price: 27 }],
    );

    expect(result).toMatchObject({
      status: 'none',
      reason: 'no_compatible_identity',
    });
    expect(result.evidence[0]).toMatchObject({
      compatible: false,
      anchors: [],
      blockingConflicts: [],
    });
  });

  it('returns ambiguity with evidence instead of selecting between duplicate candidates', () => {
    const candidates = [
      { provider: 'blinkit', title: 'Potato', packSize: '1 kg', price: 27, cartSlot: 'first' },
      { provider: 'blinkit', title: 'Potato', packSize: '1000 g', price: '₹27', cartSlot: 'second' },
    ] as const;
    const result = reconcileProviderProductIdentity(
      { provider: 'blinkit', title: 'Potato (Alugadde)', packSize: '1 kg', price: 27 },
      candidates,
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      reason: 'multiple_compatible_identities',
    });
    if (result.status !== 'ambiguous') throw new Error('expected ambiguous identity');
    expect(result.matches.map(({ candidate }) => candidate.cartSlot)).toEqual(['first', 'second']);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every(({ compatible }) => compatible)).toBe(true);
  });

  it('returns explicit none evidence when no observations exist', () => {
    expect(reconcileProviderProductIdentity(
      { provider: 'blinkit', title: 'Potato' },
      [],
    )).toEqual({
      status: 'none',
      reason: 'no_compatible_identity',
      evidence: [],
    });
  });
});
