import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { createOperationAcceptedV2 } from './operation-acknowledgement';

describe('operation accepted v2', () => {
  it('returns identity and reconnect cursor without waiting for an execution result', () => {
    const taskId = parseLocalIdentifier(
      'task',
      'task_12345678-1234-1234-1234-123456789abc',
    );
    const operationId = parseLocalIdentifier(
      'operation',
      'operation_12345678-1234-1234-1234-123456789abc',
    );

    const acknowledgement = createOperationAcceptedV2({
      acceptedAt: 123,
      afterSequence: 4,
      compatibilityDeadlineMs: 45_000,
      operationId,
      taskId,
      taskRevision: 7,
    });

    expect(acknowledgement).toEqual({
      version: 2,
      status: 'accepted',
      taskId,
      taskRevision: 7,
      operationId,
      acceptedAt: 123,
      events: {
        afterSequence: 4,
        taskId,
      },
      compatibility: {
        mode: 'bounded_synchronous',
        deadlineMs: 45_000,
      },
    });
    expect(acknowledgement).not.toHaveProperty('result');
  });
});
