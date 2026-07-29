import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const replacementTaskId = parseLocalIdentifier(
  'task',
  'task_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
);

afterEach(() => {
  vi.useRealTimers();
});

describe('retained task event stream v2 long polling', () => {
  it('returns retained replay immediately without creating a waiter', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Started',
    });

    await expect(stream.waitAfter({
      afterSequence: -1,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      afterSequence: -1,
      latestSequence: 0,
      resetRequired: false,
      events: [{ sequence: 0, title: 'Started' }],
    });
  });

  it('wakes on publish with ordered events after the requested cursor', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const waiting = stream.waitAfter({
      afterSequence: -1,
      taskId,
      timeoutMs: 30_000,
    });

    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Started',
    });
    stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 1,
      title: 'Searching',
    });

    await expect(waiting).resolves.toMatchObject({
      latestSequence: 0,
      events: [{ sequence: 0, title: 'Started' }],
    });
    expect(stream.readAfter({ afterSequence: 0, taskId }).events).toEqual([
      expect.objectContaining({ sequence: 1, title: 'Searching' }),
    ]);
  });

  it('returns a cursor-safe empty snapshot at the bounded timeout', async () => {
    vi.useFakeTimers();
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const waiting = stream.waitAfter({
      afterSequence: -1,
      taskId,
      timeoutMs: 4_000,
    });

    await vi.advanceTimersByTimeAsync(4_000);

    await expect(waiting).resolves.toMatchObject({
      afterSequence: -1,
      earliestSequence: 0,
      latestSequence: -1,
      resetRequired: false,
      events: [],
    });
  });

  it('resolves on abort and removes the waiter before later events', async () => {
    const controller = new AbortController();
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const waiting = stream.waitAfter({
      afterSequence: -1,
      signal: controller.signal,
      taskId,
      timeoutMs: 30_000,
    });

    controller.abort();
    await expect(waiting).resolves.toMatchObject({
      latestSequence: -1,
      events: [],
    });

    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Published after abort',
    });
    expect(stream.readAfter({ taskId }).events).toHaveLength(1);
  });

  it('supersedes an older subscription across replacement task ids', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const superseded = stream.waitAfter({
      afterSequence: -1,
      subscriptionId: 'client-123',
      taskId,
      timeoutMs: 30_000,
    });
    const replacement = stream.waitAfter({
      afterSequence: -1,
      subscriptionId: 'client-123',
      taskId: replacementTaskId,
      timeoutMs: 30_000,
    });

    await expect(superseded).resolves.toMatchObject({
      taskId,
      latestSequence: -1,
      events: [],
    });
    stream.publish({
      kind: 'task_started',
      taskId: replacementTaskId,
      taskRevision: 0,
      title: 'Replacement started',
    });
    await expect(replacement).resolves.toMatchObject({
      taskId: replacementTaskId,
      events: [{ sequence: 0, title: 'Replacement started' }],
    });
  });

  it('supersedes an older wait before replaying retained replacement events', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const superseded = stream.waitAfter({
      afterSequence: -1,
      subscriptionId: 'client-with-retained-replacement',
      taskId,
      timeoutMs: 30_000,
    });
    stream.publish({
      kind: 'task_started',
      taskId: replacementTaskId,
      taskRevision: 0,
      title: 'Replacement already started',
    });

    const replacement = stream.waitAfter({
      afterSequence: -1,
      subscriptionId: 'client-with-retained-replacement',
      taskId: replacementTaskId,
      timeoutMs: 30_000,
    });

    await expect(superseded).resolves.toMatchObject({
      taskId,
      latestSequence: -1,
      events: [],
    });
    await expect(replacement).resolves.toMatchObject({
      taskId: replacementTaskId,
      events: [{ sequence: 0, title: 'Replacement already started' }],
    });
  });

  it('does not retain a waiter after an explicitly terminal event', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    stream.publish({
      kind: 'completed',
      taskId,
      taskRevision: 1,
      terminal: true,
      title: 'Terminal',
    });

    await expect(stream.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      afterSequence: 0,
      latestSequence: 0,
      events: [],
    });
  });

  it('waits after ambiguity and wakes for a later reconciliation event', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    stream.publish({
      kind: 'ambiguous',
      taskId,
      taskRevision: 1,
      title: 'Needs reconciliation',
    });
    const waiting = stream.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    });

    stream.publish({
      kind: 'reviewing_cart',
      taskId,
      taskRevision: 2,
      title: 'Reconciling cart',
    });

    await expect(waiting).resolves.toMatchObject({
      events: [{ kind: 'reviewing_cart', sequence: 1 }],
      latestSequence: 1,
    });
  });

  it('returns an already-due heartbeat without retaining a waiter', async () => {
    let now = 0;
    const stream = new RetainedTaskEventStreamV2({
      heartbeatAfterMs: 1_000,
      now: () => now,
    });
    stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 1,
      title: 'Searching',
    });
    now = 1_500;

    await expect(stream.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      events: [],
      heartbeat: {
        elapsedMs: 1_500,
        sourceSequence: 0,
      },
    });
  });

  it('preserves reset semantics instead of waiting on an invalid cursor', async () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 1,
      now: () => 100,
    });
    for (const title of ['one', 'two']) {
      stream.publish({
        kind: 'step_started',
        taskId,
        taskRevision: 0,
        title,
      });
    }

    await expect(stream.waitAfter({
      afterSequence: -1,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      earliestSequence: 1,
      latestSequence: 1,
      resetRequired: true,
      events: [],
    });
  });

  it('preserves the reconstructable projection when a wait cursor needs reset', async () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 1,
      now: () => 100,
    });
    for (const [index, title] of ['Milk', 'Bread'].entries()) {
      stream.publish({
        item: {
          index: index + 1,
          requestedLabel: title.toLocaleLowerCase('en-IN'),
          title,
          total: 2,
        },
        kind: 'mutation_verified',
        progress: { completed: index + 1, total: 2 },
        taskId,
        taskRevision: index + 1,
        title: `${title} added`,
      });
    }

    await expect(stream.waitAfter({
      afterSequence: -1,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      events: [],
      resetRequired: true,
      snapshot: {
        items: [
          { index: 1, title: 'Milk' },
          { index: 2, title: 'Bread' },
        ],
        progress: { completed: 2, total: 2 },
      },
    });
  });

  it('supports long polling after export and restore', async () => {
    const original = new RetainedTaskEventStreamV2({ now: () => 100 });
    original.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Started',
    });
    const restored = new RetainedTaskEventStreamV2({
      initialState: original.exportState(),
      now: () => 101,
    });
    const waiting = restored.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    });

    restored.publish({
      kind: 'searching',
      taskId,
      taskRevision: 1,
      title: 'Searching',
    });

    await expect(waiting).resolves.toMatchObject({
      events: [{ kind: 'searching', sequence: 1 }],
      snapshot: {
        latestSequence: 1,
        taskRevision: 1,
      },
    });
  });

  it('wakes and removes waiters when retention cleanup expires a task', async () => {
    let now = 0;
    const stream = new RetainedTaskEventStreamV2({
      now: () => now,
      taskTtlMs: 10,
    });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Started',
    });
    const waiting = stream.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    });

    now = 11;
    expect(stream.cleanup()).toBe(1);
    await expect(waiting).resolves.toMatchObject({
      events: [],
      latestSequence: -1,
      taskId,
    });
  });

  it('wakes old-task waiters when max-task eviction replaces retention', async () => {
    const stream = new RetainedTaskEventStreamV2({
      maxTasks: 1,
      now: () => 100,
    });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Original',
    });
    const waiting = stream.waitAfter({
      afterSequence: 0,
      taskId,
      timeoutMs: 30_000,
    });

    stream.publish({
      kind: 'task_started',
      taskId: replacementTaskId,
      taskRevision: 0,
      title: 'Replacement',
    });

    await expect(waiting).resolves.toMatchObject({
      events: [],
      latestSequence: -1,
      taskId,
    });
  });

  it('rejects unbounded or malformed wait durations', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });

    expect(() => stream.waitAfter({
      taskId,
      timeoutMs: 30_001,
    })).toThrow('timeoutMs must be an integer between 0 and 30000.');
  });

  it('treats durable subscription identities as opaque values', async () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const opaqueSubscriptionId = ` client-${'x'.repeat(140)} `;
    const waiting = stream.waitAfter({
      subscriptionId: opaqueSubscriptionId,
      taskId,
      timeoutMs: 30_000,
    });
    const replacement = stream.waitAfter({
      subscriptionId: opaqueSubscriptionId,
      taskId: replacementTaskId,
      timeoutMs: 0,
    });

    await expect(waiting).resolves.toMatchObject({
      events: [],
      taskId,
    });
    await expect(replacement).resolves.toMatchObject({
      events: [],
      taskId: replacementTaskId,
    });
  });
});
