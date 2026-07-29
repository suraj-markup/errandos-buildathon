import type {
  CartMutationEvidenceV2,
  CartSnapshotV2,
  CartTermConflictEvidenceV2,
  DesiredCartStateV2,
  MutationOutcomeV2,
} from './contracts';
import {
  cartQuantityV2,
  desiredCartStateDigestV2,
  validateCartSnapshotV2,
} from './desired-cart-state';

type FailedBeforeMutationReasonV2 = Extract<
  MutationOutcomeV2,
  { kind: 'failed_before_mutation' }
>['reason'];

type UnverifiedReasonV2 = Extract<
  MutationOutcomeV2,
  { kind: 'mutation_unverified' }
>['reason'];

function baseEvidence(input: {
  after?: CartSnapshotV2;
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
}): CartMutationEvidenceV2 {
  const beforeQuantity = cartQuantityV2(
    input.before,
    input.desired.offerId,
  );
  const observedQuantity = input.after
    ? cartQuantityV2(input.after, input.desired.offerId)
    : undefined;
  return {
    beforeObservationId: input.before.observationId,
    ...(input.after
      ? {
          afterObservationId: input.after.observationId,
          observedQuantity,
        }
      : {}),
    desiredStateDigest: desiredCartStateDigestV2(input.desired),
    beforeQuantity,
    targetQuantity: input.desired.targetQuantity,
  };
}

export function failedBeforeCartMutationV2(input: {
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
  reason: FailedBeforeMutationReasonV2;
}): MutationOutcomeV2 {
  return {
    kind: 'failed_before_mutation',
    mutationAttempted: false,
    reason: input.reason,
    retryPolicy: 'retry_allowed',
    evidence: baseEvidence(input),
  };
}

export function unverifiedCartMutationV2(input: {
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
  reason: UnverifiedReasonV2;
}): MutationOutcomeV2 {
  return {
    kind: 'mutation_unverified',
    mutationAttempted: true,
    reason: input.reason,
    retryPolicy: 'reconcile_required',
    evidence: baseEvidence(input),
  };
}

export function ambiguousCartIdentityMutationV2(input: {
  after: CartSnapshotV2;
  before: CartSnapshotV2;
  conflicts?: readonly CartTermConflictEvidenceV2[];
  desired: DesiredCartStateV2;
}): Extract<MutationOutcomeV2, { kind: 'ambiguous' }> {
  validateCartSnapshotV2(input.before);
  validateCartSnapshotV2(input.after);
  const evidence = baseEvidence(input);
  return {
    kind: 'ambiguous',
    mutationAttempted: true,
    reason: 'conflicting_observations',
    retryPolicy: 'stop_and_ask_user',
    evidence: {
      ...evidence,
      afterObservationId: input.after.observationId,
      observedQuantity: evidence.observedQuantity!,
      identityResolution: 'ambiguous',
      ...(input.conflicts?.length
        ? { conflicts: structuredClone(input.conflicts) }
        : {}),
    },
  };
}

export function classifyObservedCartMutationV2(input: {
  after: CartSnapshotV2;
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
  mutationAttempted: boolean;
}): MutationOutcomeV2 {
  validateCartSnapshotV2(input.before);
  validateCartSnapshotV2(input.after);
  const evidence = baseEvidence(input);
  if (input.after.capturedAt <= input.before.capturedAt) {
    if (!input.mutationAttempted) {
      return {
        kind: 'failed_before_mutation',
        mutationAttempted: false,
        reason: 'invalid_precondition',
        retryPolicy: 'retry_allowed',
        evidence,
      };
    }
    return {
      kind: 'mutation_unverified',
      mutationAttempted: true,
      reason: 'observation_stale',
      retryPolicy: 'reconcile_required',
      evidence,
    };
  }
  const observedQuantity = evidence.observedQuantity!;
  if (observedQuantity === input.desired.targetQuantity) {
    return {
      kind: 'verified',
      mutationAttempted: input.mutationAttempted,
      reason: input.mutationAttempted
        ? 'desired_state_observed'
        : 'already_satisfied',
      retryPolicy: 'do_not_retry',
      evidence: {
        ...evidence,
        afterObservationId: input.after.observationId,
        observedQuantity,
      },
    };
  }
  if (observedQuantity === evidence.beforeQuantity) {
    if (!input.mutationAttempted) {
      return {
        kind: 'failed_before_mutation',
        mutationAttempted: false,
        reason: 'invalid_precondition',
        retryPolicy: 'retry_allowed',
        evidence,
      };
    }
    return {
      kind: 'mutation_unverified',
      mutationAttempted: true,
      reason: 'desired_state_not_observed',
      retryPolicy: 'reconcile_required',
      evidence,
    };
  }
  return {
    kind: 'ambiguous',
    mutationAttempted: true,
    reason: 'cart_changed_to_unexpected_state',
    retryPolicy: 'stop_and_ask_user',
    evidence: {
      ...evidence,
      afterObservationId: input.after.observationId,
      observedQuantity,
    },
  };
}
