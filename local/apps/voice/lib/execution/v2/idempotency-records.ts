import {
  newLocalIdentifier,
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../workflow/identifiers';
import type {
  DesiredCartStateV2,
  MutationOutcomeV2,
  OperationIdempotencyRecordV2,
  ReconciliationDecisionV2,
  RegisterOperationResultV2,
} from './contracts';
import { desiredCartStateDigestV2 } from './desired-cart-state';
import { stableExecutionFingerprintV2 } from './fingerprint';
import type { OperationIdempotencyPersistenceV2 } from './file-idempotency-persistence';

type RegistryOptionsV2 = {
  maxCallIdsPerOperation?: number;
  maxRecords?: number;
  now?: () => number;
  persistence?: OperationIdempotencyPersistenceV2;
  recordTtlMs?: number;
  newOperationId?: () => LocalIdentifier<'operation'>;
};

type RegisterOperationInputV2 = {
  callId: string;
  desired: DesiredCartStateV2;
  operationId?: LocalIdentifier<'operation'> | string;
};

const cloneRecord = (
  record: OperationIdempotencyRecordV2,
): OperationIdempotencyRecordV2 => structuredClone(record);

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boundedCallId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error('callId must contain 1-240 characters.');
  }
  return normalized;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validPersistedRecord(
  value: unknown,
  maxCallIds: number,
): value is OperationIdempotencyRecordV2 {
  const record = recordValue(value);
  try {
    if (
      record['version'] !== 2
      || parseLocalIdentifier('operation', record['operationId'])
        !== record['operationId']
      || parseLocalIdentifier('task', record['taskId']) !== record['taskId']
      || (
        record['itemId'] !== undefined
        && parseLocalIdentifier('task_item', record['itemId'])
          !== record['itemId']
      )
      || typeof record['stepKey'] !== 'string'
      || !record['stepKey'].trim()
      || record['stepKey'].length > 240
      || typeof record['desiredStateDigest'] !== 'string'
      || !/^exec_v2_[a-f0-9]{8}$/.test(record['desiredStateDigest'])
      || typeof record['semanticKey'] !== 'string'
      || !/^exec_v2_[a-f0-9]{8}$/.test(record['semanticKey'])
      || !Array.isArray(record['callIds'])
      || record['callIds'].length < 1
      || record['callIds'].length > maxCallIds
      || new Set(record['callIds']).size !== record['callIds'].length
      || !record['callIds'].every((callId) => {
        try {
          return boundedCallId(callId) === callId;
        } catch {
          return false;
        }
      })
      || !['pending', 'outcome_recorded', 'reconciled'].includes(
        String(record['status'] ?? ''),
      )
      || !validTimestamp(record['createdAt'])
      || !validTimestamp(record['updatedAt'])
      || !validTimestamp(record['expiresAt'])
      || record['updatedAt'] < record['createdAt']
      || record['expiresAt'] < record['updatedAt']
      || (
        record['advanceClaimedAt'] !== undefined
        && !validTimestamp(record['advanceClaimedAt'])
      )
    ) {
      return false;
    }
    const expectedSemanticKey = stableExecutionFingerprintV2({
      taskId: record['taskId'],
      itemId: record['itemId'],
      stepKey: record['stepKey'],
      desiredStateDigest: record['desiredStateDigest'],
    });
    if (record['semanticKey'] !== expectedSemanticKey) return false;
    const outcome = recordValue(record['outcome']);
    if (record['status'] === 'pending') {
      return record['outcome'] === undefined
        && record['advanceClaimedAt'] === undefined;
    }
    if (
      ![
        'ambiguous',
        'failed_before_mutation',
        'mutation_unverified',
        'verified',
      ].includes(String(outcome['kind'] ?? ''))
      || typeof outcome['mutationAttempted'] !== 'boolean'
      || typeof outcome['reason'] !== 'string'
      || typeof outcome['retryPolicy'] !== 'string'
      || typeof outcome['evidence'] !== 'object'
      || recordValue(outcome['evidence'])['desiredStateDigest']
        !== record['desiredStateDigest']
      || (
        record['advanceClaimedAt'] !== undefined
        && outcome['kind'] !== 'verified'
      )
      || (
        record['status'] === 'reconciled'
        && !['ambiguous', 'verified'].includes(String(outcome['kind']))
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export class OperationIdempotencyRegistryV2 {
  private readonly records = new Map<
    LocalIdentifier<'operation'>,
    OperationIdempotencyRecordV2
  >();

  private readonly operationByCallId = new Map<
    string,
    LocalIdentifier<'operation'>
  >();

  private readonly operationBySemanticKey = new Map<
    string,
    LocalIdentifier<'operation'>
  >();

  private readonly maxCallIdsPerOperation: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly persistence?: OperationIdempotencyPersistenceV2;
  private readonly recordTtlMs: number;
  private readonly newOperationId: () => LocalIdentifier<'operation'>;
  private transactionDepth = 0;

  constructor(options: RegistryOptionsV2 = {}) {
    this.maxCallIdsPerOperation = positiveInteger(
      options.maxCallIdsPerOperation ?? 16,
      'maxCallIdsPerOperation',
    );
    this.maxRecords = positiveInteger(options.maxRecords ?? 1_024, 'maxRecords');
    this.recordTtlMs = positiveInteger(
      options.recordTtlMs ?? 24 * 60 * 60 * 1_000,
      'recordTtlMs',
    );
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.newOperationId = options.newOperationId
      ?? (() => newLocalIdentifier('operation'));
  }

  register(input: RegisterOperationInputV2): RegisterOperationResultV2 {
    return this.transaction(() => this.registerLocal(input));
  }

  private registerLocal(
    input: RegisterOperationInputV2,
  ): RegisterOperationResultV2 {
    this.cleanup();
    const callId = boundedCallId(input.callId);
    const desiredStateDigest = desiredCartStateDigestV2(input.desired);
    const semanticKey = stableExecutionFingerprintV2({
      taskId: input.desired.taskId,
      itemId: input.desired.itemId,
      stepKey: input.desired.stepKey,
      desiredStateDigest,
    });
    const operationForCall = this.operationByCallId.get(callId);
    if (operationForCall) {
      const record = this.records.get(operationForCall)!;
      return {
        accepted: false,
        disposition: record.semanticKey === semanticKey
          ? 'duplicate_call_id'
          : 'call_id_conflict',
        record: cloneRecord(record),
      };
    }
    const semanticOperation = this.operationBySemanticKey.get(semanticKey);
    if (semanticOperation) {
      const record = this.records.get(semanticOperation)!;
      const callIds = [...record.callIds, callId];
      while (callIds.length > this.maxCallIdsPerOperation) {
        const removed = callIds.shift()!;
        this.operationByCallId.delete(removed);
      }
      const updated = {
        ...record,
        callIds,
        updatedAt: this.now(),
      };
      this.records.set(record.operationId, updated);
      this.operationByCallId.set(callId, record.operationId);
      return {
        accepted: false,
        disposition: 'semantic_duplicate',
        record: cloneRecord(updated),
      };
    }
    const operationId = input.operationId
      ? parseLocalIdentifier('operation', input.operationId)
      : this.newOperationId();
    if (this.records.has(operationId)) {
      throw new Error(`Operation ${operationId} already exists.`);
    }
    const now = this.now();
    const record: OperationIdempotencyRecordV2 = {
      version: 2,
      operationId,
      taskId: input.desired.taskId,
      ...(input.desired.itemId ? { itemId: input.desired.itemId } : {}),
      stepKey: input.desired.stepKey,
      semanticKey,
      desiredStateDigest,
      callIds: [callId],
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.recordTtlMs,
    };
    this.records.set(operationId, record);
    this.operationByCallId.set(callId, operationId);
    this.operationBySemanticKey.set(semanticKey, operationId);
    this.evictOldest();
    return {
      accepted: true,
      disposition: 'created',
      record: cloneRecord(record),
    };
  }

  get(
    operationId: LocalIdentifier<'operation'> | string,
  ): OperationIdempotencyRecordV2 | undefined {
    return this.transaction(() => this.getLocal(operationId));
  }

  private getLocal(
    operationId: LocalIdentifier<'operation'> | string,
  ): OperationIdempotencyRecordV2 | undefined {
    this.cleanup();
    const parsed = parseLocalIdentifier('operation', operationId);
    const record = this.records.get(parsed);
    return record ? cloneRecord(record) : undefined;
  }

  recordAttemptOutcome(
    operationId: LocalIdentifier<'operation'> | string,
    outcome: MutationOutcomeV2,
  ): OperationIdempotencyRecordV2 {
    return this.transaction(
      () => this.recordAttemptOutcomeLocal(operationId, outcome),
    );
  }

  private recordAttemptOutcomeLocal(
    operationId: LocalIdentifier<'operation'> | string,
    outcome: MutationOutcomeV2,
  ): OperationIdempotencyRecordV2 {
    const record = this.require(operationId);
    if (record.outcome) {
      if (
        stableExecutionFingerprintV2(record.outcome)
        === stableExecutionFingerprintV2(outcome)
      ) {
        return cloneRecord(record);
      }
      throw new Error(`Operation ${record.operationId} already has an outcome.`);
    }
    return this.update(record, {
      outcome,
      status: 'outcome_recorded',
    });
  }

  recordReconciliationOutcome(
    operationId: LocalIdentifier<'operation'> | string,
    outcome: Extract<MutationOutcomeV2, { kind: 'ambiguous' | 'verified' }>,
  ): OperationIdempotencyRecordV2 {
    return this.transaction(
      () => this.recordReconciliationOutcomeLocal(operationId, outcome),
    );
  }

  private recordReconciliationOutcomeLocal(
    operationId: LocalIdentifier<'operation'> | string,
    outcome: Extract<MutationOutcomeV2, { kind: 'ambiguous' | 'verified' }>,
  ): OperationIdempotencyRecordV2 {
    const record = this.require(operationId);
    if (
      !record.outcome
      || !['mutation_unverified', 'ambiguous'].includes(record.outcome.kind)
    ) {
      throw new Error(
        `Operation ${record.operationId} does not require reconciliation.`,
      );
    }
    return this.update(record, {
      outcome,
      status: 'reconciled',
    });
  }

  beginRetryAfterFailure(
    operationId: LocalIdentifier<'operation'> | string,
  ): OperationIdempotencyRecordV2 {
    return this.transaction(
      () => this.beginRetryAfterFailureLocal(operationId),
    );
  }

  private beginRetryAfterFailureLocal(
    operationId: LocalIdentifier<'operation'> | string,
  ): OperationIdempotencyRecordV2 {
    const record = this.require(operationId);
    if (record.outcome?.kind !== 'failed_before_mutation') {
      throw new Error(
        `Operation ${record.operationId} did not fail before mutation.`,
      );
    }
    return this.resetForRetry(record);
  }

  beginRetryAfterReconciliation(
    operationId: LocalIdentifier<'operation'> | string,
    decision: Extract<
      ReconciliationDecisionV2,
      { action: 'retry_desired_state' }
    >,
  ): OperationIdempotencyRecordV2 {
    return this.transaction(
      () => this.beginRetryAfterReconciliationLocal(operationId, decision),
    );
  }

  private beginRetryAfterReconciliationLocal(
    operationId: LocalIdentifier<'operation'> | string,
    decision: Extract<
      ReconciliationDecisionV2,
      { action: 'retry_desired_state' }
    >,
  ): OperationIdempotencyRecordV2 {
    const record = this.require(operationId);
    if (
      record.outcome?.kind !== 'mutation_unverified'
      || decision.reason !== 'fresh_snapshot_matches_pre_mutation'
    ) {
      throw new Error(
        `Operation ${record.operationId} is not eligible for a reconciled retry.`,
      );
    }
    return this.resetForRetry(record);
  }

  claimVerifiedAdvance(
    operationId: LocalIdentifier<'operation'> | string,
  ): { claimed: boolean; record: OperationIdempotencyRecordV2 } {
    return this.transaction(
      () => this.claimVerifiedAdvanceLocal(operationId),
    );
  }

  private claimVerifiedAdvanceLocal(
    operationId: LocalIdentifier<'operation'> | string,
  ): { claimed: boolean; record: OperationIdempotencyRecordV2 } {
    const record = this.require(operationId);
    if (record.outcome?.kind !== 'verified') {
      throw new Error(`Operation ${record.operationId} is not verified.`);
    }
    if (record.advanceClaimedAt !== undefined) {
      return { claimed: false, record: cloneRecord(record) };
    }
    const updated = this.update(record, { advanceClaimedAt: this.now() });
    return { claimed: true, record: updated };
  }

  cleanup(): number {
    return this.transaction(() => this.cleanupLocal());
  }

  private cleanupLocal(): number {
    const now = this.now();
    let removed = 0;
    for (const record of this.records.values()) {
      if (record.expiresAt <= now) {
        this.deleteRecord(record);
        removed += 1;
      }
    }
    return removed;
  }

  exportRecords(): readonly OperationIdempotencyRecordV2[] {
    return this.transaction(() =>
      [...this.records.values()].map(cloneRecord));
  }

  private require(
    operationId: LocalIdentifier<'operation'> | string,
  ): OperationIdempotencyRecordV2 {
    this.cleanup();
    const parsed = parseLocalIdentifier('operation', operationId);
    const record = this.records.get(parsed);
    if (!record) throw new Error(`Operation ${parsed} was not found.`);
    return record;
  }

  private update(
    record: OperationIdempotencyRecordV2,
    patch: Partial<OperationIdempotencyRecordV2>,
  ): OperationIdempotencyRecordV2 {
    const updated = {
      ...record,
      ...patch,
      updatedAt: this.now(),
    };
    this.records.set(record.operationId, updated);
    return cloneRecord(updated);
  }

  private resetForRetry(
    record: OperationIdempotencyRecordV2,
  ): OperationIdempotencyRecordV2 {
    const updated: OperationIdempotencyRecordV2 = {
      ...record,
      status: 'pending',
      outcome: undefined,
      updatedAt: this.now(),
    };
    this.records.set(record.operationId, updated);
    return cloneRecord(updated);
  }

  private evictOldest(): void {
    while (this.records.size > this.maxRecords) {
      const oldest = this.records.values().next().value;
      if (!oldest) return;
      this.deleteRecord(oldest);
    }
  }

  private deleteRecord(record: OperationIdempotencyRecordV2): void {
    this.records.delete(record.operationId);
    this.operationBySemanticKey.delete(record.semanticKey);
    for (const callId of record.callIds) {
      this.operationByCallId.delete(callId);
    }
  }

  private transaction<T>(run: () => T): T {
    if (!this.persistence || this.transactionDepth > 0) return run();
    return this.persistence.transact((state) => {
      this.replaceRecords(state.records);
      this.transactionDepth += 1;
      try {
        const result = run();
        return {
          records: [...this.records.values()].map(cloneRecord),
          result,
        };
      } finally {
        this.transactionDepth -= 1;
      }
    });
  }

  private replaceRecords(
    values: readonly OperationIdempotencyRecordV2[],
  ): void {
    this.records.clear();
    this.operationByCallId.clear();
    this.operationBySemanticKey.clear();
    const now = this.now();
    const valid = values
      .filter((record) =>
        validPersistedRecord(record, this.maxCallIdsPerOperation)
        && record.expiresAt > now)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const operationIds = new Set<string>();
    const semanticKeys = new Set<string>();
    const callIds = new Set<string>();
    const selected: OperationIdempotencyRecordV2[] = [];
    for (const record of valid) {
      if (
        operationIds.has(record.operationId)
        || semanticKeys.has(record.semanticKey)
        || record.callIds.some((callId) => callIds.has(callId))
      ) {
        continue;
      }
      operationIds.add(record.operationId);
      semanticKeys.add(record.semanticKey);
      record.callIds.forEach((callId) => callIds.add(callId));
      selected.push(cloneRecord(record));
      if (selected.length >= this.maxRecords) break;
    }
    selected.reverse();
    for (const record of selected) {
      this.records.set(record.operationId, record);
      this.operationBySemanticKey.set(record.semanticKey, record.operationId);
      for (const callId of record.callIds) {
        this.operationByCallId.set(callId, record.operationId);
      }
    }
  }
}
