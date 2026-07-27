import { z } from 'zod';

const OpaqueReferenceSchema = z.string().min(1).max(200);
export const TransactionProviderSchema = z.enum(['blinkit', 'rapido']);

const hasAtMostTwoDecimalPlaces = (amount: number): boolean => {
  const paise = amount * 100;
  const nearestPaise = Math.round(paise);
  const floatingPointEpsilon = Number.EPSILON * Math.max(1, Math.abs(paise));

  return Math.abs(paise - nearestPaise) < floatingPointEpsilon;
};

/** API amounts are rupees, constrained to exact paise and a safe operational ceiling. */
export const MoneySchema = z.object({
  currency: z.literal('INR'),
  amount: z.number().nonnegative().max(100_000_000).refine(
    hasAtMostTwoDecimalPlaces,
    'amount must have at most two decimal places',
  ),
}).strict();
export const ProposalRevisionSchema = z.number().int().positive();

const FeeSchema = z.object({
  kind: z.enum(['delivery', 'handling', 'platform', 'surge', 'booking', 'tax', 'discount', 'other']),
  label: z.string().trim().min(1).max(120),
  amount: MoneySchema,
}).strict();
const UnavailableItemSchema = z.object({
  query: z.string().trim().min(1).max(200),
  reason: z.enum(['out_of_stock', 'not_found', 'ambiguous']),
}).strict();

const SnapshotBase = {
  version: z.literal(1), principalId: OpaqueReferenceSchema, accountReference: OpaqueReferenceSchema,
  revision: ProposalRevisionSchema, preparedAt: z.string().datetime(), quoteExpiresAt: z.string().datetime(),
};
const minor = (amount: number): number => Math.round(amount * 100);
const validateTimes = (preparedAt: string, expiresAt: string, context: z.RefinementCtx): void => {
  if (Date.parse(expiresAt) <= Date.parse(preparedAt)) context.addIssue({ code: 'custom', path: ['quoteExpiresAt'], message: 'quoteExpiresAt must be after preparedAt' });
};

export const GroceryProposalSnapshotSchemaV1 = z.object({
  ...SnapshotBase, kind: z.literal('grocery'), provider: z.literal('blinkit'),
  lines: z.array(z.object({ productId: OpaqueReferenceSchema, name: z.string().trim().min(1).max(300), quantity: z.number().int().min(1).max(100), unitPrice: MoneySchema, lineTotal: MoneySchema }).strict()).min(1).max(30),
  unavailableItems: z.array(UnavailableItemSchema).max(30).optional(),
  fees: z.array(FeeSchema).max(30), total: MoneySchema,
  deliveryAddress: z.object({ reference: OpaqueReferenceSchema, summary: z.string().trim().min(1).max(240) }).strict(),
  etaMinutes: z.number().int().positive().max(24 * 60).optional(),
  paymentMode: z.enum(['cod', 'provider_saved']),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((snapshot, context) => {
  snapshot.lines.forEach((line, index) => {
    if (minor(line.lineTotal.amount) !== minor(line.unitPrice.amount) * line.quantity) context.addIssue({ code: 'custom', path: ['lines', index, 'lineTotal'], message: 'lineTotal must equal unitPrice times quantity' });
  });
  // Fee amounts are magnitudes: discounts subtract; every other fee adds.
  const lines = snapshot.lines.reduce((sum, line) => sum + minor(line.lineTotal.amount), 0);
  const fees = snapshot.fees.reduce((sum, fee) => sum + (fee.kind === 'discount' ? -1 : 1) * minor(fee.amount.amount), 0);
  if (minor(snapshot.total.amount) !== lines + fees) context.addIssue({ code: 'custom', path: ['total'], message: 'total must equal line totals plus fees, with discounts subtracted' });
  if ((snapshot.unavailableItems === undefined) !== (snapshot.providerFingerprint === undefined)) {
    context.addIssue({ code: 'custom', path: ['providerFingerprint'], message: 'checkout integrity fields must be present together' });
  }
  validateTimes(snapshot.preparedAt, snapshot.quoteExpiresAt, context);
});

export const RideProposalSnapshotSchemaV1 = z.object({
  ...SnapshotBase, kind: z.literal('ride'), provider: z.literal('rapido'),
  route: z.object({ pickupReference: OpaqueReferenceSchema, pickupSummary: z.string().trim().min(1).max(240), dropoffReference: OpaqueReferenceSchema, dropoffSummary: z.string().trim().min(1).max(240) }).strict(),
  rideOption: z.object({ id: OpaqueReferenceSchema, name: z.string().trim().min(1).max(120) }).strict(),
  fare: z.object({ minimum: MoneySchema, maximum: MoneySchema, fees: z.array(FeeSchema).max(30) }).strict(),
  paymentMode: z.enum(['cash', 'provider_saved']),
  etaMinutes: z.number().int().nonnegative().max(24 * 60).optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.fare.minimum.amount > snapshot.fare.maximum.amount) context.addIssue({ code: 'custom', path: ['fare', 'minimum'], message: 'minimum fare must not exceed maximum fare' });
  validateTimes(snapshot.preparedAt, snapshot.quoteExpiresAt, context);
});

export const ProposalSnapshotSchemaV1 = z.union([GroceryProposalSnapshotSchemaV1, RideProposalSnapshotSchemaV1]);
export type GroceryProposalSnapshotV1 = z.infer<typeof GroceryProposalSnapshotSchemaV1>;
export type RideProposalSnapshotV1 = z.infer<typeof RideProposalSnapshotSchemaV1>;
export type ProposalSnapshotV1 = z.infer<typeof ProposalSnapshotSchemaV1>;
export type TransactionProvider = z.infer<typeof TransactionProviderSchema>;
