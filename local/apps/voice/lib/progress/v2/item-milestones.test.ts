import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { buildVerifiedItemCompletionEventsV2 } from './item-milestones';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);

describe('verified item milestone announcements v2', () => {
  it('publishes one exact item-completion announcement before the next search', () => {
    const stream = new RetainedTaskEventStreamV2({ now: () => 100 });
    const milestones = buildVerifiedItemCompletionEventsV2({
      itemLabel: 'Milk',
      itemPosition: { current: 1, total: 2 },
      item: {
        packSize: '1 L',
        price: '₹29',
        quantity: 1,
        requestedLabel: 'toned milk',
      },
      next: {
        kind: 'search',
        label: 'ice cream',
        stepId: 'step_ice_cream',
      },
      operationId,
      taskId,
      taskRevision: 4,
    });
    const published = milestones.map((event) => stream.publish(event));
    const searching = stream.publish({
      kind: 'searching',
      stepId: 'step_ice_cream',
      taskId,
      taskRevision: 5,
      title: 'Searching for ice cream',
    });

    expect(published.map((event) => event.kind)).toEqual([
      'mutation_verified',
    ]);
    expect(published[0]?.announcement).toEqual({
      channel: 'speech_and_visual',
      text: 'Milk added to cart. Now looking for ice cream.',
    });
    expect(published[0]).toMatchObject({
      item: {
        title: 'Milk',
        requestedLabel: 'toned milk',
        packSize: '1 L',
        quantity: 1,
        price: '₹29',
        index: 1,
        total: 2,
      },
      progress: {
        completed: 1,
        total: 2,
        nextLabel: 'ice cream',
      },
    });
    expect(published[0]!.sequence).toBeLessThan(searching.sequence);
    expect(stream.readAfter({ taskId }).events.filter(
      (event) => event.announcement?.channel === 'speech_and_visual',
    )).toHaveLength(1);
  });

  it('speaks only verified completion when there is no next product', () => {
    expect(buildVerifiedItemCompletionEventsV2({
      itemLabel: 'Ice cream',
      operationId,
      taskId,
      taskRevision: 5,
    })).toEqual([
      expect.objectContaining({
        kind: 'mutation_verified',
        announcement: {
          channel: 'speech_and_visual',
          text: 'Ice cream added to cart.',
        },
      }),
    ]);
  });
});
