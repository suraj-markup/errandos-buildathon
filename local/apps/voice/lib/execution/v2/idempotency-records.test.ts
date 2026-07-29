import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type {
  CartSnapshotV2,
  DesiredCartStateV2,
} from './contracts';
import { OperationIdempotencyRegistryV2 } from './idempotency-records';
import {
  classifyObservedCartMutationV2,
  unverifiedCartMutationV2,
} from './mutation-outcomes';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const itemId = parseLocalIdentifier(
  'task_item',
  'task_item_12345678-1234-1234-1234-123456789abc',
);
const operationIds = [
  'operation_12345678-1234-1234-1234-123456789ab1',
  'operation_12345678-1234-1234-1234-123456789ab2',
].map((value) => parseLocalIdentifier('operation', value));

const desired: DesiredCartStateV2 = {
  version: 2,
  taskId,
  itemId,
  stepKey: 'item.0.add',
  offerId: 'offer_milk',
  targetQuantity: 2,
};

function snapshot(
  observationId: string,
  capturedAt: number,
  quantity: number,
): CartSnapshotV2 {
  return {
    version: 2,
    observationId,
    capturedAt,
    lines: quantity > 0
      ? [{ offerId: desired.offerId, quantity }]
      : [],
  };
}

describe('operation idempotency registry v2', () => {
  it('rejects duplicate call IDs and equivalent desired-state mutations', () => {
    let idIndex = 0;
    const registry = new OperationIdempotencyRegistryV2({
      newOperationId: () => operationIds[idIndex++]!,
    });

    const created = registry.register({ callId: 'call-a', desired });
    const duplicateCall = registry.register({ callId: 'call-a', desired });
    const semanticDuplicate = registry.register({
      callId: 'call-b',
      desired: { ...desired },
    });

    expect(created.accepted).toBe(true);
    expect(duplicateCall).toMatchObject({
      accepted: false,
      disposition: 'duplicate_call_id',
    });
    expect(semanticDuplicate).toMatchObject({
      accepted: false,
      disposition: 'semantic_duplicate',
    });
    expect(semanticDuplicate.record.operationId)
      .toBe(created.record.operationId);
    expect(semanticDuplicate.record.callIds).toEqual(['call-a', 'call-b']);
  });

  it('rejects reuse of one call ID for a different semantic mutation', () => {
    const registry = new OperationIdempotencyRegistryV2({
      newOperationId: () => operationIds[0]!,
    });
    registry.register({ callId: 'call-a', desired });

    expect(registry.register({
      callId: 'call-a',
      desired: { ...desired, targetQuantity: 3 },
    })).toMatchObject({
      accepted: false,
      disposition: 'call_id_conflict',
    });
  });

  it('records reconciliation and allows verified task advancement once', () => {
    const registry = new OperationIdempotencyRegistryV2({
      newOperationId: () => operationIds[0]!,
      now: () => 500,
    });
    const registered = registry.register({ callId: 'call-a', desired });
    const before = snapshot('observation_before', 100, 0);
    registry.recordAttemptOutcome(
      registered.record.operationId,
      unverifiedCartMutationV2({
        before,
        desired,
        reason: 'verification_interrupted',
      }),
    );
    const verified = classifyObservedCartMutationV2({
      before,
      after: snapshot('observation_after', 200, 2),
      desired,
      mutationAttempted: true,
    });
    if (verified.kind !== 'verified') throw new Error('Expected verification.');
    registry.recordReconciliationOutcome(
      registered.record.operationId,
      verified,
    );

    expect(registry.claimVerifiedAdvance(registered.record.operationId).claimed)
      .toBe(true);
    expect(registry.claimVerifiedAdvance(registered.record.operationId).claimed)
      .toBe(false);
  });

  it('bounds retained records and expires stale idempotency keys', () => {
    let now = 100;
    let idIndex = 0;
    const registry = new OperationIdempotencyRegistryV2({
      maxRecords: 1,
      newOperationId: () => operationIds[idIndex++]!,
      now: () => now,
      recordTtlMs: 10,
    });
    const first = registry.register({ callId: 'call-a', desired });
    registry.register({
      callId: 'call-b',
      desired: { ...desired, targetQuantity: 3 },
    });
    expect(registry.get(first.record.operationId)).toBeUndefined();

    now = 111;
    expect(registry.cleanup()).toBe(1);
  });
});
