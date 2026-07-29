import { describe, expect, it, vi } from 'vitest';
import { RetainedTaskEventStreamV2 } from '../../../progress/v2/retained-task-event-stream';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../identifiers';
import { acceptBackgroundPhoneOperationV2 } from './coordinator-hook';
import type {
  BackgroundPhoneOperationEnqueueInputV2,
  BackgroundPhoneOperationWorkerResultV2,
} from './contracts';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
} from './store';
import { BackgroundPhoneOperationManagerV2 } from './manager';
import {
  DeterministicUxTimingMetricsCollectorV1,
} from '../../../ux-timing-metrics';

const taskA = parseLocalIdentifier('task', 'task_aaaaaaaa');
const taskB = parseLocalIdentifier('task', 'task_bbbbbbbb');

function operationIds(): () => LocalIdentifier<'operation'> {
  let next = 0;
  return (): LocalIdentifier<'operation'> => parseLocalIdentifier(
    'operation',
    `operation_${String(++next).padStart(8, '0')}`,
  );
}

function request(
  taskId = taskA,
  stepId = 'search',
  taskRevision = 1,
): BackgroundPhoneOperationEnqueueInputV2 {
  return {
    taskId,
    taskRevision,
    stepId,
    operationKind: 'phone_search',
    requestPayload: { query: 'milk' },
  };
}

describe('BackgroundPhoneOperationManagerV2', () => {
  it('returns an accepted handoff while a durable tracked worker is running', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = vi.fn(async () => {
      await gate;
      return { outcome: 'completed' as const };
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store,
      stream,
      worker,
      newOperationId: operationIds(),
    });

    const accepted = await acceptBackgroundPhoneOperationV2(
      manager,
      request(),
      parseLocalIdentifier('operation', 'operation_coord001'),
    );

    expect(accepted).toMatchObject({
      disposition: 'enqueued',
      operationAccepted: {
        status: 'accepted',
        operationId: 'operation_coord001',
        taskId: taskA,
      },
    });
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
    expect(
      (await store.get(accepted.operationAccepted.operationId))?.status,
    ).toBe('running');

    release();
    await manager.awaitIdle();
    expect(
      (await store.get(accepted.operationAccepted.operationId))?.status,
    ).toBe('completed');
  });

  it('deduplicates the same task/step/revision and suppresses task concurrency', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store,
      stream,
      worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        await gate;
        return { outcome: 'completed' };
      },
      newOperationId: operationIds(),
    });

    const [first, duplicate] = await Promise.all([
      manager.enqueue(request()),
      manager.enqueue(request()),
    ]);
    const busy = await manager.enqueue(request(taskA, 'add_to_cart', 1));

    expect([first.disposition, duplicate.disposition].sort()).toEqual([
      'duplicate',
      'enqueued',
    ]);
    expect(first.operationAccepted.operationId).toBe(
      duplicate.operationAccepted.operationId,
    );
    expect(busy).toMatchObject({
      disposition: 'task_busy',
      operationAccepted: {
        operationId: first.operationAccepted.operationId,
      },
    });

    release();
    await manager.awaitIdle();
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'blocked'],
    ['ambiguous', 'ambiguous'],
  ] as const)(
    'persists %s and publishes its retained terminal event',
    async (outcome, eventKind) => {
      const store = new InMemoryBackgroundPhoneOperationStoreV2();
      const stream = new RetainedTaskEventStreamV2();
      const manager = new BackgroundPhoneOperationManagerV2({
        store,
        stream,
        worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => ({
          outcome,
          detail: `${outcome} detail`,
          resultRef: 'result_reference',
        }),
        newOperationId: operationIds(),
      });

      const accepted = await manager.enqueue(request());
      await manager.awaitIdle();
      const operation = await manager.get(
        accepted.operationAccepted.operationId,
      );
      const events = stream.readAfter({ taskId: taskA });

      expect(operation).toMatchObject({
        status: outcome,
        detail: `${outcome} detail`,
        resultRef: 'result_reference',
      });
      expect(operation?.terminalEventPublishedAt).toEqual(expect.any(Number));
      expect(events.events.at(-1)).toMatchObject({
        operationId: accepted.operationAccepted.operationId,
        kind: eventKind,
      });
    },
  );

  it('announces the exact verified product after a background add completes', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    const manager = new BackgroundPhoneOperationManagerV2({
      store,
      stream,
      worker: async () => ({ outcome: 'completed' }),
      newOperationId: operationIds(),
    });

    const accepted = await manager.enqueue({
      taskId: taskA,
      taskRevision: 4,
      stepId: 'task_item_milk',
      operationKind: 'add_cart_item',
      requestPayload: {
        version: 1,
        action: {
          action: 'add_cart_item',
          offerId: 'offer_milk',
          quantity: 1,
          request: 'Amul milk',
          selectedOffer: {
            offerId: 'offer_milk',
            priceAmount: 29,
            priceCurrency: 'INR',
            title: 'Amul Taaza Toned Milk',
          },
        },
      },
    });
    await manager.awaitIdle();

    const events = stream.readAfter({ taskId: taskA }).events.filter(
      (event) =>
        event.operationId === accepted.operationAccepted.operationId,
    );
    expect(events.map((event) => event.kind)).toEqual([
      'step_started',
      'mutation_verified',
    ]);
    expect(events[1]).toMatchObject({
      announcement: {
        channel: 'speech_and_visual',
        text: 'Amul Taaza Toned Milk added to cart.',
      },
      title: 'Amul Taaza Toned Milk added to cart',
    });
  });

  it('runs different tasks independently while retaining one worker per task', async () => {
    const activeByTask = new Map<string, number>();
    const maximumByTask = new Map<string, number>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store: new InMemoryBackgroundPhoneOperationStoreV2(),
      stream: new RetainedTaskEventStreamV2(),
      worker: async (
        operation,
      ): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        const active = (activeByTask.get(operation.taskId) ?? 0) + 1;
        activeByTask.set(operation.taskId, active);
        maximumByTask.set(
          operation.taskId,
          Math.max(maximumByTask.get(operation.taskId) ?? 0, active),
        );
        await gate;
        activeByTask.set(operation.taskId, active - 1);
        return { outcome: 'completed' };
      },
      newOperationId: operationIds(),
    });

    await Promise.all([
      manager.enqueue(request(taskA)),
      manager.enqueue(request(taskB)),
    ]);
    await vi.waitFor(() => expect(activeByTask.size).toBe(2));
    expect([...maximumByTask.values()]).toEqual([1, 1]);

    release();
    await manager.awaitIdle();
  });

  it('bounds the number of concurrently active task workers', async () => {
    const taskC = parseLocalIdentifier('task', 'task_cccccccc');
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new BackgroundPhoneOperationManagerV2({
      store: new InMemoryBackgroundPhoneOperationStoreV2(),
      stream: new RetainedTaskEventStreamV2(),
      maxConcurrentTasks: 2,
      worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return { outcome: 'completed' };
      },
      newOperationId: operationIds(),
    });

    await Promise.all([
      manager.enqueue(request(taskA)),
      manager.enqueue(request(taskB)),
      manager.enqueue(request(taskC)),
    ]);
    await vi.waitFor(() => expect(active).toBe(2));
    expect(maximum).toBe(2);

    release();
    await manager.awaitIdle();
    expect(maximum).toBe(2);
  });

  it('converts a post-marker worker crash to ambiguity', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const manager = new BackgroundPhoneOperationManagerV2({
      store,
      stream: new RetainedTaskEventStreamV2(),
      worker: async (_operation, control) => {
        await control.markMutationAttempted();
        throw new Error('simulated crash after provider dispatch');
      },
      newOperationId: operationIds(),
    });

    const accepted = await manager.enqueue(request());
    await manager.awaitIdle();

    expect(await store.get(accepted.operationAccepted.operationId))
      .toMatchObject({
        status: 'ambiguous',
        detail: 'simulated crash after provider dispatch',
      });
  });

  it('records durable background lifecycle boundaries with an injected clock', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const managerTicks = [0, 100, 140, 190, 260];
    const streamTicks = [110, 270];
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const manager = new BackgroundPhoneOperationManagerV2({
      metrics,
      now: (): number => managerTicks.shift()!,
      store,
      stream: new RetainedTaskEventStreamV2({
        now: (): number => streamTicks.shift()!,
      }),
      worker: async (
        _operation,
        control,
      ): Promise<BackgroundPhoneOperationWorkerResultV2> => {
        await control.markMutationAttempted();
        return { outcome: 'completed' };
      },
      newOperationId: operationIds(),
    });

    const accepted = await manager.enqueue({
      ...request(),
      operationKind: 'add_cart_item',
    });
    await manager.awaitIdle();

    expect(await store.get(accepted.operationAccepted.operationId))
      .toMatchObject({
        createdAt: 100,
        startedAt: 140,
        mutationAttemptedAt: 190,
        terminalAt: 260,
      });
    expect(metrics.snapshot()).toEqual([
      expect.objectContaining({
        phase: 'accepted_to_first_event',
        outcome: 'completed',
        durationMs: 10,
        targetMs: 500,
        targetMet: true,
      }),
      expect.objectContaining({
        phase: 'accepted_to_worker_start',
        outcome: 'completed',
        durationMs: 40,
        targetMs: 500,
        targetMet: true,
      }),
      expect.objectContaining({
        phase: 'accepted_to_mutation_start',
        outcome: 'completed',
        durationMs: 90,
      }),
      expect.objectContaining({
        phase: 'mutation',
        outcome: 'completed',
        durationMs: 70,
      }),
      expect.objectContaining({
        phase: 'verified_to_next_step',
        outcome: 'completed',
        durationMs: 10,
        targetMs: 1_000,
        targetMet: true,
      }),
    ]);
    expect(metrics.snapshot().every((metric) =>
      metric.operationId === accepted.operationAccepted.operationId
      && metric.taskId === taskA)).toBe(true);
  });

  it('records read-only worker time as verification without a mutation phase', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const managerTicks = [0, 100, 140, 200];
    const streamTicks = [110, 210];
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const manager = new BackgroundPhoneOperationManagerV2({
      metrics,
      now: (): number => managerTicks.shift()!,
      store,
      stream: new RetainedTaskEventStreamV2({
        now: (): number => streamTicks.shift()!,
      }),
      worker: async (): Promise<BackgroundPhoneOperationWorkerResultV2> => ({
        outcome: 'completed',
      }),
      newOperationId: operationIds(),
    });

    await manager.enqueue({
      ...request(),
      operationKind: 'inspect_cart',
    });
    await manager.awaitIdle();

    expect(metrics.snapshot()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'verification',
        outcome: 'completed',
        durationMs: 60,
      }),
    ]));
    expect(metrics.snapshot()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'mutation' }),
    ]));
  });
});
