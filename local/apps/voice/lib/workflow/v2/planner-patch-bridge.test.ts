import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from './graph';
import { InMemoryPhoneTaskRepositoryV2 } from './repository';
import { applyLlmPlanPatchesV2 } from './planner-patch-bridge';
import { validTaskV2 } from './test-fixtures';

async function repositoryWith(task = validTaskV2()) {
  const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
  await repository.create({
    task,
    event: {
      eventId: 'event:created',
      taskId: task.taskId,
      taskRevision: task.revision,
      at: task.updatedAt,
      kind: 'task_created',
    },
  });
  return repository;
}

describe('production LLM plan patch bridge', () => {
  it('adds future work without rewriting a verified step', async () => {
    const running = transitionPhoneTaskV2(validTaskV2(), {
      type: 'begin_step',
      stepId: 'step:first',
      operationId: 'operation:first',
      entryId: 'entry:begin',
      at: 2,
    });
    const task = transitionPhoneTaskV2(running, {
      type: 'verify_step',
      stepId: 'step:first',
      resultRef: 'result:first',
      entryId: 'entry:verify',
      at: 3,
    });
    const verified = structuredClone(task.steps[0]);
    const repository = await repositoryWith(task);

    const record = await applyLlmPlanPatchesV2({
      proposals: [{
        type: 'add_product',
        request: 'bread',
        quantity: 2,
        beforeStepId: 'step:second',
      }],
      repository,
      task,
      now: 4,
    });

    expect(record.task.steps[0]).toEqual(verified);
    expect(record.task.steps[1]).toMatchObject({
      kind: 'add_cart_item',
      input: { request: 'bread', quantity: 2 },
      status: 'ready',
    });
    expect(record.task.steps[2]?.dependsOn)
      .toContain(record.task.steps[1]?.stepId);
  });

  it('reactivates a completed graph only by appending new future work', async () => {
    const original = validTaskV2();
    const completed = {
      ...original,
      status: 'completed' as const,
      activeStepId: undefined,
      steps: original.steps.map((step) => ({
        ...step,
        status: 'verified' as const,
        attempts: 1,
        operationId: `operation:${step.stepId}`,
        lastResultRef: `result:${step.stepId}`,
      })),
      terminalAt: 4,
      updatedAt: 4,
    };
    const repository = await repositoryWith(completed);
    const record = await applyLlmPlanPatchesV2({
      proposals: [{
        type: 'add_product',
        request: 'eggs',
        quantity: 1,
      }],
      repository,
      task: completed,
      now: 5,
    });

    expect(record.task.status).toBe('active');
    expect(record.task.steps.slice(0, 2)).toEqual(completed.steps);
    expect(record.task.steps.at(-1)).toMatchObject({
      status: 'ready',
      input: { request: 'eggs' },
    });
  });

  it('compiles correction, skip, and checkout proposals into one bounded graph patch', async () => {
    const task = validTaskV2();
    const repository = await repositoryWith(task);
    const record = await applyLlmPlanPatchesV2({
      proposals: [
        {
          type: 'replace_product',
          stepId: 'step:first',
          request: 'oat milk',
          quantity: 2,
        },
        {
          type: 'skip_step',
          stepId: 'step:second',
          reason: 'User no longer wants it',
        },
        {
          type: 'propose_checkout',
          paymentPreference: 'cod',
        },
      ],
      repository,
      task,
      now: 2,
    });

    expect(record.task.steps[0]).toMatchObject({
      input: { request: 'oat milk', quantity: 2 },
      status: 'ready',
    });
    expect(record.task.steps[1]).toMatchObject({ status: 'skipped' });
    expect(record.task.steps[2]).toMatchObject({
      kind: 'review_checkout',
      input: { paymentPreference: 'cod' },
      status: 'planned',
    });
    expect(record.task.steps[2]?.dependsOn).toContain('step:first');
  });
});
