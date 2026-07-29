import type { LocalIdentifier } from '../../workflow/identifiers';
import type {
  CartSnapshotV2,
  CartTermConflictEvidenceV2,
  DesiredCartMutationPlanV2,
  DesiredCartStateV2,
  MutationOutcomeV2,
  OperationIdempotencyRecordV2,
} from './contracts';
import {
  desiredCartStateDigestV2,
  planDesiredCartMutationV2,
} from './desired-cart-state';
import { OperationIdempotencyRegistryV2 } from './idempotency-records';
import {
  ambiguousCartIdentityMutationV2,
  classifyObservedCartMutationV2,
  failedBeforeCartMutationV2,
  unverifiedCartMutationV2,
} from './mutation-outcomes';
import { reconcileCartMutationBeforeRetryV2 } from './reconciliation';

type FailedBeforeMutationReasonV2 = Extract<
  MutationOutcomeV2,
  { kind: 'failed_before_mutation' }
>['reason'];

type UnverifiedMutationReasonV2 = Extract<
  MutationOutcomeV2,
  { kind: 'mutation_unverified' }
>['reason'];

export type CartMutationAttemptResultV2 =
  | {
      kind: 'failed_before_mutation';
      reason: FailedBeforeMutationReasonV2;
    }
  | {
      kind: 'mutation_unverified';
      reason: UnverifiedMutationReasonV2;
    }
  | {
      kind: 'identity_ambiguous';
      after: CartSnapshotV2;
      conflicts?: readonly CartTermConflictEvidenceV2[];
    }
  | {
      kind: 'observed';
      after: CartSnapshotV2;
    };

type DirectiveBaseV2 = {
  operationId: LocalIdentifier<'operation'>;
  record: OperationIdempotencyRecordV2;
};

export type CartMutationExecutionDirectiveV2 =
  | (DirectiveBaseV2 & {
      action: 'execute';
      plan: Extract<
        DesiredCartMutationPlanV2,
        { kind: 'set_absolute_quantity' }
      >;
      retry: boolean;
    })
  | (DirectiveBaseV2 & {
      action: 'advance';
      outcome: Extract<MutationOutcomeV2, { kind: 'verified' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'completed';
      outcome: Extract<MutationOutcomeV2, { kind: 'verified' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'reconcile';
      outcome: Extract<MutationOutcomeV2, { kind: 'mutation_unverified' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'inspect_again';
      outcome: Extract<MutationOutcomeV2, { kind: 'mutation_unverified' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'retry_allowed';
      outcome: Extract<MutationOutcomeV2, { kind: 'failed_before_mutation' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'retry_requires_user';
      outcome: Extract<MutationOutcomeV2, { kind: 'mutation_unverified' }>;
      reason: 'verified_not_applied';
    })
  | (DirectiveBaseV2 & {
      action: 'stop';
      outcome: Extract<MutationOutcomeV2, { kind: 'ambiguous' }>;
    })
  | (DirectiveBaseV2 & {
      action: 'await_outcome';
      reason: 'operation_in_flight';
    })
  | (DirectiveBaseV2 & {
      action: 'reject';
      reason: 'call_id_conflict';
    });

export type PrepareCartMutationInputV2 = {
  before: CartSnapshotV2;
  callId: string;
  desired: DesiredCartStateV2;
  operationId?: LocalIdentifier<'operation'> | string;
};

export type FinishCartMutationInputV2 = {
  before: CartSnapshotV2;
  desired: DesiredCartStateV2;
  operationId: LocalIdentifier<'operation'> | string;
  result: CartMutationAttemptResultV2;
};

export type ReconcileCartMutationInputV2 = {
  before: CartSnapshotV2;
  current?: CartSnapshotV2;
  identityConflicts?: readonly CartTermConflictEvidenceV2[];
  identityResolution?: 'ambiguous';
  desired: DesiredCartStateV2;
  operationId: LocalIdentifier<'operation'> | string;
};

function alreadySatisfiedOutcomeV2(input: {
  before: CartSnapshotV2;
  plan: Extract<
    DesiredCartMutationPlanV2,
    { kind: 'already_satisfied' }
  >;
}): Extract<MutationOutcomeV2, { kind: 'verified' }> {
  return {
    kind: 'verified',
    mutationAttempted: false,
    reason: 'already_satisfied',
    retryPolicy: 'do_not_retry',
    evidence: {
      beforeObservationId: input.before.observationId,
      afterObservationId: input.before.observationId,
      desiredStateDigest: input.plan.desiredStateDigest,
      beforeQuantity: input.plan.currentQuantity,
      observedQuantity: input.plan.currentQuantity,
      targetQuantity: input.plan.desired.targetQuantity,
    },
  };
}

export class CartMutationExecutionTruthServiceV2 {
  constructor(
    private readonly registry = new OperationIdempotencyRegistryV2(),
  ) {}

  prepare(
    input: PrepareCartMutationInputV2,
  ): CartMutationExecutionDirectiveV2 {
    const registration = this.registry.register({
      callId: input.callId,
      desired: input.desired,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
    const record = registration.record;
    if (registration.disposition === 'call_id_conflict') {
      return this.directive(record, {
        action: 'reject',
        reason: 'call_id_conflict',
      });
    }
    this.assertDesiredState(record, input.desired);
    if (registration.accepted) {
      return this.prepareNew(record, input.before, input.desired, false);
    }
    if (record.outcome?.kind === 'verified') {
      return this.verifiedDirective(record);
    }
    if (record.outcome?.kind === 'ambiguous') {
      return this.directive(record, {
        action: 'stop',
        outcome: record.outcome,
      });
    }
    if (record.outcome?.kind === 'mutation_unverified') {
      return this.directive(record, {
        action: 'reconcile',
        outcome: record.outcome,
      });
    }
    if (record.outcome?.kind === 'failed_before_mutation') {
      if (registration.disposition === 'duplicate_call_id') {
        return this.directive(record, {
          action: 'retry_allowed',
          outcome: record.outcome,
        });
      }
      const reset = this.registry.beginRetryAfterFailure(record.operationId);
      return this.prepareNew(reset, input.before, input.desired, true);
    }
    return this.directive(record, {
      action: 'await_outcome',
      reason: 'operation_in_flight',
    });
  }

  finish(
    input: FinishCartMutationInputV2,
  ): CartMutationExecutionDirectiveV2 {
    const record = this.requireBoundRecord(
      input.operationId,
      input.desired,
    );
    if (record.outcome) {
      return this.directiveForRecordedOutcome(record);
    }
    const outcome = this.outcomeFromAttempt(input);
    const updated = this.registry.recordAttemptOutcome(
      record.operationId,
      outcome,
    );
    return this.directiveForRecordedOutcome(updated);
  }

  reconcile(
    input: ReconcileCartMutationInputV2,
  ): CartMutationExecutionDirectiveV2 {
    let record = this.requireBoundRecord(input.operationId, input.desired);
    if (record.outcome?.kind === 'verified') {
      return this.verifiedDirective(record);
    }
    if (record.outcome?.kind === 'ambiguous') {
      return this.directive(record, {
        action: 'stop',
        outcome: record.outcome,
      });
    }
    if (record.outcome?.kind === 'failed_before_mutation') {
      return this.directive(record, {
        action: 'retry_allowed',
        outcome: record.outcome,
      });
    }
    if (input.identityResolution === 'ambiguous' && input.current) {
      const ambiguous = ambiguousCartIdentityMutationV2({
        after: input.current,
        before: input.before,
        ...(input.identityConflicts?.length
          ? { conflicts: input.identityConflicts }
          : {}),
        desired: input.desired,
      });
      const reconciled = record.outcome
        ? this.registry.recordReconciliationOutcome(
            record.operationId,
            ambiguous,
          )
        : this.registry.recordAttemptOutcome(
            record.operationId,
            ambiguous,
          );
      return this.directive(reconciled, {
        action: 'stop',
        outcome: ambiguous,
      });
    }

    let unresolved: Extract<
      MutationOutcomeV2,
      { kind: 'mutation_unverified' }
    >;
    if (record.outcome?.kind === 'mutation_unverified') {
      unresolved = record.outcome;
    } else {
      const interrupted = unverifiedCartMutationV2({
        before: input.before,
        desired: input.desired,
        reason: 'verification_interrupted',
      });
      if (interrupted.kind !== 'mutation_unverified') {
        throw new Error('Expected an unverified mutation outcome.');
      }
      record = this.registry.recordAttemptOutcome(
        record.operationId,
        interrupted,
      );
      unresolved = interrupted;
    }
    const decision = reconcileCartMutationBeforeRetryV2({
      before: input.before,
      ...(input.current ? { current: input.current } : {}),
      desired: input.desired,
      outcome: unresolved,
    });
    if (decision.action === 'inspect_again') {
      return this.directive(record, {
        action: 'inspect_again',
        outcome: unresolved,
      });
    }
    if (decision.action === 'advance') {
      const reconciled = this.registry.recordReconciliationOutcome(
        record.operationId,
        decision.outcome,
      );
      return this.verifiedDirective(reconciled);
    }
    if (decision.action === 'stop') {
      const reconciled = this.registry.recordReconciliationOutcome(
        record.operationId,
        decision.outcome,
      );
      return this.directive(reconciled, {
        action: 'stop',
        outcome: decision.outcome,
      });
    }

    return this.directive(record, {
      action: 'retry_requires_user',
      outcome: unresolved,
      reason: 'verified_not_applied',
    });
  }

  private prepareNew(
    record: OperationIdempotencyRecordV2,
    before: CartSnapshotV2,
    desired: DesiredCartStateV2,
    retry: boolean,
  ): CartMutationExecutionDirectiveV2 {
    const plan = planDesiredCartMutationV2({ before, desired });
    if (plan.kind === 'set_absolute_quantity') {
      return this.directive(record, { action: 'execute', plan, retry });
    }
    const updated = this.registry.recordAttemptOutcome(
      record.operationId,
      alreadySatisfiedOutcomeV2({ before, plan }),
    );
    return this.verifiedDirective(updated);
  }

  private outcomeFromAttempt(
    input: FinishCartMutationInputV2,
  ): MutationOutcomeV2 {
    if (input.result.kind === 'failed_before_mutation') {
      return failedBeforeCartMutationV2({
        before: input.before,
        desired: input.desired,
        reason: input.result.reason,
      });
    }
    if (input.result.kind === 'mutation_unverified') {
      return unverifiedCartMutationV2({
        before: input.before,
        desired: input.desired,
        reason: input.result.reason,
      });
    }
    if (input.result.kind === 'identity_ambiguous') {
      return ambiguousCartIdentityMutationV2({
        after: input.result.after,
        before: input.before,
        ...(input.result.conflicts?.length
          ? { conflicts: input.result.conflicts }
          : {}),
        desired: input.desired,
      });
    }
    return classifyObservedCartMutationV2({
      before: input.before,
      after: input.result.after,
      desired: input.desired,
      mutationAttempted: true,
    });
  }

  private directiveForRecordedOutcome(
    record: OperationIdempotencyRecordV2,
  ): CartMutationExecutionDirectiveV2 {
    const outcome = record.outcome;
    if (!outcome) {
      return this.directive(record, {
        action: 'await_outcome',
        reason: 'operation_in_flight',
      });
    }
    if (outcome.kind === 'verified') {
      return this.verifiedDirective(record);
    }
    if (outcome.kind === 'mutation_unverified') {
      return this.directive(record, { action: 'reconcile', outcome });
    }
    if (outcome.kind === 'failed_before_mutation') {
      return this.directive(record, { action: 'retry_allowed', outcome });
    }
    return this.directive(record, { action: 'stop', outcome });
  }

  private verifiedDirective(
    record: OperationIdempotencyRecordV2,
  ): CartMutationExecutionDirectiveV2 {
    const outcome = record.outcome;
    if (outcome?.kind !== 'verified') {
      throw new Error(`Operation ${record.operationId} is not verified.`);
    }
    const claim = this.registry.claimVerifiedAdvance(record.operationId);
    return this.directive(claim.record, {
      action: claim.claimed ? 'advance' : 'completed',
      outcome,
    });
  }

  private requireBoundRecord(
    operationId: LocalIdentifier<'operation'> | string,
    desired: DesiredCartStateV2,
  ): OperationIdempotencyRecordV2 {
    const record = this.registry.get(operationId);
    if (!record) throw new Error(`Operation ${operationId} was not found.`);
    this.assertDesiredState(record, desired);
    return record;
  }

  private assertDesiredState(
    record: OperationIdempotencyRecordV2,
    desired: DesiredCartStateV2,
  ): void {
    if (record.desiredStateDigest !== desiredCartStateDigestV2(desired)) {
      throw new Error(
        `Desired state does not match operation ${record.operationId}.`,
      );
    }
  }

  private directive<T extends Omit<
    CartMutationExecutionDirectiveV2,
    keyof DirectiveBaseV2
  >>(
    record: OperationIdempotencyRecordV2,
    value: T,
  ): T & DirectiveBaseV2 {
    return {
      ...value,
      operationId: record.operationId,
      record,
    };
  }
}
