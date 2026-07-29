import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';
import { ensureTaskCancelledEventV2 } from './task-cancellation';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);

describe('task cancellation retained event v2', () => {
  it('publishes an idempotent terminal cancellation that stops polling', async () => {
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => 'event_cancelled',
      now: () => 100,
    });
    const first = ensureTaskCancelledEventV2({
      stream,
      taskId,
      taskRevision: 3,
    });
    const duplicate = ensureTaskCancelledEventV2({
      stream,
      taskId,
      taskRevision: 3,
    });

    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      kind: 'cancelled',
      terminal: true,
    });
    await expect(stream.waitAfter({
      afterSequence: first.sequence,
      taskId,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      events: [],
      snapshot: {
        cancelled: true,
        terminal: true,
      },
    });
  });
});
