import { describe, expect, it } from 'vitest';
import { RetainedTaskEventStreamV2 } from '../../../../../../lib/progress/v2/retained-task-event-stream';
import {
  parseLocalIdentifier,
} from '../../../../../../lib/workflow/identifiers';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
} from '../../../../../../lib/workflow/v2/background-phone-operation/store';
import { handleBackgroundPhoneOperationStatusRequestV2 } from './route';

const taskId = parseLocalIdentifier('task', 'task_status01');
const operationId = parseLocalIdentifier(
  'operation',
  'operation_status01',
);

describe('background phone operation status route', () => {
  it('returns durable public status and retained events without request payload', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    await store.enqueue({
      operationId,
      acceptedAt: 100,
      request: {
        taskId,
        taskRevision: 4,
        stepId: 'step-one',
        operationKind: 'phone_search',
        requestPayload: { secretInput: 'not-for-status' },
      },
    });
    stream.publish({
      taskId,
      taskRevision: 4,
      operationId,
      kind: 'step_started',
      title: 'Started',
    });

    const response = await handleBackgroundPhoneOperationStatusRequestV2(
      new Request(
        `http://localhost/api/device/task/operation/status`
        + `?operationId=${operationId}&afterSequence=-1`,
      ),
      { store, stream },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      version: 2,
      operation: {
        operationId,
        status: 'queued',
      },
      events: {
        taskId,
        events: [{ kind: 'step_started' }],
      },
    });
    expect(body.operation).not.toHaveProperty('requestPayload');
    expect(JSON.stringify(body)).not.toContain('not-for-status');
  });

  it('validates operation identity and reconnect cursor', async () => {
    const dependencies = {
      store: new InMemoryBackgroundPhoneOperationStoreV2(),
      stream: new RetainedTaskEventStreamV2(),
    };
    const invalidId = await handleBackgroundPhoneOperationStatusRequestV2(
      new Request(
        'http://localhost/api/device/task/operation/status?operationId=bad',
      ),
      dependencies,
    );
    const invalidCursor =
      await handleBackgroundPhoneOperationStatusRequestV2(
        new Request(
          `http://localhost/api/device/task/operation/status`
          + `?operationId=${operationId}&afterSequence=1.5`,
        ),
        dependencies,
      );

    expect(invalidId.status).toBe(400);
    expect(invalidCursor.status).toBe(400);
  });

  it('rebuilds a retained terminal event from durable status on reconnect', async () => {
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    await store.enqueue({
      operationId,
      acceptedAt: 100,
      request: {
        taskId,
        taskRevision: 4,
        stepId: 'step-one',
        operationKind: 'phone_search',
        requestPayload: {},
      },
    });
    await store.claim(operationId, 110);
    await store.complete({
      operationId,
      outcome: 'failed',
      terminalAt: 120,
      detail: 'Worker stopped safely.',
    });

    const response = await handleBackgroundPhoneOperationStatusRequestV2(
      new Request(
        `http://localhost/api/device/task/operation/status`
        + `?operationId=${operationId}`,
      ),
      { store, stream },
    );
    const body = await response.json();

    expect(body).toMatchObject({
      operation: { status: 'failed' },
      events: {
        events: [{
          kind: 'blocked',
          operationId,
          detail: 'JaldiAI could not complete this step safely.',
        }],
      },
    });
    expect(JSON.stringify(body.events)).not.toContain(
      'Worker stopped safely.',
    );
  });
});
