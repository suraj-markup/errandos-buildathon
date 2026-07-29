import { describe, expect, it } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import {
  buildCodCheckoutProposal,
  buildCodCheckoutSnapshot,
  checkoutTermChanges,
  isExplicitCodConfirmation,
} from './cod';

const checkout = [
  '<hierarchy>',
  '<node text="Shipment of 1 item"/>',
  '<node resource-id="com.grofers.customerapp:id/title" content-desc="Lay&apos;s Magic Masala"/>',
  '<node text="Delivering to Home, Bengaluru"/>',
  '<node text="Bill total"/>',
  '<node text="₹125"/>',
  '<node text="Cash on Delivery"/>',
  '<node text="Place Order" clickable="true"/>',
  '</hierarchy>',
].join('');

describe('COD checkout safeguards', () => {
  it('requires the full explicit confirmation phrase', () => {
    expect(isExplicitCodConfirmation('Confirm COD order')).toBe(true);
    expect(isExplicitCodConfirmation('Please confirm C.O.D. order')).toBe(true);
    for (const unsafe of [
      'Yes',
      'Add to cart',
      'Place order',
      'Do not confirm COD order',
      'Did you say confirm COD order?',
      'Translate “Confirm COD order” into Hindi',
      'COD order confirm karo',
      'कृपया COD ऑर्डर कन्फर्म करें',
      'I previously said Confirm COD order',
    ]) {
      expect(isExplicitCodConfirmation(unsafe), unsafe).toBe(false);
    }
  });

  it('builds stable review terms only with COD evidence', () => {
    expect(buildCodCheckoutSnapshot(checkout)).toMatchObject({
      addressLabel: 'Home',
      itemCount: 1,
      paymentMode: 'cod',
      total: 125,
    });
    expect(buildCodCheckoutSnapshot(checkout.replace('Cash on Delivery', 'UPI')))
      .toBeUndefined();
  });

  it('rejects unavailable COD', () => {
    expect(buildCodCheckoutSnapshot(
      checkout.replace('Cash on Delivery', 'Cash on Delivery unavailable'),
    )).toBeUndefined();
  });

  it('binds proposal identity, expiry, and all exact checkout terms', () => {
    const proposal = buildCodCheckoutProposal(
      review(),
      new Date('2026-07-27T12:00:00.000Z'),
      60_000,
    );
    expect(proposal).toMatchObject({
      expiresAt: '2026-07-27T12:01:00.000Z',
      itemCount: 1,
      preparedAt: '2026-07-27T12:00:00.000Z',
      proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      total: 33,
    });
  });

  it.each([
    ['price', (value: AndroidCheckoutReviewV1) => ({
      ...value,
      lines: [{ ...value.lines[0]!, unitPrice: money(29) }],
    }), ['items']],
    ['fee', (value: AndroidCheckoutReviewV1) => ({
      ...value,
      fees: [{ ...value.fees[0]!, amount: money(6) }],
    }), ['fees']],
    ['address', (value: AndroidCheckoutReviewV1) => ({
      ...value,
      addressLabel: 'Office',
    }), ['address']],
    ['quantity', (value: AndroidCheckoutReviewV1) => ({
      ...value,
      lines: [{ ...value.lines[0]!, quantity: 2 }],
    }), ['items']],
    ['eta', (value: AndroidCheckoutReviewV1) => ({
      ...value,
      etaMinutes: 18,
    }), ['eta']],
  ] as const)('reports a typed %s term change', (_name, change, expected) => {
    const original = review();
    expect(checkoutTermChanges(original, change(original))).toEqual(expected);
  });

  it('ignores provider ordering but reports provider fingerprint changes', () => {
    const original = review({
      fees: [
        { amount: money(5), kind: 'handling', label: 'Handling' },
        { amount: money(2), kind: 'delivery', label: 'Delivery' },
      ],
      lines: [
        line('milk', 'Milk', 1, 28),
        line('bread', 'Bread', 1, 40),
      ],
    });
    expect(checkoutTermChanges(original, {
      ...original,
      fees: [...original.fees].reverse(),
      lines: [...original.lines].reverse(),
    })).toEqual([]);
    expect(checkoutTermChanges(original, {
      ...original,
      providerFingerprint: 'd'.repeat(64),
    })).toEqual(['provider_fingerprint']);
  });
});

const money = (amount: number) => ({ amount, currency: 'INR' as const });
const line = (
  productId: string,
  name: string,
  quantity: number,
  unitPrice: number,
) => ({
  lineTotal: money(quantity * unitPrice),
  name,
  productId,
  quantity,
  unitPrice: money(unitPrice),
});
const review = (
  overrides: Partial<AndroidCheckoutReviewV1> = {},
): AndroidCheckoutReviewV1 => ({
  addressLabel: 'Home',
  addressReference: 'address_home',
  etaMinutes: 12,
  fees: [{ amount: money(5), kind: 'handling', label: 'Handling' }],
  lines: [line('milk', 'Milk', 1, 28)],
  paymentMode: 'cod',
  providerFingerprint: 'c'.repeat(64),
  total: money(33),
  unavailableItems: [],
  ...overrides,
});
