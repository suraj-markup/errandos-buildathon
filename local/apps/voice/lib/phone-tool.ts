import {
  openBlinkit,
  readPhoneStatus,
} from './appium';
import {
  blinkitExecutionService,
  type BlinkitExecutionService,
} from './blinkit-execution';
import {
  PhoneOperationCancelledError,
  cancelCurrentPhoneTask,
  enqueuePhoneOperation,
  enqueueRegisteredPhoneOperation,
  localOperationRegistry,
  type PhoneOperationExecutionControl,
} from './operation-queue';
import {
  isTerminalOperationStatus,
  type LocalPhoneOperationKind,
  type LocalPhoneOperationV1,
} from './operations/registry';
import type { SelectedProductOffer } from './product-workflow';
import type { CodCheckoutProposalV1 } from './cod';
import {
  errorDetails,
  logEvent,
  traceFunction,
  updateLogContext,
} from './structured-logger';
import { publishOverlayStatus } from './overlay';
import {
  newLocalIdentifier,
  type LocalIdentifier,
} from './workflow/identifiers';
import type { OverlayTaskProgressStageV1 } from '@errandos/contracts';
import {
  compatibilityExecutionSafetyV2,
  type CompatibilityExecutionSafetyV2,
} from './workflow/v2/compatibility-execution-safety';

export type PhoneActionArguments = {
  action?:
    | 'phone_status'
    | 'open_blinkit'
    | 'inspect_cart'
    | 'search_products'
    | 'add_cart_item'
    | 'set_cart_item_quantity'
    | 'remove_cart_item'
    | 'prepare_checkout'
    | 'confirm_checkout'
    | 'cancel_current_task';
  checkoutProposal?: CodCheckoutProposalV1;
  offerId?: string;
  productId?: string;
  quantity?: number;
  reconcileOnly?: boolean;
  request?: string;
  searchQuery?: string;
  selectedOffer?: SelectedProductOffer;
  taskId?: string;
};

export type PhoneActionExecutionContext = {
  callId?: string;
  operationId?: LocalIdentifier<'operation'> | string;
  taskId?: LocalIdentifier<'task'> | string;
  itemId?: LocalIdentifier<'task_item'> | string;
  itemPosition?: {
    current: number;
    total?: number;
  };
  protocolVersion?: 1 | 2;
  stepKey?: string;
  stepId?: string;
  taskRevision?: number;
  queueTimeoutMs?: number;
  deviceTimeoutMs?: number;
  isCurrent?: (operation: LocalPhoneOperationV1) => boolean;
  markMutationAttempted?: () => Promise<void>;
  overlayStatusPublisher?: typeof publishOverlayStatus | null;
};

export type ReversibleBlinkitExecutionPort = Pick<
  BlinkitExecutionService,
  | 'addCartItem'
  | 'confirmCheckout'
  | 'inspectCart'
  | 'prepareCheckout'
  | 'removeCartItem'
  | 'searchProducts'
  | 'setCartItemQuantity'
> & Partial<Pick<
  BlinkitExecutionService,
  'inspectCartForMutationBaseline'
>>;

const overlayStatusTimeoutMs = 1_500;

function overlayStatusDispatcher(
  publisher: typeof publishOverlayStatus | undefined,
): (
  message: string,
  state: Parameters<typeof publishOverlayStatus>[1],
) => void {
  let publicationTail = Promise.resolve();
  return (message, state) => {
    if (!publisher) return;
    publicationTail = publicationTail.then(async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const publication = Promise.resolve()
        .then(() => publisher(message, state))
        .then(
          (published) => ({
            kind: published ? 'published' : 'unavailable',
          } as const),
          (error: unknown) => ({ kind: 'failed', error } as const),
        );
      const timeout = new Promise<{ kind: 'timed_out' }>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve({ kind: 'timed_out' }),
          overlayStatusTimeoutMs,
        );
        timeoutHandle.unref?.();
      });
      const outcome = await Promise.race([publication, timeout]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (outcome.kind === 'published') return;
      logEvent('warn', `phone.overlay_status.${outcome.kind}`, {
        state,
        ...(outcome.kind === 'failed'
          ? errorDetails(outcome.error)
          : outcome.kind === 'timed_out'
            ? { timeoutMs: overlayStatusTimeoutMs }
            : {}),
      });
    }).catch((error: unknown) => {
      logEvent('warn', 'phone.overlay_status.dispatch_failed', {
        state,
        ...errorDetails(error),
      });
    });
  };
}

async function executePhoneActionUnlocked(
  arguments_: PhoneActionArguments,
  reversibleExecution: ReversibleBlinkitExecutionPort,
  control?: PhoneOperationExecutionControl,
) {
  switch (arguments_.action) {
    case 'phone_status':
      return { ok: true, result: await readPhoneStatus() };
    case 'open_blinkit':
      return { ok: true, result: await openBlinkit() };
    case 'inspect_cart':
      return reversibleExecution.inspectCart(control);
    case 'search_products':
      return reversibleExecution.searchProducts(arguments_.request ?? '', control);
    case 'add_cart_item':
      return reversibleExecution.addCartItem({
        ...(arguments_.offerId ? { offerId: arguments_.offerId } : {}),
        quantity: arguments_.quantity ?? Number.NaN,
        ...(arguments_.reconcileOnly ? { reconcileOnly: true } : {}),
        request: arguments_.request ?? '',
        ...(arguments_.searchQuery ? { searchQuery: arguments_.searchQuery } : {}),
        ...(arguments_.selectedOffer ? { selectedOffer: arguments_.selectedOffer } : {}),
      }, control);
    case 'set_cart_item_quantity':
      return reversibleExecution.setCartItemQuantity(
        arguments_.productId ?? '',
        arguments_.quantity ?? Number.NaN,
        control,
      );
    case 'remove_cart_item':
      return reversibleExecution.removeCartItem(
        arguments_.productId ?? '',
        control,
      );
    case 'prepare_checkout':
      return reversibleExecution.prepareCheckout(control);
    case 'confirm_checkout':
      return reversibleExecution.confirmCheckout(
        arguments_.checkoutProposal,
        control,
      );
    default:
      return {
        ok: false,
        status: 'unsupported_action',
        message: 'The requested phone action is not supported.',
      };
  }
}

function operationKindFor(
  action: PhoneActionArguments['action'],
): LocalPhoneOperationKind | undefined {
  switch (action) {
    case 'search_products':
      return 'search_products';
    case 'inspect_cart':
      return 'inspect_cart';
    case 'add_cart_item':
      return 'add_cart_item';
    case 'set_cart_item_quantity':
      return 'set_cart_item_quantity';
    case 'remove_cart_item':
      return 'remove_cart_item';
    case 'prepare_checkout':
      return 'prepare_checkout';
    case 'confirm_checkout':
      return 'confirm_order';
    default:
      return undefined;
  }
}

function operationSummary(operationId: LocalIdentifier<'operation'>) {
  const operation = localOperationRegistry.require(operationId);
  return {
    operationId: operation.operationId,
    taskId: operation.taskId,
    itemId: operation.itemId,
    stepId: operation.stepId,
    status: operation.status,
    sequence: operation.sequence,
    cancellationPolicy: operation.cancellationPolicy,
    mutationBoundary: operation.mutationBoundary,
  };
}

function phoneResultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function finishResolvedOperation(
  control: PhoneOperationExecutionControl,
  result: unknown,
): void {
  const operation = control.current();
  if (isTerminalOperationStatus(operation.status)) return;
  const record = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};
  if (record['status'] === 'order_status_ambiguous') {
    localOperationRegistry.transition(operation.operationId, {
      status: 'ambiguous',
      step: 'final dispatch outcome requires read-only reconciliation',
    });
    return;
  }
  if (record['status'] === 'execution_loop_stopped') {
    localOperationRegistry.transition(operation.operationId, {
      status: 'failed',
      step: 'execution loop stopped after repeated no-progress actions',
    });
    return;
  }
  if ([
    'execution_guard_error',
    'idempotency_conflict',
    'mutation_outcome_ambiguous',
    'reconciliation_required',
    'retry_allowed',
    'retry_requires_user',
  ].includes(String(record['status'] ?? ''))) {
    const verification = phoneResultRecord(record['verification']);
    const mutationMayHaveStarted =
      verification['mutationAttempted'] === true
      || operation.status === 'mutation_attempted'
      || operation.status === 'reconciling';
    localOperationRegistry.transition(operation.operationId, {
      status: mutationMayHaveStarted ? 'ambiguous' : 'failed',
      step: mutationMayHaveStarted
        ? 'mutation outcome requires read-only reconciliation'
        : 'execution guard rejected the operation before mutation',
    });
    return;
  }
  if (record['status'] !== 'execution_failed') return;
  localOperationRegistry.transition(operation.operationId, {
    status:
      operation.status === 'mutation_attempted'
      || operation.status === 'reconciling'
        ? 'ambiguous'
        : 'failed',
    step:
      operation.status === 'mutation_attempted'
      || operation.status === 'reconciling'
        ? 'mutation outcome requires reconciliation'
        : 'phone execution failed before mutation',
  });
}

export function progressStageForResolvedOperation(
  operation: Pick<LocalPhoneOperationV1, 'status'>,
  result: unknown,
): OverlayTaskProgressStageV1 {
  const resultStatus =
    result && typeof result === 'object'
      ? (result as Record<string, unknown>)['status']
      : undefined;
  const status = typeof resultStatus === 'string' ? resultStatus : '';
  if ([
    'checkout_changed',
    'checkout_expired',
    'confirmation_required',
    'needs_clarification',
    'not_found',
    'search_results',
  ].includes(status)) {
    return 'waiting_for_choice';
  }
  if (status === 'order_status_ambiguous') return 'ambiguous';
  if ([
    'execution_failed',
    'execution_loop_stopped',
    'final_dispatch_disabled',
  ].includes(status)) {
    return 'failed';
  }
  if (operation.status === 'cancelled') return 'cancelled';
  if (operation.status === 'ambiguous') return 'ambiguous';
  if (operation.status === 'failed') return 'failed';
  return 'completed';
}

export async function executePhoneActionWithService(
  input: PhoneActionArguments,
  reversibleExecution: ReversibleBlinkitExecutionPort,
  executionContext: PhoneActionExecutionContext = {},
  executionSafety: Pick<CompatibilityExecutionSafetyV2, 'execute'> =
    compatibilityExecutionSafetyV2,
) {
  const protocolVersion = executionContext.protocolVersion ?? 2;
  if (protocolVersion !== 1 && protocolVersion !== 2) {
    return {
      ok: false,
      status: 'unsupported_protocol_version',
      protocolVersion,
    };
  }
  const dispatchOverlayStatus = overlayStatusDispatcher(
    executionContext.overlayStatusPublisher === null
      ? undefined
      : executionContext.overlayStatusPublisher
        ?? (process.env.NODE_ENV === 'test' ? undefined : publishOverlayStatus),
  );
  const arguments_ = input;
  const action = arguments_.action ?? 'unknown';
  return traceFunction(
    `phone.${action}`,
    {
      toolName: action,
      toolArguments: arguments_,
    },
    async () => {
      if (action === 'cancel_current_task') {
        const taskId = executionContext.taskId ?? arguments_.taskId;
        if (!taskId) {
          return {
            ok: false,
            status: 'invalid_command',
            message: 'A current task is required for cancellation.',
          };
        }
        const cancellation = cancelCurrentPhoneTask(taskId);
        return {
          ok: cancellation.outcome === 'cancelled'
            || cancellation.outcome === 'already_cancelled'
            || cancellation.outcome === 'cancellation_requested'
            || cancellation.outcome === 'no_active_operation',
          status: cancellation.outcome,
          cancellationPolicy: cancellation.policy,
          ...(cancellation.operation
            ? { operation: operationSummary(cancellation.operation.operationId) }
            : {}),
        };
      }

      const operationKind = operationKindFor(arguments_.action);
      if (!operationKind) {
        return enqueuePhoneOperation(
          () => executePhoneActionUnlocked(arguments_, reversibleExecution),
        );
      }

      const taskId = executionContext.taskId
        ?? newLocalIdentifier('task');
      let operationId: LocalIdentifier<'operation'> | undefined;
      try {
        const result = await enqueueRegisteredPhoneOperation(
          {
            ...(executionContext.operationId
              ? { operationId: executionContext.operationId }
              : {}),
            taskId,
            ...(executionContext.itemId
              ? { itemId: executionContext.itemId }
              : {}),
            ...((executionContext.stepId ?? executionContext.stepKey)
              ? {
                  stepId:
                    executionContext.stepId
                    ?? executionContext.stepKey,
                }
              : {}),
            kind: operationKind,
            ...(executionContext.queueTimeoutMs !== undefined
              ? { queueTimeoutMs: executionContext.queueTimeoutMs }
              : {}),
            ...(executionContext.deviceTimeoutMs !== undefined
              ? { deviceTimeoutMs: executionContext.deviceTimeoutMs }
              : {}),
            ...(executionContext.isCurrent
              ? { isCurrent: executionContext.isCurrent }
              : {}),
            onCreated: (operation) => {
              operationId = operation.operationId;
              updateLogContext({
                operationId: operation.operationId,
                taskId: operation.taskId,
                ...(operation.itemId ? { itemId: operation.itemId } : {}),
              });
            },
            onQueued: () => {
              dispatchOverlayStatus(
                'Waiting for phone',
                'working',
              );
            },
            onOwned: () => {
              dispatchOverlayStatus(
                'Connecting to phone provider',
                'working',
              );
            },
            onTerminal: (operation, result) => {
              const stage = progressStageForResolvedOperation(
                operation,
                result,
              );
              dispatchOverlayStatus(
                operation.step,
                stage === 'completed'
                  ? 'success'
                  : stage === 'waiting_for_choice'
                    ? 'clarification'
                    : 'error',
              );
            },
          },
          async (control) => {
            const operation = control.current();
            const providerControl: PhoneOperationExecutionControl =
              executionContext.markMutationAttempted
                ? {
                    ...control,
                    markMutationAttemptedAtProviderBoundary: async (step) => {
                      await executionContext.markMutationAttempted!();
                      control.markMutationAttempted(step);
                    },
                  }
                : control;
            const result = await executionSafety.execute({
              action: arguments_,
              context: {
                callId:
                  executionContext.callId
                  ?? operation.operationId,
                operationId: operation.operationId,
                taskId: operation.taskId,
                ...(operation.itemId ? { itemId: operation.itemId } : {}),
                ...(executionContext.stepKey
                  ? { stepKey: executionContext.stepKey }
                  : executionContext.stepId
                    ? { stepKey: executionContext.stepId }
                  : {}),
                ...(executionContext.taskRevision !== undefined
                  ? { taskRevision: executionContext.taskRevision }
                  : {}),
              },
              execute: (action) => executePhoneActionUnlocked(
                action as PhoneActionArguments,
                reversibleExecution,
                providerControl,
              ),
              inspectCart: () =>
                arguments_.action === 'add_cart_item'
                && arguments_.selectedOffer
                && reversibleExecution.inspectCartForMutationBaseline
                  ? reversibleExecution.inspectCartForMutationBaseline(
                      arguments_.selectedOffer,
                      providerControl,
                    )
                  : reversibleExecution.inspectCart(providerControl),
            });
            finishResolvedOperation(control, result);
            return result;
          },
        );
        return operationId
          ? {
              ...phoneResultRecord(result),
              operation: operationSummary(operationId),
            }
          : result;
      } catch (error) {
        if (
          error instanceof PhoneOperationCancelledError
          && operationId
        ) {
          return {
            ok: false,
            status: 'cancelled',
            operation: operationSummary(operationId),
          };
        }
        throw error;
      }
    },
    (result) => {
      const record = result && typeof result === 'object'
        ? result as Record<string, unknown>
        : {};
      return {
        toolName: action,
        resultOk: record['ok'],
        resultStatus: record['status'],
      };
    },
  );
}

export async function executePhoneAction(
  arguments_: PhoneActionArguments,
  executionContext: PhoneActionExecutionContext = {},
) {
  return executePhoneActionWithService(
    arguments_,
    blinkitExecutionService,
    executionContext,
  );
}
