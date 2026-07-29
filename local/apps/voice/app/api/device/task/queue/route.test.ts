import { describe, expect, it } from 'vitest';
import { RetainedTaskEventStreamV2 } from '../../../../../lib/progress/v2';
import {
  DEFAULT_TASK_BUDGETS_V2,
  InMemoryPhoneTaskRepositoryV2,
  commitQueueEditV2,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import {
  handleQueueEditRequestV2,
  type QueueEditRouteDependenciesV2,
} from './route';

const taskId = 'task_queueedit1';
const clientId = 'pixel-overlay';

function task(): PhoneTaskV2 {
  return {
    version: 2,
    taskId,
    clientId,
    revision: 0,
    originalGoal: 'Add potato, paneer, and rice',
    goalKind: 'grocery',
    status: 'active',
    activeStepId: 'step:potato',
    steps: [
      {
        stepId: 'step:potato',
        adapterId: 'blinkit',
        kind: 'search_products',
        status: 'ready',
        dependsOn: [],
        input: { action: 'search_products', request: 'potato' },
        expectedPostcondition: { kind: 'product_options_observed' },
        attempts: 0,
      },
      {
        stepId: 'step:paneer',
        adapterId: 'blinkit',
        kind: 'search_products',
        status: 'planned',
        dependsOn: ['step:potato'],
        input: { action: 'search_products', request: 'paneer' },
        expectedPostcondition: { kind: 'product_options_observed' },
        attempts: 0,
      },
      {
        stepId: 'step:rice',
        adapterId: 'blinkit',
        kind: 'search_products',
        status: 'planned',
        dependsOn: ['step:paneer'],
        input: { action: 'search_products', request: 'rice' },
        expectedPostcondition: { kind: 'product_options_observed' },
        attempts: 0,
      },
    ],
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function seed(
  repository: PhoneTaskRepositoryV2,
  value: PhoneTaskV2 = task(),
  activeOperation?: Parameters<PhoneTaskRepositoryV2['create']>[0]['activeOperation'],
): Promise<void> {
  await repository.create({
    task: value,
    event: {
      eventId: 'task-created',
      taskId,
      taskRevision: value.revision,
      at: value.updatedAt,
      kind: 'task_created',
    },
    ...(activeOperation ? { activeOperation } : {}),
  });
}

async function dependencies(
  repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 20 }),
  value: PhoneTaskV2 = task(),
): Promise<QueueEditRouteDependenciesV2> {
  await seed(repository, value);
  return {
    now: () => 10,
    repository,
    stream: new RetainedTaskEventStreamV2({ now: () => 10 }),
  };
}

function request(
  command: Record<string, unknown>,
  options: { commandId?: string; revision?: number } = {},
): Request {
  return new Request('http://localhost/api/device/task/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 2,
      clientId,
      taskId,
      taskRevision: options.revision ?? 0,
      commandId: options.commandId ?? 'command_queue01',
      command,
    }),
  });
}

describe('authoritative queue editing route v2', () => {
  it('refines only a future item and clears stale offer selection', async () => {
    const correctionTask = task();
    correctionTask.productChoicePolicy = {
      mode: 'suggested_with_price_limit',
      priceCeiling: { amount: 150, currency: 'INR' },
    };
    const deps = await dependencies(
      new InMemoryPhoneTaskRepositoryV2({ now: (): number => 20 }),
      correctionTask,
    );
    const response = await handleQueueEditRequestV2(
      request({
        command: 'refine',
        stepId: 'step:paneer',
        request: 'Amul paneer 200 g',
        quantity: 2,
      }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledgement: 'accepted',
      outcome: 'updated',
      taskRevision: 1,
    });
    expect((await deps.repository.getById(taskId))?.task.steps[1])
      .toMatchObject({
        kind: 'search_products',
        status: 'planned',
        input: {
          action: 'search_products',
          request: 'Amul paneer 200 g',
          quantity: 2,
        },
        attempts: 0,
      });
    expect((await deps.repository.getById(taskId))?.task).toMatchObject({
      activeStepId: 'step:potato',
      productChoicePolicy: {
        mode: 'suggested_with_price_limit',
        priceCeiling: { amount: 150, currency: 'INR' },
      },
      steps: [
        { stepId: 'step:potato', status: 'ready' },
        {
          stepId: 'step:paneer',
          kind: 'search_products',
          status: 'planned',
        },
        { stepId: 'step:rice', status: 'planned' },
      ],
    });
    expect(deps.stream.readAfter({
      taskId: taskId as never,
      afterSequence: -1,
    }).events[0]).toMatchObject({
      kind: 'selection_accepted',
      title: 'Task list updated',
      progress: { completed: 0, total: 3 },
    });
  });

  it('removes and skips future items without deleting history', async () => {
    const deps = await dependencies();
    const removed = await handleQueueEditRequestV2(
      request(
        { command: 'remove', stepId: 'step:paneer' },
        { commandId: 'command_remove01' },
      ),
      deps,
    );
    expect(removed.status).toBe(200);
    const skipped = await handleQueueEditRequestV2(
      request(
        { command: 'skip', stepId: 'step:rice' },
        { commandId: 'command_skip001', revision: 1 },
      ),
      deps,
    );
    expect(skipped.status).toBe(200);
    const stored = (await deps.repository.getById(taskId))!.task;
    expect(stored.steps).toHaveLength(3);
    expect(stored.steps.slice(1).map((step) => step.status))
      .toEqual(['skipped', 'skipped']);
    expect(stored.journal.map((entry) => entry.type))
      .toEqual(['queue_remove', 'queue_skip']);
  });

  it('reorders future items and keeps their dependency on active history', async () => {
    const deps = await dependencies();
    const response = await handleQueueEditRequestV2(
      request({
        command: 'reorder',
        orderedStepIds: ['step:rice', 'step:paneer'],
      }),
      deps,
    );
    expect(response.status).toBe(200);
    const steps = (await deps.repository.getById(taskId))!.task.steps;
    expect(steps.map((step) => step.stepId)).toEqual([
      'step:potato',
      'step:rice',
      'step:paneer',
    ]);
    expect(steps[1]?.dependsOn).toEqual(['step:potato']);
    expect(steps[2]?.dependsOn).toEqual(['step:rice']);
  });

  it('rejects the active step and any edit while a mutation owns the task', async () => {
    const deps = await dependencies();
    const active = await handleQueueEditRequestV2(
      request({ command: 'skip', stepId: 'step:potato' }),
      deps,
    );
    expect(active.status).toBe(409);

    const running = task();
    running.activeStepId = 'step:potato';
    running.steps[0] = {
      ...running.steps[0]!,
      status: 'running',
      operationId: 'operation_queue01',
      attempts: 1,
    };
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: (): number => 20,
    });
    await seed(repository, running, {
      operationId: 'operation_queue01',
      taskId,
      stepId: 'step:potato',
      kind: 'search_products',
      boundary: 'mutation_attempted',
      status: 'running',
      updatedAt: 1,
    });
    await expect(commitQueueEditV2({
      at: 10,
      command: { command: 'remove', stepId: 'step:paneer' },
      commandId: 'command_block01',
      expectedRevision: 0,
      repository,
      taskId,
    })).rejects.toThrow('phone operation is active');
  });

  it('pauses and resumes durably, and dispatcher-visible status follows', async () => {
    const deps = await dependencies();
    const paused = await handleQueueEditRequestV2(
      request({ command: 'pause' }, { commandId: 'command_pause01' }),
      deps,
    );
    expect(await paused.json()).toMatchObject({
      outcome: 'paused',
      taskRevision: 1,
    });
    expect((await deps.repository.getById(taskId))?.task.status).toBe('paused');

    const resumed = await handleQueueEditRequestV2(
      request(
        { command: 'resume' },
        { commandId: 'command_resume1', revision: 1 },
      ),
      deps,
    );
    expect(await resumed.json()).toMatchObject({
      outcome: 'resumed',
      taskRevision: 2,
    });
    expect((await deps.repository.getById(taskId))?.task.status).toBe('active');
  });

  it('requests cancellation without altering an active mutation boundary', async () => {
    const running = task();
    running.activeStepId = 'step:potato';
    running.steps[0] = {
      ...running.steps[0]!,
      status: 'running',
      operationId: 'operation_queue02',
      attempts: 1,
    };
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: (): number => 20,
    });
    const operation = {
      operationId: 'operation_queue02',
      taskId,
      stepId: 'step:potato',
      kind: 'search_products',
      boundary: 'mutation_attempted' as const,
      status: 'running' as const,
      updatedAt: 1,
    };
    await seed(repository, running, operation);
    const deps = {
      now: (): number => 10,
      repository,
      stream: new RetainedTaskEventStreamV2({ now: (): number => 10 }),
    };
    const response = await handleQueueEditRequestV2(
      request({ command: 'cancel' }, { commandId: 'command_cancel1' }),
      deps,
    );
    expect(await response.json()).toMatchObject({
      outcome: 'cancellation_requested',
      taskRevision: 1,
    });
    const stored = (await repository.getById(taskId))!;
    expect(stored.task.status).toBe('paused');
    expect(stored.activeOperation).toEqual(operation);
    expect(stored.task.journal.at(-1)).toMatchObject({
      type: 'queue_cancellation_requested',
      operationId: 'operation_queue02',
    });
  });

  it('cancels immediately only when no operation is active', async () => {
    const deps = await dependencies();
    const response = await handleQueueEditRequestV2(
      request({ command: 'cancel' }, { commandId: 'command_cancel2' }),
      deps,
    );
    expect(await response.json()).toMatchObject({
      outcome: 'cancelled',
      taskRevision: 1,
    });
    expect((await deps.repository.getById(taskId))?.task).toMatchObject({
      status: 'cancelled',
      terminalAt: 10,
    });
    expect(deps.stream.readAfter({
      taskId: taskId as never,
      afterSequence: -1,
    }).events[0]).toMatchObject({
      kind: 'cancelled',
      terminal: true,
    });
  });

  it('rejects stale revisions but replays an exact command idempotently', async () => {
    const deps = await dependencies();
    const body = request(
      { command: 'remove', stepId: 'step:paneer' },
      { commandId: 'command_replay1' },
    );
    expect((await handleQueueEditRequestV2(body, deps)).status).toBe(200);
    const replay = await handleQueueEditRequestV2(
      request(
        { command: 'remove', stepId: 'step:paneer' },
        { commandId: 'command_replay1', revision: 0 },
      ),
      deps,
    );
    expect(await replay.json()).toMatchObject({
      acknowledgement: 'duplicate',
      taskRevision: 1,
    });
    const stale = await handleQueueEditRequestV2(
      request(
        { command: 'skip', stepId: 'step:rice' },
        { commandId: 'command_stale01', revision: 0 },
      ),
      deps,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'stale_task_revision',
      actualRevision: 1,
    });
  });

  it('rejects unknown fields and command-id reuse with different content', async () => {
    const deps = await dependencies();
    const malformed = await handleQueueEditRequestV2(
      request({
        command: 'remove',
        stepId: 'step:paneer',
        unsafeExtra: true,
      }),
      deps,
    );
    expect(malformed.status).toBe(400);

    const accepted = await handleQueueEditRequestV2(
      request(
        { command: 'remove', stepId: 'step:paneer' },
        { commandId: 'command_conflict' },
      ),
      deps,
    );
    expect(accepted.status).toBe(200);
    const conflict = await handleQueueEditRequestV2(
      request(
        { command: 'skip', stepId: 'step:rice' },
        { commandId: 'command_conflict', revision: 1 },
      ),
      deps,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: 'command_id_conflict',
    });
  });

  it('accepts one concurrent winner and deduplicates the exact race', async () => {
    let commits = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: (): number => 20,
      beforeCommit: async (operation): Promise<void> => {
        if (operation !== 'commit') return;
        commits += 1;
        if (commits === 2) release();
        await bothArrived;
      },
    });
    const deps = await dependencies(repository);
    const responses = await Promise.all([
      handleQueueEditRequestV2(
        request(
          { command: 'remove', stepId: 'step:paneer' },
          { commandId: 'command_race001' },
        ),
        deps,
      ),
      handleQueueEditRequestV2(
        request(
          { command: 'remove', stepId: 'step:paneer' },
          { commandId: 'command_race001' },
        ),
        deps,
      ),
    ]);
    const bodies = await Promise.all(responses.map((response) =>
      response.json()));
    expect(bodies.map((body) => body.acknowledgement).sort())
      .toEqual(['accepted', 'duplicate']);
    expect((await repository.getById(taskId))?.task.revision).toBe(1);
  });
});
