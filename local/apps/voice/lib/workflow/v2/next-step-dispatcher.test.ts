import { describe, expect, it, vi } from 'vitest';
import type { LocalIdentifier } from '../identifiers';
import { transitionPhoneTaskV2 } from './graph';
import {
  attachAutomaticFinalCartInspectionV2,
  DurableNextStepDispatcherV2,
  type NextStepEnqueueInputV2,
} from './next-step-dispatcher';
import {
  InMemoryPhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { validTaskV2 } from './test-fixtures';

function productTask() {
  const task = validTaskV2();
  task.taskId = 'task:automatic-list';
  task.clientId = 'client:automatic-list';
  task.activeStepId = undefined;
  task.originalGoal = 'Add milk and bread';
  task.desiredTerminalOutcome = { kind: 'cart_ready' };
  task.steps = [
    {
      stepId: 'step:milk',
      adapterId: 'blinkit',
      kind: 'add_cart_item',
      status: 'ready',
      dependsOn: [],
      input: { action: 'add_cart_item', request: 'milk', quantity: 1 },
      expectedPostcondition: { kind: 'cart_contains_requested_quantity' },
      attempts: 0,
    },
    {
      stepId: 'step:bread',
      adapterId: 'blinkit',
      kind: 'add_cart_item',
      status: 'planned',
      dependsOn: ['step:milk'],
      input: {
        action: 'add_cart_item',
        offerId: 'offer-bread',
        quantity: 1,
        request: 'bread',
        selectedOffer: {
          offerId: 'offer-bread',
          title: 'Bread',
          priceAmount: 40,
          priceCurrency: 'INR',
        },
      },
      expectedPostcondition: { kind: 'cart_contains_requested_quantity' },
      attempts: 0,
    },
  ];
  return attachAutomaticFinalCartInspectionV2(task);
}

async function created() {
  const repository = new InMemoryPhoneTaskRepositoryV2();
  const task = productTask();
  const record = await repository.create({
    task,
    event: {
      eventId: 'task-created',
      taskId: task.taskId,
      taskRevision: task.revision,
      at: task.createdAt,
      kind: 'task_created',
    },
  });
  return { record, repository };
}

async function verifyRunning(
  repository: InMemoryPhoneTaskRepositoryV2,
  record: TaskRepositoryRecordV2,
) {
  const step = record.task.steps.find((candidate) =>
    candidate.status === 'running')!;
  const at = record.task.updatedAt + 1;
  const task = transitionPhoneTaskV2(record.task, {
    type: 'verify_step',
    stepId: step.stepId,
    resultRef: `result:${step.stepId}`,
    entryId: `verified:${step.stepId}`,
    at,
  });
  return repository.commit({
    expectedRevision: record.task.revision,
    task,
    event: {
      eventId: `verified:${step.stepId}`,
      taskId: task.taskId,
      taskRevision: task.revision,
      at,
      kind: 'execution_verified',
    },
  });
}

describe('DurableNextStepDispatcherV2', () => {
  it('attaches one final read-only cart step and one next-action step', () => {
    const once = productTask();
    const twice = attachAutomaticFinalCartInspectionV2(once);
    expect(twice.steps.filter((step) => step.kind === 'inspect_cart')).toEqual([
      expect.objectContaining({
        stepId: 'step:automatic-final-cart-inspection',
        dependsOn: ['step:milk', 'step:bread'],
        input: { action: 'inspect_cart' },
      }),
    ]);
    expect(twice.steps.filter((step) => step.kind === 'ask_next')).toEqual([
      expect.objectContaining({
        stepId: 'step:automatic-next-action',
        dependsOn: ['step:automatic-final-cart-inspection'],
      }),
    ]);
    expect(twice).toEqual(once);
  });

  it('reuses a planner-created ask-next node after final inspection', () => {
    const source = productTask();
    source.steps = source.steps.filter((step) =>
      !['inspect_cart', 'ask_next'].includes(step.kind));
    source.steps.push({
      stepId: 'step:planner-ask-next',
      adapterId: 'blinkit',
      kind: 'ask_next',
      status: 'planned',
      dependsOn: ['step:bread'],
      input: { choices: ['add_more', 'stop'] },
      expectedPostcondition: { kind: 'next_action_selected' },
      attempts: 0,
    });

    const attached = attachAutomaticFinalCartInspectionV2(source);

    expect(attached.steps.filter((step) => step.kind === 'ask_next'))
      .toEqual([expect.objectContaining({
        stepId: 'step:planner-ask-next',
        dependsOn: [
          'step:bread',
          'step:automatic-final-cart-inspection',
        ],
      })]);
  });

  it('turns a broad add into visible search work but preserves exact mutation input', async () => {
    const { repository } = await created();
    const enqueued: NextStepEnqueueInputV2[] = [];
    const dispatcher = new DurableNextStepDispatcherV2({
      repository,
      enqueue: async (input) => { enqueued.push(input); },
      newOperationId: () =>
        'operation:milk-search' as LocalIdentifier<'operation'>,
      now: () => 10,
    });

    const result = await dispatcher.dispatch('task:automatic-list');

    expect(result.disposition).toBe('dispatched');
    expect(enqueued).toEqual([
      expect.objectContaining({
        stepId: 'step:milk',
        requestPayload: {
          version: 1,
          action: { action: 'search_products', request: 'milk' },
        },
      }),
    ]);
    const stored = await repository.getById('task:automatic-list');
    expect(stored?.task.steps[0]).toMatchObject({
      kind: 'search_products',
      input: { action: 'add_cart_item', request: 'milk', quantity: 1 },
      status: 'running',
    });
  });

  it('ends final inspection at one persisted next-action interaction', async () => {
    const { repository } = await created();
    const enqueued: NextStepEnqueueInputV2[] = [];
    let operation = 0;
    const dispatcher = new DurableNextStepDispatcherV2({
      repository,
      enqueue: async (input) => { enqueued.push(input); },
      newOperationId: () =>
        `operation:auto-${++operation}` as LocalIdentifier<'operation'>,
      newInteractionId: () => 'interaction_final_cart',
      now: () => 20 + operation,
    });

    await dispatcher.dispatch('task:automatic-list');
    let current = (await repository.getById('task:automatic-list'))!;
    current = await verifyRunning(repository, current);
    await dispatcher.dispatch(current.task.taskId);
    current = (await repository.getById(current.task.taskId))!;
    current = await verifyRunning(repository, current);
    expect(current.task.status).toBe('active');
    await dispatcher.dispatch(current.task.taskId);
    current = (await repository.getById(current.task.taskId))!;
    current = await verifyRunning(repository, current);
    const waiting = await dispatcher.dispatch(current.task.taskId);
    current = (await repository.getById(current.task.taskId))!;

    expect(enqueued.map((input) => [
      input.stepId,
      input.requestPayload.action.action,
    ])).toEqual([
      ['step:milk', 'search_products'],
      ['step:bread', 'add_cart_item'],
      ['step:automatic-final-cart-inspection', 'inspect_cart'],
    ]);
    expect(waiting.disposition).toBe('waiting');
    expect(current.task).toMatchObject({
      status: 'waiting_for_user',
      pendingInteraction: {
        interactionId: 'interaction_final_cart',
        kind: 'next_action',
        allowedResponses: [
          'review_cart',
          'add_more',
          'review_checkout',
          'stop',
        ],
      },
    });
  });

  it('resumes the same durable claim after enqueue interruption', async () => {
    const { repository } = await created();
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new Error('process interrupted'))
      .mockResolvedValue(undefined);
    const newOperationId = vi.fn(() =>
      'operation:restart-safe' as LocalIdentifier<'operation'>);
    const dispatcher = new DurableNextStepDispatcherV2({
      repository,
      enqueue,
      newOperationId,
      now: () => 30,
    });

    await expect(
      dispatcher.dispatch('task:automatic-list'),
    ).rejects.toThrow('process interrupted');
    const resumed = await dispatcher.dispatch('task:automatic-list');

    expect(resumed.disposition).toBe('resumed');
    expect(newOperationId).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0].operationId).toBe(
      enqueue.mock.calls[1]?.[0].operationId,
    );
  });

  it('durably reopens a legacy completed product graph for its sole inspection', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = productTask();
    task.steps = task.steps
      .filter((step) =>
        !['inspect_cart', 'ask_next'].includes(step.kind))
      .map((step) => ({ ...step, status: 'verified' as const }));
    task.status = 'completed';
    task.terminalAt = 2;
    const created = await repository.create({
      task,
      event: {
        eventId: 'legacy-created',
        taskId: task.taskId,
        taskRevision: task.revision,
        at: 1,
        kind: 'task_created',
      },
    });
    expect(created.task.status).toBe('completed');
    const enqueue = vi.fn();

    const result = await new DurableNextStepDispatcherV2({
      repository,
      enqueue,
      newOperationId: () =>
        'operation:legacy-inspect' as LocalIdentifier<'operation'>,
      now: () => 3,
    }).dispatch(task.taskId);

    expect(result.disposition).toBe('dispatched');
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      stepId: 'step:automatic-final-cart-inspection',
      requestPayload: {
        version: 1,
        action: { action: 'inspect_cart' },
      },
    });
  });

  it('does not cross user, ambiguity, block, or checkout boundaries', async () => {
    const cases = [
      { status: 'ambiguous', stepStatus: 'ambiguous' },
      { status: 'blocked', stepStatus: 'blocked' },
    ] as const;
    for (const [index, boundary] of cases.entries()) {
      const repository = new InMemoryPhoneTaskRepositoryV2();
      const task = productTask();
      task.taskId = `task:boundary-${index}`;
      task.clientId = `client:boundary-${index}`;
      task.status = boundary.status;
      task.steps[0]!.status = boundary.stepStatus;
      await repository.create({
        task,
        event: {
          eventId: `created-${index}`,
          taskId: task.taskId,
          taskRevision: task.revision,
          at: 1,
          kind: 'task_created',
        },
      });
      const enqueue = vi.fn();
      const result = await new DurableNextStepDispatcherV2({
        repository,
        enqueue,
      }).dispatch(task.taskId);
      expect(['waiting', 'blocked']).toContain(result.disposition);
      expect(enqueue).not.toHaveBeenCalled();
    }

    const { repository } = await created();
    const record = (await repository.getById('task:automatic-list'))!;
    record.task.steps[0]!.kind = 'review_checkout';
    record.task.steps[0]!.input = { action: 'prepare_checkout' };
    const replacement = new InMemoryPhoneTaskRepositoryV2();
    await replacement.create({
      task: record.task,
      event: {
        eventId: 'checkout-created',
        taskId: record.task.taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const enqueue = vi.fn();
    const result = await new DurableNextStepDispatcherV2({
      repository: replacement,
      enqueue,
    }).dispatch(record.task.taskId);
    expect(result.disposition).toBe('checkout_boundary');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does not dispatch later ready work past two recovered failures', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = productTask();
    const [first, second] = task.steps;
    first!.status = 'failed';
    first!.attempts = 1;
    first!.dependsOn = [];
    second!.status = 'failed';
    second!.attempts = 1;
    second!.dependsOn = [];
    const later = {
      ...structuredClone(second!),
      stepId: 'step:later-ready',
      status: 'ready' as const,
      attempts: 0,
      input: {
        action: 'add_cart_item',
        offerId: 'offer-eggs',
        quantity: 1,
        request: 'eggs',
        selectedOffer: {
          offerId: 'offer-eggs',
          title: 'Eggs',
          priceAmount: 80,
          priceCurrency: 'INR',
        },
      },
    };
    task.steps.splice(2, 0, later);
    task.activeStepId = second!.stepId;
    task.journal.push(
      {
        entryId: 'recovery:first',
        at: task.updatedAt + 1,
        type: 'recovery_verified_not_applied',
        stepId: first!.stepId,
        operationId: 'operation:first',
      },
      {
        entryId: 'recovery:second',
        at: task.updatedAt + 2,
        type: 'recovery_verified_not_applied',
        stepId: second!.stepId,
        operationId: 'operation:second',
      },
    );
    task.updatedAt += 2;
    await repository.create({
      task,
      event: {
        eventId: 'two-failures-created',
        taskId: task.taskId,
        taskRevision: task.revision,
        at: task.createdAt,
        kind: 'task_created',
      },
    });
    const enqueue = vi.fn();

    const result = await new DurableNextStepDispatcherV2({
      repository,
      enqueue,
      newOperationId: () =>
        'operation:must-not-run' as LocalIdentifier<'operation'>,
    }).dispatch(task.taskId);

    expect(result.disposition).toBe('waiting');
    expect(enqueue).not.toHaveBeenCalled();
    expect((await repository.getById(task.taskId))?.task.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: first!.stepId,
          status: 'failed',
        }),
        expect.objectContaining({
          stepId: second!.stepId,
          status: 'failed',
        }),
        expect.objectContaining({
          stepId: later.stepId,
          status: 'ready',
        }),
      ]),
    );
  });
});
