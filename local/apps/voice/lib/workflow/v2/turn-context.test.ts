import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SequentialProductAction } from '../../product-workflow';
import { transitionPhoneTaskV2 } from './graph';
import { FileBackedPhoneTaskRepositoryV2 } from './file-repository';
import { validTaskV2 } from './test-fixtures';
import {
  commitTaskTurnContextV2,
  productChoiceContinuationV2,
  updateTaskTurnContextV2,
} from './turn-context';

const directories: string[] = [];
const add = (request: string): SequentialProductAction => ({
  action: 'add_cart_item',
  quantity: 1,
  request,
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function waitingTask() {
  const source = validTaskV2();
  source.clientId = 'pixel-overlay';
  source.steps[0] = {
    ...source.steps[0]!,
    kind: 'add_cart_item',
    input: add('milk'),
  };
  source.turnContext = {
    languageCode: 'en-IN',
    responseId: 'response-before-choice',
    updatedAt: 1,
  };
  return transitionPhoneTaskV2(source, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:product-choice',
    at: 2,
    interaction: {
      interactionId: 'interaction:milk',
      taskId: source.taskId,
      taskRevision: 1,
      kind: 'product_choice',
      allowedResponses: [{
        offerId: 'offer-1',
        product: 'Amul Milk',
        size: '500 ml',
      }],
      presentationRef: 'presentation:milk',
      status: 'open',
      createdAt: 2,
      expiresAt: 100,
    },
  });
}

describe('PhoneTaskV2 turn context', () => {
  it('retains language and response continuity with the product choice', () => {
    const task = waitingTask();

    expect(productChoiceContinuationV2(task)).toMatchObject({
      taskId: task.taskId,
      taskRevision: task.revision,
      languageCode: 'en-IN',
      responseId: 'response-before-choice',
      allowedResponses: [{ offerId: 'offer-1' }],
      stepInput: { request: 'milk' },
    });
  });

  it('updates context and the pending interaction under one revision', () => {
    const task = waitingTask();
    const updated = updateTaskTurnContextV2(task, {
      entryId: 'turn-context:one',
      languageCode: 'hi-IN',
      responseId: 'response-after-choice',
      updatedAt: 12,
    });

    expect(updated.revision).toBe(task.revision + 1);
    expect(updated.pendingInteraction?.taskRevision).toBe(updated.revision);
    expect(updated.turnContext).toEqual({
      languageCode: 'hi-IN',
      responseId: 'response-after-choice',
      updatedAt: 12,
    });
    expect(updated.journal.at(-1)).toMatchObject({
      entryId: 'turn-context:one',
      type: 'turn_context_updated',
    });
  });

  it('restores product-choice continuity from the V2 repository after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'turn-context-v2-'));
    directories.push(directory);
    const path = join(directory, 'phone-task-v2.json');
    const task = waitingTask();
    const first = new FileBackedPhoneTaskRepositoryV2(path, {
      now: () => 11,
    });
    const created = await first.create({
      task,
      event: {
        eventId: 'turn-context:created',
        taskId: task.taskId,
        taskRevision: task.revision,
        at: task.updatedAt,
        kind: 'task_created',
      },
    });
    await commitTaskTurnContextV2({
      repository: first,
      record: created,
      languageCode: 'mr-IN',
      responseId: 'response-after-restart',
      at: 12,
      entryId: 'turn-context:checkpoint',
    });

    const restarted = new FileBackedPhoneTaskRepositoryV2(path, {
      now: () => 13,
    });
    const record = await restarted.getByClientId(task.clientId);

    expect(record).toBeDefined();
    expect(productChoiceContinuationV2(record!.task)).toMatchObject({
      interactionId: task.pendingInteraction?.interactionId,
      languageCode: 'mr-IN',
      responseId: 'response-after-restart',
      taskRevision: task.revision + 1,
    });
  });
});
