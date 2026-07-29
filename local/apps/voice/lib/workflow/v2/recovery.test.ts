import { describe, expect, it, vi } from 'vitest';
import { transitionPhoneTaskV2 } from './graph';
import { recoverRepositoryOnStartupV2 } from './recovery';
import {
  InMemoryPhoneTaskRepositoryV2,
  type TaskRecoveryOperationV2,
} from './repository';
import { validTaskV2 } from './test-fixtures';

function runningTask() {
  return transitionPhoneTaskV2(validTaskV2(), {
    type: 'begin_step',
    stepId: 'step:first',
    operationId: 'operation:recovery',
    entryId: 'journal:begin-recovery',
    at: 2,
  });
}

function operation(
  boundary: TaskRecoveryOperationV2['boundary'],
): TaskRecoveryOperationV2 {
  return {
    operationId: 'operation:recovery',
    taskId: 'task:v2:test',
    stepId: 'step:first',
    kind: 'external_mutation',
    boundary,
    status: boundary === 'verified' ? 'completed' : 'running',
    ...(boundary === 'verified' ? { resultRef: 'result:checkpoint' } : {}),
    updatedAt: 2,
  };
}

async function restartedRepository(boundary: TaskRecoveryOperationV2['boundary']) {
  const source = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
  const task = runningTask();
  await source.create({
    task,
    event: {
      eventId: 'repository:created',
      taskId: task.taskId,
      taskRevision: task.revision,
      at: 2,
      kind: 'task_created',
    },
    activeOperation: operation(boundary),
  });
  const restarted = new InMemoryPhoneTaskRepositoryV2({ now: () => 11 });
  await restarted.restoreSnapshot(await source.exportSnapshot());
  return restarted;
}

describe('PhoneTaskV2 restart recovery', () => {
  it('restores pre-mutation work without calling reconciliation', async () => {
    const repository = await restartedRepository('before_mutation');
    const reconcile = vi.fn();
    const reports = await recoverRepositoryOnStartupV2({
      repository,
      reconciler: { reconcile },
      now: () => 12,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(reports).toEqual([expect.objectContaining({
      outcome: 'safe_to_resume',
      revision: 2,
    })]);
    const restored = await repository.getById('task:v2:test');
    expect(restored?.task.steps[0]).toMatchObject({ status: 'ready' });
    expect(restored?.task.steps[0]).not.toHaveProperty('operationId');
    expect(restored?.activeOperation).toBeUndefined();
  });

  it('reconciles a crossed mutation boundary and advances exactly once', async () => {
    const repository = await restartedRepository('mutation_attempted');
    const reconcile = vi.fn().mockResolvedValue({
      outcome: 'verified_applied',
      evidenceRef: 'evidence:cart',
    });
    const reports = await recoverRepositoryOnStartupV2({
      repository,
      reconciler: { reconcile },
      now: () => 12,
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]![0].mode).toBe('mutation');
    expect(reports[0]?.outcome).toBe('mutation_verified');
    const restored = (await repository.getById('task:v2:test'))!.task;
    expect(restored.steps.map((step) => step.status)).toEqual([
      'verified',
      'ready',
    ]);
    expect(restored.revision).toBe(2);
  });

  it('never replays final dispatch and blocks a verified-not-applied result', async () => {
    const repository = await restartedRepository('final_dispatch_attempted');
    const reconcile = vi.fn().mockResolvedValue({
      outcome: 'verified_not_applied',
      evidenceRef: 'evidence:not-ordered',
    });
    const reports = await recoverRepositoryOnStartupV2({
      repository,
      reconciler: { reconcile },
      now: () => 12,
    });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0]![0].mode).toBe('final_dispatch');
    expect(reports[0]?.outcome).toBe('final_dispatch_not_applied');
    const restored = (await repository.getById('task:v2:test'))!.task;
    expect(restored.status).toBe('blocked');
    expect(restored.steps[0]!.status).toBe('blocked');
  });

  it('converts reconciliation failure into ambiguity instead of replay', async () => {
    const repository = await restartedRepository('mutation_attempted');
    const reports = await recoverRepositoryOnStartupV2({
      repository,
      reconciler: {
        reconcile: vi.fn().mockRejectedValue(new Error('phone unavailable')),
      },
      now: () => 12,
    });

    expect(reports[0]?.outcome).toBe('mutation_ambiguous');
    const restored = (await repository.getById('task:v2:test'))!.task;
    expect(restored.status).toBe('ambiguous');
    expect(restored.steps[0]!.status).toBe('ambiguous');
  });

  it('trusts an atomically persisted verified checkpoint without reconciliation', async () => {
    const repository = await restartedRepository('verified');
    const reconcile = vi.fn();
    const reports = await recoverRepositoryOnStartupV2({
      repository,
      reconciler: { reconcile },
      now: () => 12,
    });

    expect(reconcile).not.toHaveBeenCalled();
    expect(reports[0]?.outcome).toBe('mutation_verified');
    expect((await repository.getById('task:v2:test'))?.task.steps[0])
      .toMatchObject({ status: 'verified', lastResultRef: 'result:checkpoint' });
  });
});
