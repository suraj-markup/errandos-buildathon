import { GroceryProposalSnapshotSchemaV1, type GroceryProposalSnapshotV1, type PrepareGroceryInput, type PrincipalId } from '@errandos/contracts';

type Money = { currency: 'INR'; amount: number };
export type BlinkitFeeKind = 'delivery' | 'handling' | 'platform' | 'surge' | 'booking' | 'tax' | 'discount' | 'other';
export interface BlinkitLine { productId: string; name: string; quantity: number; unitPrice: Money; lineTotal: Money }
export interface BlinkitFee { kind: BlinkitFeeKind; label: string; amount: Money }
export interface BlinkitCheckoutReview {
  lines: BlinkitLine[];
  fees: BlinkitFee[];
  total: Money;
  addressSummary: string;
  deliveryLocationReference?: string;
  etaMinutes: number;
  paymentMode: 'cod';
  providerFingerprint: string;
}

export class BlinkitReviewExtractionError extends Error {
  public constructor(message: string) { super(message); this.name = 'BlinkitReviewExtractionError'; }
}

const fail = (message: string): never => { throw new BlinkitReviewExtractionError(message); };
const text = (value: unknown, missing: string): string => typeof value === 'string' && value.trim() ? value.trim() : fail(missing);
const number = (value: unknown, missing: string): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.round(value * 100) === value * 100 ? value : fail(missing);
const money = (value: unknown, missing: string): Money => ({ currency: 'INR', amount: number(value, missing) });
const positiveInteger = (value: unknown, missing: string): number => typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fail(missing);

export function normalizeBlinkitReview(value: unknown): BlinkitCheckoutReview {
  if (!value || typeof value !== 'object') fail('missing checkout review');
  const raw = value as Record<string, unknown>;
  const rawLines: unknown[] = Array.isArray(raw['lines']) ? raw['lines'] : fail('missing cart lines');
  if (rawLines.length === 0) fail('missing cart lines');
  const lines = rawLines.map((entry): BlinkitLine => {
    if (!entry || typeof entry !== 'object') fail('invalid cart line');
    const line = entry as Record<string, unknown>;
    const quantity = positiveInteger(line['quantity'], 'invalid cart quantity');
    const unitPrice = money(line['unitPrice'], 'missing unit price');
    const lineTotal = money(line['lineTotal'], 'missing line total');
    if (Math.round(unitPrice.amount * quantity * 100) !== Math.round(lineTotal.amount * 100)) fail('inconsistent line total');
    return { productId: text(line['productId'], 'missing product identity'), name: text(line['name'], 'missing product name'), quantity, unitPrice, lineTotal };
  });
  const rawFees: unknown[] = Array.isArray(raw['fees']) ? raw['fees'] : fail('missing fees');
  const allowed = new Set<BlinkitFeeKind>(['delivery', 'handling', 'platform', 'surge', 'booking', 'tax', 'discount', 'other']);
  const fees = rawFees.map((entry): BlinkitFee => {
    if (!entry || typeof entry !== 'object') fail('invalid fee');
    const fee = entry as Record<string, unknown>;
    const kind = fee['kind'];
    if (typeof kind !== 'string' || !allowed.has(kind as BlinkitFeeKind)) fail('invalid fee kind');
    return { kind: kind as BlinkitFeeKind, label: text(fee['label'], 'missing fee label'), amount: money(fee['amount'], 'missing fee amount') };
  });
  const total = money(raw['total'], 'missing total');
  const calculated = lines.reduce((sum, line) => sum + Math.round(line.lineTotal.amount * 100), 0)
    + fees.reduce((sum, fee) => sum + (fee.kind === 'discount' ? -1 : 1) * Math.round(fee.amount.amount * 100), 0);
  if (calculated !== Math.round(total.amount * 100)) fail('inconsistent total');
  if (raw['codAvailable'] !== true || raw['paymentMode'] !== 'cod') fail('COD unavailable');
  const etaMinutes = positiveInteger(raw['etaMinutes'], 'missing ETA');
  const deliveryLocationReference = raw['deliveryLocationReference'];
  return {
    lines,
    fees,
    total,
    addressSummary: text(raw['addressSummary'], 'missing address'),
    ...(typeof deliveryLocationReference === 'string' && deliveryLocationReference.trim() ? { deliveryLocationReference: deliveryLocationReference.trim() } : {}),
    etaMinutes,
    paymentMode: 'cod',
    providerFingerprint: text(raw['providerFingerprint'], 'missing provider fingerprint'),
  };
}

export function toGrocerySnapshot(owner: PrincipalId, input: PrepareGroceryInput, review: BlinkitCheckoutReview, now = new Date()): GroceryProposalSnapshotV1 {
  return GroceryProposalSnapshotSchemaV1.parse({
    version: 1,
    kind: 'grocery',
    provider: 'blinkit',
    principalId: owner,
    accountReference: input.accountKey,
    revision: 1,
    lines: review.lines,
    fees: review.fees,
    total: review.total,
    deliveryAddress: { reference: review.deliveryLocationReference ?? input.deliveryAddressRef, summary: review.addressSummary },
    etaMinutes: review.etaMinutes,
    paymentMode: review.paymentMode,
    preparedAt: now.toISOString(),
    quoteExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  });
}
