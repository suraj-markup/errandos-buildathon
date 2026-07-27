import { describe, expect, it } from 'vitest';
import {
  GroceryProposalSnapshotSchemaV1,
  CommitOutputSchemaV1,
  MoneySchema,
  PlaceCodOrderInputSchemaV1,
  ProposalOutputSchemaV1,
} from '../src/index.js';

const grocery = {
  version: 1 as const,
  kind: 'grocery' as const,
  provider: 'blinkit' as const,
  principalId: 'principal-1',
  accountReference: 'account-1',
  revision: 1,
  lines: [{ productId: 'milk-500', name: 'Milk 500 ml', quantity: 2, unitPrice: { currency: 'INR' as const, amount: 35 }, lineTotal: { currency: 'INR' as const, amount: 70 } }],
  fees: [{ kind: 'delivery' as const, label: 'Delivery fee', amount: { currency: 'INR' as const, amount: 10 } }],
  total: { currency: 'INR' as const, amount: 80 },
  deliveryAddress: { reference: 'address-1', summary: 'Home, Bengaluru' },
  paymentMode: 'cod' as const,
  preparedAt: '2026-07-11T10:00:00.000Z',
  quoteExpiresAt: '2026-07-11T10:05:00.000Z',
};

describe('canonical proposal snapshot contracts', () => {
  it.each([0.29, 80.01])('accepts valid INR paise amount %s', (amount) => {
    expect(MoneySchema.safeParse({ currency: 'INR', amount }).success).toBe(true);
  });

  it.each([0.291, 80.011])('rejects amount %s with more than two decimal places', (amount) => {
    expect(MoneySchema.safeParse({ currency: 'INR', amount }).success).toBe(false);
  });

  it('round-trips grocery snapshots', () => {
    expect(GroceryProposalSnapshotSchemaV1.parse(grocery)).toEqual(grocery);
  });

  it('accepts checkout integrity facts without exposing provider UI state', () => {
    const bound = {
      ...grocery,
      unavailableItems: [{ query: 'Diet cola', reason: 'out_of_stock' as const }],
      providerFingerprint: 'a'.repeat(64),
    };
    expect(GroceryProposalSnapshotSchemaV1.parse(bound)).toEqual(bound);
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...bound, providerFingerprint: 'raw-device-state' }).success).toBe(false);
  });

  it.each(['cookie', 'otp', 'password', 'approvalCapability', 'profilePath'])('rejects unknown or secret-bearing field %s', (field) => {
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...grocery, [field]: 'secret' }).success).toBe(false);
  });

  it('strictly rejects unknown nested fields', () => {
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...grocery, deliveryAddress: { ...grocery.deliveryAddress, token: 'secret' } }).success).toBe(false);
  });

  it('enforces exact paise, line arithmetic, discount semantics, and totals', () => {
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...grocery, lines: [{ ...grocery.lines[0]!, lineTotal: { currency: 'INR', amount: 69 } }] }).success).toBe(false);
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...grocery, total: { currency: 'INR', amount: 80.001 } }).success).toBe(false);
    const discounted = { ...grocery, fees: [...grocery.fees, { kind: 'discount' as const, label: 'Offer', amount: { currency: 'INR' as const, amount: 5 } }], total: { currency: 'INR' as const, amount: 75 } };
    expect(GroceryProposalSnapshotSchemaV1.safeParse(discounted).success).toBe(true);
  });

  it('enforces quote ordering', () => {
    expect(GroceryProposalSnapshotSchemaV1.safeParse({ ...grocery, quoteExpiresAt: grocery.preparedAt }).success).toBe(false);
  });
});

describe('personal COD transaction contracts', () => {
  const proposal = {
    version: 1 as const,
    proposalId: 'proposal-personal-cod',
    provider: 'blinkit' as const,
    status: 'prepared' as const,
    proposalHash: 'a'.repeat(64),
    summary: {
      kind: 'grocery' as const,
      description: 'Milk x1',
      items: [{ name: 'Milk 500 ml', quantity: 1 }],
      unavailableItems: [{ query: 'Diet cola', reason: 'out_of_stock' as const }],
      total: { currency: 'INR' as const, amount: 35 },
      paymentMode: 'cod',
      addressSummary: 'Home, Bengaluru',
    },
    expiresAt: '2026-07-14T12:00:00.000Z',
    requiresExternalApproval: false,
  };

  it('represents an owner-autonomous proposal without external approval', () => {
    expect(ProposalOutputSchemaV1.parse(proposal)).toEqual(proposal);
    expect(proposal.summary.items).toHaveLength(1);
    expect(proposal.summary.unavailableItems).toEqual([{ query: 'Diet cola', reason: 'out_of_stock' }]);
  });

  it('requires an explicit idempotency key to place a COD order', () => {
    expect(PlaceCodOrderInputSchemaV1.safeParse({ version: 1, proposalId: proposal.proposalId }).success).toBe(false);
    expect(PlaceCodOrderInputSchemaV1.safeParse({
      version: 1,
      proposalId: proposal.proposalId,
      idempotencyKey: 'telegram-update-12345',
    }).success).toBe(true);
  });

  it('requires a verified provider reference before reporting committed', () => {
    expect(CommitOutputSchemaV1.safeParse({ version: 1, proposalId: proposal.proposalId, status: 'committed', receiptId: 'receipt-1', reconciliationRequired: false }).success).toBe(false);
    expect(CommitOutputSchemaV1.safeParse({ version: 1, proposalId: proposal.proposalId, status: 'committed', receiptId: 'receipt-1', providerReference: 'BLK123456', reconciliationRequired: false }).success).toBe(true);
  });
});
