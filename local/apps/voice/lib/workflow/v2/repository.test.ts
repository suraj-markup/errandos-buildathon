import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from './graph';
import {
  ClientTaskConflictV2Error,
  InMemoryPhoneTaskRepositoryV2,
  TaskRevisionConflictV2Error,
  type TaskRepositoryEventV2,
} from './repository';
import { validTaskV2 } from './test-fixtures';

function event(
  taskId: string,
  revision: number,
  suffix: string,
): TaskRepositoryEventV2 {
  return {
    eventId: `repository-event:${suffix}`,
    taskId,
    taskRevision: revision,
    at: revision + 1,
    kind: `test_${suffix}`,
  };
}

function beginTask(operationId: string) {
  return transitionPhoneTaskV2(validTaskV2(), {
    type: 'begin_step',
    stepId: 'step:first',
    operationId,
    entryId: `journal:${operationId}`,
    at: 2,
  });
}

describe('InMemoryPhoneTaskRepositoryV2', () => {
  it('atomically stores state, event, and operation checkpoint', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const task = beginTask('operation:one');
    const operation = {
      operationId: 'operation:one',
      taskId: task.taskId,
      stepId: 'step:first',
      kind: 'external_mutation',
      boundary: 'before_mutation' as const,
      status: 'running' as const,
      updatedAt: 2,
    };
    await repository.create({
      task,
      event: event(task.taskId, task.revision, 'created'),
      activeOperation: operation,
    });

    const stored = await repository.getById(task.taskId);
    expect(stored).toMatchObject({
      task: { revision: 1 },
      events: [{ taskRevision: 1 }],
      activeOperation: operation,
    });
    stored!.task.originalGoal = 'tampered clone';
    expect((await repository.getById(task.taskId))!.task.originalGoal)
      .toBe(validTaskV2().originalGoal);
  });

  it('exports and restores a checksummed restart snapshot', async () => {
    const first = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const task = validTaskV2();
    await first.create({
      task,
      event: event(task.taskId, task.revision, 'created'),
    });
    const snapshot = await first.exportSnapshot();

    const restarted = new InMemoryPhoneTaskRepositoryV2({ now: () => 11 });
    await expect(restarted.restoreSnapshot(snapshot)).resolves.toEqual({
      discarded: 0,
      restored: 1,
    });
    expect((await restarted.getByClientId(task.clientId))?.task)
      .toEqual(task);
  });

  it('discards a corrupt record without restoring partial contents', async () => {
    const source = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const first = validTaskV2();
    const second = structuredClone(first);
    second.taskId = 'task:v2:second';
    second.clientId = 'second-client';
    await source.create({
      task: first,
      event: event(first.taskId, first.revision, 'first'),
    });
    await source.create({
      task: second,
      event: event(second.taskId, second.revision, 'second'),
    });
    const snapshot = JSON.parse(await source.exportSnapshot());
    snapshot.records[0].record.task.originalGoal = 'checksum mismatch';

    const restarted = new InMemoryPhoneTaskRepositoryV2({ now: () => 11 });
    await expect(restarted.restoreSnapshot(JSON.stringify(snapshot))).resolves
      .toEqual({ discarded: 1, restored: 1 });
    expect(await restarted.getById(first.taskId)).toBeUndefined();
    expect(await restarted.getById(second.taskId)).toBeDefined();
  });

  it('expires records and their client ownership index', async () => {
    let now = 10;
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: () => now,
      ttlMs: 5,
    });
    const task = validTaskV2();
    await repository.create({
      task,
      event: event(task.taskId, task.revision, 'created'),
    });
    now = 15;

    expect(await repository.getById(task.taskId)).toBeUndefined();
    expect(await repository.getByClientId(task.clientId)).toBeUndefined();
    expect(await repository.cleanupExpired()).toBe(0);
  });

  it('allows exactly one concurrent compare-and-swap commit', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const task = validTaskV2();
    await repository.create({
      task,
      event: event(task.taskId, task.revision, 'created'),
    });
    const first = beginTask('operation:first');
    const second = beginTask('operation:second');

    const results = await Promise.allSettled([
      repository.commit({
        expectedRevision: 0,
        task: first,
        event: event(first.taskId, first.revision, 'first-commit'),
      }),
      repository.commit({
        expectedRevision: 0,
        task: second,
        event: event(second.taskId, second.revision, 'second-commit'),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.any(TaskRevisionConflictV2Error),
    });
    expect((await repository.getById(task.taskId))?.events).toHaveLength(2);
  });

  it('does not partially write when the commit hook fails', async () => {
    let fail = false;
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: () => 10,
      beforeCommit: (operation) => {
        if (fail && operation === 'commit') throw new Error('injected failure');
      },
    });
    const task = validTaskV2();
    await repository.create({
      task,
      event: event(task.taskId, task.revision, 'created'),
    });
    fail = true;
    const next = beginTask('operation:one');

    await expect(repository.commit({
      expectedRevision: 0,
      task: next,
      event: event(next.taskId, next.revision, 'failed-commit'),
    })).rejects.toThrow('injected failure');
    const stored = await repository.getById(task.taskId);
    expect(stored?.task.revision).toBe(0);
    expect(stored?.events).toHaveLength(1);
  });

  it('does not partially replace either task when the replacement hook fails', async () => {
    let fail = false;
    const repository = new InMemoryPhoneTaskRepositoryV2({
      beforeCommit: (operation) => {
        if (fail && operation === 'replace') throw new Error('replace failure');
      },
    });
    const current = validTaskV2();
    await repository.create({
      task: current,
      event: event(current.taskId, 0, 'current'),
    });
    const next = structuredClone(current);
    next.taskId = 'task:v2:replacement';
    fail = true;

    await expect(repository.replaceForClient({
      currentTaskId: current.taskId,
      expectedRevision: 0,
      nextTask: next,
      reason: 'start_over',
      replacedEvent: {
        ...event(current.taskId, 1, 'cancelled'),
        at: 2,
      },
      createdEvent: {
        ...event(next.taskId, 0, 'replacement'),
        at: 2,
      },
    })).rejects.toThrow('replace failure');
    expect((await repository.getById(current.taskId))?.task.status).toBe('active');
    expect(await repository.getById(next.taskId)).toBeUndefined();
  });

  it('rejects implicit replacement for a client with an active task', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const current = validTaskV2();
    const unrelated = structuredClone(current);
    unrelated.taskId = 'task:v2:unrelated';
    await repository.create({
      task: current,
      event: event(current.taskId, 0, 'current'),
    });
    await expect(repository.create({
      task: unrelated,
      event: event(unrelated.taskId, 0, 'unrelated'),
    })).rejects.toBeInstanceOf(ClientTaskConflictV2Error);
  });
});
