import type { ProposalOutput, ProposalSnapshotV1 } from '@errandos/contracts';

/** The sole V1 projection used for proposal display. No independently supplied summary is trusted. */
export function projectProposalSummary(snapshot: ProposalSnapshotV1): ProposalOutput['summary'] {
  if (snapshot.kind === 'ride') {
    return {
      kind: 'ride',
      description: snapshot.rideOption.name,
      fees: snapshot.fare.fees,
      fareMin: snapshot.fare.minimum,
      fareMax: snapshot.fare.maximum,
      ...(snapshot.etaMinutes === undefined ? {} : { etaMinutes: snapshot.etaMinutes }),
      paymentMode: snapshot.paymentMode,
      addressSummary: `${snapshot.route.pickupSummary} → ${snapshot.route.dropoffSummary}`,
      pickupSummary: snapshot.route.pickupSummary,
      dropoffSummary: snapshot.route.dropoffSummary,
      rideType: snapshot.rideOption.name,
    };
  }
  const count = snapshot.lines.reduce((sum, line) => sum + line.quantity, 0);
  return {
    kind: 'grocery',
    description: `${count} grocery item${count === 1 ? '' : 's'}`,
    items: snapshot.lines.map(({ name, quantity, unitPrice, lineTotal }) => ({ name, quantity, unitPrice, lineTotal })),
    ...(snapshot.unavailableItems?.length ? { unavailableItems: snapshot.unavailableItems } : {}),
    fees: snapshot.fees,
    total: snapshot.total,
    ...(snapshot.etaMinutes === undefined ? {} : { etaMinutes: snapshot.etaMinutes }),
    paymentMode: snapshot.paymentMode,
    addressSummary: snapshot.deliveryAddress.summary,
  };
}
