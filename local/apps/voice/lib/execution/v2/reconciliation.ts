import type {
  CartSnapshotV2,
  DesiredCartStateV2,
  MutationOutcomeV2,
  ReconciliationDecisionV2,
} from './contracts';
import {
  classifyObservedCartMutationV2,
} from './mutation-outcomes';

export function reconcileCartMutationBeforeRetryV2(input: {
  before: CartSnapshotV2;
  current?: CartSnapshotV2;
  desired: DesiredCartStateV2;
  outcome: MutationOutcomeV2;
}): ReconciliationDecisionV2 {
  if (input.outcome.kind === 'verified') {
    return { action: 'advance', outcome: input.outcome };
  }
  if (input.outcome.kind === 'failed_before_mutation') {
    return {
      action: 'retry_desired_state',
      reason: 'fresh_snapshot_matches_pre_mutation',
    };
  }
  if (
    !input.current
    || input.current.capturedAt <= input.before.capturedAt
  ) {
    return { action: 'inspect_again', reason: 'fresh_snapshot_required' };
  }
  const reconciled = classifyObservedCartMutationV2({
    after: input.current,
    before: input.before,
    desired: input.desired,
    mutationAttempted: true,
  });
  if (reconciled.kind === 'verified') {
    return { action: 'advance', outcome: reconciled };
  }
  if (
    reconciled.kind === 'mutation_unverified'
    || reconciled.kind === 'failed_before_mutation'
  ) {
    return {
      action: 'retry_desired_state',
      reason: 'fresh_snapshot_matches_pre_mutation',
    };
  }
  return {
    action: 'stop',
    outcome: reconciled,
    reason: 'unexpected_cart_state',
  };
}
