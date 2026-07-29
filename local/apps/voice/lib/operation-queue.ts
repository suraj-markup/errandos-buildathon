import {
  LocalOperationRegistry,
  isTerminalOperationStatus,
  type CancelLocalPhoneOperationResult,
  type LocalPhoneOperationKind,
  type LocalPhoneOperationV1,
} from './operations/registry';
import { logEvent } from './structured-logger';
import {
  stageMetrics,
  type DeterministicStageMetricsCollector,
  type StageMetricTimer,
} from './stage-metrics';
import {
  runWithStageDeadline,
  stageDeadlinePolicy,
  StageDeadlineExceededError,
  type StageDeadlinePolicy,
} from './stage-deadlines';
import type { LocalIdentifier } from './workflow/identifiers';

const queueGlobal = globalThis as typeof globalThis & {
  errandosLocalOperationRegistry?: LocalOperationRegistry;
  errandosPhoneOperationTail?: Promise<void>;
};

queueGlobal.errandosPhoneOperationTail ??= Promise.resolve();
queueGlobal.errandosLocalOperationRegistry ??= new LocalOperationRegistry();

export const localOperationRegistry =
  queueGlobal.errandosLocalOperationRegistry;

export class PhoneOperationQueueTimeoutError extends StageDeadlineExceededError {
  constructor(
    readonly operationId: LocalIdentifier<'operation'>,
    override readonly timeoutMs: number,
  ) {
    super('phone_queue_wait', timeoutMs, 'retry_safe');
    this.name = 'PhoneOperationQueueTimeoutError';
  }
}

export class PhoneOperationCancelledError extends Error {
  constructor(readonly operation: LocalPhoneOperationV1) {
    super(`Operation ${operation.operationId} was cancelled.`);
    this.name = 'PhoneOperationCancelledError';
  }
}

type RegisteredPhoneOperationInput = {
  operationId?: LocalIdentifier<'operation'> | string;
  taskId: LocalIdentifier<'task'> | string;
  itemId?: LocalIdentifier<'task_item'> | string;
  stepId?: string;
  kind: LocalPhoneOperationKind;
  queueTimeoutMs?: number;
  registry?: LocalOperationRegistry;
  isCurrent?: (
    operation: LocalPhoneOperationV1,
  ) => boolean;
  onCreated?: (operation: LocalPhoneOperationV1) => void;
  onQueued?: (operation: LocalPhoneOperationV1) => Promise<void> | void;
  onOwned?: (operation: LocalPhoneOperationV1) => Promise<void> | void;
  onTerminal?: (
    operation: LocalPhoneOperationV1,
    result?: unknown,
  ) => Promise<void> | void;
  metrics?: DeterministicStageMetricsCollector;
  deadlinePolicy?: StageDeadlinePolicy;
  deviceTimeoutMs?: number;
};

export type PhoneOperationExecutionControl = {
  operationId: LocalIdentifier<'operation'>;
  checkpoint(step?: string): void;
  current(): LocalPhoneOperationV1;
  isCurrent(): boolean;
  markFinalDispatchAttempted(step?: string): void;
  markMutationAttempted(step?: string): void;
  markMutationAttemptedAtProviderBoundary(step?: string): Promise<void>;
  markReconciling(step?: string): void;
};

type CancelCurrentPhoneTaskResult =
  | CancelLocalPhoneOperationResult
  | {
      outcome: 'no_active_operation';
      policy: 'not_cancellable';
      operation?: undefined;
    };

function terminalAfterError(
  registry: LocalOperationRegistry,
  operationId: LocalIdentifier<'operation'>,
  step: string,
): void {
  const operation = registry.get(operationId);
  if (!operation || isTerminalOperationStatus(operation.status)) return;
  registry.transition(operationId, {
    status:
      operation.status === 'mutation_attempted'
      || operation.status === 'reconciling'
        ? 'ambiguous'
        : 'failed',
    step,
  });
}

function executionControl(
  registry: LocalOperationRegistry,
  operationId: LocalIdentifier<'operation'>,
  isCurrent: RegisteredPhoneOperationInput['isCurrent'],
): PhoneOperationExecutionControl {
  const current = () => registry.require(operationId);
  const checkpoint = (step = 'safe cancellation checkpoint') => {
    const beforeCheckpoint = current();
    if (
      !(isCurrent?.(beforeCheckpoint) ?? true)
      && beforeCheckpoint.status !== 'mutation_attempted'
      && beforeCheckpoint.status !== 'reconciling'
      && !isTerminalOperationStatus(beforeCheckpoint.status)
    ) {
      const obsolete = registry.transition(operationId, {
        status: 'cancelled',
        step: 'obsolete operation stopped before mutation',
      });
      throw new PhoneOperationCancelledError(obsolete);
    }
    const cancelled = registry.cancelAtCheckpoint(operationId, step);
    if (cancelled) throw new PhoneOperationCancelledError(cancelled);
  };
  return {
    operationId,
    checkpoint,
    current,
    isCurrent: () => isCurrent?.(current()) ?? true,
    markFinalDispatchAttempted(step) {
      checkpoint('cancelled before final dispatch');
      registry.markFinalDispatchAttempted(operationId, step);
    },
    markMutationAttempted(step = 'mutation attempted') {
      checkpoint('cancelled before mutation');
      registry.transition(operationId, {
        status: 'mutation_attempted',
        step,
      });
    },
    async markMutationAttemptedAtProviderBoundary(
      step = 'mutation attempted',
    ) {
      checkpoint('cancelled before mutation');
      registry.transition(operationId, {
        status: 'mutation_attempted',
        step,
      });
    },
    markReconciling(step = 'reconciling mutation result') {
      const operation = current();
      if (
        operation.status === 'running'
        || operation.status === 'mutation_attempted'
      ) {
        registry.transition(operationId, {
          status: 'reconciling',
          step,
        });
      }
    },
  };
}

export function cancelCurrentPhoneTask(
  taskId: LocalIdentifier<'task'> | string,
  registry: LocalOperationRegistry = localOperationRegistry,
): CancelCurrentPhoneTaskResult {
  const operation = registry.latestActiveForTask(taskId);
  if (!operation) {
    const latest = registry.listForTask(taskId).at(-1);
    if (latest?.status === 'cancelled') {
      return registry.requestCancellation(latest.operationId);
    }
    return {
      outcome: 'no_active_operation',
      policy: 'not_cancellable',
    };
  }
  const result = registry.requestCancellation(operation.operationId);
  logEvent('info', 'phone.operation.cancel_requested', {
    operationId: result.operation.operationId,
    taskId: result.operation.taskId,
    itemId: result.operation.itemId,
    outcome: result.outcome,
    cancellationPolicy: result.policy,
    mutationBoundary: result.operation.mutationBoundary,
  });
  return result;
}

/**
 * Serializes access to the single connected Android device across overlay,
 * browser, and tool requests.
 */
export async function enqueuePhoneOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queueGlobal.errandosPhoneOperationTail ?? Promise.resolve();
  let release: (() => void) | undefined;
  queueGlobal.errandosPhoneOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release?.();
  }
}

/**
 * Creates an operation before joining the device queue, then transfers phone
 * ownership to it exactly once. Queue timeout and cancellation do not let a
 * later operation overtake the current owner.
 */
export async function enqueueRegisteredPhoneOperation<T>(
  input: RegisteredPhoneOperationInput,
  work: (control: PhoneOperationExecutionControl) => Promise<T>,
): Promise<T> {
  const registry = input.registry ?? localOperationRegistry;
  const operation = registry.create({
    ...(input.operationId ? { operationId: input.operationId } : {}),
    taskId: input.taskId,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    kind: input.kind,
    step: 'waiting for phone ownership',
  });
  input.onCreated?.(operation);
  const metrics = input.metrics ?? stageMetrics;
  const deadlinePolicy = input.deadlinePolicy ?? stageDeadlinePolicy;
  const metricIds = {
    operationId: operation.operationId,
    taskId: operation.taskId,
    ...(operation.itemId ? { itemId: operation.itemId } : {}),
  };
  const queueTimer = metrics.begin('queue_wait', metricIds);
  logEvent('info', 'phone.operation.queued', {
    operationId: operation.operationId,
    taskId: operation.taskId,
    itemId: operation.itemId,
    operationKind: operation.kind,
    sequence: operation.sequence,
  });
  await input.onQueued?.(operation);

  const previous = queueGlobal.errandosPhoneOperationTail ?? Promise.resolve();
  let release: (() => void) | undefined;
  const queueSlot = new Promise<void>((resolve) => {
    release = resolve;
  });
  queueGlobal.errandosPhoneOperationTail = queueSlot;

  const waitForPrevious = previous.catch(() => undefined);
  const timeoutMs = input.queueTimeoutMs
    ?? deadlinePolicy.timeoutFor('phone_queue_wait');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const ownsPhone = await Promise.race([
    waitForPrevious.then(() => true),
    new Promise<false>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (!ownsPhone) {
    const queueMetric = queueTimer.finish({
      fallbackReason: 'queue_timeout',
      outcome: 'timeout',
    });
    logEvent('warn', 'metric.stage', queueMetric);
    terminalAfterError(
      registry,
      operation.operationId,
      'timed out before phone ownership',
    );
    await input.onTerminal?.(registry.require(operation.operationId));
    void waitForPrevious.finally(() => release?.());
    logEvent('warn', 'phone.operation.queue_timeout', {
      operationId: operation.operationId,
      taskId: operation.taskId,
      timeoutMs,
    });
    throw new PhoneOperationQueueTimeoutError(
      operation.operationId,
      timeoutMs,
    );
  }

  const queueMetric = queueTimer.finish({ outcome: 'completed' });
  logEvent('info', 'metric.stage', queueMetric);
  let deviceTimer: StageMetricTimer | undefined;
  try {
    const beforeOwnership = registry.require(operation.operationId);
    if (beforeOwnership.status === 'cancelled') {
      throw new PhoneOperationCancelledError(beforeOwnership);
    }
    const owned = registry.transition(operation.operationId, {
      status: 'running',
      step: 'phone ownership acquired',
    });
    logEvent('info', 'phone.operation.owned', {
      operationId: owned.operationId,
      taskId: owned.taskId,
      itemId: owned.itemId,
      operationKind: owned.kind,
      sequence: owned.sequence,
    });
    await input.onOwned?.(owned);
    const control = executionControl(
      registry,
      operation.operationId,
      input.isCurrent,
    );
    control.checkpoint();
    deviceTimer = metrics.begin('device_automation', metricIds);
    const workPromise = Promise.resolve().then(() => work(control));
    let result: T;
    try {
      result = await runWithStageDeadline({
        run: async () => workPromise,
        stage: 'device_automation',
        timeoutMs: input.deviceTimeoutMs
          ?? deadlinePolicy.timeoutFor('device_automation'),
      });
    } catch (error) {
      if (!(error instanceof StageDeadlineExceededError)) throw error;
      const lateResult = await workPromise.then(
        (value) => ({ status: 'completed' as const, value }),
        () => ({ status: 'failed' as const }),
      );
      const afterDeadline = control.current();
      const mutationMayHaveHappened =
        afterDeadline.mutationBoundary === 'mutation_attempted'
        || afterDeadline.mutationBoundary === 'final_dispatch_attempted'
        || afterDeadline.status === 'mutation_attempted'
        || afterDeadline.status === 'reconciling';
      if (lateResult.status === 'completed' && mutationMayHaveHappened) {
        result = lateResult.value;
      } else {
        throw new StageDeadlineExceededError(
          'device_automation',
          error.timeoutMs,
          mutationMayHaveHappened ? 'reconcile_only' : 'retry_safe',
        );
      }
    }
    const deviceMetric = deviceTimer.finish({ outcome: 'completed' });
    logEvent('info', 'metric.stage', deviceMetric);
    const beforeCompletion = registry.require(operation.operationId);
    let completed = beforeCompletion;
    if (!isTerminalOperationStatus(beforeCompletion.status)) {
      completed = registry.transition(operation.operationId, {
        status: 'succeeded',
        step: control.isCurrent()
          ? 'operation completed'
          : 'obsolete operation completed without publishing',
      });
    }
    await input.onTerminal?.(completed, result);
    return result;
  } catch (error) {
    if (deviceTimer) {
      const cancelled = error instanceof PhoneOperationCancelledError;
      const deviceMetric = deviceTimer.finish({
        ...(cancelled ? { fallbackReason: 'cancelled' as const } : {
          fallbackReason: 'function_error' as const,
        }),
        outcome: cancelled ? 'cancelled' : 'error',
      });
      logEvent(cancelled ? 'info' : 'warn', 'metric.stage', deviceMetric);
    }
    if (!(error instanceof PhoneOperationCancelledError)) {
      terminalAfterError(
        registry,
        operation.operationId,
        error instanceof Error ? error.message : 'operation failed',
      );
    }
    await input.onTerminal?.(registry.require(operation.operationId));
    throw error;
  } finally {
    release?.();
  }
}
