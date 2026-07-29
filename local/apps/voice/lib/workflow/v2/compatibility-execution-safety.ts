import { join } from 'node:path';
import { reconcileProviderProductIdentity } from '@errandos/provider-connectors';
import type { LocalIdentifier } from '../identifiers';
import {
  CartMutationExecutionTruthServiceV2,
  type CartMutationExecutionDirectiveV2,
} from '../../execution/v2/cart-mutation-execution-truth';
import type {
  CartSnapshotV2,
  CartTermConflictEvidenceV2,
  DesiredCartStateV2,
} from '../../execution/v2/contracts';
import {
  ExecutionLoopDetectorV2,
  type ExecutionLoopDecisionV2,
} from '../../execution/v2/loop-detector';
import { OperationIdempotencyRegistryV2 } from '../../execution/v2/idempotency-records';
import { FileOperationIdempotencyPersistenceV2 } from '../../execution/v2/file-idempotency-persistence';
import {
  sharedCartInspectionEvidenceV2,
} from '../../execution/v2/cart-inspection-evidence';

type CompatibilityCartActionV2 = {
  action?:
    | 'add_cart_item'
    | 'inspect_cart'
    | 'open_blinkit'
    | 'remove_cart_item'
    | 'search_products'
    | 'set_cart_item_quantity'
    | string;
  offerId?: string;
  productId?: string;
  quantity?: number;
  selectedOffer?: {
    offerId: string;
    packSize?: string;
    priceAmount?: number;
    priceCurrency?: string;
    title?: string;
  };
  [key: string]: unknown;
};

type CompatibilityExecutionContextV2 = {
  callId: string;
  itemId?: LocalIdentifier<'task_item'>;
  operationId: LocalIdentifier<'operation'>;
  stepKey?: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision?: number;
};

type CompatibilityExecutionResultV2 = Record<string, unknown>;

type CompatibilityCartInspectionV2 = {
  conflicts: readonly CartTermConflictEvidenceV2[];
  identityResolution?: 'ambiguous' | 'none' | 'unique';
  snapshot: CartSnapshotV2;
};

type InspectCartV2 = () => Promise<unknown>;
type ExecuteActionV2 = (
  action: CompatibilityCartActionV2,
) => Promise<unknown>;

type CompatibilityExecutionSafetyOptionsV2 = {
  now?: () => number;
  truth?: CartMutationExecutionTruthServiceV2;
  newLoopDetector?: () => ExecutionLoopDetectorV2;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cartTermConflicts(value: unknown): CartTermConflictEvidenceV2[] {
  if (!Array.isArray(value)) return [];
  const conflicts: CartTermConflictEvidenceV2[] = [];
  for (const entry of value) {
    const candidate = record(entry);
    const field = candidate['field'];
    const expected = candidate['expected'];
    const observed = candidate['observed'];
    if (
      !['pack_size', 'price'].includes(String(field ?? ''))
      || typeof expected !== 'string'
      || typeof observed !== 'string'
      || !expected.trim()
      || !observed.trim()
    ) {
      continue;
    }
    conflicts.push({
      field: field as CartTermConflictEvidenceV2['field'],
      expected: expected.trim().slice(0, 100),
      observed: observed.trim().slice(0, 100),
    });
  }
  return conflicts.slice(0, 4);
}

function identityEvidenceFromResult(
  result: Record<string, unknown>,
): Pick<
  CompatibilityCartInspectionV2,
  'conflicts' | 'identityResolution'
> {
  const verification = record(result['verification']);
  const identity = record(verification['identity']);
  const rawResolution =
    verification['identityResolution']
    ?? verification['identityMatchStatus']
    ?? identity['status'];
  const identityResolution =
    rawResolution === 'unique'
    || rawResolution === 'none'
    || rawResolution === 'ambiguous'
      ? rawResolution
      : undefined;
  const conflicts = cartTermConflicts(
    verification['conflicts']
      ?? verification['conflictEvidence']
      ?? identity['conflicts'],
  );
  return {
    conflicts,
    ...(identityResolution ? { identityResolution } : {}),
  };
}

function mergedIdentityEvidence(
  ...values: readonly Pick<
    CompatibilityCartInspectionV2,
    'conflicts' | 'identityResolution'
  >[]
): Pick<
  CompatibilityCartInspectionV2,
  'conflicts' | 'identityResolution'
> {
  const conflicts = new Map<string, CartTermConflictEvidenceV2>();
  let identityResolution: CompatibilityCartInspectionV2['identityResolution'];
  for (const value of values) {
    if (value.identityResolution === 'ambiguous') {
      identityResolution = 'ambiguous';
    } else if (!identityResolution && value.identityResolution) {
      identityResolution = value.identityResolution;
    }
    for (const conflict of value.conflicts) {
      conflicts.set(
        `${conflict.field}\u0000${conflict.expected}\u0000${conflict.observed}`,
        conflict,
      );
    }
  }
  const retainedConflicts = [...conflicts.values()].slice(0, 4);
  if (retainedConflicts.length > 0) identityResolution = 'ambiguous';
  return {
    conflicts: retainedConflicts,
    ...(identityResolution ? { identityResolution } : {}),
  };
}

function withIdentityEvidence(
  result: Record<string, unknown>,
  evidence: Pick<
    CompatibilityCartInspectionV2,
    'conflicts' | 'identityResolution'
  >,
): Record<string, unknown> {
  if (!evidence.identityResolution && evidence.conflicts.length === 0) {
    return result;
  }
  return {
    ...result,
    verification: {
      ...record(result['verification']),
      ...(evidence.identityResolution
        ? { identityResolution: evidence.identityResolution }
        : {}),
      ...(evidence.conflicts.length
        ? { conflicts: structuredClone(evidence.conflicts) }
        : {}),
    },
  };
}

function finiteQuantity(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 999
    ? value
    : undefined;
}

function cartLinePriceAmount(
  line: Record<string, unknown>,
): number | undefined {
  if (typeof line['price'] === 'string') {
    const amount = Number(line['price'].replace(/[^0-9.]+/g, ''));
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  const unitPrice = record(line['unitPrice']);
  const amount = unitPrice['amount'];
  return typeof amount === 'number'
    && Number.isFinite(amount)
    && amount >= 0
    ? amount
    : undefined;
}

function desiredStateFor(
  action: CompatibilityCartActionV2,
  context: CompatibilityExecutionContextV2,
): DesiredCartStateV2 | undefined {
  const kind = action.action;
  const offerId = kind === 'set_cart_item_quantity'
    || kind === 'remove_cart_item'
    ? action.productId
    : action.offerId ?? action.selectedOffer?.offerId;
  const targetQuantity = kind === 'remove_cart_item'
    ? 0
    : finiteQuantity(action.quantity);
  if (
    ![
      'add_cart_item',
      'remove_cart_item',
      'set_cart_item_quantity',
    ].includes(kind ?? '')
    || !offerId?.trim()
    || targetQuantity === undefined
  ) {
    return undefined;
  }
  return {
    version: 2,
    taskId: context.taskId,
    ...(context.itemId ? { itemId: context.itemId } : {}),
    stepKey:
      context.stepKey?.trim()
      || context.itemId
      || `cart:${offerId.trim()}`,
    offerId: offerId.trim(),
    targetQuantity,
  };
}

function normalizedMutationAction(
  action: CompatibilityCartActionV2,
  directive: Extract<
    CartMutationExecutionDirectiveV2,
    { action: 'execute' }
  >,
): CompatibilityCartActionV2 {
  const quantity = directive.plan.targetQuantity;
  if (action.action === 'remove_cart_item') {
    return quantity === 0
      ? { ...action, productId: directive.plan.desired.offerId }
      : {
          ...action,
          action: 'set_cart_item_quantity',
          productId: directive.plan.desired.offerId,
          quantity,
        };
  }
  if (action.action === 'set_cart_item_quantity') {
    return {
      ...action,
      productId: directive.plan.desired.offerId,
      quantity,
    };
  }
  return {
    ...action,
    offerId: directive.plan.desired.offerId,
    quantity,
  };
}

function mutationAttempted(result: Record<string, unknown>): boolean {
  const verification = record(result['verification']);
  if (typeof verification['mutationAttempted'] === 'boolean') {
    return verification['mutationAttempted'];
  }
  return ![
    'invalid_command',
    'invalid_quantity',
    'needs_clarification',
    'not_found',
    'unsupported_action',
  ].includes(String(result['status'] ?? ''));
}

function successfulStatus(
  action: CompatibilityCartActionV2,
  desired: DesiredCartStateV2,
  mutationWasAttempted: boolean,
): string {
  if (!mutationWasAttempted) return 'already_in_cart';
  if (desired.targetQuantity === 0) return 'removed';
  if (action.action === 'set_cart_item_quantity') return 'quantity_updated';
  return 'added';
}

function verifiedCompatibilityResult(input: {
  action: CompatibilityCartActionV2;
  desired: DesiredCartStateV2;
  directive: Extract<
    CartMutationExecutionDirectiveV2,
    { action: 'advance' | 'completed' }
  >;
  original?: Record<string, unknown>;
}): CompatibilityExecutionResultV2 {
  if (input.directive.action === 'completed') {
    return {
      ok: true,
      status: 'duplicate_suppressed',
      offerId: input.desired.offerId,
      quantity: input.desired.targetQuantity,
      verification: {
        mutationAttempted: false,
        outcome: 'duplicate_suppressed',
        reconciliation: 'not_run',
      },
      executionTruthV2: {
        action: input.directive.action,
        desiredStateDigest: input.directive.record.desiredStateDigest,
        operationId: input.directive.operationId,
        retryPolicy: input.directive.outcome.retryPolicy,
      },
    };
  }
  const mutationWasAttempted =
    input.directive.outcome.mutationAttempted;
  return {
    ...(input.original ?? {}),
    ok: true,
    status: successfulStatus(
      input.action,
      input.desired,
      mutationWasAttempted,
    ),
    offerId: input.desired.offerId,
    quantity: input.desired.targetQuantity,
    verification: {
      ...record(input.original?.['verification']),
      mutationAttempted: mutationWasAttempted,
      outcome: 'verified_success',
      reconciliation: mutationWasAttempted ? 'verified' : 'not_run',
    },
    executionTruthV2: {
      action: input.directive.action,
      desiredStateDigest: input.directive.record.desiredStateDigest,
      operationId: input.directive.operationId,
      retryPolicy: input.directive.outcome.retryPolicy,
    },
  };
}

function guardedResult(
  directive: CartMutationExecutionDirectiveV2,
): CompatibilityExecutionResultV2 {
  switch (directive.action) {
    case 'await_outcome':
      return {
        ok: true,
        status: 'duplicate_suppressed',
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          reason: directive.reason,
        },
      };
    case 'reject':
      return {
        ok: false,
        status: 'idempotency_conflict',
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          reason: directive.reason,
        },
      };
    case 'reconcile':
    case 'inspect_again':
      return {
        ok: false,
        status: 'reconciliation_required',
        verification: {
          mutationAttempted: true,
          outcome: 'ambiguous',
          reconciliation: 'inspection_failed',
        },
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          retryPolicy: directive.outcome.retryPolicy,
        },
      };
    case 'retry_allowed':
      return {
        ok: false,
        status: 'retry_allowed',
        verification: {
          mutationAttempted: false,
          outcome: 'failed_before_mutation',
          reconciliation: 'not_run',
        },
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          retryPolicy: directive.outcome.retryPolicy,
        },
      };
    case 'retry_requires_user':
      return {
        ok: false,
        status: 'retry_requires_user',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_not_applied',
          reconciliation: 'verified',
        },
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          reason: directive.reason,
          retryPolicy: 'explicit_user_retry_only',
        },
      };
    case 'stop':
      return {
        ok: false,
        status: 'mutation_outcome_ambiguous',
        verification: {
          mutationAttempted: true,
          outcome: 'ambiguous',
          reconciliation: 'mismatch',
        },
        executionTruthV2: {
          action: directive.action,
          operationId: directive.operationId,
          reason: directive.outcome.reason,
          retryPolicy: directive.outcome.retryPolicy,
        },
      };
    default:
      return {
        ok: false,
        status: 'execution_guard_error',
      };
  }
}

export class CompatibilityExecutionSafetyV2 {
  private readonly truth: CartMutationExecutionTruthServiceV2;
  private readonly now: () => number;
  private readonly newLoopDetector: () => ExecutionLoopDetectorV2;
  private readonly loopDetectors = new Map<
    LocalIdentifier<'task'>,
    ExecutionLoopDetectorV2
  >();
  private readonly stoppedLoopRevision = new Map<
    LocalIdentifier<'task'>,
    number
  >();
  private lastCapturedAt = 0;
  private observationSequence = 0;

  constructor(options: CompatibilityExecutionSafetyOptionsV2 = {}) {
    this.truth = options.truth ?? new CartMutationExecutionTruthServiceV2();
    this.now = options.now ?? Date.now;
    this.newLoopDetector = options.newLoopDetector
      ?? (() => new ExecutionLoopDetectorV2());
  }

  async execute(input: {
    action: CompatibilityCartActionV2;
    context: CompatibilityExecutionContextV2;
    execute: ExecuteActionV2;
    inspectCart: InspectCartV2;
  }): Promise<unknown> {
    const desired = desiredStateFor(input.action, input.context);
    if (!desired) {
      const revision = input.context.taskRevision ?? 0;
      const stoppedAt = this.stoppedLoopRevision.get(input.context.taskId);
      if (stoppedAt !== undefined && stoppedAt === revision) {
        return {
          ok: false,
          status: 'execution_loop_stopped',
          loop: {
            reason: 'previous_loop_stop',
            taskRevision: revision,
          },
        };
      }
      if (stoppedAt !== undefined) {
        this.resetLoopGuard(input.context.taskId);
      }
      const result = await input.execute(input.action);
      return this.applyLoopGuard(input.action, input.context, result);
    }

    const beforeInspection = await this.inspectSnapshot(
      input.inspectCart,
      input.action,
    );
    if (!beforeInspection) {
      return {
        ok: false,
        status: 'execution_failed',
        failure: {
          operation: input.action.action,
          reason: 'cart_inspection_failed',
          recoverable: true,
          stage: 'inspection',
        },
        verification: {
          mutationAttempted: false,
          outcome: 'failed_before_mutation',
          reconciliation: 'inspection_failed',
        },
      };
    }
    const before = beforeInspection.snapshot;

    let directive = this.truth.prepare({
      before,
      callId: input.context.callId,
      desired,
      operationId: input.context.operationId,
    });
    if (directive.action === 'advance' || directive.action === 'completed') {
      this.resetLoopGuard(input.context.taskId);
      return verifiedCompatibilityResult({
        action: input.action,
        desired,
        directive,
      });
    }
    if (directive.action === 'reconcile') {
      const reconciliation = await this.reconcile(
        directive.operationId,
        before,
        desired,
        input.inspectCart,
        input.action,
      );
      directive = reconciliation.directive;
      if (directive.action !== 'execute') {
        return this.guardedAttemptResult(
          {},
          directive,
          reconciliation.identityEvidence,
        );
      }
    }
    if (directive.action !== 'execute') return guardedResult(directive);

    const first = await this.attempt({
      action: input.action,
      before,
      desired,
      directive,
      execute: input.execute,
      inspectCart: input.inspectCart,
    });
    if (first.directive.action === 'reconcile') {
      const identityEvidence =
        first.identityEvidence ?? { conflicts: [] };
      const reconciledDirective = first.current
        ? this.truth.reconcile({
            before,
            current: first.current,
            ...(identityEvidence.identityResolution === 'ambiguous'
              ? {
                  identityResolution: 'ambiguous' as const,
                  ...(identityEvidence.conflicts.length
                    ? { identityConflicts: identityEvidence.conflicts }
                    : {}),
                }
              : {}),
            desired,
            operationId: first.directive.operationId,
          })
        : first.directive;
      return this.resultForAttempt(
        input.action,
        desired,
        reconciledDirective,
        first.result,
        input.context.taskId,
        identityEvidence,
      );
    }
    return this.resultForAttempt(
      input.action,
      desired,
      first.directive,
      first.result,
      input.context.taskId,
    );
  }

  private async attempt(input: {
    action: CompatibilityCartActionV2;
    before: CartSnapshotV2;
    desired: DesiredCartStateV2;
    directive: Extract<
      CartMutationExecutionDirectiveV2,
      { action: 'execute' }
    >;
    execute: ExecuteActionV2;
    inspectCart: InspectCartV2;
  }): Promise<{
    current?: CartSnapshotV2;
    directive: CartMutationExecutionDirectiveV2;
    identityEvidence?: Pick<
      CompatibilityCartInspectionV2,
      'conflicts' | 'identityResolution'
    >;
    result: Record<string, unknown>;
  }> {
    let result: Record<string, unknown>;
    let sharedInspectionEvidence:
      ReturnType<typeof sharedCartInspectionEvidenceV2>;
    try {
      const rawResult = await input.execute(
        normalizedMutationAction(input.action, input.directive),
      );
      sharedInspectionEvidence = sharedCartInspectionEvidenceV2(rawResult);
      result = record(rawResult);
    } catch {
      result = {
        ok: false,
        status: 'execution_failed',
        verification: {
          mutationAttempted: true,
          outcome: 'ambiguous',
          reconciliation: 'not_run',
        },
      };
    }
    const attempted = mutationAttempted(result);
    if (!attempted) {
      return {
        directive: this.truth.finish({
          before: input.before,
          desired: input.desired,
          operationId: input.directive.operationId,
          result: {
            kind: 'failed_before_mutation',
            reason: 'invalid_precondition',
          },
        }),
        result,
      };
    }
    const retainedInspection =
      this.retainedPostCartSnapshot(result, input.action)
      ?? (sharedInspectionEvidence?.inspection === undefined
        ? undefined
        : this.snapshotFromInspection(
            record(sharedInspectionEvidence.inspection),
            input.action,
          ));
    const currentInspection = retainedInspection
      ?? (sharedInspectionEvidence?.ordinaryPostMutationInspections === 1
        ? undefined
        : await this.inspectSnapshot(input.inspectCart, input.action));
    const identityEvidence = mergedIdentityEvidence(
      identityEvidenceFromResult(result),
      currentInspection ?? { conflicts: [] },
    );
    result = withIdentityEvidence(result, identityEvidence);
    const current = currentInspection?.snapshot;
    const directive = this.truth.finish({
      before: input.before,
      desired: input.desired,
      operationId: input.directive.operationId,
      result: current && identityEvidence.identityResolution === 'ambiguous'
        ? {
            kind: 'identity_ambiguous',
            after: current,
            ...(identityEvidence.conflicts.length
              ? { conflicts: identityEvidence.conflicts }
              : {}),
          }
        : current
          ? { kind: 'observed', after: current }
        : {
            kind: 'mutation_unverified',
            reason: 'fresh_snapshot_unavailable',
          },
    });
    return {
      ...(current ? { current } : {}),
      directive,
      identityEvidence,
      result,
    };
  }

  private async reconcile(
    operationId: LocalIdentifier<'operation'>,
    before: CartSnapshotV2,
    desired: DesiredCartStateV2,
    inspectCart: InspectCartV2,
    action: CompatibilityCartActionV2,
  ): Promise<{
    directive: CartMutationExecutionDirectiveV2;
    identityEvidence: Pick<
      CompatibilityCartInspectionV2,
      'conflicts' | 'identityResolution'
    >;
  }> {
    const current = await this.inspectSnapshot(inspectCart, action);
    const identityEvidence = current ?? { conflicts: [] };
    return {
      directive: this.truth.reconcile({
      before,
      ...(current ? { current: current.snapshot } : {}),
      ...(current?.identityResolution === 'ambiguous'
        ? {
            identityResolution: 'ambiguous' as const,
            ...(current.conflicts.length
              ? { identityConflicts: current.conflicts }
              : {}),
          }
        : {}),
      desired,
      operationId,
      }),
      identityEvidence,
    };
  }

  private resultForAttempt(
    action: CompatibilityCartActionV2,
    desired: DesiredCartStateV2,
    directive: CartMutationExecutionDirectiveV2,
    result: Record<string, unknown>,
    taskId: LocalIdentifier<'task'>,
    additionalIdentityEvidence?: Pick<
      CompatibilityCartInspectionV2,
      'conflicts' | 'identityResolution'
    >,
  ): CompatibilityExecutionResultV2 {
    if (directive.action === 'advance' || directive.action === 'completed') {
      this.resetLoopGuard(taskId);
      return verifiedCompatibilityResult({
        action,
        desired,
        directive,
        original: result,
      });
    }
    return this.guardedAttemptResult(
      result,
      directive,
      additionalIdentityEvidence,
    );
  }

  private guardedAttemptResult(
    result: Record<string, unknown>,
    directive: CartMutationExecutionDirectiveV2,
    additionalIdentityEvidence?: Pick<
      CompatibilityCartInspectionV2,
      'conflicts' | 'identityResolution'
    >,
  ): CompatibilityExecutionResultV2 {
    const guarded = guardedResult(directive);
    const identityEvidence = mergedIdentityEvidence(
      identityEvidenceFromResult(result),
      additionalIdentityEvidence ?? { conflicts: [] },
    );
    return withIdentityEvidence({
      ...result,
      ...guarded,
      verification: {
        ...record(result['verification']),
        ...record(guarded['verification']),
      },
    }, identityEvidence);
  }

  private async inspectSnapshot(
    inspectCart: InspectCartV2,
    action?: CompatibilityCartActionV2,
  ): Promise<CompatibilityCartInspectionV2 | undefined> {
    let inspected: Record<string, unknown>;
    try {
      inspected = record(await inspectCart());
    } catch {
      return undefined;
    }
    return this.snapshotFromInspection(inspected, action);
  }

  private retainedPostCartSnapshot(
    result: Record<string, unknown>,
    action?: CompatibilityCartActionV2,
  ): CompatibilityCartInspectionV2 | undefined {
    const verification = record(result['verification']);
    const retained = record(
      verification['postCart']
      ?? verification['postCartInspection']
      ?? verification['observedCart'],
    );
    return Object.keys(retained).length > 0
      ? this.snapshotFromInspection(retained, action)
      : undefined;
  }

  private snapshotFromInspection(
    inspected: Record<string, unknown>,
    action?: CompatibilityCartActionV2,
  ): CompatibilityCartInspectionV2 | undefined {
    const status = String(inspected['status'] ?? '');
    if (status !== 'cart_empty' && status !== 'cart_status') return undefined;
    const cart = record(inspected['cart']);
    const linesValue = status === 'cart_empty' ? [] : cart['lines'];
    if (!Array.isArray(linesValue)) return undefined;
    const selectedOffer = record(action?.selectedOffer);
    const selectedOfferId =
      action?.action === 'add_cart_item'
      && typeof selectedOffer['offerId'] === 'string'
        ? selectedOffer['offerId'].trim()
        : '';
    const selectedTitle = typeof selectedOffer['title'] === 'string'
      ? selectedOffer['title'].trim()
      : '';
    const selectedPackSize =
      typeof selectedOffer['packSize'] === 'string'
        ? selectedOffer['packSize'].trim()
        : undefined;
    const selectedPrice = typeof selectedOffer['priceAmount'] === 'number'
      ? selectedOffer['priceAmount']
      : undefined;
    const selectedIdentity = selectedOfferId && selectedTitle
      ? reconcileProviderProductIdentity(
          {
            provider: 'blinkit',
            offerId: selectedOfferId,
            ...(selectedPackSize ? { packSize: selectedPackSize } : {}),
            ...(selectedPrice !== undefined
              ? {
                  price: {
                    amount: selectedPrice,
                    currency:
                      typeof selectedOffer['priceCurrency'] === 'string'
                        ? selectedOffer['priceCurrency']
                        : 'INR',
                  },
                }
              : {}),
            title: selectedTitle,
          },
          linesValue.map((value, index) => {
            const line = record(value);
            return {
              index,
              productId: typeof line['productId'] === 'string'
                ? line['productId']
                : undefined,
              packSize:
                typeof line['packSize'] === 'string'
                  ? line['packSize']
                  : typeof line['size'] === 'string'
                    ? line['size']
                    : undefined,
              provider: 'blinkit',
              price: cartLinePriceAmount(line),
              title: typeof line['product'] === 'string'
                ? line['product']
                : '',
            };
          }),
        )
      : undefined;
    const identityConflicts = selectedIdentity?.evidence.flatMap((candidate) =>
      candidate.anchors.length === 0
        ? []
        : candidate.comparisons.flatMap((comparison) => {
        if (
          comparison.outcome !== 'conflict'
          || !['packSize', 'price'].includes(comparison.field)
          || !comparison.expected
          || !comparison.observed
        ) {
          return [];
        }
        const observedLine = record(linesValue[candidate.candidateIndex]);
        const observedPack =
          typeof observedLine['packSize'] === 'string'
            ? observedLine['packSize']
            : typeof observedLine['size'] === 'string'
              ? observedLine['size']
              : comparison.observed;
        const observedPrice = cartLinePriceAmount(observedLine);
        const priceCurrency =
          typeof selectedOffer['priceCurrency'] === 'string'
            ? selectedOffer['priceCurrency']
            : 'INR';
        const formatPrice = (amount: number) =>
          new Intl.NumberFormat('en-IN', {
            currency: priceCurrency,
            maximumFractionDigits: 2,
            style: 'currency',
          }).format(amount);
        return [{
          field: comparison.field === 'packSize'
            ? 'pack_size' as const
            : 'price' as const,
          expected: (
            comparison.field === 'packSize'
              ? selectedPackSize ?? comparison.expected
              : selectedPrice === undefined
                ? comparison.expected
                : formatPrice(selectedPrice)
          ).slice(0, 100),
          observed: (
            comparison.field === 'packSize'
              ? observedPack
              : observedPrice === undefined
                ? comparison.observed
                : formatPrice(observedPrice)
          ).slice(0, 100),
        }];
        })) ?? [];
    const identityResolution =
      selectedIdentity?.status === 'ambiguous'
      || identityConflicts.length > 0
        ? 'ambiguous' as const
        : selectedIdentity?.status;
    const selectedAliasIndex = selectedIdentity?.status === 'unique'
      ? selectedIdentity.match.candidate.index
      : undefined;
    const lines: { offerId: string; quantity: number }[] = [];
    for (const [index, value] of linesValue.entries()) {
      const line = record(value);
      const providerLineId = typeof line['productId'] === 'string'
        ? line['productId'].trim()
        : typeof line['offerId'] === 'string'
          ? line['offerId'].trim()
          : '';
      const offerId = index === selectedAliasIndex
        ? selectedOfferId
        : providerLineId;
      const quantity = finiteQuantity(line['quantity']);
      if (!offerId || quantity === undefined) return undefined;
      lines.push({ offerId, quantity });
    }
    const capturedAt = Math.max(this.now(), this.lastCapturedAt + 1);
    this.lastCapturedAt = capturedAt;
    this.observationSequence += 1;
    return {
      conflicts: identityConflicts.slice(0, 4),
      ...(identityResolution ? { identityResolution } : {}),
      snapshot: {
        version: 2,
        capturedAt,
        observationId:
          `compat-cart:${capturedAt}:${this.observationSequence}`,
        lines,
      },
    };
  }

  private applyLoopGuard(
    action: CompatibilityCartActionV2,
    context: CompatibilityExecutionContextV2,
    result: unknown,
  ): unknown {
    const resultRecord = record(result);
    const detector = this.loopDetectors.get(context.taskId)
      ?? this.newLoopDetector();
    this.loopDetectors.set(context.taskId, detector);
    const decision = detector.observe({
      taskId: context.taskId,
      taskRevision: context.taskRevision ?? 0,
      screen:
        resultRecord['screenEvidence']
        ?? resultRecord['cart']
        ?? { status: resultRecord['status'] },
      action,
      result: {
        ok: resultRecord['ok'],
        status: resultRecord['status'],
      },
    });
    if (decision.decision === 'continue') return result;
    this.stoppedLoopRevision.set(
      context.taskId,
      context.taskRevision ?? 0,
    );
    return this.loopStoppedResult(resultRecord, decision);
  }

  private loopStoppedResult(
    result: Record<string, unknown>,
    decision: Extract<ExecutionLoopDecisionV2, { decision: 'stop' }>,
  ): CompatibilityExecutionResultV2 {
    return {
      ...result,
      ok: false,
      status: 'execution_loop_stopped',
      loop: {
        cycleLength: decision.cycleLength,
        fingerprint: decision.fingerprint,
        reason: decision.reason,
        repetitions: decision.repetitions,
      },
    };
  }

  private resetLoopGuard(taskId: LocalIdentifier<'task'>): void {
    this.loopDetectors.delete(taskId);
    this.stoppedLoopRevision.delete(taskId);
  }
}

const executionSafetyGlobal = globalThis as typeof globalThis & {
  errandosCompatibilityExecutionSafetyV2?: CompatibilityExecutionSafetyV2;
};

executionSafetyGlobal.errandosCompatibilityExecutionSafetyV2 ??=
  new CompatibilityExecutionSafetyV2({
    truth: new CartMutationExecutionTruthServiceV2(
      new OperationIdempotencyRegistryV2({
        ...(process.env.NODE_ENV === 'test'
          ? {}
          : {
              persistence: new FileOperationIdempotencyPersistenceV2(
                join(
                  process.cwd(),
                  '.runtime',
                  'cart-mutation-idempotency-v2.json',
                ),
              ),
            }),
      }),
    ),
  });

export const compatibilityExecutionSafetyV2 =
  executionSafetyGlobal.errandosCompatibilityExecutionSafetyV2;
