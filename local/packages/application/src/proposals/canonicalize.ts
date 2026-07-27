import { createHash } from 'node:crypto';
import { ProposalSnapshotSchemaV1, type GroceryProposalSnapshotV1, type ProposalSnapshotV1, type RideProposalSnapshotV1 } from '@errandos/contracts';

const DOMAIN = 'errandos:proposal:v1\n';
const money = (value: { currency: 'INR'; amount: number }): readonly ['INR', number] => [value.currency, value.amount];
const fee = (value: GroceryProposalSnapshotV1['fees'][number]): readonly [string, string, readonly ['INR', number]] => [value.kind, value.label, money(value.amount)];

function canonicalGrocery(value: GroceryProposalSnapshotV1): unknown {
  const legacy = [value.version, value.kind, value.provider, value.principalId, value.accountReference, value.revision,
    value.lines.map((line) => [line.productId, line.name, line.quantity, money(line.unitPrice), money(line.lineTotal)]),
    value.fees.map(fee), money(value.total), [value.deliveryAddress.reference, value.deliveryAddress.summary],
    value.paymentMode, value.preparedAt, value.quoteExpiresAt];
  if (value.providerFingerprint === undefined || value.unavailableItems === undefined) return legacy;
  return [...legacy, ['checkout-integrity-v1',
    value.unavailableItems.map((item) => [item.query, item.reason]),
    value.etaMinutes ?? null,
    value.providerFingerprint,
  ]];
}
function canonicalRide(value: RideProposalSnapshotV1): unknown {
  return [value.version, value.kind, value.provider, value.principalId, value.accountReference, value.revision,
    [value.route.pickupReference, value.route.pickupSummary, value.route.dropoffReference, value.route.dropoffSummary],
    [value.rideOption.id, value.rideOption.name],
    [money(value.fare.minimum), money(value.fare.maximum), value.fare.fees.map(fee)],
    value.paymentMode, value.preparedAt, value.quoteExpiresAt,
    ['ride-integrity-v1', value.etaMinutes ?? null, value.durationMinutes ?? null, value.providerFingerprint]];
}
/** Exact versioned bytes shared by display/approval and commit verification. */
export function canonicalProposalBytes(snapshot: ProposalSnapshotV1): Uint8Array {
  const value = ProposalSnapshotSchemaV1.parse(snapshot);
  const fields = value.kind === 'grocery' ? canonicalGrocery(value) : canonicalRide(value);
  return new TextEncoder().encode(`${DOMAIN}${JSON.stringify({ domain: 'errandos.proposal', version: 1, fields })}`);
}
export function hashProposalSnapshot(snapshot: ProposalSnapshotV1): string {
  return createHash('sha256').update(canonicalProposalBytes(snapshot)).digest('hex');
}
