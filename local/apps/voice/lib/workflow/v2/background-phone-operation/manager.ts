import {
  createRetainedOperationHandoffV2,
} from '../../../progress/v2/operation-handoff';
import {
  publishBackgroundPhoneOperationTerminalEventV2,
} from '../../../progress/v2/background-phone-operation-events';
import type {
  OperationAcceptedV2,
  TaskEventStreamSnapshotV2,
} from '../../../progress/v2/contracts';
import type {
  RetainedTaskEventStreamV2,
} from '../../../progress/v2/retained-task-event-stream';
import {
  DeterministicUxTimingMetricsCollectorV1,
  recordUxTimingIntervalSafelyV1,
  uxTimingMetricsV1,
  type UxTimingMetricV1,
} from '../../../ux-timing-metrics';
import { logEvent } from '../../../structured-logger';
import {
  newLocalIdentifier,
  type LocalIdentifier,
} from '../../identifiers';
import type {
  BackgroundPhoneOperationEnqueueInputV2,
  BackgroundPhoneOperationRecordV2,
  BackgroundPhoneOperationWorkerResultV2,
  BackgroundPhoneOperationWorkerV2,
} from './contracts';
import type {
  BackgroundPhoneOperationStoreV2,
} from './store';

type BackgroundPhoneOperationAcceptanceV2 = {
  disposition: 'enqueued' | 'duplicate' | 'task_busy';
  operationAccepted: OperationAcceptedV2;
};

type BackgroundPhoneOperationManagerOptionsV2 = {
  store: BackgroundPhoneOperationStoreV2;
  stream: RetainedTaskEventStreamV2;
  worker: BackgroundPhoneOperationWorkerV2;
  maxConcurrentTasks?: number;
  now?: () => number;
  metrics?: DeterministicUxTimingMetricsCollectorV1;
  newOperationId?: () => LocalIdentifier<'operation'>;
  onTerminal?: (
    operation: Readonly<BackgroundPhoneOperationRecordV2>,
  ) => Promise<void>;
};

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 300);
  }
  return 'The background worker stopped unexpectedly.';
}

function validateWorkerResult(
  result: BackgroundPhoneOperationWorkerResultV2,
): BackgroundPhoneOperationWorkerResultV2 {
  if (
    !result
    || !['completed', 'failed', 'ambiguous'].includes(result.outcome)
  ) {
    throw new Error('Background worker returned an invalid outcome.');
  }
  return result;
}

export class BackgroundPhoneOperationManagerV2 {
  private readonly store: BackgroundPhoneOperationStoreV2;
  private readonly stream: RetainedTaskEventStreamV2;
  private readonly worker: BackgroundPhoneOperationWorkerV2;
  private readonly now: () => number;
  private readonly newOperationId: () => LocalIdentifier<'operation'>;
  private readonly maxConcurrentTasks: number;
  private readonly metrics: DeterministicUxTimingMetricsCollectorV1;
  private readonly onTerminal?: BackgroundPhoneOperationManagerOptionsV2['onTerminal'];
  private readonly runningByTask = new Map<string, Promise<void>>();
  private readonly pendingTasks = new Set<LocalIdentifier<'task'>>();
  private readonly rescheduleTasks = new Set<string>();
  private initializePromise?: Promise<void>;

  constructor(options: BackgroundPhoneOperationManagerOptionsV2) {
    this.store = options.store;
    this.stream = options.stream;
    this.worker = options.worker;
    this.now = options.now ?? Date.now;
    this.metrics = options.metrics ?? uxTimingMetricsV1;
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? 4;
    this.onTerminal = options.onTerminal;
    if (
      !Number.isSafeInteger(this.maxConcurrentTasks)
      || this.maxConcurrentTasks < 1
      || this.maxConcurrentTasks > 32
    ) {
      throw new Error('maxConcurrentTasks must be between 1 and 32.');
    }
    this.newOperationId = options.newOperationId
      ?? ((): LocalIdentifier<'operation'> =>
        newLocalIdentifier('operation'));
  }

  initialize(): Promise<void> {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  async enqueue(
    request: BackgroundPhoneOperationEnqueueInputV2,
    operationId = this.newOperationId(),
  ): Promise<BackgroundPhoneOperationAcceptanceV2> {
    await this.initialize();
    const result = await this.store.enqueue({
      operationId,
      acceptedAt: this.now(),
      request,
    });
    const handoff = createRetainedOperationHandoffV2({
      operationId: result.operation.operationId,
      stream: this.stream,
      taskId: result.operation.taskId,
      taskRevision: result.operation.taskRevision,
      stepId: result.operation.stepId,
      title: result.disposition === 'task_busy'
        ? 'Phone operation already running'
        : 'Phone operation accepted',
    });
    if (result.disposition === 'enqueued') {
      recordUxTimingIntervalSafelyV1(this.metrics, {
        endedAt: handoff.retainedEvent.occurredAt,
        operationId: result.operation.operationId,
        outcome: 'completed',
        phase: 'accepted_to_first_event',
        startedAt: result.operation.createdAt,
        targetMs: 500,
        taskId: result.operation.taskId,
        ...(result.operation.itemId
          ? { itemId: result.operation.itemId }
          : {}),
      });
    }
    if (
      result.disposition === 'enqueued'
      || result.operation.status === 'queued'
    ) {
      this.scheduleTask(result.operation.taskId);
    }
    return {
      disposition: result.disposition,
      operationAccepted: handoff.operationAccepted,
    };
  }

  async get(
    operationId: LocalIdentifier<'operation'>,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined> {
    await this.initialize();
    return this.store.get(operationId);
  }

  async reconnect(input: {
    operationId: LocalIdentifier<'operation'>;
    afterSequence?: number;
  }): Promise<{
    operation: BackgroundPhoneOperationRecordV2 | undefined;
    events?: TaskEventStreamSnapshotV2;
  }> {
    const operation = await this.get(input.operationId);
    return {
      operation,
      ...(operation
        ? {
            events: this.stream.readAfter({
              afterSequence: input.afterSequence,
              taskId: operation.taskId,
            }),
          }
        : {}),
    };
  }

  async awaitIdle(): Promise<void> {
    for (;;) {
      const running = [...this.runningByTask.values()];
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  private async initializeOnce(): Promise<void> {
    await this.store.recoverInterrupted(this.now());
    for (const operation of await this.store.listTerminalOperations()) {
      await this.publishTerminal(operation, true);
    }
    const queued = await this.store.listQueued();
    for (const operation of queued) this.scheduleTask(operation.taskId);
  }

  private scheduleTask(taskId: LocalIdentifier<'task'>): void {
    if (this.runningByTask.has(taskId)) {
      this.rescheduleTasks.add(taskId);
      return;
    }
    if (this.pendingTasks.has(taskId)) return;
    if (this.runningByTask.size >= this.maxConcurrentTasks) {
      this.pendingTasks.add(taskId);
      return;
    }
    this.startTask(taskId);
  }

  private startTask(taskId: LocalIdentifier<'task'>): void {
    const tracked = Promise.resolve()
      .then(() => this.runNext(taskId))
      .catch(() => {
        // The durable queued/running record remains available for restart.
      })
      .then(() => {
        this.runningByTask.delete(taskId);
        if (this.rescheduleTasks.delete(taskId)) this.scheduleTask(taskId);
        this.drainPendingTasks();
      });
    this.runningByTask.set(taskId, tracked);
  }

  private drainPendingTasks(): void {
    while (
      this.runningByTask.size < this.maxConcurrentTasks
      && this.pendingTasks.size > 0
    ) {
      const taskId = this.pendingTasks.values().next().value;
      if (taskId === undefined) return;
      this.pendingTasks.delete(taskId);
      this.startTask(taskId);
    }
  }

  private async runNext(taskId: LocalIdentifier<'task'>): Promise<void> {
    const queued = (await this.store.listQueued(taskId))[0];
    if (!queued) return;
    const operation = await this.store.claim(queued.operationId, this.now());
    if (!operation) return;
    if (operation.startedAt !== undefined) {
      this.recordTiming({
        endedAt: operation.startedAt,
        operation,
        outcome: 'completed',
        phase: 'accepted_to_worker_start',
        startedAt: operation.createdAt,
        targetMs: 500,
      });
    }
    let mutationTimingRecorded = false;
    let result: BackgroundPhoneOperationWorkerResultV2;
    try {
      result = validateWorkerResult(await this.worker(operation, {
        markMutationAttempted: async () => {
          const marked = await this.store.markMutationAttempted(
            operation.operationId,
            this.now(),
          );
          if (
            !mutationTimingRecorded
            && marked.mutationAttemptedAt !== undefined
          ) {
            mutationTimingRecorded = true;
            this.recordTiming({
              endedAt: marked.mutationAttemptedAt,
              operation: marked,
              outcome: 'completed',
              phase: 'accepted_to_mutation_start',
              startedAt: marked.createdAt,
            });
          }
        },
      }));
    } catch (error) {
      const current = await this.store.get(operation.operationId);
      result = {
        outcome: current?.status === 'mutation_attempted'
          ? 'ambiguous'
          : 'failed',
        detail: errorDetail(error),
      };
    }
    const terminal = await this.store.complete({
      operationId: operation.operationId,
      outcome: result.outcome,
      terminalAt: this.now(),
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.resultRef === undefined ? {} : { resultRef: result.resultRef }),
    });
    const outcome = terminal.status === 'completed' ? 'completed' : 'error';
    if (
      terminal.mutationAttemptedAt !== undefined
      && terminal.terminalAt !== undefined
    ) {
      this.recordTiming({
        endedAt: terminal.terminalAt,
        operation: terminal,
        outcome,
        phase: 'mutation',
        startedAt: terminal.mutationAttemptedAt,
      });
    } else if (
      terminal.status === 'completed'
      && terminal.startedAt !== undefined
      && terminal.terminalAt !== undefined
      && !isMutationKind(terminal.operationKind)
    ) {
      this.recordTiming({
        endedAt: terminal.terminalAt,
        operation: terminal,
        outcome: 'completed',
        phase: 'verification',
        startedAt: terminal.startedAt,
      });
    }
    const publishedAt = await this.publishTerminal(terminal);
    await this.onTerminal?.(terminal);
    if (
      terminal.status === 'completed'
      && terminal.terminalAt !== undefined
      && publishedAt !== undefined
    ) {
      this.recordTiming({
        endedAt: this.onTerminal ? this.now() : publishedAt,
        operation: terminal,
        outcome: 'completed',
        phase: 'verified_to_next_step',
        startedAt: terminal.terminalAt,
        targetMs: 1_000,
      });
    }
  }

  private async publishTerminal(
    operation: BackgroundPhoneOperationRecordV2,
    replay = false,
  ): Promise<number | undefined> {
    if (!replay && operation.terminalEventPublishedAt !== undefined) {
      return operation.terminalEventPublishedAt;
    }
    const event = publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream: this.stream,
    });
    if (operation.terminalEventPublishedAt === undefined) {
      await this.store.markTerminalEventPublished(
        operation.operationId,
        event.occurredAt,
      );
    }
    return event.occurredAt;
  }

  private recordTiming(input: {
    endedAt: number;
    operation: BackgroundPhoneOperationRecordV2;
    outcome: UxTimingMetricV1['outcome'];
    phase: UxTimingMetricV1['phase'];
    startedAt: number;
    targetMs?: number;
  }): void {
    try {
      this.metrics.recordInterval({
        endedAt: input.endedAt,
        operationId: input.operation.operationId,
        outcome: input.outcome,
        phase: input.phase,
        startedAt: input.startedAt,
        taskId: input.operation.taskId,
        ...(input.operation.itemId
          ? { itemId: input.operation.itemId }
          : {}),
        ...(input.targetMs === undefined
          ? {}
          : { targetMs: input.targetMs }),
      });
    } catch {
      // Telemetry must never alter durable operation truth or retry behavior.
      logEvent('warn', 'metric.ux_timing_dropped', {
        operationId: input.operation.operationId,
        phase: input.phase,
        reason: 'invalid_lifecycle_boundary',
        taskId: input.operation.taskId,
      });
    }
  }
}

function isMutationKind(operationKind: string): boolean {
  return [
    'add_cart_item',
    'remove_cart_item',
    'set_cart_item_quantity',
  ].includes(operationKind);
}
