import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type { CartSnapshotV2, DesiredCartStateV2 } from './contracts';
import { CartMutationExecutionTruthServiceV2 } from './cart-mutation-execution-truth';
import { OperationIdempotencyRegistryV2 } from './idempotency-records';

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
  targetQuantity: 1,
};

const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);

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

function service(): CartMutationExecutionTruthServiceV2 {
  return new CartMutationExecutionTruthServiceV2(
    new OperationIdempotencyRegistryV2({
      newOperationId: () => operationId,
      now: () => 500,
    }),
  );
}

describe('cart mutation execution truth v2', () => {
  it('deduplicates semantic mutations and never increments an already satisfied cart', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    const prepared = truth.prepare({ before, callId: 'call-a', desired });
    expect(prepared).toMatchObject({
      action: 'execute',
      retry: false,
      plan: {
        kind: 'set_absolute_quantity',
        currentQuantity: 0,
        targetQuantity: 1,
      },
    });

    const finished = truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'observed',
        after: snapshot('observation_after', 200, 1),
      },
    });
    expect(finished).toMatchObject({
      action: 'advance',
      outcome: { kind: 'verified', mutationAttempted: true },
    });

    const duplicate = truth.prepare({
      before: snapshot('observation_duplicate', 300, 1),
      callId: 'call-b',
      desired,
    });
    expect(duplicate).toMatchObject({
      action: 'completed',
      operationId,
      outcome: { kind: 'verified' },
    });
  });

  it('treats a desired state already visible before mutation as verified', () => {
    const truth = service();
    const result = truth.prepare({
      before: snapshot('observation_satisfied', 100, 1),
      callId: 'call-a',
      desired,
    });

    expect(result).toMatchObject({
      action: 'advance',
      outcome: {
        kind: 'verified',
        mutationAttempted: false,
        reason: 'already_satisfied',
      },
    });
  });

  it('requires explicit user retry after reconciliation proves no mutation', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    truth.prepare({ before, callId: 'call-a', desired });
    expect(truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'mutation_unverified',
        reason: 'verification_interrupted',
      },
    }).action).toBe('reconcile');

    expect(truth.prepare({
      before,
      callId: 'call-b',
      desired,
    }).action).toBe('reconcile');
    expect(truth.reconcile({
      before,
      desired,
      operationId,
    }).action).toBe('inspect_again');
    expect(truth.reconcile({
      before,
      current: snapshot('observation_stale', 100, 0),
      desired,
      operationId,
    }).action).toBe('inspect_again');

    const retry = truth.reconcile({
      before,
      current: snapshot('observation_fresh', 200, 0),
      desired,
      operationId,
    });
    expect(retry).toMatchObject({
      action: 'retry_requires_user',
      reason: 'verified_not_applied',
      outcome: {
        kind: 'mutation_unverified',
        mutationAttempted: true,
      },
    });
  });

  it('advances exactly once when reconciliation proves success', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    truth.prepare({ before, callId: 'call-a', desired });
    truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'mutation_unverified',
        reason: 'fresh_snapshot_unavailable',
      },
    });

    expect(truth.reconcile({
      before,
      current: snapshot('observation_success', 200, 1),
      desired,
      operationId,
    }).action).toBe('advance');
    expect(truth.prepare({
      before: snapshot('observation_later', 300, 1),
      callId: 'call-b',
      desired,
    }).action).toBe('completed');
  });

  it('stops on an unexpected cart state and preserves ambiguity', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    truth.prepare({ before, callId: 'call-a', desired });
    truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'mutation_unverified',
        reason: 'verification_interrupted',
      },
    });

    const stopped = truth.reconcile({
      before,
      current: snapshot('observation_divergent', 200, 2),
      desired,
      operationId,
    });
    expect(stopped).toMatchObject({
      action: 'stop',
      outcome: {
        kind: 'ambiguous',
        retryPolicy: 'stop_and_ask_user',
      },
    });
    expect(truth.prepare({
      before: snapshot('observation_later', 300, 2),
      callId: 'call-b',
      desired,
    }).action).toBe('stop');
  });

  it('allows a new semantic call to retry a proven pre-mutation failure', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    truth.prepare({ before, callId: 'call-a', desired });
    expect(truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'failed_before_mutation',
        reason: 'executor_unavailable',
      },
    }).action).toBe('retry_allowed');

    expect(truth.prepare({
      before: snapshot('observation_fresh', 200, 0),
      callId: 'call-b',
      desired,
    })).toMatchObject({
      action: 'execute',
      retry: true,
    });
  });

  it('rejects one call ID reused for a different desired state', () => {
    const truth = service();
    const before = snapshot('observation_before', 100, 0);
    truth.prepare({ before, callId: 'call-a', desired });

    expect(truth.prepare({
      before,
      callId: 'call-a',
      desired: { ...desired, targetQuantity: 2 },
    })).toMatchObject({
      action: 'reject',
      reason: 'call_id_conflict',
    });
  });
});
