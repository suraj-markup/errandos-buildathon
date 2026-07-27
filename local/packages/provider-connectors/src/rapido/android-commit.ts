import { createHash } from 'node:crypto';
import type {
  RapidoAndroidRideReviewV1,
  RapidoAndroidTripV1,
  RapidoExpectedRideV1,
} from '@errandos/contracts';
import type {
  AndroidCommitResult,
  AndroidCommitStore,
} from '../blinkit/android-commit.js';

export interface RapidoCommitDependencies {
  store: AndroidCommitStore;
  readRide(): Promise<RapidoAndroidRideReviewV1>;
  clickFinal(): Promise<void>;
  readConfirmation(): Promise<{ status: 'committed'; providerReference: string } | { status: 'unverified' }>;
  now?: () => Date;
}

export async function commitRapidoRideOnce(
  expected: RapidoExpectedRideV1,
  dependencies: RapidoCommitDependencies,
): Promise<AndroidCommitResult> {
  const existing = await dependencies.store.get(expected.idempotencyKey);
  if (existing) {
    return existing.state === 'committed' && existing.providerReference
      ? { outcome: 'committed', providerReference: existing.providerReference }
      : { outcome: 'ambiguous' };
  }

  const now = (dependencies.now ?? ((): Date => new Date()))();
  const live = await dependencies.readRide();
  if (now.getTime() > Date.parse(expected.expiresAt) || !sameRide(live, expected.ride)) {
    return { outcome: 'stale' };
  }

  const reservation = await dependencies.store.recordDispatch({
    idempotencyKeyHash: hashIdempotencyKey(expected.idempotencyKey),
    proposalHash: expected.proposalHash,
    providerFingerprint: expected.ride.providerFingerprint,
    state: 'dispatching',
    dispatchedAt: now.toISOString(),
  });
  if (!reservation.created) {
    return reservation.record.state === 'committed' && reservation.record.providerReference
      ? { outcome: 'committed', providerReference: reservation.record.providerReference }
      : { outcome: 'ambiguous' };
  }

  try {
    await dependencies.clickFinal();
    const confirmation = await dependencies.readConfirmation();
    if (confirmation.status !== 'committed') {
      await dependencies.store.recordOutcome(expected.idempotencyKey, 'ambiguous');
      return { outcome: 'ambiguous' };
    }
    await dependencies.store.recordOutcome(expected.idempotencyKey, 'committed', confirmation.providerReference);
    return { outcome: 'committed', providerReference: confirmation.providerReference };
  } catch {
    await dependencies.store.recordOutcome(expected.idempotencyKey, 'ambiguous').catch(() => undefined);
    return { outcome: 'ambiguous' };
  }
}

export function reconcileRapidoRide(
  expected: RapidoExpectedRideV1,
  trips: readonly RapidoAndroidTripV1[],
): { outcome: 'committed'; providerReference: string } | { outcome: 'pending' } {
  const start = Date.parse(expected.preparedAt);
  const end = Date.parse(expected.expiresAt) + 15 * 60_000;
  const matches = trips.filter((trip) => {
    const requestedAt = Date.parse(trip.requestedAt);
    return Number.isFinite(requestedAt)
      && requestedAt >= start
      && requestedAt <= end
      && normalize(trip.pickupSummary) === normalize(expected.ride.pickupSummary)
      && normalize(trip.dropoffSummary) === normalize(expected.ride.dropoffSummary)
      && normalize(trip.rideType) === normalize(expected.ride.rideOption.name);
  });
  return matches.length === 1
    ? { outcome: 'committed', providerReference: matches[0]!.tripReference }
    : { outcome: 'pending' };
}

function sameRide(left: RapidoAndroidRideReviewV1, right: RapidoAndroidRideReviewV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
