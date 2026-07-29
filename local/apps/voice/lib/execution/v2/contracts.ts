import type { LocalIdentifier } from '../../workflow/identifiers';

export type CartLineQuantityV2 = {
  offerId: string;
  quantity: number;
};

export type CartTermConflictEvidenceV2 = {
  field: 'pack_size' | 'price';
  expected: string;
  observed: string;
};

export type CartSnapshotV2 = {
  version: 2;
  capturedAt: number;
  observationId: string;
  lines: readonly CartLineQuantityV2[];
};

export type DesiredCartStateV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  stepKey: string;
  offerId: string;
  targetQuantity: number;
};

export type CartMutationEvidenceV2 = {
  beforeObservationId: string;
  afterObservationId?: string;
  desiredStateDigest: string;
  beforeQuantity: number;
  observedQuantity?: number;
  targetQuantity: number;
  identityResolution?: 'ambiguous' | 'none' | 'unique';
  conflicts?: readonly CartTermConflictEvidenceV2[];
};

export type MutationOutcomeV2 =
  | {
      kind: 'failed_before_mutation';
      mutationAttempted: false;
      reason:
        | 'executor_unavailable'
        | 'invalid_precondition'
        | 'ownership_unavailable'
        | 'policy_blocked';
      retryPolicy: 'retry_allowed';
      evidence: CartMutationEvidenceV2;
    }
  | {
      kind: 'mutation_unverified';
      mutationAttempted: true;
      reason:
        | 'desired_state_not_observed'
        | 'fresh_snapshot_unavailable'
        | 'observation_stale'
        | 'verification_interrupted';
      retryPolicy: 'reconcile_required';
      evidence: CartMutationEvidenceV2;
    }
  | {
      kind: 'verified';
      mutationAttempted: boolean;
      reason: 'already_satisfied' | 'desired_state_observed';
      retryPolicy: 'do_not_retry';
      evidence: CartMutationEvidenceV2 & {
        afterObservationId: string;
        observedQuantity: number;
      };
    }
  | {
      kind: 'ambiguous';
      mutationAttempted: true;
      reason: 'cart_changed_to_unexpected_state' | 'conflicting_observations';
      retryPolicy: 'stop_and_ask_user';
      evidence: CartMutationEvidenceV2 & {
        afterObservationId: string;
        observedQuantity: number;
      };
    };

export type OperationIdempotencyStatusV2 =
  | 'pending'
  | 'outcome_recorded'
  | 'reconciled';

export type OperationIdempotencyRecordV2 = {
  version: 2;
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  stepKey: string;
  semanticKey: string;
  desiredStateDigest: string;
  callIds: readonly string[];
  status: OperationIdempotencyStatusV2;
  outcome?: MutationOutcomeV2;
  advanceClaimedAt?: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type RegisterOperationResultV2 =
  | {
      accepted: true;
      disposition: 'created';
      record: OperationIdempotencyRecordV2;
    }
  | {
      accepted: false;
      disposition:
        | 'duplicate_call_id'
        | 'semantic_duplicate'
        | 'call_id_conflict';
      record: OperationIdempotencyRecordV2;
    };

export type DesiredCartMutationPlanV2 =
  | {
      kind: 'already_satisfied';
      desired: DesiredCartStateV2;
      desiredStateDigest: string;
      currentQuantity: number;
    }
  | {
      kind: 'set_absolute_quantity';
      desired: DesiredCartStateV2;
      desiredStateDigest: string;
      currentQuantity: number;
      targetQuantity: number;
    };

export type ReconciliationDecisionV2 =
  | {
      action: 'advance';
      outcome: Extract<MutationOutcomeV2, { kind: 'verified' }>;
    }
  | {
      action: 'retry_desired_state';
      reason: 'fresh_snapshot_matches_pre_mutation';
    }
  | {
      action: 'inspect_again';
      reason: 'fresh_snapshot_required';
    }
  | {
      action: 'stop';
      outcome: Extract<MutationOutcomeV2, { kind: 'ambiguous' }>;
      reason: 'unexpected_cart_state';
    };
