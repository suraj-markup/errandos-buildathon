import { describe, expect, it } from 'vitest';
import { newLocalIdentifier } from '../identifiers';
import { InMemoryPhoneTaskRepositoryV2 } from './repository';
import {
  beginV2CompatibilityExecution,
  completeV2CompatibilityExecution,
  hasNativeV2Transitions,
} from './execution-bridge';
import { validTaskV2 } from './test-fixtures';

describe('V2 compatibility execution bridge', () => {
  it('records the pre-mutation boundary and verified outcome atomically', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const task = validTaskV2();
    await repository.create({
      task,
      event: {
        eventId: 'event:created',
        taskId: task.taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const operationId = newLocalIdentifier('operation');
    const running = await beginV2CompatibilityExecution({
      at: 2,
      operationId,
      repository,
      stepId: 'step:first',
      task,
    });
    expect(running.task.revision).toBe(1);
    expect(running.task.steps[0]).toMatchObject({
      status: 'running',
      operationId,
    });
    expect(running).toMatchObject({
      activeOperation: {
        boundary: 'before_mutation',
        operationId,
        status: 'running',
      },
    });

    const completed = await completeV2CompatibilityExecution({
      at: 3,
      operationId,
      repository,
      result: {
        status: 'added',
        verification: { outcome: 'verified_success' },
      },
      stepId: 'step:first',
      task: running.task,
    });
    expect(completed.task.steps[0]?.status).toBe('verified');
    expect(completed.activeOperation).toBeUndefined();
    expect(hasNativeV2Transitions(completed.task)).toBe(true);
  });

  it('retains an ambiguous mutation for mandatory reconciliation', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const task = validTaskV2();
    await repository.create({
      task,
      event: {
        eventId: 'event:created',
        taskId: task.taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const operationId = newLocalIdentifier('operation');
    const running = await beginV2CompatibilityExecution({
      at: 2,
      operationId,
      repository,
      stepId: 'step:first',
      task,
    });
    const ambiguous = await completeV2CompatibilityExecution({
      at: 3,
      operationId,
      repository,
      result: {
        status: 'execution_failed',
        verification: { mutationAttempted: true },
      },
      stepId: 'step:first',
      task: running.task,
    });

    expect(ambiguous.task.status).toBe('ambiguous');
    expect(ambiguous.activeOperation).toMatchObject({
      boundary: 'mutation_attempted',
      status: 'ambiguous',
    });
  });
});
