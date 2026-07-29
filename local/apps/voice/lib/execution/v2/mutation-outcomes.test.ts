import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type {
  CartSnapshotV2,
  DesiredCartStateV2,
} from './contracts';
import {
  classifyObservedCartMutationV2,
  failedBeforeCartMutationV2,
  unverifiedCartMutationV2,
} from './mutation-outcomes';
import { reconcileCartMutationBeforeRetryV2 } from './reconciliation';

const desired: DesiredCartStateV2 = {
  version: 2,
  taskId: parseLocalIdentifier(
    'task',
    'task_12345678-1234-1234-1234-123456789abc',
  ),
  stepKey: 'item.0.add',
  offerId: 'offer_milk',
  targetQuantity: 1,
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

const before = snapshot('observation_before', 100, 0);

describe('standard mutation outcomes v2', () => {
  it('separates failure before mutation from an attempted unverified mutation', () => {
    expect(failedBeforeCartMutationV2({
      before,
      desired,
      reason: 'executor_unavailable',
    })).toMatchObject({
      kind: 'failed_before_mutation',
      mutationAttempted: false,
      retryPolicy: 'retry_allowed',
    });
    expect(unverifiedCartMutationV2({
      before,
      desired,
      reason: 'verification_interrupted',
    })).toMatchObject({
      kind: 'mutation_unverified',
      mutationAttempted: true,
      retryPolicy: 'reconcile_required',
    });
  });

  it('classifies exact desired state as verified and divergence as ambiguous', () => {
    expect(classifyObservedCartMutationV2({
      before,
      after: snapshot('observation_after', 200, 1),
      desired,
      mutationAttempted: true,
    })).toMatchObject({
      kind: 'verified',
      retryPolicy: 'do_not_retry',
    });
    expect(classifyObservedCartMutationV2({
      before,
      after: snapshot('observation_after', 200, 2),
      desired,
      mutationAttempted: true,
    })).toMatchObject({
      kind: 'ambiguous',
      retryPolicy: 'stop_and_ask_user',
    });
  });

  it('does not treat an unchanged or stale observation as verification', () => {
    expect(classifyObservedCartMutationV2({
      before,
      after: snapshot('observation_same', 200, 0),
      desired,
      mutationAttempted: true,
    })).toMatchObject({
      kind: 'mutation_unverified',
      reason: 'desired_state_not_observed',
    });
    expect(classifyObservedCartMutationV2({
      before,
      after: snapshot('observation_stale', 100, 1),
      desired,
      mutationAttempted: true,
    })).toMatchObject({
      kind: 'mutation_unverified',
      reason: 'observation_stale',
    });
  });
});

describe('reconciliation before retry v2', () => {
  const unresolved = unverifiedCartMutationV2({
    before,
    desired,
    reason: 'verification_interrupted',
  });

  it('requires a fresh snapshot before retrying an unresolved mutation', () => {
    expect(reconcileCartMutationBeforeRetryV2({
      before,
      desired,
      outcome: unresolved,
    })).toEqual({
      action: 'inspect_again',
      reason: 'fresh_snapshot_required',
    });
  });

  it('advances on desired state, retries only on unchanged state, and stops on divergence', () => {
    expect(reconcileCartMutationBeforeRetryV2({
      before,
      current: snapshot('observation_success', 200, 1),
      desired,
      outcome: unresolved,
    }).action).toBe('advance');
    expect(reconcileCartMutationBeforeRetryV2({
      before,
      current: snapshot('observation_unchanged', 200, 0),
      desired,
      outcome: unresolved,
    })).toEqual({
      action: 'retry_desired_state',
      reason: 'fresh_snapshot_matches_pre_mutation',
    });
    expect(reconcileCartMutationBeforeRetryV2({
      before,
      current: snapshot('observation_divergent', 200, 2),
      desired,
      outcome: unresolved,
    }).action).toBe('stop');
  });
});
