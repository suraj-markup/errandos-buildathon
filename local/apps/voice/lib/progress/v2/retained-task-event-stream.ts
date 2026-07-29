import {
  canonicalTaskEventKindV2,
  taskEventKindsV2,
  type RetainedTaskEventStreamStateV2,
  type SemanticTaskEventDraftV2,
  type SemanticTaskEventV2,
  type FinalCartSummaryV2,
  type TaskEventCursorCheckpointV2,
  type TaskEventItemV2,
  type TaskEventProgressV2,
  type TaskHeartbeatProjectionV2,
  type TaskProjectionSnapshotV2,
  type TaskEventStreamSnapshotV2,
} from './contracts';
import type { LocalIdentifier } from '../../workflow/identifiers';

type RetainedTaskEvents = {
  dedupe: Map<string, number>;
  events: SemanticTaskEventV2[];
  latestSequence: number;
  latestRevision: number;
  terminalRevision?: number;
  items: Map<number, TaskEventItemV2>;
  activeItem?: TaskEventItemV2;
  progress?: TaskEventProgressV2;
  finalCartSummary?: FinalCartSummaryV2;
  safePresentation?: SemanticTaskEventV2['safePresentation'];
  updatedAt: number;
};

type TaskEventWaiter = {
  afterSequence: number;
  limit: number;
  taskId: LocalIdentifier<'task'>;
  subscriptionId?: string;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (snapshot: TaskEventStreamSnapshotV2) => void;
};

export type RetainedTaskEventStreamOptions = {
  maxEventsPerTask?: number;
  maxTasks?: number;
  taskTtlMs?: number;
  heartbeatAfterMs?: number;
  initialState?: RetainedTaskEventStreamStateV2;
  now?: () => number;
  newEventId?: () => string;
};

function boundedText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${field} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function validPosition(
  value: SemanticTaskEventDraftV2['itemPosition'],
): void {
  if (!value) return;
  if (
    !Number.isSafeInteger(value.current)
    || !Number.isSafeInteger(value.total)
    || value.current < 1
    || value.total < value.current
  ) {
    throw new Error('itemPosition must be a valid known current/total pair.');
  }
}

function validItem(value: TaskEventItemV2 | undefined): void {
  if (!value) return;
  boundedText(value.title, 'item.title', 160);
  boundedText(value.requestedLabel, 'item.requestedLabel', 160);
  if (value.packSize !== undefined) {
    boundedText(value.packSize, 'item.packSize', 100);
  }
  if (value.price !== undefined) boundedText(value.price, 'item.price', 80);
  validConflicts(value.conflicts, 'item.conflicts');
  if (
    !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || value.index < 1
    || value.total < value.index
  ) {
    throw new Error('item index/total must be a valid known pair.');
  }
  if (
    value.quantity !== undefined
    && (
      !Number.isSafeInteger(value.quantity)
      || value.quantity < 1
      || value.quantity > 100
    )
  ) {
    throw new Error('item.quantity must be an integer between 1 and 100.');
  }
}

function validConflicts(
  value: TaskEventItemV2['conflicts'],
  field: string,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new Error(`${field} must contain between 1 and 4 conflicts.`);
  }
  for (const conflict of value) {
    if (!['pack_size', 'price'].includes(conflict.field)) {
      throw new Error(`${field}.field is unsupported.`);
    }
    boundedText(conflict.expected, `${field}.expected`, 100);
    boundedText(conflict.observed, `${field}.observed`, 100);
  }
}

function validateDraft(draft: SemanticTaskEventDraftV2): void {
  const canonicalKind = canonicalTaskEventKindV2(draft.kind);
  if (!taskEventKindsV2.includes(canonicalKind)) {
    throw new Error('Unsupported task event kind.');
  }
  if (!Number.isSafeInteger(draft.taskRevision) || draft.taskRevision < 0) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  boundedText(draft.title, 'title', 120);
  if (draft.detail !== undefined) boundedText(draft.detail, 'detail', 300);
  if (draft.stepId !== undefined) boundedText(draft.stepId, 'stepId', 120);
  if (draft.dedupeKey !== undefined) {
    boundedText(draft.dedupeKey, 'dedupeKey', 160);
  }
  if (draft.announcement) {
    boundedText(draft.announcement.text, 'announcement.text', 240);
  }
  if (draft.recoveryInteraction) {
    const recovery = draft.recoveryInteraction;
    if (!draft.issue) {
      throw new Error('recoveryInteraction requires an issue.');
    }
    if (
      draft.operationId === undefined
      || draft.stepId === undefined
      || recovery.taskId !== draft.taskId
      || recovery.taskRevision !== draft.taskRevision
      || recovery.operationId !== draft.operationId
      || recovery.stepId !== draft.stepId
    ) {
      throw new Error(
        'recoveryInteraction must match the retained event identity.',
      );
    }
    boundedText(
      recovery.interactionId,
      'recoveryInteraction.interactionId',
      160,
    );
    boundedText(recovery.stepId, 'recoveryInteraction.stepId', 160);
    if (
      recovery.version !== 2
      || !Number.isSafeInteger(recovery.expiresAt)
      || recovery.expiresAt < 0
    ) {
      throw new Error('recoveryInteraction is invalid.');
    }
  }
  validPosition(draft.itemPosition);
  validItem(draft.item);
  if (
    draft.item
    && draft.itemPosition
    && (
      draft.item.index !== draft.itemPosition.current
      || draft.item.total !== draft.itemPosition.total
    )
  ) {
    throw new Error('item and itemPosition must describe the same position.');
  }
  if (draft.progress) {
    if (
      !Number.isSafeInteger(draft.progress.completed)
      || !Number.isSafeInteger(draft.progress.total)
      || draft.progress.completed < 0
      || draft.progress.total < draft.progress.completed
    ) {
      throw new Error('progress must be a valid completed/total pair.');
    }
    if (draft.progress.nextLabel !== undefined) {
      boundedText(draft.progress.nextLabel, 'progress.nextLabel', 160);
    }
  }
  if (
    draft.terminal
    && canonicalKind !== 'completed'
    && canonicalKind !== 'cancelled'
  ) {
    throw new Error('Only a completed or cancelled task event may be terminal.');
  }
  if (draft.finalCartSummary) {
    if (
      !Number.isSafeInteger(draft.finalCartSummary.inspectedAt)
      || draft.finalCartSummary.inspectedAt < 0
    ) {
      throw new Error('finalCartSummary.inspectedAt must be a timestamp.');
    }
    if (
      draft.finalCartSummary.status === 'empty'
      && draft.finalCartSummary.lines.length > 0
    ) {
      throw new Error('An empty final cart summary cannot contain lines.');
    }
    if (draft.finalCartSummary.lines.length > 30) {
      throw new Error('A final cart summary cannot contain more than 30 lines.');
    }
    for (const line of draft.finalCartSummary.lines) {
      boundedText(line.title, 'finalCartSummary.lines.title', 300);
      if (line.productId !== undefined) {
        boundedText(line.productId, 'finalCartSummary.lines.productId', 200);
      }
      if (line.spokenLabel !== undefined) {
        boundedText(
          line.spokenLabel,
          'finalCartSummary.lines.spokenLabel',
          300,
        );
      }
      if (line.packSize !== undefined) {
        boundedText(line.packSize, 'finalCartSummary.lines.packSize', 100);
      }
      if (line.price !== undefined) {
        boundedText(line.price, 'finalCartSummary.lines.price', 80);
      }
      validConflicts(
        line.conflicts,
        'finalCartSummary.lines.conflicts',
      );
    }
  }
}

function mergedItem(
  previous: TaskEventItemV2 | undefined,
  next: TaskEventItemV2,
): TaskEventItemV2 {
  if (!previous) return structuredClone(next);
  return {
    ...structuredClone(previous),
    ...structuredClone(next),
    requestedLabel: previous.requestedLabel,
    ...(next.packSize === undefined && previous.packSize !== undefined
      ? { packSize: previous.packSize }
      : {}),
    ...(next.quantity === undefined && previous.quantity !== undefined
      ? { quantity: previous.quantity }
      : {}),
    ...(next.price === undefined && previous.price !== undefined
      ? { price: previous.price }
      : {}),
    ...(next.conflicts === undefined && previous.conflicts !== undefined
      ? { conflicts: structuredClone(previous.conflicts) }
      : {}),
  };
}

function retainItemProjection(
  retained: RetainedTaskEvents,
  input: Pick<SemanticTaskEventDraftV2, 'item' | 'kind' | 'progress'>,
): void {
  if (input.item) {
    const item = mergedItem(retained.items.get(input.item.index), input.item);
    retained.items.set(item.index, item);
    if (canonicalTaskEventKindV2(input.kind) !== 'mutation_verified') {
      retained.activeItem = item;
    }
  }
  if (!input.progress) return;
  retained.progress = structuredClone(input.progress);
  if (input.progress.completed >= input.progress.total) {
    retained.activeItem = undefined;
    return;
  }
  const nextIndex = input.progress.completed + 1;
  let next = retained.items.get(nextIndex);
  if (!next && input.progress.nextLabel) {
    next = {
      index: nextIndex,
      total: input.progress.total,
      title: input.progress.nextLabel,
      requestedLabel: input.progress.nextLabel,
    };
    retained.items.set(nextIndex, next);
  }
  retained.activeItem = next;
}

export class RetainedTaskEventStreamV2 {
  private readonly tasks = new Map<string, RetainedTaskEvents>();
  private readonly waiters = new Map<string, Set<TaskEventWaiter>>();
  private readonly waitersBySubscription = new Map<string, TaskEventWaiter>();
  private readonly maxEventsPerTask: number;
  private readonly maxTasks: number;
  private readonly taskTtlMs: number;
  private readonly heartbeatAfterMs: number;
  private readonly now: () => number;
  private readonly newEventId: () => string;

  constructor(options: RetainedTaskEventStreamOptions = {}) {
    this.maxEventsPerTask = options.maxEventsPerTask ?? 64;
    this.maxTasks = options.maxTasks ?? 64;
    this.taskTtlMs = options.taskTtlMs ?? 30 * 60_000;
    this.heartbeatAfterMs = options.heartbeatAfterMs ?? 10_000;
    this.now = options.now ?? Date.now;
    this.newEventId = options.newEventId
      ?? (() => `event_${crypto.randomUUID()}`);
    if (
      !Number.isSafeInteger(this.maxEventsPerTask)
      || this.maxEventsPerTask < 1
      || !Number.isSafeInteger(this.maxTasks)
      || this.maxTasks < 1
      || !Number.isSafeInteger(this.taskTtlMs)
      || this.taskTtlMs < 1
      || !Number.isSafeInteger(this.heartbeatAfterMs)
      || this.heartbeatAfterMs < 1
    ) {
      throw new Error('Task event retention bounds must be positive integers.');
    }
    if (options.initialState) this.restoreState(options.initialState);
  }

  publish(draft: SemanticTaskEventDraftV2): SemanticTaskEventV2 {
    validateDraft(draft);
    const now = this.now();
    this.cleanup(now);
    let retained = this.tasks.get(draft.taskId);
    if (!retained) {
      this.evictOldestTaskIfNeeded();
      retained = {
        dedupe: new Map(),
        events: [],
        latestSequence: -1,
        latestRevision: -1,
        items: new Map(),
        updatedAt: now,
      };
      this.tasks.set(draft.taskId, retained);
    }

    if (draft.dedupeKey) {
      const previousSequence = retained.dedupe.get(draft.dedupeKey);
      const previous = retained.events.find(
        (event) => event.sequence === previousSequence,
      );
      if (previous) {
        // A generic durable-operation terminal may win the dedupe race before
        // the coordinator supplies richer item/progress details. Preserve
        // those details in the reset projection without replaying speech.
        retainItemProjection(retained, draft);
        retained.updatedAt = now;
        this.resolveTaskWaiters(draft.taskId);
        return structuredClone(previous);
      }
    }
    if (draft.taskRevision < retained.latestRevision) {
      throw new Error('Cannot publish a stale task revision.');
    }
    if (
      retained.terminalRevision !== undefined
    ) {
      throw new Error('Cannot publish after a terminal task event.');
    }

    const { dedupeKey, kind, ...eventFields } = draft;
    const event: SemanticTaskEventV2 = {
      ...structuredClone(eventFields),
      eventId: boundedText(this.newEventId(), 'eventId', 120),
      occurredAt: now,
      sequence: retained.latestSequence + 1,
      kind: canonicalTaskEventKindV2(kind),
      title: draft.title.trim(),
      version: 2,
    };
    retained.events.push(event);
    retained.latestSequence = event.sequence;
    retained.latestRevision = Math.max(
      retained.latestRevision,
      event.taskRevision,
    );
    if (event.terminal) retained.terminalRevision = event.taskRevision;
    retainItemProjection(retained, event);
    if (event.finalCartSummary) {
      retained.finalCartSummary = event.finalCartSummary;
    }
    if (event.safePresentation) {
      retained.safePresentation = event.safePresentation;
    }
    retained.updatedAt = now;
    if (dedupeKey) retained.dedupe.set(dedupeKey, event.sequence);

    while (retained.events.length > this.maxEventsPerTask) {
      const removed = retained.events.shift();
      if (!removed) break;
      for (const [key, sequence] of retained.dedupe) {
        if (sequence === removed.sequence) retained.dedupe.delete(key);
      }
    }
    this.resolveTaskWaiters(draft.taskId);
    return structuredClone(event);
  }

  readAfter(input: {
    afterSequence?: number;
    limit?: number;
    taskId: LocalIdentifier<'task'>;
  }): TaskEventStreamSnapshotV2 {
    const afterSequence = input.afterSequence ?? -1;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
      throw new Error('afterSequence must be -1 or a non-negative integer.');
    }
    const limit = input.limit ?? this.maxEventsPerTask;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('limit must be an integer between 1 and 256.');
    }
    this.cleanup(this.now());
    return this.snapshotAfter(input.taskId, afterSequence, limit);
  }

  waitAfter(input: {
    afterSequence?: number;
    limit?: number;
    taskId: LocalIdentifier<'task'>;
    timeoutMs: number;
    signal?: AbortSignal;
    subscriptionId?: string;
  }): Promise<TaskEventStreamSnapshotV2> {
    const afterSequence = input.afterSequence ?? -1;
    const limit = input.limit ?? this.maxEventsPerTask;
    if (
      !Number.isSafeInteger(input.timeoutMs)
      || input.timeoutMs < 0
      || input.timeoutMs > 30_000
    ) {
      throw new Error('timeoutMs must be an integer between 0 and 30000.');
    }
    const snapshot = this.readAfter({
      afterSequence,
      limit,
      taskId: input.taskId,
    });
    const subscriptionId = input.subscriptionId;
    const superseded = subscriptionId === undefined
      ? undefined
      : this.waitersBySubscription.get(subscriptionId);
    if (superseded) this.resolveWaiter(superseded);
    if (
      snapshot.resetRequired
      || snapshot.events.length > 0
      || snapshot.heartbeat !== undefined
      || input.timeoutMs === 0
      || input.signal?.aborted
      || this.taskIsTerminal(input.taskId)
    ) {
      return Promise.resolve(snapshot);
    }

    return new Promise((resolve) => {
      const waiter: TaskEventWaiter = {
        afterSequence,
        limit,
        resolve,
        signal: input.signal,
        subscriptionId,
        taskId: input.taskId,
      };
      let taskWaiters = this.waiters.get(input.taskId);
      if (!taskWaiters) {
        taskWaiters = new Set();
        this.waiters.set(input.taskId, taskWaiters);
      }
      taskWaiters.add(waiter);
      if (subscriptionId !== undefined) {
        this.waitersBySubscription.set(subscriptionId, waiter);
      }
      if (input.signal) {
        waiter.onAbort = () => this.resolveWaiter(waiter);
        input.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiter.timeout = setTimeout(
        () => this.resolveWaiter(waiter),
        input.timeoutMs,
      );
    });
  }

  private snapshotAfter(
    taskId: LocalIdentifier<'task'>,
    afterSequence: number,
    limit: number,
  ): TaskEventStreamSnapshotV2 {
    const retained = this.tasks.get(taskId);
    if (!retained) {
      return {
        version: 2,
        taskId,
        afterSequence,
        earliestSequence: 0,
        latestSequence: -1,
        resetRequired: false,
        events: [],
      };
    }
    const earliestSequence =
      retained.events[0]?.sequence ?? retained.latestSequence + 1;
    const resetRequired = afterSequence < earliestSequence - 1
      || afterSequence > retained.latestSequence;
    const snapshot = this.projectionSnapshot(taskId, retained);
    const heartbeat = this.heartbeatProjection(retained, this.now());
    return {
      version: 2,
      taskId,
      afterSequence,
      earliestSequence,
      latestSequence: retained.latestSequence,
      resetRequired,
      events: resetRequired
        ? []
        : structuredClone(
            retained.events
              .filter((event) => event.sequence > afterSequence)
              .slice(0, limit),
          ),
      ...(snapshot ? { snapshot } : {}),
      ...(heartbeat ? { heartbeat } : {}),
    };
  }

  private taskIsTerminal(taskId: LocalIdentifier<'task'>): boolean {
    const latest = this.tasks.get(taskId)?.events.at(-1);
    return latest?.terminal === true;
  }

  private resolveTaskWaiters(taskId: LocalIdentifier<'task'>): void {
    const waiters = this.waiters.get(taskId);
    if (!waiters) return;
    for (const waiter of [...waiters]) this.resolveWaiter(waiter);
  }

  private resolveWaiter(waiter: TaskEventWaiter): void {
    const taskWaiters = this.waiters.get(waiter.taskId);
    if (!taskWaiters?.delete(waiter)) return;
    if (taskWaiters.size === 0) this.waiters.delete(waiter.taskId);
    if (
      waiter.subscriptionId !== undefined
      && this.waitersBySubscription.get(waiter.subscriptionId) === waiter
    ) {
      this.waitersBySubscription.delete(waiter.subscriptionId);
    }
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve(
      this.snapshotAfter(waiter.taskId, waiter.afterSequence, waiter.limit),
    );
  }

  exportState(): RetainedTaskEventStreamStateV2 {
    this.cleanup(this.now());
    return {
      version: 2,
      tasks: [...this.tasks.entries()].map(([taskId, retained]) => ({
        taskId: taskId as LocalIdentifier<'task'>,
        events: structuredClone(retained.events),
        dedupeEntries: [...retained.dedupe.entries()],
        latestSequence: retained.latestSequence,
        latestRevision: retained.latestRevision,
        ...(retained.terminalRevision === undefined
          ? {}
          : { terminalRevision: retained.terminalRevision }),
        items: structuredClone([...retained.items.values()]),
        ...(retained.activeItem
          ? { activeItem: structuredClone(retained.activeItem) }
          : {}),
        ...(retained.progress
          ? { progress: structuredClone(retained.progress) }
          : {}),
        ...(retained.finalCartSummary
          ? { finalCartSummary: structuredClone(retained.finalCartSummary) }
          : {}),
        ...(retained.safePresentation
          ? { safePresentation: structuredClone(retained.safePresentation) }
          : {}),
        updatedAt: retained.updatedAt,
      })),
    };
  }

  latestSafePresentation(
    taskId: LocalIdentifier<'task'>,
  ): SemanticTaskEventV2['safePresentation'] {
    this.cleanup(this.now());
    const retained = this.tasks.get(taskId);
    return retained?.safePresentation
      ? structuredClone(retained.safePresentation)
      : undefined;
  }

  cleanup(now = this.now()): number {
    let removed = 0;
    for (const [taskId, retained] of this.tasks) {
      if (now - retained.updatedAt < this.taskTtlMs) continue;
      this.tasks.delete(taskId);
      this.resolveTaskWaiters(taskId as LocalIdentifier<'task'>);
      removed += 1;
    }
    return removed;
  }

  private restoreState(state: RetainedTaskEventStreamStateV2): void {
    if (state.version !== 2 || !Array.isArray(state.tasks)) {
      throw new Error('Unsupported retained task event stream state.');
    }
    for (const task of state.tasks) {
      if (
        !Number.isSafeInteger(task.latestSequence)
        || task.latestSequence < -1
        || !Number.isSafeInteger(task.latestRevision)
        || task.latestRevision < -1
        || !Number.isSafeInteger(task.updatedAt)
        || task.updatedAt < 0
      ) {
        throw new Error('Retained task event stream state is invalid.');
      }
      for (const event of task.events) {
        validateDraft(event);
        if (event.taskId !== task.taskId) {
          throw new Error('Retained event belongs to the wrong task.');
        }
      }
      const ordered = [...task.events].sort(
        (left, right) => left.sequence - right.sequence,
      );
      if (
        ordered.some((event, index) =>
          index > 0
          && event.sequence !== ordered[index - 1]!.sequence + 1)
        || ordered.at(-1)?.sequence !== task.latestSequence
      ) {
        throw new Error('Retained event sequences must be contiguous.');
      }
      this.tasks.set(task.taskId, {
        dedupe: new Map(task.dedupeEntries),
        events: structuredClone(ordered),
        latestSequence: task.latestSequence,
        latestRevision: task.latestRevision,
        ...(task.terminalRevision === undefined
          ? {}
          : { terminalRevision: task.terminalRevision }),
        items: new Map(
          task.items.map((item) => [item.index, structuredClone(item)]),
        ),
        ...(task.activeItem
          ? { activeItem: structuredClone(task.activeItem) }
          : {}),
        ...(task.progress
          ? { progress: structuredClone(task.progress) }
          : {}),
        ...(task.finalCartSummary
          ? { finalCartSummary: structuredClone(task.finalCartSummary) }
          : {}),
        ...(task.safePresentation
          ? { safePresentation: structuredClone(task.safePresentation) }
          : {}),
        updatedAt: task.updatedAt,
      });
    }
  }

  private projectionSnapshot(
    taskId: LocalIdentifier<'task'>,
    retained: RetainedTaskEvents,
  ): TaskProjectionSnapshotV2 | undefined {
    const latestEvent = retained.events.at(-1);
    if (!latestEvent) return undefined;
    return {
      version: 2,
      taskId,
      taskRevision: retained.latestRevision,
      latestSequence: retained.latestSequence,
      latestEvent: structuredClone(latestEvent),
      items: structuredClone(
        [...retained.items.values()].sort(
          (left, right) => left.index - right.index,
        ),
      ),
      ...(retained.activeItem
        ? { activeItem: structuredClone(retained.activeItem) }
        : {}),
      ...(retained.progress
        ? { progress: structuredClone(retained.progress) }
        : {}),
      ...(retained.finalCartSummary
        ? { finalCartSummary: structuredClone(retained.finalCartSummary) }
        : {}),
      ...(retained.safePresentation
        ? { safePresentation: structuredClone(retained.safePresentation) }
        : {}),
      terminal: retained.terminalRevision !== undefined,
      cancelled:
        retained.terminalRevision !== undefined
        && latestEvent.kind === 'cancelled',
      updatedAt: retained.updatedAt,
    };
  }

  private heartbeatProjection(
    retained: RetainedTaskEvents,
    now: number,
  ): TaskHeartbeatProjectionV2 | undefined {
    const latest = retained.events.at(-1);
    if (
      !latest
      || latest.terminal
      || ![
        'step_started',
        'searching',
        'mutation_started',
        'reviewing_cart',
      ].includes(latest.kind)
    ) {
      return undefined;
    }
    const elapsedMs = Math.max(0, now - latest.occurredAt);
    if (elapsedMs < this.heartbeatAfterMs) return undefined;
    const elapsedSeconds = Math.floor(elapsedMs / 1_000);
    return {
      version: 2,
      taskId: latest.taskId,
      taskRevision: latest.taskRevision,
      sourceSequence: latest.sequence,
      elapsedMs,
      title: latest.title,
      detail: `Still working · ${elapsedSeconds}s elapsed`,
      announcement: {
        channel: 'visual_only',
        text: 'Still working.',
      },
    };
  }

  private evictOldestTaskIfNeeded(): void {
    if (this.tasks.size < this.maxTasks) return;
    let oldest: [string, RetainedTaskEvents] | undefined;
    for (const entry of this.tasks) {
      if (!oldest || entry[1].updatedAt < oldest[1].updatedAt) oldest = entry;
    }
    if (oldest) {
      this.tasks.delete(oldest[0]);
      this.resolveTaskWaiters(oldest[0] as LocalIdentifier<'task'>);
    }
  }
}

export class TaskEventCursorV2 {
  private nextSequence: number;
  private latestRevision: number | undefined;
  private terminalRevision: number | undefined;

  constructor(
    private readonly taskId: LocalIdentifier<'task'>,
    checkpoint: number | TaskEventCursorCheckpointV2 = -1,
  ) {
    if (typeof checkpoint === 'number') {
      this.nextSequence = checkpoint + 1;
      return;
    }
    if (checkpoint.taskId !== taskId || checkpoint.version !== 2) {
      throw new Error('Cursor checkpoint belongs to a different task.');
    }
    this.nextSequence = checkpoint.afterSequence + 1;
    this.latestRevision = checkpoint.latestRevision;
    this.terminalRevision = checkpoint.terminalRevision;
  }

  accept(event: SemanticTaskEventV2):
    | { accepted: true; nextSequence: number }
    | {
        accepted: false;
        reason:
          | 'post_terminal'
          | 'stale'
          | 'stale_revision'
          | 'sequence_gap'
          | 'wrong_task';
      } {
    if (event.taskId !== this.taskId) {
      return { accepted: false, reason: 'wrong_task' };
    }
    if (event.sequence < this.nextSequence) {
      return { accepted: false, reason: 'stale' };
    }
    if (event.sequence > this.nextSequence) {
      return { accepted: false, reason: 'sequence_gap' };
    }
    if (this.terminalRevision !== undefined) {
      return { accepted: false, reason: 'post_terminal' };
    }
    if (
      this.latestRevision !== undefined
      && event.taskRevision < this.latestRevision
    ) {
      return { accepted: false, reason: 'stale_revision' };
    }
    this.nextSequence += 1;
    this.latestRevision = Math.max(
      this.latestRevision ?? -1,
      event.taskRevision,
    );
    if (event.terminal) this.terminalRevision = event.taskRevision;
    return { accepted: true, nextSequence: this.nextSequence };
  }

  checkpoint(): TaskEventCursorCheckpointV2 {
    return {
      version: 2,
      taskId: this.taskId,
      afterSequence: this.nextSequence - 1,
      ...(this.latestRevision === undefined
        ? {}
        : { latestRevision: this.latestRevision }),
      ...(this.terminalRevision === undefined
        ? {}
        : { terminalRevision: this.terminalRevision }),
    };
  }
}
