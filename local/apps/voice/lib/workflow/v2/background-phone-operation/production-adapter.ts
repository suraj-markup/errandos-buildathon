import {
  executePhoneAction,
  type PhoneActionArguments,
  type PhoneActionExecutionContext,
} from '../../../phone-tool';
import { taskEventStreamV2 } from '../../../progress/v2/task-event-bus';
import type {
  RetainedTaskEventStreamV2,
} from '../../../progress/v2/retained-task-event-stream';
import {
  buildFinalCartSummaryEventV2,
  type FinalCartInspectionV2,
} from '../../../progress/v2/final-cart-summary';
import {
  completionChoicePromptForTaskV2,
} from '../../../progress/v2/completion-interaction-events';
import {
  companionIssueForBackgroundOperationV2,
  type CompanionIssueV2,
} from '../../../progress/v2/companion-issue';
import {
  publishBackgroundPhoneOperationTerminalEventV2,
} from '../../../progress/v2/background-phone-operation-events';
import {
  withAuthoritativeCartPresentationProof,
} from '../../../overlay-presentation-builder';
import type { PresentableToolResult } from '../../../voice-presentation';
import {
  recordUxTimingIntervalSafelyV1,
  uxTimingMetricsV1,
  type DeterministicUxTimingMetricsCollectorV1,
} from '../../../ux-timing-metrics';
import {
  buildVerifiedItemCompletionEventsV2,
} from '../../../progress/v2/item-milestones';
import type { CartTermConflictEvidenceV2 } from '../../../execution/v2/contracts';
import type { LocalIdentifier } from '../../identifiers';
import {
  completeV2CompatibilityExecution,
  markV2CompatibilityMutationAttempted,
} from '../execution-bridge';
import {
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from '../repository';
import {
  DurableNextStepDispatcherV2,
  type NextStepDispatchResultV2,
} from '../next-step-dispatcher';
import { phoneTaskRepositoryV2 } from '../runtime-repository';
import { transitionPhoneTaskV2 } from '../graph';
import { settleReadyNextActionV2 } from '../next-action-lifecycle';
import {
  parseRecoveryHandoffResponsesV2,
  persistRecoveryHandoffV2,
} from '../recovery-handoff';
import {
  commitSearchProductChoicePolicyV2,
} from '../product-choice-policy-runtime';
import { acceptBackgroundPhoneOperationV2 } from './coordinator-hook';
import type {
  BackgroundPhoneOperationRecordV2,
  BackgroundPhoneOperationWorkerResultV2,
  BackgroundPhoneOperationWorkerV2,
} from './contracts';
import { BackgroundPhoneOperationManagerV2 } from './manager';
import { backgroundPhoneOperationStoreV2 } from './runtime-store';
import type { BackgroundPhoneOperationStoreV2 } from './store';

type DurablePhoneActionV1 = PhoneActionArguments & {
  action:
    | 'phone_status'
    | 'open_blinkit'
    | 'inspect_cart'
    | 'search_products'
    | 'add_cart_item'
    | 'set_cart_item_quantity'
    | 'remove_cart_item'
    | 'prepare_checkout';
};

type DurablePhoneOperationPayloadV1 = {
  version: 1;
  action: DurablePhoneActionV1;
};

type ProductionEnqueueInputV2 = {
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  taskRevision: number;
  stepId: string;
  requestPayload: unknown;
};

type ProductionAdapterDependenciesV2 = {
  executePhone?: typeof executePhoneAction;
  metrics?: DeterministicUxTimingMetricsCollectorV1;
  now?: () => number;
  repository?: PhoneTaskRepositoryV2;
  store?: BackgroundPhoneOperationStoreV2;
  stream?: RetainedTaskEventStreamV2;
};

const mutatingActions = new Set<DurablePhoneActionV1['action']>([
  'add_cart_item',
  'set_cart_item_quantity',
  'remove_cart_item',
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function quantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 99) {
    throw new Error('action.quantity must be an integer between 1 and 99.');
  }
  return value as number;
}

function selectedOffer(value: unknown): NonNullable<
  PhoneActionArguments['selectedOffer']
> {
  const input = record(value, 'action.selectedOffer');
  exactKeys(
    input,
    ['offerId', 'packSize', 'priceAmount', 'priceCurrency', 'title'],
    'action.selectedOffer',
  );
  const priceAmount = input['priceAmount'];
  if (
    typeof priceAmount !== 'number'
    || !Number.isFinite(priceAmount)
    || priceAmount < 0
    || priceAmount > 1_000_000
  ) {
    throw new Error('action.selectedOffer.priceAmount is invalid.');
  }
  if (input['priceCurrency'] !== 'INR') {
    throw new Error('action.selectedOffer.priceCurrency must be INR.');
  }
  const packSize = boundedText(
    input['packSize'],
    'action.selectedOffer.packSize',
    80,
    true,
  );
  return {
    offerId: boundedText(
      input['offerId'],
      'action.selectedOffer.offerId',
      160,
    ) as string,
    title: boundedText(
      input['title'],
      'action.selectedOffer.title',
      160,
    ) as string,
    priceAmount,
    priceCurrency: 'INR',
    ...(packSize === undefined ? {} : { packSize }),
  };
}

function optionalTextField(
  input: Record<string, unknown>,
  field: string,
  maximum = 240,
): string | undefined {
  return boundedText(input[field], `action.${field}`, maximum, true);
}

function parseDurablePhoneOperationPayloadV1(
  value: unknown,
): DurablePhoneOperationPayloadV1 {
  const payload = record(value, 'requestPayload');
  exactKeys(payload, ['version', 'action'], 'requestPayload');
  if (payload['version'] !== 1) {
    throw new Error('requestPayload.version must be 1.');
  }
  const input = record(payload['action'], 'requestPayload.action');
  const action = input['action'];
  if (typeof action !== 'string') {
    throw new Error('requestPayload.action.action is required.');
  }
  switch (action) {
    case 'phone_status':
    case 'open_blinkit':
    case 'inspect_cart':
    case 'prepare_checkout':
      exactKeys(input, ['action'], 'requestPayload.action');
      return { version: 1, action: { action } };
    case 'search_products': {
      exactKeys(input, ['action', 'request'], 'requestPayload.action');
      return {
        version: 1,
        action: {
          action,
          request: boundedText(
            input['request'],
            'action.request',
            240,
          ) as string,
        },
      };
    }
    case 'add_cart_item': {
      exactKeys(
        input,
        [
          'action',
          'offerId',
          'quantity',
          'reconcileOnly',
          'request',
          'searchQuery',
          'selectedOffer',
        ],
        'requestPayload.action',
      );
      const offerId = boundedText(input['offerId'], 'action.offerId', 160);
      const offer = selectedOffer(input['selectedOffer']);
      if (offer.offerId !== offerId) {
        throw new Error('Selected offer identity does not match offerId.');
      }
      if (
        input['reconcileOnly'] !== undefined
        && typeof input['reconcileOnly'] !== 'boolean'
      ) {
        throw new Error('action.reconcileOnly must be boolean.');
      }
      const request = optionalTextField(input, 'request');
      const searchQuery = optionalTextField(input, 'searchQuery');
      return {
        version: 1,
        action: {
          action,
          offerId,
          selectedOffer: offer,
          quantity: quantity(input['quantity']),
          ...(input['reconcileOnly'] === true ? { reconcileOnly: true } : {}),
          ...(request === undefined ? {} : { request }),
          ...(searchQuery === undefined ? {} : { searchQuery }),
        },
      };
    }
    case 'set_cart_item_quantity':
      exactKeys(
        input,
        ['action', 'productId', 'quantity'],
        'requestPayload.action',
      );
      return {
        version: 1,
        action: {
          action,
          productId: boundedText(
            input['productId'],
            'action.productId',
            160,
          ) as string,
          quantity: quantity(input['quantity']),
        },
      };
    case 'remove_cart_item':
      exactKeys(
        input,
        ['action', 'productId'],
        'requestPayload.action',
      );
      return {
        version: 1,
        action: {
          action,
          productId: boundedText(
            input['productId'],
            'action.productId',
            160,
          ) as string,
        },
      };
    default:
      throw new Error('The background phone action is not allowlisted.');
  }
}

function outcomeFromAuthoritativeRecord(
  recordValue: TaskRepositoryRecordV2 | undefined,
  operation: BackgroundPhoneOperationRecordV2,
): BackgroundPhoneOperationWorkerResultV2 | undefined {
  const step = recordValue?.task.steps.find(
    (candidate) => candidate.stepId === operation.stepId,
  );
  if (!step || step.operationId !== operation.operationId) return undefined;
  const resultRef = step.lastResultRef;
  if (step.status === 'verified' || step.status === 'waiting_for_user') {
    return {
      outcome: 'completed',
      detail: step.status === 'waiting_for_user'
        ? 'Phone work completed and is waiting for a user choice.'
        : 'Authoritative task state verified the phone operation.',
      ...(resultRef ? { resultRef } : {}),
    };
  }
  if (step.status === 'failed' || step.status === 'blocked') {
    return {
      outcome: 'failed',
      detail: 'Authoritative task state recorded a safe failure.',
      ...(resultRef ? { resultRef } : {}),
    };
  }
  if (step.status === 'ambiguous') {
    return {
      outcome: 'ambiguous',
      detail: 'Authoritative task state requires read-only reconciliation.',
      ...(resultRef ? { resultRef } : {}),
    };
  }
  return undefined;
}

function operationIsCurrent(
  recordValue: TaskRepositoryRecordV2 | undefined,
  operation: BackgroundPhoneOperationRecordV2,
  expectedBoundary: 'before_mutation' | 'mutation_attempted',
): recordValue is TaskRepositoryRecordV2 {
  if (!recordValue || recordValue.task.revision < operation.taskRevision) {
    return false;
  }
  const step = recordValue.task.steps.find(
    (candidate) => candidate.stepId === operation.stepId,
  );
  return Boolean(
    step
    && step.status === 'running'
    && step.operationId === operation.operationId
    && step.kind === operation.operationKind
    && recordValue.activeOperation?.operationId === operation.operationId
    && recordValue.activeOperation.stepId === operation.stepId
    && recordValue.activeOperation.kind === operation.operationKind
    && recordValue.activeOperation.status === 'running'
    && recordValue.activeOperation.boundary === expectedBoundary
  );
}

const ambiguousExecutionResult = {
  status: 'reconciliation_required',
  verification: {
    mutationAttempted: true,
    outcome: 'ambiguous',
  },
};

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function retainedCartTermConflicts(
  value: unknown,
): CartTermConflictEvidenceV2[] {
  const verification = resultRecord(resultRecord(value)['verification']);
  const identity = resultRecord(verification['identity']);
  const candidates =
    verification['conflicts']
    ?? verification['conflictEvidence']
    ?? identity['conflicts'];
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((entry) => {
    const conflict = resultRecord(entry);
    const field = conflict['field'];
    const expected = conflict['expected'];
    const observed = conflict['observed'];
    if (
      !['pack_size', 'price'].includes(String(field ?? ''))
      || typeof expected !== 'string'
      || typeof observed !== 'string'
      || !expected.trim()
      || !observed.trim()
    ) {
      return [];
    }
    return [{
      field: field as CartTermConflictEvidenceV2['field'],
      expected: expected.trim().slice(0, 100),
      observed: observed.trim().slice(0, 100),
    }];
  }).slice(0, 4);
}

function directlyVerifiedResult(
  action: DurablePhoneActionV1['action'],
  result: unknown,
): boolean {
  const value = resultRecord(result);
  if (value['ok'] === false) return false;
  const status = String(value['status'] ?? '');
  if (
    [
      'automation_failed',
      'checkout_changed',
      'checkout_expired',
      'device_locked',
      'execution_failed',
      'execution_loop_stopped',
      'mutation_outcome_ambiguous',
      'reconciliation_required',
    ].includes(status)
  ) {
    return false;
  }
  if (action === 'set_cart_item_quantity') {
    return status === 'quantity_updated';
  }
  if (action === 'remove_cart_item') return status === 'removed';
  if (action === 'inspect_cart') {
    return status === 'cart_empty' || status === 'cart_status';
  }
  return [
    'phone_status',
    'open_blinkit',
    'prepare_checkout',
  ].includes(action);
}

async function commitDirectVerification(input: {
  now: () => number;
  operation: BackgroundPhoneOperationRecordV2;
  repository: PhoneTaskRepositoryV2;
  taskRecord: TaskRepositoryRecordV2;
  result: unknown;
}): Promise<TaskRepositoryRecordV2> {
  const status = String(resultRecord(input.result)['status'] ?? 'ok')
    .replaceAll(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80) || 'ok';
  const at = Math.max(input.now(), input.taskRecord.task.updatedAt);
  const next = transitionPhoneTaskV2(input.taskRecord.task, {
    type: 'verify_step',
    stepId: input.operation.stepId,
    resultRef: `result:${input.operation.operationId}:${status}`,
    entryId: `execution-verified:${input.operation.operationId}`,
    at,
  });
  const verified = await input.repository.commit({
    expectedRevision: input.taskRecord.task.revision,
    task: next,
    event: {
      eventId:
        `execution-verified:${input.operation.operationId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'execution_verified',
      dataRef: `result:${input.operation.operationId}:${status}`,
    },
  });
  if (input.operation.operationKind !== 'inspect_cart') return verified;
  const value = resultRecord(input.result);
  const cart = resultRecord(value['cart']);
  const lines = Array.isArray(cart['lines'])
    ? cart['lines']
    : Array.isArray(value['lines'])
      ? value['lines']
      : [];
  const checkoutAvailable =
    value['status'] !== 'cart_empty' && lines.length > 0;
  const interactionAt = Math.max(input.now(), verified.task.updatedAt);
  const interactionId = `interaction_${crypto.randomUUID()}`;
  const waiting = settleReadyNextActionV2({
    at: interactionAt,
    checkoutAvailable,
    expiresAt: interactionAt + 15 * 60_000,
    interactionId,
    journalEntryId:
      `final-cart-next-action:${input.operation.operationId}`,
    presentationRef:
      `presentation:final-cart:${input.operation.operationId}`,
    task: verified.task,
  });
  if (waiting === verified.task) return verified;
  return input.repository.commit({
    expectedRevision: verified.task.revision,
    task: waiting,
    event: {
      eventId: `final-cart-next-action:${input.operation.operationId}`,
      taskId: waiting.taskId,
      taskRevision: waiting.revision,
      at: interactionAt,
      kind: 'waiting_for_next_action',
      dataRef: interactionId,
    },
  });
}

async function commitAmbiguousAfterConflict(
  repository: PhoneTaskRepositoryV2,
  operation: BackgroundPhoneOperationRecordV2,
): Promise<BackgroundPhoneOperationWorkerResultV2> {
  const latest = await repository.getById(operation.taskId);
  const terminal = outcomeFromAuthoritativeRecord(latest, operation);
  if (terminal) return terminal;
  const step = latest?.task.steps.find(
    (candidate) => candidate.stepId === operation.stepId,
  );
  if (
    !latest
    || latest.task.status === 'cancelled'
    || step?.status !== 'running'
    || step.operationId !== operation.operationId
  ) {
    return {
      outcome: 'ambiguous',
      detail: 'Task revision changed after phone execution; reconcile safely.',
    };
  }
  try {
    const committed = await completeV2CompatibilityExecution({
      operationId: operation.operationId,
      repository,
      result: ambiguousExecutionResult,
      stepId: operation.stepId,
      task: latest.task,
    });
    return outcomeFromAuthoritativeRecord(committed, operation) ?? {
      outcome: 'ambiguous',
      detail: 'Task revision conflict requires read-only reconciliation.',
    };
  } catch {
    return {
      outcome: 'ambiguous',
      detail: 'Task revision conflict requires read-only reconciliation.',
    };
  }
}

function createProductionWorker(
  dependencies: {
    executePhone: typeof executePhoneAction;
    metrics?: DeterministicUxTimingMetricsCollectorV1;
    now?: () => number;
    repository: PhoneTaskRepositoryV2;
    stream: RetainedTaskEventStreamV2;
  },
): BackgroundPhoneOperationWorkerV2 {
  return async (
    operation,
    control,
  ): Promise<BackgroundPhoneOperationWorkerResultV2> => {
    let payload: DurablePhoneOperationPayloadV1;
    try {
      payload = parseDurablePhoneOperationPayloadV1(
        operation.requestPayload,
      );
    } catch {
      return {
        outcome: 'failed',
        detail: 'Durable phone request failed schema validation.',
      };
    }
    if (payload.action.action !== operation.operationKind) {
      return {
        outcome: 'failed',
        detail: 'Durable phone action identity does not match the operation.',
      };
    }
    const before = await dependencies.repository.getById(operation.taskId);
    const alreadyTerminal = outcomeFromAuthoritativeRecord(before, operation);
    if (alreadyTerminal) return alreadyTerminal;
    const mutating = mutatingActions.has(payload.action.action);
    if (
      mutating
      && before?.activeOperation?.operationId === operation.operationId
      && before.activeOperation.boundary === 'mutation_attempted'
    ) {
      return {
        outcome: 'ambiguous',
        detail:
          'Durable mutation boundary was already crossed; read-only reconciliation is required.',
      };
    }
    if (!operationIsCurrent(before, operation, 'before_mutation')) {
      return {
        outcome: 'failed',
        detail: 'Authoritative task revision no longer authorizes execution.',
      };
    }

    const executionContext: PhoneActionExecutionContext = {
      callId: `background:${operation.operationId}`,
      operationId: operation.operationId,
      protocolVersion: 2,
      ...(operation.itemId
        ? {
            itemId: operation.itemId,
          }
        : operation.stepId.startsWith('task_item_')
          ? {
              itemId: operation.stepId as LocalIdentifier<'task_item'>,
            }
        : {}),
      stepId: operation.stepId,
      stepKey: operation.stepId,
      taskId: operation.taskId,
      taskRevision: operation.taskRevision,
    };
    let providerMutationStarted = false;
    if (mutating) {
      executionContext.markMutationAttempted = async (): Promise<void> => {
        if (providerMutationStarted) return;
        const marked = await markV2CompatibilityMutationAttempted({
          operationId: operation.operationId,
          repository: dependencies.repository,
          stepId: operation.stepId,
          taskId: operation.taskId,
        });
        executionContext.taskRevision = marked.task.revision;
        await control.markMutationAttempted();
        providerMutationStarted = true;
      };
    }
    let phoneResult: unknown;
    try {
      phoneResult = await dependencies.executePhone(
        payload.action,
        executionContext,
      );
    } catch {
      phoneResult = providerMutationStarted
        ? ambiguousExecutionResult
        : {
            status: 'execution_failed',
            verification: {
              mutationAttempted: false,
              outcome: 'failed_before_mutation',
            },
          };
    }

    const latest = await dependencies.repository.getById(operation.taskId);
    const terminal = outcomeFromAuthoritativeRecord(latest, operation);
    if (terminal) return terminal;
    const verification = resultRecord(resultRecord(phoneResult)['verification']);
    const mutationWasAttempted =
      providerMutationStarted || verification['mutationAttempted'] === true;
    if (!operationIsCurrent(
      latest,
      operation,
      mutationWasAttempted ? 'mutation_attempted' : 'before_mutation',
    )) {
      return commitAmbiguousAfterConflict(
        dependencies.repository,
        operation,
      );
    }
    try {
      const directlyVerified = directlyVerifiedResult(
        payload.action.action,
        phoneResult,
      );
      const policyCompletion = payload.action.action === 'search_products'
        ? await commitSearchProductChoicePolicyV2({
            operationId: operation.operationId,
            repository: dependencies.repository,
            result: phoneResult,
            stepId: operation.stepId,
            task: latest.task,
          })
        : undefined;
      const committed = policyCompletion?.record ?? (directlyVerified
        ? await commitDirectVerification({
            now: dependencies.now ?? Date.now,
            operation,
            repository: dependencies.repository,
            taskRecord: latest,
            result: phoneResult,
          })
        : await completeV2CompatibilityExecution({
            operationId: operation.operationId,
            repository: dependencies.repository,
            result: phoneResult,
            stepId: operation.stepId,
            task: latest.task,
          }));
      if (
        committed.task.status === 'completed'
        && committed.task.terminalAt !== undefined
      ) {
        recordUxTimingIntervalSafelyV1(
          dependencies.metrics ?? uxTimingMetricsV1,
          {
            endedAt: committed.task.terminalAt,
            operationId: operation.operationId,
            outcome: 'completed',
            phase: 'task_completion',
            startedAt: committed.task.createdAt,
            taskId: operation.taskId,
          },
        );
      }
      try {
        if (payload.action.action === 'inspect_cart' && directlyVerified) {
          const persistedInteraction = completionChoicePromptForTaskV2({
            task: committed.task,
          });
          const proofAttestedInspection =
            withAuthoritativeCartPresentationProof(
              phoneResult as PresentableToolResult,
            );
          dependencies.stream.publish(buildFinalCartSummaryEventV2({
            inspection:
              proofAttestedInspection as FinalCartInspectionV2,
            ...(persistedInteraction ? { persistedInteraction } : {}),
            operationId: operation.operationId,
            stepId: operation.stepId,
            taskId: operation.taskId,
            taskRevision: committed.task.revision,
          }));
        } else if (payload.action.action === 'add_cart_item') {
          const selectedOffer = resultRecord(payload.action.selectedOffer);
          const conflicts = retainedCartTermConflicts(phoneResult);
          const priceAmount = selectedOffer['priceAmount'];
          const productSteps = committed.task.steps.filter((step) =>
            ['add_cart_item', 'search_products'].includes(step.kind));
          const completedIndex = productSteps.findIndex((step) =>
            step.stepId === operation.stepId);
          const next = committed.task.steps.find((step) =>
            step.status === 'ready');
          const nextInput = resultRecord(next?.input);
          const nextLabel = typeof nextInput['request'] === 'string'
            ? nextInput['request']
            : undefined;
          const committedStep = committed.task.steps.find((step) =>
            step.stepId === operation.stepId);
          if (conflicts.length > 0) {
            const observedPack = conflicts.find(
              (conflict) => conflict.field === 'pack_size',
            )?.observed;
            const observedPrice = conflicts.find(
              (conflict) => conflict.field === 'price',
            )?.observed;
            dependencies.stream.publish({
              announcement: {
                channel: 'speech_and_visual',
                text:
                  'I found conflicting pack or price details. Please review the cart.',
              },
              dedupeKey: `${operation.operationId}:identity-conflict`,
              detail:
                'Expected and observed product terms conflict; no retry is allowed.',
              item: {
                title: String(
                  selectedOffer['title']
                    ?? payload.action.request
                    ?? 'Item',
                ),
                requestedLabel:
                  payload.action.searchQuery
                  ?? payload.action.request
                  ?? String(selectedOffer['title'] ?? 'Item'),
                ...(observedPack
                  ? { packSize: observedPack }
                  : typeof selectedOffer['packSize'] === 'string'
                    ? { packSize: selectedOffer['packSize'] }
                    : {}),
                quantity: payload.action.quantity,
                ...(observedPrice ? { price: observedPrice } : {}),
                conflicts,
                index: Math.max(completedIndex + 1, 1),
                total: Math.max(productSteps.length, 1),
              },
              kind: 'ambiguous',
              operationId: operation.operationId,
              progress: {
                completed: Math.max(completedIndex, 0),
                total: Math.max(productSteps.length, 1),
                ...(nextLabel ? { nextLabel } : {}),
              },
              stepId: operation.stepId,
              taskId: operation.taskId,
              taskRevision: committed.task.revision,
              title: 'Cart terms need review',
            } as Parameters<RetainedTaskEventStreamV2['publish']>[0] & {
              item: {
                conflicts: CartTermConflictEvidenceV2[];
              };
            });
          } else if (committedStep?.status === 'verified') {
            const milestones = buildVerifiedItemCompletionEventsV2({
            itemLabel: String(
              selectedOffer['title']
                ?? payload.action.request
                ?? 'Item',
            ),
            itemPosition: completedIndex < 0
              ? undefined
              : {
                  current: completedIndex + 1,
                  total: productSteps.length,
                },
            item: {
              requestedLabel:
                payload.action.searchQuery
                ?? payload.action.request
                ?? String(selectedOffer['title'] ?? 'Item'),
              ...(typeof selectedOffer['packSize'] === 'string'
                ? { packSize: selectedOffer['packSize'] }
                : {}),
              quantity: payload.action.quantity,
              ...(typeof priceAmount === 'number'
                && Number.isFinite(priceAmount)
                ? {
                    price: new Intl.NumberFormat('en-IN', {
                      currency: 'INR',
                      maximumFractionDigits: 2,
                      style: 'currency',
                    }).format(priceAmount),
                  }
                : {}),
            },
            operationId: operation.operationId,
            stepId: operation.stepId,
            taskId: operation.taskId,
            taskRevision: committed.task.revision,
            ...(next?.kind === 'inspect_cart'
              ? { next: { kind: 'review_cart' as const } }
              : nextLabel
                ? {
                    next: {
                      kind: 'search' as const,
                      label: nextLabel,
                      stepId: next?.stepId,
                    },
                  }
                : {}),
            });
            for (const milestone of milestones) {
              dependencies.stream.publish(milestone);
            }
          }
        }
      } catch {
        // Semantic presentation must never alter authoritative execution truth.
      }
      if (policyCompletion?.selected) {
        const resultRef = committed.task.steps.find((candidate) =>
          candidate.stepId === operation.stepId)?.lastResultRef;
        return {
          outcome: 'completed',
          detail:
            'Product choice policy persisted an exact offer for continuation.',
          ...(resultRef ? { resultRef } : {}),
        };
      }
      return outcomeFromAuthoritativeRecord(committed, operation) ?? {
        outcome: 'ambiguous',
        detail: 'Authoritative terminal state could not be classified.',
      };
    } catch (error) {
      if (!(error instanceof TaskRevisionConflictV2Error)) throw error;
      return commitAmbiguousAfterConflict(
        dependencies.repository,
        operation,
      );
    }
  };
}

const runtimeGlobal = globalThis as typeof globalThis & {
  errandosBackgroundPhoneOperationManagerV2?:
    BackgroundPhoneOperationManagerV2;
};

async function persistAndPublishRecoveryHandoffV2(input: {
  issue: CompanionIssueV2;
  operation: BackgroundPhoneOperationRecordV2;
  repository: PhoneTaskRepositoryV2;
  stream: RetainedTaskEventStreamV2;
}): Promise<void> {
  const committed = await persistRecoveryHandoffV2({
    issue: input.issue,
    operation: input.operation,
    repository: input.repository,
  });
  const pending = committed?.task.pendingInteraction;
  if (!pending || pending.kind !== 'recovery_handoff') return;
  const responses = parseRecoveryHandoffResponsesV2(
    pending.allowedResponses,
  );
  if (
    responses.operationId !== input.operation.operationId
    || responses.stepId !== input.operation.stepId
  ) {
    return;
  }
  publishBackgroundPhoneOperationTerminalEventV2({
    operation: {
      ...input.operation,
      taskRevision: committed.task.revision,
    },
    recoveryInteraction: {
      version: 2,
      interactionId: pending.interactionId,
      operationId: input.operation.operationId,
      stepId: input.operation.stepId,
      taskId: input.operation.taskId,
      taskRevision: committed.task.revision,
      expiresAt: pending.expiresAt,
    },
    stream: input.stream,
  });
}

function productionManager(): BackgroundPhoneOperationManagerV2 {
  runtimeGlobal.errandosBackgroundPhoneOperationManagerV2 ??=
    new BackgroundPhoneOperationManagerV2({
      store: backgroundPhoneOperationStoreV2(),
      stream: taskEventStreamV2,
      worker: createProductionWorker({
        executePhone: executePhoneAction,
        metrics: uxTimingMetricsV1,
        now: Date.now,
        repository: phoneTaskRepositoryV2(),
        stream: taskEventStreamV2,
      }),
      onTerminal: async (operation): Promise<void> => {
        const issue = (
          operation.status === 'completed'
          || operation.status === 'failed'
          || operation.status === 'ambiguous'
        )
          ? companionIssueForBackgroundOperationV2({
              operationKind: operation.operationKind,
              status: operation.status === 'failed'
                ? 'failed'
                : operation.status === 'ambiguous'
                  ? 'ambiguous'
                  : 'completed',
            })
          : undefined;
        if (issue) {
          await persistAndPublishRecoveryHandoffV2({
            issue,
            operation,
            repository: phoneTaskRepositoryV2(),
            stream: taskEventStreamV2,
          });
        }
        await dispatchProductionContinuationV2(operation.taskId);
      },
    });
  return runtimeGlobal.errandosBackgroundPhoneOperationManagerV2;
}

export async function dispatchProductionContinuationV2(
  taskId: string,
): Promise<NextStepDispatchResultV2> {
  return new DurableNextStepDispatcherV2({
    repository: phoneTaskRepositoryV2(),
    enqueue: async (input): Promise<void> => {
      await enqueueProductionBackgroundPhoneOperationV2(input);
    },
  }).dispatch(taskId);
}

function managerFor(
  dependencies: ProductionAdapterDependenciesV2,
): BackgroundPhoneOperationManagerV2 {
  if (
    !dependencies.executePhone
    && !dependencies.repository
    && !dependencies.store
    && !dependencies.stream
  ) {
    return productionManager();
  }
  if (
    !dependencies.executePhone
    || !dependencies.repository
    || !dependencies.store
    || !dependencies.stream
  ) {
    throw new Error('Injected production adapter dependencies must be complete.');
  }
  return new BackgroundPhoneOperationManagerV2({
    ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    store: dependencies.store,
    stream: dependencies.stream,
    worker: createProductionWorker({
      executePhone: dependencies.executePhone,
      ...(dependencies.metrics ? { metrics: dependencies.metrics } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      repository: dependencies.repository,
      stream: dependencies.stream,
    }),
    onTerminal: async (operation): Promise<void> => {
      const issue = (
        operation.status === 'completed'
        || operation.status === 'failed'
        || operation.status === 'ambiguous'
      )
        ? companionIssueForBackgroundOperationV2({
            operationKind: operation.operationKind,
            status: operation.status === 'failed'
              ? 'failed'
              : operation.status === 'ambiguous'
                ? 'ambiguous'
                : 'completed',
          })
        : undefined;
      if (issue) {
        await persistAndPublishRecoveryHandoffV2({
          issue,
          operation,
          repository: dependencies.repository!,
          stream: dependencies.stream!,
        });
      }
      await new DurableNextStepDispatcherV2({
        repository: dependencies.repository!,
        enqueue: async (input): Promise<void> => {
          await enqueueProductionBackgroundPhoneOperationV2(
            input,
            dependencies,
          );
        },
      }).dispatch(operation.taskId);
    },
  });
}

export async function enqueueProductionBackgroundPhoneOperationV2(
  input: ProductionEnqueueInputV2,
  dependencies: ProductionAdapterDependenciesV2 = {},
): Promise<Awaited<ReturnType<typeof acceptBackgroundPhoneOperationV2>>> {
  const payload = parseDurablePhoneOperationPayloadV1(input.requestPayload);
  return acceptBackgroundPhoneOperationV2(
    managerFor(dependencies),
    {
      taskId: input.taskId,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      taskRevision: input.taskRevision,
      stepId: input.stepId,
      operationKind: payload.action.action,
      requestPayload: payload,
    },
    input.operationId,
  );
}
