import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { createRetainedOperationHandoffV2 } from './operation-handoff';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

describe('retained operation handoff v2', () => {
  it('returns operation identity with the exact retained reconnect cursor', () => {
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => 'event_operation_accepted',
      now: () => 123,
    });
    const taskId = parseLocalIdentifier(
      'task',
      'task_12345678-1234-1234-1234-123456789abc',
    );
    const operationId = parseLocalIdentifier(
      'operation',
      'operation_12345678-1234-1234-1234-123456789abc',
    );
    const handoff = createRetainedOperationHandoffV2({
      compatibilityDeadlineMs: 45_000,
      operationId,
      stepId: 'step:first',
      stream,
      taskId,
      taskRevision: 7,
    });

    expect(handoff.operationAccepted).toMatchObject({
      status: 'accepted',
      operationId,
      taskId,
      taskRevision: 7,
      events: { afterSequence: 0, taskId },
      compatibility: {
        mode: 'bounded_synchronous',
        deadlineMs: 45_000,
      },
    });
    expect(handoff.retainedEvent).toMatchObject({
      eventId: 'event_operation_accepted',
      kind: 'step_started',
      operationId,
      sequence: 0,
    });
    expect(createRetainedOperationHandoffV2({
      operationId,
      stream,
      taskId,
      taskRevision: 7,
    }).retainedEvent).toEqual(handoff.retainedEvent);
  });

  it('preserves ordered queue details, active item, and conflicts in resets', () => {
    const stream = new RetainedTaskEventStreamV2({
      maxEventsPerTask: 1,
      now: () => 123,
    });
    const taskId = parseLocalIdentifier(
      'task',
      'task_12345678-1234-1234-1234-123456789abc',
    );
    const firstOperationId = parseLocalIdentifier(
      'operation',
      'operation_12345678-1234-1234-1234-123456789abc',
    );
    const secondOperationId = parseLocalIdentifier(
      'operation',
      'operation_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
    createRetainedOperationHandoffV2({
      item: {
        index: 1,
        total: 2,
        title: 'Potatoes',
        requestedLabel: 'potatoes',
        packSize: '1 kg',
        quantity: 2,
        price: '₹80',
      },
      operationId: firstOperationId,
      progress: {
        completed: 0,
        total: 2,
        nextLabel: 'Paneer',
      },
      stream,
      taskId,
      taskRevision: 1,
    });
    createRetainedOperationHandoffV2({
      item: {
        index: 2,
        total: 2,
        title: 'Paneer',
        requestedLabel: 'paneer',
        packSize: '200 g',
        quantity: 1,
        price: '₹105',
        conflicts: [{
          field: 'pack_size',
          expected: '200 g',
          observed: '250 g',
        }],
      },
      operationId: secondOperationId,
      progress: {
        completed: 1,
        total: 2,
        nextLabel: 'Paneer',
      },
      stream,
      taskId,
      taskRevision: 2,
    });

    const reset = stream.readAfter({ afterSequence: -1, taskId });
    expect(reset).toMatchObject({
      resetRequired: true,
      snapshot: {
        items: [
          {
            index: 1,
            requestedLabel: 'potatoes',
            packSize: '1 kg',
            quantity: 2,
            price: '₹80',
          },
          {
            index: 2,
            requestedLabel: 'paneer',
            packSize: '200 g',
            quantity: 1,
            price: '₹105',
            conflicts: [{
              field: 'pack_size',
              expected: '200 g',
              observed: '250 g',
            }],
          },
        ],
        activeItem: {
          index: 2,
          requestedLabel: 'paneer',
        },
        progress: {
          completed: 1,
          total: 2,
          nextLabel: 'Paneer',
        },
      },
    });

    const restored = new RetainedTaskEventStreamV2({
      initialState: stream.exportState(),
      maxEventsPerTask: 1,
      now: () => 124,
    });
    expect(restored.readAfter({ afterSequence: -1, taskId }).snapshot)
      .toEqual(reset.snapshot);
  });
});
