import type {
  CartSnapshotV2,
  DesiredCartMutationPlanV2,
  DesiredCartStateV2,
} from './contracts';
import { stableExecutionFingerprintV2 } from './fingerprint';

function assertBoundedText(value: string, name: string, maxLength = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function assertQuantity(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 999) {
    throw new Error(`${name} must be an integer from 0 to 999.`);
  }
}

export function validateCartSnapshotV2(
  snapshot: CartSnapshotV2,
): CartSnapshotV2 {
  if (
    snapshot.version !== 2
    || !Number.isSafeInteger(snapshot.capturedAt)
    || snapshot.capturedAt < 0
  ) {
    throw new Error('Cart snapshot metadata is invalid.');
  }
  assertBoundedText(snapshot.observationId, 'observationId');
  const seen = new Set<string>();
  for (const line of snapshot.lines) {
    const offerId = assertBoundedText(line.offerId, 'offerId');
    assertQuantity(line.quantity, 'quantity');
    if (seen.has(offerId)) {
      throw new Error(`Cart snapshot repeats offer ${offerId}.`);
    }
    seen.add(offerId);
  }
  return snapshot;
}

export function cartQuantityV2(
  snapshot: CartSnapshotV2,
  offerId: string,
): number {
  validateCartSnapshotV2(snapshot);
  const normalizedOfferId = assertBoundedText(offerId, 'offerId');
  return snapshot.lines.find((line) => line.offerId === normalizedOfferId)
    ?.quantity ?? 0;
}

export function desiredCartStateDigestV2(
  desired: DesiredCartStateV2,
): string {
  if (desired.version !== 2) throw new Error('Desired cart state must be V2.');
  const stepKey = assertBoundedText(desired.stepKey, 'stepKey');
  const offerId = assertBoundedText(desired.offerId, 'offerId');
  assertQuantity(desired.targetQuantity, 'targetQuantity');
  return stableExecutionFingerprintV2({
    taskId: desired.taskId,
    itemId: desired.itemId,
    stepKey,
    offerId,
    targetQuantity: desired.targetQuantity,
  });
}

export function planDesiredCartMutationV2(input: {
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
}): DesiredCartMutationPlanV2 {
  const currentQuantity = cartQuantityV2(
    input.before,
    input.desired.offerId,
  );
  const desiredStateDigest = desiredCartStateDigestV2(input.desired);
  if (currentQuantity === input.desired.targetQuantity) {
    return {
      kind: 'already_satisfied',
      desired: input.desired,
      desiredStateDigest,
      currentQuantity,
    };
  }
  return {
    kind: 'set_absolute_quantity',
    desired: input.desired,
    desiredStateDigest,
    currentQuantity,
    targetQuantity: input.desired.targetQuantity,
  };
}
