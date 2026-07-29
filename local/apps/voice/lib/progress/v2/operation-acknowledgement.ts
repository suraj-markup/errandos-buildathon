import type { LocalIdentifier } from '../../workflow/identifiers';
import type { OperationAcceptedV2 } from './contracts';

export function createOperationAcceptedV2(input: {
  acceptedAt?: number;
  afterSequence?: number;
  compatibilityDeadlineMs?: number;
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): OperationAcceptedV2 {
  const acceptedAt = input.acceptedAt ?? Date.now();
  const afterSequence = input.afterSequence ?? -1;
  const deadlineMs = input.compatibilityDeadlineMs ?? 90_000;
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0) {
    throw new Error('acceptedAt must be a non-negative integer timestamp.');
  }
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 0) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
    throw new Error('afterSequence must be -1 or a non-negative integer.');
  }
  if (
    !Number.isSafeInteger(deadlineMs)
    || deadlineMs < 1_000
    || deadlineMs > 120_000
  ) {
    throw new Error('compatibilityDeadlineMs must be between 1s and 120s.');
  }
  return {
    version: 2,
    status: 'accepted',
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    operationId: input.operationId,
    acceptedAt,
    events: {
      afterSequence,
      taskId: input.taskId,
    },
    compatibility: {
      mode: 'bounded_synchronous',
      deadlineMs,
    },
  };
}
