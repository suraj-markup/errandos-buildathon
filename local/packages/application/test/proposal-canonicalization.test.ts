import { describe, expect, it } from 'vitest';
import type { GroceryProposalSnapshotV1 } from '@errandos/contracts';
import { canonicalProposalBytes, hashProposalSnapshot } from '../src/proposals/canonicalize.js';

const grocery: GroceryProposalSnapshotV1 = { version: 1, kind: 'grocery', provider: 'blinkit', principalId: 'p1', accountReference: 'a1', revision: 1, lines: [{ productId: 'milk', name: 'Milk', quantity: 2, unitPrice: { currency: 'INR', amount: 30 }, lineTotal: { currency: 'INR', amount: 60 } }], fees: [{ kind: 'delivery', label: 'Delivery', amount: { currency: 'INR', amount: 5 } }], total: { currency: 'INR', amount: 65 }, deliveryAddress: { reference: 'home', summary: 'Home' }, paymentMode: 'cod', preparedAt: '2026-07-11T10:00:00.000Z', quoteExpiresAt: '2026-07-11T10:05:00.000Z' };
const boundGrocery: GroceryProposalSnapshotV1 = { ...grocery, unavailableItems: [], etaMinutes: 12, providerFingerprint: 'a'.repeat(64) };

describe('proposal canonicalization', () => {
  it('emits deterministic UTF-8 bytes independent of object insertion order', () => {
    const reordered = Object.fromEntries(Object.entries(grocery).reverse()) as unknown as GroceryProposalSnapshotV1;
    expect(canonicalProposalBytes(reordered)).toEqual(canonicalProposalBytes(grocery));
    expect(new TextDecoder().decode(canonicalProposalBytes(grocery))).toMatch(/^errandos:proposal:v1\n\{/);
  });

  it('matches the canonical v1 golden byte and SHA-256 vector', () => {
    const bytes = 'errandos:proposal:v1\n{"domain":"errandos.proposal","version":1,"fields":[1,"grocery","blinkit","p1","a1",1,[["milk","Milk",2,["INR",30],["INR",60]]],[["delivery","Delivery",["INR",5]]],["INR",65],["home","Home"],"cod","2026-07-11T10:00:00.000Z","2026-07-11T10:05:00.000Z"]}';
    expect(new TextDecoder().decode(canonicalProposalBytes(grocery))).toBe(bytes);
    expect(hashProposalSnapshot(grocery)).toBe('8c31dd1e850850abae7d14ce951596efe830762a7983696ff73840b1d1af5887');
  });

  it.each([
    ['product ID', { ...grocery, lines: [{ ...grocery.lines[0]!, productId: 'milk-2' }] }],
    ['quantity', { ...grocery, lines: [{ ...grocery.lines[0]!, quantity: 3, lineTotal: { currency: 'INR' as const, amount: 90 } }], total: { currency: 'INR' as const, amount: 95 } }],
    ['amount', { ...grocery, lines: [{ ...grocery.lines[0]!, unitPrice: { currency: 'INR' as const, amount: 30.5 }, lineTotal: { currency: 'INR' as const, amount: 61 } }], total: { currency: 'INR' as const, amount: 66 } }],
    ['fee', { ...grocery, fees: [{ ...grocery.fees[0]!, amount: { currency: 'INR' as const, amount: 6 } }], total: { currency: 'INR' as const, amount: 66 } }],
    ['address', { ...grocery, deliveryAddress: { ...grocery.deliveryAddress, reference: 'work' } }],
    ['payment mode', { ...grocery, paymentMode: 'provider_saved' as const }],
    ['expiry', { ...grocery, quoteExpiresAt: '2026-07-11T10:06:00.000Z' }],
    ['revision', { ...grocery, revision: 2 }],
  ])('changes hash when %s changes', (_name, changed) => expect(hashProposalSnapshot(changed)).not.toBe(hashProposalSnapshot(grocery)));

  it.each([
    ['ETA', { ...boundGrocery, etaMinutes: 13 }],
    ['unavailable items', { ...boundGrocery, unavailableItems: [{ query: 'Diet cola', reason: 'out_of_stock' as const }] }],
    ['provider fingerprint', { ...boundGrocery, providerFingerprint: 'b'.repeat(64) }],
  ])('changes a checkout-bound hash when %s changes', (_name, changed) => {
    expect(hashProposalSnapshot(changed)).not.toBe(hashProposalSnapshot(boundGrocery));
  });

});
