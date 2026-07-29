import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  RetainedTaskEventStreamV2,
  TaskEventCursorV2,
} from './retained-task-event-stream';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const anotherTaskId = parseLocalIdentifier(
  'task',
  'task_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
);

describe('retained task event stream v2', () => {
  it('assigns ordered sequences, deduplicates checkpoints, and resumes by cursor', () => {
    let eventNumber = 0;
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => `event_${++eventNumber}`,
      now: () => 100,
    });

    const first = stream.publish({
      dedupeKey: 'task-start',
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Shopping task started',
    });
    const duplicate = stream.publish({
      dedupeKey: 'task-start',
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Shopping task started',
    });
    const second = stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 1,
      title: 'Searching for milk',
    });

    expect(first.sequence).toBe(0);
    expect(duplicate).toEqual(first);
    expect(second.sequence).toBe(1);
    expect(stream.readAfter({ afterSequence: 0, taskId })).toMatchObject({
      earliestSequence: 0,
      latestSequence: 1,
      resetRequired: false,
      events: [{ sequence: 1, title: 'Searching for milk' }],
    });
  });

  it('enriches a deduplicated handoff projection without replaying an event', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    stream.publish({
      dedupeKey: 'operation:mutation_verified',
      kind: 'mutation_verified',
      taskId,
      taskRevision: 1,
      title: 'Operation completed',
    });
    const retained = stream.publish({
      dedupeKey: 'operation:mutation_verified',
      kind: 'mutation_verified',
      taskId,
      taskRevision: 1,
      title: 'Potatoes added',
      item: {
        index: 1,
        total: 2,
        title: 'Potatoes',
        requestedLabel: 'potatoes',
        packSize: '1 kg',
        quantity: 2,
        price: '₹80',
      },
      progress: {
        completed: 1,
        total: 2,
        nextLabel: 'Paneer',
      },
    });

    expect(retained.title).toBe('Operation completed');
    expect(stream.readAfter({ taskId })).toMatchObject({
      latestSequence: 0,
      events: [{ title: 'Operation completed' }],
      snapshot: {
        items: [
          {
            index: 1,
            packSize: '1 kg',
            quantity: 2,
            price: '₹80',
          },
          {
            index: 2,
            title: 'Paneer',
            requestedLabel: 'Paneer',
          },
        ],
        activeItem: {
          index: 2,
          title: 'Paneer',
        },
        progress: {
          completed: 1,
          total: 2,
          nextLabel: 'Paneer',
        },
      },
    });
  });

  it('bounds retained history and requires a reset when a reconnect cursor is too old', () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 2,
      newEventId: (() => {
        let number = 0;
        return () => `event_${++number}`;
      })(),
      now: () => 100,
    });
    for (const title of ['one', 'two', 'three']) {
      stream.publish({
        kind: 'step_started',
        taskId,
        taskRevision: 0,
        title,
      });
    }

    expect(stream.readAfter({ afterSequence: -1, taskId })).toMatchObject({
      earliestSequence: 1,
      latestSequence: 2,
      resetRequired: true,
      events: [],
    });
    expect(stream.readAfter({ afterSequence: 0, taskId })).toMatchObject({
      resetRequired: false,
      events: [
        { sequence: 1, title: 'two' },
        { sequence: 2, title: 'three' },
      ],
    });
  });

  it('keeps a reconstructable item snapshot after old events expire', () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 1,
      now: () => 100,
    });
    for (const [index, title] of ['Milk', 'Bread'].entries()) {
      stream.publish({
        kind: 'mutation_verified',
        taskId,
        taskRevision: index + 1,
        title: `${title} added`,
        item: {
          title,
          requestedLabel: title.toLocaleLowerCase('en-IN'),
          index: index + 1,
          total: 2,
        },
        progress: {
          completed: index + 1,
          total: 2,
        },
      });
    }

    expect(stream.readAfter({ afterSequence: -1, taskId })).toMatchObject({
      resetRequired: true,
      events: [],
      snapshot: {
        items: [
          { title: 'Milk', index: 1, total: 2 },
          { title: 'Bread', index: 2, total: 2 },
        ],
        progress: { completed: 2, total: 2 },
      },
    });
  });

  it('retains ambiguous pack and price evidence without completing the task', () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 1,
      now: () => 100,
    });
    stream.publish({
      item: {
        index: 1,
        total: 1,
        title: 'Paneer',
        requestedLabel: 'paneer 200 g',
        packSize: '250 g',
        quantity: 1,
        price: '₹120',
        conflicts: [
          {
            field: 'pack_size',
            expected: '200 g',
            observed: '250 g',
          },
          {
            field: 'price',
            expected: '₹105',
            observed: '₹120',
          },
        ],
      },
      kind: 'ambiguous',
      progress: {
        completed: 0,
        total: 1,
        nextLabel: 'Paneer',
      },
      taskId,
      taskRevision: 2,
      title: 'Paneer needs reconciliation',
    });
    stream.publish({
      kind: 'reviewing_cart',
      taskId,
      taskRevision: 3,
      title: 'Checking the cart',
    });

    const reset = stream.readAfter({ afterSequence: -1, taskId });
    expect(reset).toMatchObject({
      resetRequired: true,
      snapshot: {
        activeItem: {
          index: 1,
          conflicts: [
            { field: 'pack_size', expected: '200 g', observed: '250 g' },
            { field: 'price', expected: '₹105', observed: '₹120' },
          ],
        },
        items: [{
          index: 1,
          conflicts: [
            { field: 'pack_size', expected: '200 g', observed: '250 g' },
            { field: 'price', expected: '₹105', observed: '₹120' },
          ],
        }],
        terminal: false,
        cancelled: false,
      },
    });
    expect(stream.exportState().tasks[0]?.terminalRevision).toBeUndefined();
    expect(reset.snapshot?.latestEvent.kind).toBe('reviewing_cart');
  });

  it('retains a cloned latest safe presentation for service recovery', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const event = stream.publish({
      kind: 'waiting_for_user',
      taskId,
      taskRevision: 2,
      title: 'Choose a product',
      safePresentation: {
        version: 1,
        mode: 'waiting_for_user',
        primarySurface: 'overlay_card',
        card: {
          type: 'compact_status',
          tone: 'attention',
        },
        spoken: {
          languageCode: 'en-IN',
          text: 'Choose a product.',
        },
        behavior: {
          autoCollapse: false,
          keepVisibleWhileSpeaking: true,
        },
      },
    });
    event.safePresentation!.spoken.text = 'mutated';

    expect(stream.latestSafePresentation(taskId)?.spoken.text)
      .toBe('Choose a product.');
  });

  it('rejects stale, gapped, and wrong-task delivery at the consumer cursor', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const event0 = stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'Started',
    });
    const event1 = stream.publish({
      kind: 'step_started',
      taskId,
      taskRevision: 1,
      title: 'Step',
    });
    const wrongTask = stream.publish({
      kind: 'task_started',
      taskId: anotherTaskId,
      taskRevision: 0,
      title: 'Other task',
    });
    const cursor = new TaskEventCursorV2(taskId);

    expect(cursor.accept(event1)).toEqual({
      accepted: false,
      reason: 'sequence_gap',
    });
    expect(cursor.accept(wrongTask)).toEqual({
      accepted: false,
      reason: 'wrong_task',
    });
    expect(cursor.accept(event0)).toEqual({
      accepted: true,
      nextSequence: 1,
    });
    expect(cursor.accept(event0)).toEqual({
      accepted: false,
      reason: 'stale',
    });
    expect(cursor.accept(event1)).toEqual({
      accepted: true,
      nextSequence: 2,
    });
  });

  it('rejects stale revisions and post-terminal publication while allowing exact terminal retries', () => {
    let eventNumber = 0;
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => `event_${++eventNumber}`,
      now: () => 100,
    });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 4,
      title: 'Started',
    });
    expect(() => stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 3,
      title: 'Stale search',
    })).toThrow('stale task revision');

    const terminal = stream.publish({
      dedupeKey: 'final-summary:5',
      kind: 'completed',
      taskId,
      taskRevision: 5,
      terminal: true,
      title: 'Your cart is ready',
    });
    expect(stream.publish({
      dedupeKey: 'final-summary:5',
      kind: 'completed',
      taskId,
      taskRevision: 5,
      terminal: true,
      title: 'Duplicate retry',
    })).toEqual(terminal);
    expect(() => stream.publish({
      kind: 'waiting_for_user',
      taskId,
      taskRevision: 5,
      title: 'Late prompt',
    })).toThrow('after a terminal task event');
    expect(() => stream.publish({
      kind: 'waiting_for_user',
      taskId,
      taskRevision: 6,
      title: 'Late higher-revision prompt',
    })).toThrow('after a terminal task event');
  });

  it('normalizes the plan task_completed alias to canonical v2 completed', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const terminal = stream.publish({
      kind: 'task_completed',
      taskId,
      taskRevision: 1,
      terminal: true,
      title: 'Done',
    });

    expect(terminal.kind).toBe('completed');
    expect(stream.readAfter({ taskId }).snapshot).toMatchObject({
      terminal: true,
      cancelled: false,
    });
  });

  it('restores retained snapshots and cursor checkpoints without replaying old events', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const started = stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 1,
      title: 'Started',
    });
    const searching = stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 2,
      title: 'Searching for milk',
    });
    const cursor = new TaskEventCursorV2(taskId);
    expect(cursor.accept(started).accepted).toBe(true);
    expect(cursor.accept(searching).accepted).toBe(true);

    const restartedStream = new RetainedTaskEventStreamV2({
      initialState: stream.exportState(),
      now: () => 101,
    });
    const restartedCursor = new TaskEventCursorV2(
      taskId,
      cursor.checkpoint(),
    );
    expect(restartedStream.readAfter({
      afterSequence: searching.sequence,
      taskId,
    })).toMatchObject({
      latestSequence: searching.sequence,
      events: [],
      snapshot: {
        latestEvent: { title: 'Searching for milk' },
        latestSequence: searching.sequence,
        taskRevision: 2,
      },
    });
    expect(restartedCursor.accept(searching)).toEqual({
      accepted: false,
      reason: 'stale',
    });
    const next = restartedStream.publish({
      kind: 'mutation_started',
      taskId,
      taskRevision: 3,
      title: 'Adding milk',
    });
    expect(restartedCursor.accept(next)).toEqual({
      accepted: true,
      nextSequence: 3,
    });
  });

  it('projects a visual-only heartbeat without appending event spam', () => {
    let now = 0;
    const stream = new RetainedTaskEventStreamV2({
      heartbeatAfterMs: 10_000,
      now: () => now,
    });
    stream.publish({
      kind: 'searching',
      taskId,
      taskRevision: 1,
      title: 'Searching for milk',
    });
    now = 10_500;

    const first = stream.readAfter({ afterSequence: 0, taskId });
    now = 21_000;
    const second = stream.readAfter({ afterSequence: 0, taskId });

    expect(first.events).toEqual([]);
    expect(first.heartbeat).toMatchObject({
      sourceSequence: 0,
      elapsedMs: 10_500,
      announcement: { channel: 'visual_only' },
    });
    expect(second).toMatchObject({
      latestSequence: 0,
      events: [],
      heartbeat: {
        sourceSequence: 0,
        elapsedMs: 21_000,
      },
    });
  });

  it('rejects stale revisions and same-revision post-terminal events at the consumer cursor', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const revision2 = stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 2,
      title: 'Started',
    });
    const revision3 = stream.publish({
      kind: 'completed',
      taskId,
      taskRevision: 3,
      terminal: true,
      title: 'Done',
    });
    const cursor = new TaskEventCursorV2(taskId);
    expect(cursor.accept(revision2).accepted).toBe(true);
    expect(cursor.accept({
      ...revision3,
      eventId: 'late-revision',
      kind: 'searching',
      taskRevision: 1,
      terminal: false,
    })).toEqual({
      accepted: false,
      reason: 'stale_revision',
    });
    expect(cursor.accept(revision3).accepted).toBe(true);
    expect(cursor.accept({
      ...revision3,
      eventId: 'late',
      kind: 'waiting_for_user',
      sequence: 2,
      terminal: false,
    })).toEqual({
      accepted: false,
      reason: 'post_terminal',
    });
    expect(cursor.accept({
      ...revision3,
      eventId: 'late-higher-revision',
      kind: 'waiting_for_user',
      sequence: 2,
      taskRevision: 4,
      terminal: false,
    })).toEqual({
      accepted: false,
      reason: 'post_terminal',
    });
  });

  it('expires inactive tasks and evicts the oldest task at the task bound', () => {
    let now = 0;
    const stream = new RetainedTaskEventStreamV2({
      maxTasks: 1,
      now: () => now,
      taskTtlMs: 10,
    });
    stream.publish({
      kind: 'task_started',
      taskId,
      taskRevision: 0,
      title: 'First',
    });
    now = 1;
    stream.publish({
      kind: 'task_started',
      taskId: anotherTaskId,
      taskRevision: 0,
      title: 'Second',
    });

    expect(stream.readAfter({ taskId }).events).toEqual([]);
    now = 20;
    expect(stream.cleanup()).toBe(1);
    expect(stream.readAfter({ taskId: anotherTaskId }).events).toEqual([]);
  });
});
