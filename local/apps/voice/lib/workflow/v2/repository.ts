import { createHash } from 'node:crypto';
import {
  PHONE_TASK_V2_VERSION,
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskV2,
  type TaskJournalEntryV2,
} from './contracts';
import { assertVerifiedStepsImmutable } from './graph';
import { parsePhoneTaskV2 } from './validation';

export type TaskRepositoryEventV2 = {
  eventId: string;
  taskId: string;
  taskRevision: number;
  at: number;
  kind: string;
  dataRef?: string;
};

export type TaskRecoveryOperationV2 = {
  operationId: string;
  taskId: string;
  stepId: string;
  kind: string;
  boundary:
    | 'not_started'
    | 'before_mutation'
    | 'mutation_attempted'
    | 'verified'
    | 'final_dispatch_attempted';
  status: 'planned' | 'running' | 'reconciling' | 'ambiguous' | 'completed';
  resultRef?: string;
  updatedAt: number;
};

export type TaskRepositoryRecordV2 = {
  schemaVersion: typeof PHONE_TASK_V2_VERSION;
  task: PhoneTaskV2;
  events: TaskRepositoryEventV2[];
  activeOperation?: TaskRecoveryOperationV2;
  savedAt: number;
  expiresAt: number;
};

export type TaskRepositorySnapshotV2 = {
  schemaVersion: typeof PHONE_TASK_V2_VERSION;
  createdAt: number;
  records: Array<{
    record: TaskRepositoryRecordV2;
    checksum: string;
  }>;
};

export class TaskRevisionConflictV2Error extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Task ${taskId} revision conflict: expected ${expectedRevision}, received ${actualRevision}.`,
    );
    this.name = 'TaskRevisionConflictV2Error';
  }
}

export class ClientTaskConflictV2Error extends Error {
  constructor(readonly clientId: string, readonly taskId: string) {
    super(`Client ${clientId} already owns active task ${taskId}.`);
    this.name = 'ClientTaskConflictV2Error';
  }
}

export type TaskReplacementReasonV2 = 'start_over' | 'unrelated_task';

export interface PhoneTaskRepositoryV2 {
  cleanupExpired(): Promise<number>;
  commit(input: {
    expectedRevision: number;
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2>;
  create(input: {
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2>;
  delete(taskId: string): Promise<boolean>;
  exportSnapshot(): Promise<string>;
  getByClientId(clientId: string): Promise<TaskRepositoryRecordV2 | undefined>;
  getById(taskId: string): Promise<TaskRepositoryRecordV2 | undefined>;
  list(): Promise<TaskRepositoryRecordV2[]>;
  replaceForClient(input: {
    currentTaskId: string;
    expectedRevision: number;
    nextTask: PhoneTaskV2;
    reason: TaskReplacementReasonV2;
    replacedEvent: TaskRepositoryEventV2;
    createdEvent: TaskRepositoryEventV2;
  }): Promise<{
    replaced: TaskRepositoryRecordV2;
    created: TaskRepositoryRecordV2;
  }>;
  restoreSnapshot(serialized: string): Promise<{
    discarded: number;
    restored: number;
  }>;
}

type InMemoryRepositoryOptionsV2 = {
  beforeCommit?: (
    operation: 'commit' | 'create' | 'replace' | 'restore',
  ) => Promise<void> | void;
  maxEventsPerTask?: number;
  maxTasks?: number;
  now?: () => number;
  ttlMs?: number;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function parseEvent(value: unknown): TaskRepositoryEventV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid task repository event.');
  }
  const input = value as Record<string, unknown>;
  if (!Number.isInteger(input['taskRevision']) || (input['taskRevision'] as number) < 0) {
    throw new Error('Invalid task repository event revision.');
  }
  return {
    eventId: boundedIdentifier(input['eventId'], 'repository event identifier'),
    taskId: boundedIdentifier(input['taskId'], 'repository event task identifier'),
    taskRevision: input['taskRevision'] as number,
    at: timestamp(input['at'], 'repository event time'),
    kind: boundedIdentifier(input['kind'], 'repository event kind'),
    ...(input['dataRef'] === undefined
      ? {}
      : { dataRef: boundedIdentifier(input['dataRef'], 'repository event data reference') }),
  };
}

function parseOperation(value: unknown): TaskRecoveryOperationV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recovery operation.');
  }
  const input = value as Record<string, unknown>;
  const boundary = boundedIdentifier(input['boundary'], 'recovery operation boundary');
  const status = boundedIdentifier(input['status'], 'recovery operation status');
  if (![
    'not_started',
    'before_mutation',
    'mutation_attempted',
    'verified',
    'final_dispatch_attempted',
  ].includes(boundary)) {
    throw new Error('Invalid recovery operation boundary.');
  }
  if (!['planned', 'running', 'reconciling', 'ambiguous', 'completed'].includes(status)) {
    throw new Error('Invalid recovery operation status.');
  }
  return {
    operationId: boundedIdentifier(input['operationId'], 'recovery operation identifier'),
    taskId: boundedIdentifier(input['taskId'], 'recovery operation task identifier'),
    stepId: boundedIdentifier(input['stepId'], 'recovery operation step identifier'),
    kind: boundedIdentifier(input['kind'], 'recovery operation kind'),
    boundary: boundary as TaskRecoveryOperationV2['boundary'],
    status: status as TaskRecoveryOperationV2['status'],
    ...(input['resultRef'] === undefined
      ? {}
      : { resultRef: boundedIdentifier(input['resultRef'], 'recovery operation result reference') }),
    updatedAt: timestamp(input['updatedAt'], 'recovery operation update time'),
  };
}

function validateEventForTask(
  eventValue: TaskRepositoryEventV2,
  task: PhoneTaskV2,
): TaskRepositoryEventV2 {
  const event = parseEvent(eventValue);
  if (event.taskId !== task.taskId || event.taskRevision !== task.revision) {
    throw new Error('Repository event does not describe the committed task revision.');
  }
  return event;
}

function validateOperationForTask(
  operationValue: TaskRecoveryOperationV2 | undefined,
  task: PhoneTaskV2,
): TaskRecoveryOperationV2 | undefined {
  if (!operationValue) return undefined;
  const operation = parseOperation(operationValue);
  if (
    operation.taskId !== task.taskId
    || !task.steps.some((step) => step.stepId === operation.stepId)
  ) {
    throw new Error('Recovery operation does not belong to the committed task.');
  }
  return operation;
}

function checksum(record: TaskRepositoryRecordV2): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function cloneRecord(record: TaskRepositoryRecordV2): TaskRepositoryRecordV2 {
  return structuredClone(record);
}

function cancelledReplacement(
  task: PhoneTaskV2,
  event: TaskRepositoryEventV2,
): PhoneTaskV2 {
  const journalEntry: TaskJournalEntryV2 = {
    entryId: event.eventId,
    at: event.at,
    type: event.kind,
    ...(event.dataRef ? { dataRef: event.dataRef } : {}),
  };
  if (task.journal.some((entry) => entry.entryId === event.eventId)) {
    throw new Error('Replacement event already exists in task journal.');
  }
  if (task.journal.length >= task.budgets.maxJournalEntries) {
    throw new Error('Replacement exceeds the task journal budget.');
  }
  return parsePhoneTaskV2({
    ...task,
    revision: task.revision + 1,
    status: 'cancelled',
    activeStepId: undefined,
    pendingInteraction: undefined,
    journal: [...task.journal, journalEntry],
    updatedAt: event.at,
    terminalAt: event.at,
  });
}

export class InMemoryPhoneTaskRepositoryV2 implements PhoneTaskRepositoryV2 {
  private byClientId = new Map<string, string>();
  private byTaskId = new Map<string, TaskRepositoryRecordV2>();
  private readonly beforeCommit?: InMemoryRepositoryOptionsV2['beforeCommit'];
  private readonly maxEventsPerTask: number;
  private readonly maxTasks: number;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(options: InMemoryRepositoryOptionsV2 = {}) {
    this.beforeCommit = options.beforeCommit;
    this.maxEventsPerTask = options.maxEventsPerTask ?? 200;
    this.maxTasks = options.maxTasks ?? 100;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    if (
      !Number.isSafeInteger(this.maxEventsPerTask)
      || this.maxEventsPerTask < 1
      || !Number.isSafeInteger(this.maxTasks)
      || this.maxTasks < 1
      || !Number.isFinite(this.ttlMs)
      || this.ttlMs <= 0
    ) {
      throw new Error('Invalid V2 repository bounds.');
    }
  }

  async create(input: {
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2> {
    const task = parsePhoneTaskV2(structuredClone(input.task));
    const event = validateEventForTask(input.event, task);
    const operation = validateOperationForTask(input.activeOperation, task);
    if (this.byTaskId.has(task.taskId)) {
      throw new TaskRevisionConflictV2Error(task.taskId, -1, task.revision);
    }
    const clientTaskId = this.byClientId.get(task.clientId);
    if (clientTaskId) throw new ClientTaskConflictV2Error(task.clientId, clientTaskId);
    if (this.byTaskId.size >= this.maxTasks) throw new Error('Task repository capacity reached.');
    await this.beforeCommit?.('create');
    if (this.byTaskId.has(task.taskId)) {
      throw new TaskRevisionConflictV2Error(task.taskId, -1, task.revision);
    }
    const currentClientTaskId = this.byClientId.get(task.clientId);
    if (currentClientTaskId) {
      throw new ClientTaskConflictV2Error(task.clientId, currentClientTaskId);
    }
    if (this.byTaskId.size >= this.maxTasks) {
      throw new Error('Task repository capacity reached.');
    }
    const savedAt = this.now();
    const record: TaskRepositoryRecordV2 = {
      schemaVersion: PHONE_TASK_V2_VERSION,
      task,
      events: [event],
      ...(operation ? { activeOperation: operation } : {}),
      savedAt,
      expiresAt: savedAt + this.ttlMs,
    };
    this.byTaskId.set(task.taskId, record);
    this.byClientId.set(task.clientId, task.taskId);
    return cloneRecord(record);
  }

  async commit(input: {
    expectedRevision: number;
    task: PhoneTaskV2;
    event: TaskRepositoryEventV2;
    activeOperation?: TaskRecoveryOperationV2;
  }): Promise<TaskRepositoryRecordV2> {
    const task = parsePhoneTaskV2(structuredClone(input.task));
    const event = validateEventForTask(input.event, task);
    const operation = validateOperationForTask(input.activeOperation, task);
    const initial = this.byTaskId.get(task.taskId);
    this.assertRevision(initial, task.taskId, input.expectedRevision);
    if (task.revision !== input.expectedRevision + 1) {
      throw new TaskRevisionConflictV2Error(
        task.taskId,
        input.expectedRevision + 1,
        task.revision,
      );
    }
    if (initial!.task.clientId !== task.clientId) {
      throw new Error('A task commit cannot change task ownership.');
    }
    assertVerifiedStepsImmutable(initial!.task, task);
    if (initial!.events.some((entry) => entry.eventId === event.eventId)) {
      throw new Error('Duplicate repository event identifier.');
    }
    if (initial!.events.length >= this.maxEventsPerTask) {
      throw new Error('Task event budget is exhausted.');
    }
    await this.beforeCommit?.('commit');
    const current = this.byTaskId.get(task.taskId);
    this.assertRevision(current, task.taskId, input.expectedRevision);
    const savedAt = this.now();
    const next: TaskRepositoryRecordV2 = {
      schemaVersion: PHONE_TASK_V2_VERSION,
      task,
      events: [...current!.events, event],
      ...(operation ? { activeOperation: operation } : {}),
      savedAt,
      expiresAt: savedAt + this.ttlMs,
    };
    this.byTaskId.set(task.taskId, next);
    return cloneRecord(next);
  }

  async getById(taskId: string): Promise<TaskRepositoryRecordV2 | undefined> {
    const record = this.byTaskId.get(taskId);
    if (!record) return undefined;
    if (record.expiresAt <= this.now()) {
      await this.delete(taskId);
      return undefined;
    }
    return cloneRecord(record);
  }

  async getByClientId(
    clientId: string,
  ): Promise<TaskRepositoryRecordV2 | undefined> {
    const taskId = this.byClientId.get(clientId);
    return taskId ? this.getById(taskId) : undefined;
  }

  async list(): Promise<TaskRepositoryRecordV2[]> {
    await this.cleanupExpired();
    return [...this.byTaskId.values()].map(cloneRecord);
  }

  async delete(taskId: string): Promise<boolean> {
    const record = this.byTaskId.get(taskId);
    if (!record) return false;
    this.byTaskId.delete(taskId);
    if (this.byClientId.get(record.task.clientId) === taskId) {
      this.byClientId.delete(record.task.clientId);
    }
    return true;
  }

  async cleanupExpired(): Promise<number> {
    const expired = [...this.byTaskId.values()]
      .filter((record) => record.expiresAt <= this.now())
      .map((record) => record.task.taskId);
    for (const taskId of expired) await this.delete(taskId);
    return expired.length;
  }

  async replaceForClient(input: {
    currentTaskId: string;
    expectedRevision: number;
    nextTask: PhoneTaskV2;
    reason: TaskReplacementReasonV2;
    replacedEvent: TaskRepositoryEventV2;
    createdEvent: TaskRepositoryEventV2;
  }): Promise<{
    replaced: TaskRepositoryRecordV2;
    created: TaskRepositoryRecordV2;
  }> {
    const initial = this.byTaskId.get(input.currentTaskId);
    this.assertRevision(initial, input.currentTaskId, input.expectedRevision);
    const nextTask = parsePhoneTaskV2(structuredClone(input.nextTask));
    if (
      nextTask.taskId === input.currentTaskId
      || nextTask.clientId !== initial!.task.clientId
      || this.byTaskId.has(nextTask.taskId)
    ) {
      throw new Error('Invalid explicit task replacement.');
    }
    if (!['start_over', 'unrelated_task'].includes(input.reason)) {
      throw new Error('Task replacement requires an explicit reason.');
    }
    if (
      initial!.activeOperation
      || initial!.task.steps.some((step) =>
        Boolean(step.operationId)
        && ['running', 'ambiguous', 'blocked'].includes(step.status))
    ) {
      throw new Error('Task replacement requires operation reconciliation.');
    }
    const replacementEvent = parseEvent(input.replacedEvent);
    if (
      replacementEvent.taskId !== initial!.task.taskId
      || replacementEvent.taskRevision !== initial!.task.revision + 1
    ) {
      throw new Error('Replacement event does not target the cancelled revision.');
    }
    const creationEvent = validateEventForTask(input.createdEvent, nextTask);
    const cancelled = cancelledReplacement(initial!.task, replacementEvent);
    await this.beforeCommit?.('replace');
    const current = this.byTaskId.get(input.currentTaskId);
    this.assertRevision(current, input.currentTaskId, input.expectedRevision);
    if (this.byTaskId.has(nextTask.taskId)) {
      throw new TaskRevisionConflictV2Error(nextTask.taskId, -1, nextTask.revision);
    }
    const savedAt = this.now();
    const replaced: TaskRepositoryRecordV2 = {
      schemaVersion: PHONE_TASK_V2_VERSION,
      task: cancelled,
      events: [...current!.events, replacementEvent],
      savedAt,
      expiresAt: savedAt + this.ttlMs,
    };
    const created: TaskRepositoryRecordV2 = {
      schemaVersion: PHONE_TASK_V2_VERSION,
      task: nextTask,
      events: [creationEvent],
      savedAt,
      expiresAt: savedAt + this.ttlMs,
    };
    this.byTaskId.set(replaced.task.taskId, replaced);
    this.byTaskId.set(created.task.taskId, created);
    this.byClientId.set(created.task.clientId, created.task.taskId);
    return {
      replaced: cloneRecord(replaced),
      created: cloneRecord(created),
    };
  }

  async exportSnapshot(): Promise<string> {
    await this.cleanupExpired();
    const snapshot: TaskRepositorySnapshotV2 = {
      schemaVersion: PHONE_TASK_V2_VERSION,
      createdAt: this.now(),
      records: [...this.byTaskId.values()].map((record) => ({
        record: cloneRecord(record),
        checksum: checksum(record),
      })),
    };
    return JSON.stringify(snapshot);
  }

  async restoreSnapshot(serialized: string): Promise<{
    discarded: number;
    restored: number;
  }> {
    const parsed = JSON.parse(serialized) as Partial<TaskRepositorySnapshotV2>;
    if (
      parsed.schemaVersion !== PHONE_TASK_V2_VERSION
      || !Array.isArray(parsed.records)
    ) {
      throw new Error('Invalid V2 repository snapshot.');
    }
    const stagedByTask = new Map<string, TaskRepositoryRecordV2>();
    const stagedByClient = new Map<string, string>();
    let discarded = 0;
    for (const envelope of parsed.records) {
      try {
        if (!envelope || typeof envelope !== 'object') throw new Error('Invalid record.');
        const record = structuredClone(envelope.record);
        if (!record || checksum(record) !== envelope.checksum) {
          throw new Error('Corrupt repository record.');
        }
        const task = parsePhoneTaskV2(record.task);
        const events = record.events.map(parseEvent);
        if (
          record.schemaVersion !== PHONE_TASK_V2_VERSION
          || record.expiresAt <= this.now()
          || events.some((event) => event.taskId !== task.taskId)
          || events.some((event) => event.taskRevision > task.revision)
          || new Set(events.map((event) => event.eventId)).size !== events.length
          || events.length > this.maxEventsPerTask
          || stagedByTask.has(task.taskId)
          || (
            !TERMINAL_TASK_STATUSES_V2.has(task.status)
            && stagedByClient.has(task.clientId)
          )
        ) {
          throw new Error('Invalid or expired repository record.');
        }
        const operation = record.activeOperation
          ? validateOperationForTask(record.activeOperation, task)
          : undefined;
        const restored: TaskRepositoryRecordV2 = {
          schemaVersion: PHONE_TASK_V2_VERSION,
          task,
          events,
          ...(operation ? { activeOperation: operation } : {}),
          savedAt: timestamp(record.savedAt, 'repository save time'),
          expiresAt: timestamp(record.expiresAt, 'repository expiry time'),
        };
        if (restored.expiresAt <= restored.savedAt) {
          throw new Error('Repository expiry must follow its save time.');
        }
        stagedByTask.set(task.taskId, restored);
        if (!TERMINAL_TASK_STATUSES_V2.has(task.status)) {
          stagedByClient.set(task.clientId, task.taskId);
        }
      } catch {
        discarded += 1;
      }
    }
    if (stagedByTask.size > this.maxTasks) {
      throw new Error('Restored snapshot exceeds repository capacity.');
    }
    await this.beforeCommit?.('restore');
    this.byTaskId = stagedByTask;
    this.byClientId = stagedByClient;
    return { discarded, restored: stagedByTask.size };
  }

  private assertRevision(
    record: TaskRepositoryRecordV2 | undefined,
    taskId: string,
    expectedRevision: number,
  ): void {
    const actual = record?.task.revision ?? -1;
    if (actual !== expectedRevision) {
      throw new TaskRevisionConflictV2Error(taskId, expectedRevision, actual);
    }
  }
}
