import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../identifiers';
import {
  BACKGROUND_PHONE_OPERATION_VERSION,
  type BackgroundPhoneOperationEnqueueInputV2,
  type BackgroundPhoneOperationRecordV2,
  type BackgroundPhoneOperationTerminalStatusV2,
} from './contracts';

const MAX_STEP_ID_LENGTH = 120;
const MAX_OPERATION_KIND_LENGTH = 120;
const MAX_DETAIL_LENGTH = 300;
const MAX_RESULT_REF_LENGTH = 240;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export type BackgroundPhoneOperationEnqueueResultV2 =
  | {
    disposition: 'enqueued' | 'duplicate';
    operation: BackgroundPhoneOperationRecordV2;
  }
  | {
    disposition: 'task_busy';
    operation: BackgroundPhoneOperationRecordV2;
  };

export interface BackgroundPhoneOperationStoreV2 {
  claim(
    operationId: LocalIdentifier<'operation'>,
    startedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined>;
  complete(input: {
    operationId: LocalIdentifier<'operation'>;
    outcome: BackgroundPhoneOperationTerminalStatusV2;
    terminalAt: number;
    detail?: string;
    resultRef?: string;
  }): Promise<BackgroundPhoneOperationRecordV2>;
  enqueue(input: {
    operationId: LocalIdentifier<'operation'>;
    acceptedAt: number;
    request: BackgroundPhoneOperationEnqueueInputV2;
  }): Promise<BackgroundPhoneOperationEnqueueResultV2>;
  exportSnapshot(): Promise<string>;
  get(
    operationId: LocalIdentifier<'operation'>,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined>;
  listTerminalOperations(): Promise<BackgroundPhoneOperationRecordV2[]>;
  listQueued(taskId?: LocalIdentifier<'task'>):
    Promise<BackgroundPhoneOperationRecordV2[]>;
  markMutationAttempted(
    operationId: LocalIdentifier<'operation'>,
    attemptedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2>;
  markTerminalEventPublished(
    operationId: LocalIdentifier<'operation'>,
    publishedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2>;
  recoverInterrupted(recoveredAt: number): Promise<number>;
  restoreSnapshot(serialized: string): Promise<{ restored: number }>;
}

type SnapshotV2 = {
  version: 2;
  operations: BackgroundPhoneOperationRecordV2[];
};

function boundedText(
  value: unknown,
  field: string,
  maximum: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${field} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function timestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer timestamp.`);
  }
  return value as number;
}

function safePayload(payload: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new Error('requestPayload must be JSON serializable.');
  }
  if (serialized === undefined) {
    throw new Error('requestPayload must be JSON serializable.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`requestPayload must not exceed ${MAX_PAYLOAD_BYTES} bytes.`);
  }
  return JSON.parse(serialized) as unknown;
}

function validateRequest(
  request: BackgroundPhoneOperationEnqueueInputV2,
): BackgroundPhoneOperationEnqueueInputV2 {
  return {
    taskId: parseLocalIdentifier('task', request.taskId),
    ...(request.itemId
      ? { itemId: parseLocalIdentifier('task_item', request.itemId) }
      : {}),
    taskRevision: timestamp(request.taskRevision, 'taskRevision'),
    stepId: boundedText(
      request.stepId,
      'stepId',
      MAX_STEP_ID_LENGTH,
    ) as string,
    operationKind: boundedText(
      request.operationKind,
      'operationKind',
      MAX_OPERATION_KIND_LENGTH,
    ) as string,
    requestPayload: safePayload(request.requestPayload),
  };
}

function validateRecord(
  value: BackgroundPhoneOperationRecordV2,
): BackgroundPhoneOperationRecordV2 {
  if (!value || value.version !== BACKGROUND_PHONE_OPERATION_VERSION) {
    throw new Error('Unsupported background operation record.');
  }
  if (
    ![
      'queued',
      'running',
      'mutation_attempted',
      'completed',
      'failed',
      'ambiguous',
    ].includes(value.status)
  ) {
    throw new Error('Unsupported background operation status.');
  }
  const request = validateRequest(value);
  const createdAt = timestamp(value.createdAt, 'createdAt');
  const updatedAt = timestamp(value.updatedAt, 'updatedAt');
  const startedAt = value.startedAt === undefined
    ? undefined
    : timestamp(value.startedAt, 'startedAt');
  const mutationAttemptedAt = value.mutationAttemptedAt === undefined
    ? undefined
    : timestamp(value.mutationAttemptedAt, 'mutationAttemptedAt');
  const terminalAt = value.terminalAt === undefined
    ? undefined
    : timestamp(value.terminalAt, 'terminalAt');
  const terminalEventPublishedAt =
    value.terminalEventPublishedAt === undefined
      ? undefined
      : timestamp(
          value.terminalEventPublishedAt,
          'terminalEventPublishedAt',
        );
  if (
    !Number.isSafeInteger(value.attempts)
    || value.attempts < 0
    || !Number.isSafeInteger(value.recoveryCount)
    || value.recoveryCount < 0
  ) {
    throw new Error('Operation counters must be non-negative integers.');
  }
  const isTerminal = ['completed', 'failed', 'ambiguous'].includes(value.status);
  if (isTerminal !== (terminalAt !== undefined)) {
    throw new Error('Terminal operations must contain terminalAt.');
  }
  if (
    mutationAttemptedAt !== undefined
    && (
      startedAt === undefined
      || mutationAttemptedAt < startedAt
      || (terminalAt !== undefined && mutationAttemptedAt > terminalAt)
    )
  ) {
    throw new Error(
      'mutationAttemptedAt must be within the started operation interval.',
    );
  }
  if (
    (value.status === 'mutation_attempted')
    !== (mutationAttemptedAt !== undefined && !isTerminal)
    && !isTerminal
  ) {
    throw new Error(
      'Only mutation-attempted or terminal operations may retain a mutation boundary.',
    );
  }
  return {
    version: BACKGROUND_PHONE_OPERATION_VERSION,
    operationId: parseLocalIdentifier('operation', value.operationId),
    ...request,
    status: value.status,
    attempts: value.attempts,
    recoveryCount: value.recoveryCount,
    createdAt,
    updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(mutationAttemptedAt === undefined
      ? {}
      : { mutationAttemptedAt }),
    ...(terminalAt === undefined ? {} : { terminalAt }),
    ...(boundedText(
      value.resultRef,
      'resultRef',
      MAX_RESULT_REF_LENGTH,
      true,
    ) === undefined
      ? {}
      : {
          resultRef: boundedText(
            value.resultRef,
            'resultRef',
            MAX_RESULT_REF_LENGTH,
          ) as string,
        }),
    ...(boundedText(value.detail, 'detail', MAX_DETAIL_LENGTH, true) === undefined
      ? {}
      : {
          detail: boundedText(
            value.detail,
            'detail',
            MAX_DETAIL_LENGTH,
          ) as string,
        }),
    ...(terminalEventPublishedAt === undefined
      ? {}
      : { terminalEventPublishedAt }),
  };
}

function clone(
  operation: BackgroundPhoneOperationRecordV2,
): BackgroundPhoneOperationRecordV2 {
  return structuredClone(operation);
}

function isTerminal(operation: BackgroundPhoneOperationRecordV2): boolean {
  return ['completed', 'failed', 'ambiguous'].includes(operation.status);
}

export class InMemoryBackgroundPhoneOperationStoreV2
implements BackgroundPhoneOperationStoreV2 {
  private operations = new Map<string, BackgroundPhoneOperationRecordV2>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly maxOperations = 128) {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) {
      throw new Error('maxOperations must be a positive integer.');
    }
  }

  async claim(
    operationId: LocalIdentifier<'operation'>,
    startedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined> {
    return this.mutate(() => {
      const current = this.operations.get(operationId);
      if (!current || current.status !== 'queued') return undefined;
      const at = timestamp(startedAt, 'startedAt');
      const claimed: BackgroundPhoneOperationRecordV2 = {
        ...current,
        status: 'running',
        attempts: current.attempts + 1,
        startedAt: at,
        updatedAt: at,
      };
      this.operations.set(operationId, claimed);
      return clone(claimed);
    });
  }

  async complete(input: {
    operationId: LocalIdentifier<'operation'>;
    outcome: BackgroundPhoneOperationTerminalStatusV2;
    terminalAt: number;
    detail?: string;
    resultRef?: string;
  }): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(() => {
      const current = this.operations.get(input.operationId);
      if (!current) throw new Error('Background operation was not found.');
      if (
        current.status !== 'running'
        && current.status !== 'mutation_attempted'
      ) {
        if (current.status === input.outcome) return clone(current);
        throw new Error('Only a running operation can become terminal.');
      }
      const terminalAt = timestamp(input.terminalAt, 'terminalAt');
      const detail = boundedText(
        input.detail,
        'detail',
        MAX_DETAIL_LENGTH,
        true,
      );
      const resultRef = boundedText(
        input.resultRef,
        'resultRef',
        MAX_RESULT_REF_LENGTH,
        true,
      );
      const completed: BackgroundPhoneOperationRecordV2 = {
        ...current,
        status: input.outcome,
        terminalAt,
        updatedAt: terminalAt,
        ...(detail === undefined ? {} : { detail }),
        ...(resultRef === undefined ? {} : { resultRef }),
      };
      this.operations.set(input.operationId, completed);
      return clone(completed);
    });
  }

  async enqueue(input: {
    operationId: LocalIdentifier<'operation'>;
    acceptedAt: number;
    request: BackgroundPhoneOperationEnqueueInputV2;
  }): Promise<BackgroundPhoneOperationEnqueueResultV2> {
    return this.mutate(() => {
      const request = validateRequest(input.request);
      const acceptedAt = timestamp(input.acceptedAt, 'acceptedAt');
      const operationId = parseLocalIdentifier(
        'operation',
        input.operationId,
      );
      for (const operation of this.operations.values()) {
        if (
          operation.taskId === request.taskId
          && operation.stepId === request.stepId
          && operation.taskRevision === request.taskRevision
        ) {
          return {
            disposition: 'duplicate' as const,
            operation: clone(operation),
          };
        }
      }
      for (const operation of this.operations.values()) {
        if (operation.taskId === request.taskId && !isTerminal(operation)) {
          return {
            disposition: 'task_busy' as const,
            operation: clone(operation),
          };
        }
      }
      this.ensureCapacity();
      const operation: BackgroundPhoneOperationRecordV2 = {
        version: BACKGROUND_PHONE_OPERATION_VERSION,
        operationId,
        ...request,
        status: 'queued',
        attempts: 0,
        recoveryCount: 0,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
      };
      this.operations.set(operationId, operation);
      return {
        disposition: 'enqueued' as const,
        operation: clone(operation),
      };
    });
  }

  async exportSnapshot(): Promise<string> {
    await this.mutationTail;
    const snapshot: SnapshotV2 = {
      version: 2,
      operations: [...this.operations.values()].map(clone),
    };
    return JSON.stringify(snapshot);
  }

  async get(
    operationId: LocalIdentifier<'operation'>,
  ): Promise<BackgroundPhoneOperationRecordV2 | undefined> {
    await this.mutationTail;
    const operation = this.operations.get(operationId);
    return operation ? clone(operation) : undefined;
  }

  async listTerminalOperations():
  Promise<BackgroundPhoneOperationRecordV2[]> {
    await this.mutationTail;
    return [...this.operations.values()]
      .filter(isTerminal)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .map(clone);
  }

  async listQueued(
    taskId?: LocalIdentifier<'task'>,
  ): Promise<BackgroundPhoneOperationRecordV2[]> {
    await this.mutationTail;
    return [...this.operations.values()]
      .filter((operation) =>
        operation.status === 'queued'
        && (taskId === undefined || operation.taskId === taskId)
      )
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  }

  async markTerminalEventPublished(
    operationId: LocalIdentifier<'operation'>,
    publishedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(() => {
      const current = this.operations.get(operationId);
      if (!current || !isTerminal(current)) {
        throw new Error('Only a terminal operation can publish its event.');
      }
      if (current.terminalEventPublishedAt !== undefined) {
        return clone(current);
      }
      const updated = {
        ...current,
        terminalEventPublishedAt: timestamp(publishedAt, 'publishedAt'),
      };
      this.operations.set(operationId, updated);
      return clone(updated);
    });
  }

  async markMutationAttempted(
    operationId: LocalIdentifier<'operation'>,
    attemptedAt: number,
  ): Promise<BackgroundPhoneOperationRecordV2> {
    return this.mutate(() => {
      const current = this.operations.get(operationId);
      if (!current) throw new Error('Background operation was not found.');
      if (current.status === 'mutation_attempted') return clone(current);
      if (current.status !== 'running') {
        throw new Error(
          'Only a running operation can cross the mutation boundary.',
        );
      }
      const at = timestamp(attemptedAt, 'attemptedAt');
      if (current.startedAt === undefined || at < current.startedAt) {
        throw new Error(
          'Mutation attempt time must not precede worker start.',
        );
      }
      const marked: BackgroundPhoneOperationRecordV2 = {
        ...current,
        status: 'mutation_attempted',
        mutationAttemptedAt: at,
        updatedAt: at,
      };
      this.operations.set(operationId, marked);
      return clone(marked);
    });
  }

  async recoverInterrupted(recoveredAt: number): Promise<number> {
    return this.mutate(() => {
      const at = timestamp(recoveredAt, 'recoveredAt');
      let recovered = 0;
      for (const [operationId, current] of this.operations) {
        if (
          current.status !== 'running'
          && current.status !== 'mutation_attempted'
        ) continue;
        this.operations.set(operationId, current.status === 'running'
          ? {
              ...current,
              status: 'queued',
              recoveryCount: current.recoveryCount + 1,
              updatedAt: at,
            }
          : {
              ...current,
              status: 'ambiguous',
              recoveryCount: current.recoveryCount + 1,
              terminalAt: at,
              updatedAt: at,
              detail:
                'Restart found a possibly-started mutation; read-only reconciliation is required.',
            });
        recovered += 1;
      }
      return recovered;
    });
  }

  async restoreSnapshot(serialized: string): Promise<{ restored: number }> {
    return this.mutate(() => {
      const parsed = JSON.parse(serialized) as Partial<SnapshotV2>;
      if (parsed.version !== 2 || !Array.isArray(parsed.operations)) {
        throw new Error('Unsupported background operation snapshot.');
      }
      if (parsed.operations.length > this.maxOperations) {
        throw new Error('Background operation snapshot exceeds capacity.');
      }
      const restored = new Map<string, BackgroundPhoneOperationRecordV2>();
      for (const raw of parsed.operations) {
        const operation = validateRecord(raw);
        if (restored.has(operation.operationId)) {
          throw new Error('Background operation snapshot contains duplicates.');
        }
        restored.set(operation.operationId, operation);
      }
      this.operations = restored;
      return { restored: restored.size };
    });
  }

  private ensureCapacity(): void {
    if (this.operations.size < this.maxOperations) return;
    const terminal = [...this.operations.values()]
      .filter(isTerminal)
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (!terminal) {
      throw new Error('Background operation capacity is exhausted.');
    }
    this.operations.delete(terminal.operationId);
  }

  private async mutate<T>(operation: () => T): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}
