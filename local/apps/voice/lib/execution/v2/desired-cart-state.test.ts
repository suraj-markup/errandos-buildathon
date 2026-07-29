import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type {
  CartSnapshotV2,
  DesiredCartStateV2,
} from './contracts';
import {
  desiredCartStateDigestV2,
  planDesiredCartMutationV2,
  validateCartSnapshotV2,
} from './desired-cart-state';

const desired: DesiredCartStateV2 = {
  version: 2,
  taskId: parseLocalIdentifier(
    'task',
    'task_12345678-1234-1234-1234-123456789abc',
  ),
  itemId: parseLocalIdentifier(
    'task_item',
    'task_item_12345678-1234-1234-1234-123456789abc',
  ),
  stepKey: 'item.0.add',
  offerId: 'offer_milk',
  targetQuantity: 2,
};

function snapshot(quantity: number): CartSnapshotV2 {
  return {
    version: 2,
    capturedAt: 100,
    observationId: `observation_${quantity}`,
    lines: quantity > 0
      ? [{ offerId: desired.offerId, quantity }]
      : [],
  };
}

describe('desired cart state v2', () => {
  it('plans an absolute target rather than an increment', () => {
    expect(planDesiredCartMutationV2({
      before: snapshot(1),
      desired,
    })).toMatchObject({
      kind: 'set_absolute_quantity',
      currentQuantity: 1,
      targetQuantity: 2,
    });
  });

  it('turns a retried request into a no-op after the target is reached', () => {
    const first = planDesiredCartMutationV2({
      before: snapshot(1),
      desired,
    });
    const retry = planDesiredCartMutationV2({
      before: snapshot(2),
      desired,
    });

    expect(first.desiredStateDigest).toBe(retry.desiredStateDigest);
    expect(retry).toMatchObject({
      kind: 'already_satisfied',
      currentQuantity: 2,
    });
  });

  it('binds the digest to task, step, selected offer, and target quantity', () => {
    const base = desiredCartStateDigestV2(desired);
    expect(desiredCartStateDigestV2({ ...desired, stepKey: 'item.1.add' }))
      .not.toBe(base);
    expect(desiredCartStateDigestV2({ ...desired, offerId: 'offer_other' }))
      .not.toBe(base);
    expect(desiredCartStateDigestV2({ ...desired, targetQuantity: 3 }))
      .not.toBe(base);
  });

  it('rejects duplicate offers in a cart snapshot', () => {
    expect(() => validateCartSnapshotV2({
      ...snapshot(1),
      lines: [
        { offerId: desired.offerId, quantity: 1 },
        { offerId: desired.offerId, quantity: 2 },
      ],
    })).toThrow(/repeats offer/);
  });
});
