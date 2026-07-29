import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RetainedTaskEventStreamV2,
  taskEventStreamV2,
} from '../../../../../lib/progress/v2';
import { newLocalIdentifier } from '../../../../../lib/workflow/identifiers';
import {
  DeterministicUxTimingMetricsCollectorV1,
} from '../../../../../lib/ux-timing-metrics';
import {
  InMemoryPhoneTaskRepositoryV2,
  transitionPhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import { validTaskV2 } from '../../../../../lib/workflow/v2/test-fixtures';
import { GET, handleTaskEventsRequest } from './route';

describe('GET /api/device/task/events', () => {
  const taskId = newLocalIdentifier('task');

  beforeEach(() => {
    taskEventStreamV2.cleanup(Number.POSITIVE_INFINITY);
  });

  it('returns retained events after the supplied cursor', async () => {
    taskEventStreamV2.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Task started',
    });

    const response = await GET(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1`,
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      afterSequence: -1,
      latestSequence: 0,
      resetRequired: false,
      taskId,
    });
    expect(body.events).toHaveLength(1);
  });

  it('rejects malformed cursors and task identifiers', async () => {
    expect((await GET(new Request(
      'http://localhost/api/device/task/events?taskId=nope',
    ))).status).toBe(400);
    expect((await GET(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=1.5`,
    ))).status).toBe(400);
    expect((await GET(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&waitMs=4501`,
    ))).status).toBe(400);
    expect((await GET(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&waitMs=1.5`,
    ))).status).toBe(400);
  });

  it('idempotently projects an open completion interaction into retained events', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const waiting = transitionPhoneTaskV2(task, {
      type: 'wait_for_user',
      stepId: 'step:first',
      entryId: 'journal:wait-for-next',
      at: 2,
      interaction: {
        interactionId: 'interaction_12345678',
        taskId,
        taskRevision: 1,
        kind: 'next_action',
        allowedResponses: ['add_more', 'review_checkout', 'stop'],
        presentationRef: 'presentation:next-action',
        status: 'open',
        createdAt: 2,
        expiresAt: 100,
      },
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task: waiting,
      event: {
        eventId: 'repository-event:waiting',
        taskId,
        taskRevision: waiting.revision,
        at: waiting.updatedAt,
        kind: 'waiting_for_next_action',
      },
    });
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => 'event_completion_prompt',
      now: () => 50,
    });
    const request = new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1`,
    );
    const dependencies = {
      now: () => 50,
      repository,
      stream,
    };
    const first = await handleTaskEventsRequest(request, dependencies);
    const second = await handleTaskEventsRequest(request, dependencies);
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(firstBody.events).toMatchObject([{
      eventId: 'event_completion_prompt',
      kind: 'waiting_for_user',
      interaction: {
        interactionId: 'interaction_12345678',
        taskId,
        taskRevision: 1,
        choices: [
          {
            choiceId: 'review_cart',
            enabled: true,
            label: 'Review cart',
          },
          {
            choiceId: 'add_more',
            enabled: true,
            label: 'Keep shopping',
          },
          {
            choiceId: 'review_checkout',
            enabled: true,
            label: 'Review checkout',
          },
          { choiceId: 'stop', enabled: true, label: 'Stop' },
        ],
      },
    }]);
    expect(secondBody.events).toHaveLength(1);
    expect(secondBody.latestSequence).toBe(0);
  });

  it('waits for a new event and preserves cursor ordering on reconnect', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:created',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });
    let eventNumber = 0;
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => `event_${eventNumber += 1}`,
      now: () => 50,
    });
    const dependencies = {
      now: () => 50,
      repository,
      stream,
    };

    const firstResponsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1&waitMs=250`,
    ), dependencies);
    setTimeout(() => stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 0,
      title: 'Searching',
    }), 5);
    const firstResponse = await firstResponsePromise;
    const firstBody = await firstResponse.json();

    expect(firstBody.events.map((event: { sequence: number }) => event.sequence))
      .toEqual([0]);

    const secondResponsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=0&waitMs=250`,
    ), dependencies);
    setTimeout(() => stream.publish({
      kind: 'options_ready',
      taskId,
      taskRevision: 0,
      title: 'Options ready',
    }), 5);
    const secondResponse = await secondResponsePromise;
    const secondBody = await secondResponse.json();

    expect(secondBody).toMatchObject({
      afterSequence: 0,
      latestSequence: 1,
      resetRequired: false,
    });
    expect(secondBody.events.map((event: { sequence: number }) => event.sequence))
      .toEqual([1]);
  });

  it('returns a cursor-safe empty snapshot when the bounded wait expires', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:created',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });
    const stream = new RetainedTaskEventStreamV2({ now: () => 50 });

    const response = await handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1&waitMs=5`,
    ), {
      now: () => 50,
      repository,
      stream,
    });

    expect(await response.json()).toMatchObject({
      afterSequence: -1,
      events: [],
      latestSequence: -1,
      resetRequired: false,
      taskId,
    });
  });

  it('ends an in-flight wait when the request is aborted', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:created',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });
    const stream = new RetainedTaskEventStreamV2({ now: () => 50 });
    const controller = new AbortController();
    const responsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1&waitMs=4000`,
      { signal: controller.signal },
    ), {
      now: () => 50,
      repository,
      stream,
    });
    setTimeout(() => controller.abort(), 5);

    const response = await responsePromise;

    expect(await response.json()).toMatchObject({
      afterSequence: -1,
      events: [],
      latestSequence: -1,
      taskId,
    });
  });

  it('supersedes an older task wait for the same durable client', async () => {
    const replacementTaskId = newLocalIdentifier('task');
    const original = validTaskV2();
    original.taskId = taskId;
    original.clientId = 'pixel-overlay';
    const replacement = validTaskV2();
    replacement.taskId = replacementTaskId;
    replacement.clientId = original.clientId;
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task: original,
      event: {
        eventId: 'repository-event:original',
        taskId,
        taskRevision: original.revision,
        at: original.updatedAt,
        kind: 'task_created',
      },
    });
    const stream = new RetainedTaskEventStreamV2({ now: () => 50 });
    const waitSpy = vi.spyOn(stream, 'waitAfter');
    const dependencies = {
      now: () => 50,
      repository,
      stream,
    };

    const originalResponsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1&waitMs=4000`,
    ), dependencies);
    await vi.waitFor(() => expect(waitSpy).toHaveBeenCalledTimes(1));
    await repository.replaceForClient({
      currentTaskId: taskId,
      expectedRevision: original.revision,
      nextTask: replacement,
      reason: 'unrelated_task',
      replacedEvent: {
        eventId: 'repository-event:replaced',
        taskId,
        taskRevision: original.revision + 1,
        at: 2,
        kind: 'task_replaced',
      },
      createdEvent: {
        eventId: 'repository-event:replacement',
        taskId: replacementTaskId,
        taskRevision: replacement.revision,
        at: replacement.updatedAt,
        kind: 'task_created',
      },
    });

    stream.publish({
      kind: 'task_started',
      taskId: replacementTaskId,
      taskRevision: 0,
      title: 'Replacement task started',
    });
    const replacementResponsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${replacementTaskId}&afterSequence=-1&waitMs=4000`,
    ), dependencies);
    await vi.waitFor(() => expect(waitSpy).toHaveBeenCalledTimes(2));

    const [originalResponse, replacementResponse] = await Promise.all([
      originalResponsePromise,
      replacementResponsePromise,
    ]);
    const originalBody = await originalResponse.json();
    const replacementBody = await replacementResponse.json();

    expect(originalBody).toMatchObject({
      events: [],
      latestSequence: -1,
      taskId,
    });
    expect(replacementBody).toMatchObject({
      latestSequence: 0,
      taskId: replacementTaskId,
    });
    expect(replacementBody.events).toMatchObject([{
      kind: 'task_started',
      sequence: 0,
    }]);
  });

  it('keeps an ambiguous task subscribed for reconciliation events', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    task.status = 'ambiguous';
    task.steps[0]!.status = 'ambiguous';
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:ambiguous',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_ambiguous',
      },
    });
    const stream = new RetainedTaskEventStreamV2({ now: () => 50 });
    stream.publish({
      kind: 'ambiguous',
      taskId,
      taskRevision: task.revision,
      title: 'Needs reconciliation',
    });
    const waitSpy = vi.spyOn(stream, 'waitAfter');

    const responsePromise = handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=0&waitMs=250`,
    ), {
      now: () => 50,
      repository,
      stream,
    });
    setTimeout(() => stream.publish({
      kind: 'reviewing_cart',
      taskId,
      taskRevision: task.revision + 1,
      title: 'Reconciling',
    }), 5);

    const response = await responsePromise;
    expect(waitSpy).toHaveBeenCalledWith(expect.objectContaining({
      timeoutMs: 250,
    }));
    expect((await response.json()).events).toMatchObject([{
      kind: 'reviewing_cart',
      sequence: 1,
    }]);
  });

  it('idempotently publishes a cancelled terminal event and stops polling', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const cancelled = transitionPhoneTaskV2(task, {
      type: 'cancel_task',
      entryId: 'journal:cancel',
      at: 2,
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 50 });
    await repository.create({
      task: cancelled,
      event: {
        eventId: 'repository-event:cancelled',
        taskId,
        taskRevision: cancelled.revision,
        at: cancelled.updatedAt,
        kind: 'task_cancelled',
      },
    });
    const stream = new RetainedTaskEventStreamV2({ now: () => 50 });
    const waitSpy = vi.spyOn(stream, 'waitAfter');

    const request = new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}&afterSequence=-1&waitMs=4000`,
    );
    const dependencies = {
      now: () => 50,
      repository,
      stream,
    };
    const response = await handleTaskEventsRequest(request, dependencies);
    const replay = await handleTaskEventsRequest(request, dependencies);

    expect(response.status).toBe(200);
    expect(waitSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      subscriptionId: 'pixel-overlay',
      timeoutMs: 0,
    }));
    expect(await response.json()).toMatchObject({
      events: [{
        kind: 'cancelled',
        taskId,
        taskRevision: cancelled.revision,
        terminal: true,
      }],
      snapshot: {
        cancelled: true,
        taskId,
        terminal: true,
      },
    });
    expect((await replay.json()).events).toHaveLength(1);
  });

  it('records delivered events and an empty bounded wait as timeout, never error', async () => {
    const task = validTaskV2();
    task.taskId = taskId;
    task.clientId = 'pixel-overlay';
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: (): number => 50,
    });
    await repository.create({
      task,
      event: {
        eventId: 'repository-event:created',
        taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });
    const stream = new RetainedTaskEventStreamV2({
      now: (): number => 50,
    });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: task.revision,
      title: 'Task started',
    });
    const ticks = [100, 125, 200, 4_200];
    const metrics = new DeterministicUxTimingMetricsCollectorV1({
      now: (): number => ticks.shift()!,
    });
    const dependencies = {
      metrics,
      now: (): number => 50,
      repository,
      stream,
    };

    await handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}`
      + '&afterSequence=-1&waitMs=0',
    ), dependencies);
    await handleTaskEventsRequest(new Request(
      `http://localhost/api/device/task/events?taskId=${taskId}`
      + '&afterSequence=0&waitMs=1',
    ), dependencies);

    expect(metrics.snapshot()).toEqual([
      {
        version: 1,
        phase: 'event_delivery',
        outcome: 'completed',
        durationMs: 25,
        clientId: 'pixel-overlay',
        taskId,
      },
      {
        version: 1,
        phase: 'event_delivery',
        outcome: 'timeout',
        durationMs: 4_000,
        clientId: 'pixel-overlay',
        taskId,
      },
    ]);
    expect(metrics.snapshot()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: 'error' })]),
    );
  });
});
