import { describe, expect, it } from 'vitest';
import {
  newLocalIdentifier,
} from '../../workflow/identifiers';
import type {
  BackgroundPhoneOperationRecordV2,
} from '../../workflow/v2/background-phone-operation/contracts';
import {
  publishBackgroundPhoneOperationTerminalEventV2,
} from './background-phone-operation-events';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

describe('background phone operation retained events v2', () => {
  it('publishes one exact verified-item event for a completed cart mutation', () => {
    const taskId = newLocalIdentifier('task');
    const operationId = newLocalIdentifier('operation');
    const operation: BackgroundPhoneOperationRecordV2 = {
      version: 2,
      operationId,
      taskId,
      taskRevision: 4,
      stepId: 'step:milk',
      operationKind: 'add_cart_item',
      requestPayload: {
        version: 1,
        action: {
          action: 'add_cart_item',
          request: 'toned milk',
          quantity: 1,
          selectedOffer: {
            offerId: 'offer_milk',
            title: 'Amul Taaza Toned Milk',
          },
        },
      },
      status: 'completed',
      attempts: 1,
      recoveryCount: 0,
      createdAt: 1,
      updatedAt: 2,
      terminalAt: 2,
    };
    const stream = new RetainedTaskEventStreamV2({ now: (): number => 2 });

    const first = publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    });
    const duplicate = publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    });

    expect(duplicate).toEqual(first);
    expect(stream.readAfter({ taskId }).events).toEqual([
      expect.objectContaining({
        kind: 'mutation_verified',
        operationId,
        announcement: {
          channel: 'speech_and_visual',
          text: 'Amul Taaza Toned Milk added to cart.',
        },
      }),
    ]);
  });

  it.each([
    ['failed', 'blocked'],
    ['ambiguous', 'ambiguous'],
  ] as const)('deduplicates a %s terminal boundary', (status, kind) => {
    const taskId = newLocalIdentifier('task');
    const operationId = newLocalIdentifier('operation');
    const operation: BackgroundPhoneOperationRecordV2 = {
      version: 2,
      operationId,
      taskId,
      taskRevision: 4,
      stepId: 'step:milk',
      operationKind: 'add_cart_item',
      requestPayload: {},
      status,
      attempts: 1,
      recoveryCount: 0,
      createdAt: 1,
      updatedAt: 2,
      terminalAt: 2,
    };
    const stream = new RetainedTaskEventStreamV2({ now: (): number => 2 });

    const first = publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    });
    expect(publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    })).toEqual(first);
    expect(first.kind).toBe(kind);
  });

  it('publishes a bounded issue and never raw worker detail for ambiguity', () => {
    const taskId = newLocalIdentifier('task');
    const operationId = newLocalIdentifier('operation');
    const operation: BackgroundPhoneOperationRecordV2 = {
      version: 2,
      operationId,
      taskId,
      taskRevision: 4,
      stepId: 'step:milk',
      operationKind: 'add_cart_item',
      requestPayload: {},
      status: 'ambiguous',
      attempts: 1,
      recoveryCount: 0,
      createdAt: 1,
      updatedAt: 2,
      terminalAt: 2,
      detail: 'raw provider selector and account content',
    };
    const stream = new RetainedTaskEventStreamV2({ now: (): number => 2 });

    const event = publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    });

    expect(event).toMatchObject({
      kind: 'ambiguous',
      issue: {
        code: 'mutation_ambiguous',
        queueBehavior: 'stop_queue',
        recoveryActions: [
          { actionId: 'check_cart_again', safety: 'read_only' },
          { actionId: 'stop_task', safety: 'stop_only' },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain('raw provider selector');
    expect(event.issue?.recoveryActions.some(
      (action) => action.actionId === 'retry_verified_not_applied',
    )).toBe(false);
  });

  it('uses precise search treatment for a durable search failure', () => {
    const taskId = newLocalIdentifier('task');
    const operationId = newLocalIdentifier('operation');
    const operation: BackgroundPhoneOperationRecordV2 = {
      version: 2,
      operationId,
      taskId,
      taskRevision: 4,
      stepId: 'step:milk',
      operationKind: 'search_products',
      requestPayload: {},
      status: 'failed',
      attempts: 1,
      recoveryCount: 0,
      createdAt: 1,
      updatedAt: 2,
      terminalAt: 2,
    };
    const stream = new RetainedTaskEventStreamV2({ now: (): number => 2 });

    expect(publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream,
    })).toMatchObject({
      kind: 'blocked',
      title: 'Blinkit search did not finish',
      issue: {
        code: 'search_failed',
        queueBehavior: 'pause_current_item',
      },
    });
  });
});
