import { describe, expect, it } from 'vitest';
import { RetainedTaskEventStreamV2 } from '../../../../../lib/progress/v2';
import {
  InMemoryPhoneTaskRepositoryV2,
  transitionPhoneTaskV2,
  type PhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import { parseLocalIdentifier } from '../../../../../lib/workflow/identifiers';
import {
  DeterministicUxTimingMetricsCollectorV1,
} from '../../../../../lib/ux-timing-metrics';
import { validTaskV2 } from '../../../../../lib/workflow/v2/test-fixtures';
import {
  handleCompletionInteractionRequest,
  type CompletionInteractionRouteDependencies,
} from './route';
import { handleTaskEventsRequest } from '../events/route';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const interactionId = 'interaction_12345678';

function waitingTask(input: {
  allowedResponses?: string[];
  expiresAt?: number;
} = {}): PhoneTaskV2 {
  const task = validTaskV2();
  task.taskId = taskId;
  task.clientId = 'pixel-overlay';
  task.steps = [{ ...task.steps[0]!, kind: 'ask_next' }];
  return transitionPhoneTaskV2(task, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:completion-prompt',
    at: 2,
    interaction: {
      interactionId,
      taskId,
      taskRevision: 1,
      kind: 'next_action',
      allowedResponses:
        input.allowedResponses
        ?? ['review_cart', 'add_more', 'review_checkout', 'stop'],
      presentationRef: 'presentation:completion',
      status: 'open',
      createdAt: 2,
      expiresAt: input.expiresAt ?? 100,
    },
  });
}

async function dependencies(
  task: PhoneTaskV2 = waitingTask(),
  now = 50,
): Promise<CompletionInteractionRouteDependencies> {
  const repository = new InMemoryPhoneTaskRepositoryV2({
    now: () => now,
  });
  await repository.create({
    task,
    event: {
      eventId: 'repository-event:waiting',
      taskId: task.taskId,
      taskRevision: task.revision,
      at: task.updatedAt,
      kind: 'waiting_for_completion_choice',
    },
  });
  return {
    now: () => now,
    repository,
    stream: new RetainedTaskEventStreamV2({
      newEventId: () => 'event_completion_accepted',
      now: () => now,
    }),
  };
}

function request(overrides: Record<string, unknown> = {}): Request {
  return new Request(
    'http://localhost/api/device/task/interaction',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        clientId: 'pixel-overlay',
        taskId,
        taskRevision: 1,
        interactionId,
        choiceId: 'add_more',
        source: 'tap',
        ...overrides,
      }),
    },
  );
}

describe('POST /api/device/task/interaction', () => {
  it('atomically resolves one exact completion choice and publishes progress', async () => {
    const deps = await dependencies();
    const response = await handleCompletionInteractionRequest(
      request(),
      deps,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      acknowledgement: 'accepted',
      choiceId: 'add_more',
      command: { kind: 'add_more' },
      interactionId,
      taskId,
      taskRevision: 2,
      event: { eventId: 'event_completion_accepted', sequence: 0 },
    });
    const stored = await deps.repository.getById(taskId);
    expect(stored?.task).toMatchObject({
      revision: 2,
      status: 'active',
    });
    expect(stored?.task).not.toHaveProperty('pendingInteraction');
    expect(stored?.task.steps.find((step) => step.stepId === 'step:first'))
      .toMatchObject({ status: 'skipped' });
    expect(stored?.task.journal.at(-1)).toMatchObject({
      type: 'resolve_interaction',
    });
    expect(deps.stream.readAfter({
      afterSequence: -1,
      taskId,
    }).events).toMatchObject([{
      kind: 'selection_accepted',
      taskRevision: 2,
      title: 'Keep shopping selected',
    }]);
  });

  it('normalizes the legacy keep-shopping ingress alias to add_more', async () => {
    const deps = await dependencies();
    const response = await handleCompletionInteractionRequest(
      request({ choiceId: 'keep_shopping' }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acknowledgement: 'accepted',
      choiceId: 'add_more',
      command: { kind: 'add_more' },
    });
    const stored = await deps.repository.getById(taskId);
    expect(stored?.task.pendingInteraction).toBeUndefined();
    expect(JSON.stringify(stored?.task)).not.toContain('keep_shopping');
  });

  it.each([
    {
      choiceId: 'review_cart',
      expected: {
        status: 'active',
        steps: [
          { kind: 'inspect_cart', status: 'ready' },
          { kind: 'ask_next', status: 'planned' },
        ],
      },
    },
    {
      choiceId: 'add_more',
      expected: {
        status: 'active',
        steps: [{ kind: 'ask_next', status: 'skipped' }],
      },
    },
    {
      choiceId: 'stop',
      expected: {
        status: 'completed',
        steps: [{ kind: 'ask_next', status: 'skipped' }],
      },
    },
    {
      choiceId: 'review_checkout',
      expected: {
        status: 'active',
        steps: [{
          kind: 'review_checkout',
          status: 'ready',
          input: {
            action: 'prepare_checkout',
            mode: 'read_only_review',
          },
        }],
      },
    },
  ])(
    'resolves retained event -> $choiceId tap into authoritative state',
    async ({ choiceId, expected }) => {
      const deps = await dependencies();
      deps.newContinuationStepId =
        () => 'step:next-action:after-review';
      const eventResponse = await handleTaskEventsRequest(new Request(
        `http://localhost/api/device/task/events?taskId=${taskId}`
        + '&afterSequence=-1&waitMs=0',
      ), deps);
      const eventBody = await eventResponse.json();
      const interaction = eventBody.events[0]?.interaction;
      expect(interaction).toMatchObject({
        interactionId,
        taskId,
        taskRevision: 1,
      });
      expect(interaction.choices.map(
        (choice: { choiceId: string }) => choice.choiceId,
      )).toEqual([
        'review_cart',
        'add_more',
        'review_checkout',
        'stop',
      ]);

      const response = await handleCompletionInteractionRequest(request({
        choiceId,
        interactionId: interaction.interactionId,
        taskRevision: interaction.taskRevision,
      }), deps);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        acknowledgement: 'accepted',
        choiceId,
      });
      const stored = await deps.repository.getById(taskId);
      expect(stored?.task).toMatchObject(expected);
      expect(stored?.task.steps.some((step) =>
        /dispatch|place_order|confirm/i.test(step.kind))).toBe(false);
    },
  );

  it('is one-shot: exact retry is duplicate and a different winner is rejected', async () => {
    const deps = await dependencies();
    expect((await handleCompletionInteractionRequest(
      request(),
      deps,
    )).status).toBe(200);

    const duplicate = await handleCompletionInteractionRequest(
      request(),
      deps,
    );
    expect(await duplicate.json()).toMatchObject({
      acknowledgement: 'duplicate',
      choiceId: 'add_more',
      taskRevision: 2,
    });

    const conflict = await handleCompletionInteractionRequest(
      request({ choiceId: 'stop' }),
      deps,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      acknowledgement: 'rejected',
      reason: 'already_resolved',
    });
    expect(deps.stream.readAfter({
      afterSequence: -1,
      taskId,
    }).events).toHaveLength(1);
  });

  it('rejects a retained interaction while the task is paused', async () => {
    const task = waitingTask();
    task.status = 'paused';
    const response = await handleCompletionInteractionRequest(
      request(),
      await dependencies(task),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      acknowledgement: 'rejected',
      reason: 'task_paused',
    });
  });

  it('serializes concurrent taps through the repository revision boundary', async () => {
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: () => 50,
      beforeCommit: async (operation) => {
        if (operation !== 'commit') return;
        entered += 1;
        if (entered === 2) release();
        await gate;
      },
    });
    const task = waitingTask();
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:waiting',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'waiting_for_completion_choice',
      },
    });
    const deps: CompletionInteractionRouteDependencies = {
      now: () => 50,
      repository,
      stream: new RetainedTaskEventStreamV2({
        newEventId: () => 'event_concurrent_winner',
        now: () => 50,
      }),
    };
    const responses = await Promise.all([
      handleCompletionInteractionRequest(request(), deps),
      handleCompletionInteractionRequest(request(), deps),
    ]);
    const bodies = await Promise.all(responses.map((response) =>
      response.json()));

    expect(bodies.map((body) => body.acknowledgement).sort()).toEqual([
      'accepted',
      'duplicate',
    ]);
    expect((await repository.getById(taskId))?.task.revision).toBe(2);
    expect(deps.stream.readAfter({
      afterSequence: -1,
      taskId,
    }).events).toHaveLength(1);
  });

  it('rejects stale, expired, disabled, mismatched, and malformed input without committing', async () => {
    const staleDeps = await dependencies();
    expect((await handleCompletionInteractionRequest(
      request({ taskRevision: 0 }),
      staleDeps,
    )).status).toBe(409);

    const expiredDeps = await dependencies(waitingTask({ expiresAt: 40 }));
    const expired = await handleCompletionInteractionRequest(
      request(),
      expiredDeps,
    );
    expect(expired.status).toBe(409);
    expect(await expired.json()).toMatchObject({ reason: 'expired' });

    const unavailableDeps = await dependencies();
    const unavailable = await handleCompletionInteractionRequest(
      request({ choiceId: 'use_current_payment' }),
      unavailableDeps,
    );
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      reason: 'invalid_choice',
    });

    const noCheckoutDeps = await dependencies(waitingTask({
      allowedResponses: ['review_cart', 'add_more', 'stop'],
    }));
    const noCheckout = await handleCompletionInteractionRequest(
      request({ choiceId: 'review_checkout' }),
      noCheckoutDeps,
    );
    expect(noCheckout.status).toBe(422);
    expect(await noCheckout.json()).toMatchObject({
      reason: 'choice_unavailable',
    });

    const wrongClientDeps = await dependencies();
    expect((await handleCompletionInteractionRequest(
      request({ clientId: 'other-client' }),
      wrongClientDeps,
    )).status).toBe(403);
    expect((await handleCompletionInteractionRequest(
      request({ interactionId: 'interaction_87654321' }),
      wrongClientDeps,
    )).status).toBe(404);
    expect((await handleCompletionInteractionRequest(
      request({ source: 'voice' }),
      wrongClientDeps,
    )).status).toBe(400);

    expect((await staleDeps.repository.getById(taskId))?.task.revision)
      .toBe(1);
    expect(staleDeps.stream.readAfter({
      afterSequence: -1,
      taskId,
    }).events).toHaveLength(0);
  });

  it('records deterministic choice wait and accepted, duplicate, and rejected acknowledgements', async () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const deps = await dependencies();
    deps.metrics = metrics;

    expect((await handleCompletionInteractionRequest(
      request(),
      deps,
    )).status).toBe(200);
    expect((await handleCompletionInteractionRequest(
      request(),
      deps,
    )).status).toBe(200);
    expect((await handleCompletionInteractionRequest(
      request({ source: 'voice' }),
      deps,
    )).status).toBe(400);

    expect(metrics.snapshot()).toEqual([
      {
        version: 1,
        phase: 'choice_wait',
        outcome: 'completed',
        durationMs: 48,
        clientId: 'pixel-overlay',
        interactionId,
        taskId,
      },
      {
        version: 1,
        phase: 'choice_acknowledgement',
        outcome: 'completed',
        durationMs: 0,
        targetMs: 250,
        targetMet: true,
        clientId: 'pixel-overlay',
        interactionId,
        taskId,
      },
      {
        version: 1,
        phase: 'choice_acknowledgement',
        outcome: 'duplicate',
        durationMs: 0,
        targetMs: 250,
        targetMet: true,
        clientId: 'pixel-overlay',
        interactionId,
        taskId,
      },
      {
        version: 1,
        phase: 'choice_acknowledgement',
        outcome: 'rejected',
        durationMs: 0,
        targetMs: 250,
        targetMet: true,
      },
    ]);
  });

  it('records terminal task completion once at the authoritative stop commit', async () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const deps = await dependencies(waitingTask(), 50);
    deps.metrics = metrics;

    const response = await handleCompletionInteractionRequest(
      request({ choiceId: 'stop' }),
      deps,
    );

    expect(response.status).toBe(200);
    const stored = (await deps.repository.getById(taskId))!.task;
    expect(stored).toMatchObject({
      status: 'completed',
      terminalAt: 50,
    });
    expect(metrics.snapshot()).toContainEqual({
      version: 1,
      phase: 'task_completion',
      outcome: 'completed',
      durationMs: 49,
      clientId: 'pixel-overlay',
      taskId,
    });
  });
});
