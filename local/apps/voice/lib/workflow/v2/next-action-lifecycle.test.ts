import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from './graph';
import {
  buildNextActionStepV2,
  nextActionAllowedResponsesV2,
  resolveNextActionChoiceV2,
  settleReadyNextActionV2,
} from './next-action-lifecycle';
import { InMemoryPhoneTaskRepositoryV2 } from './repository';
import { validTaskV2 } from './test-fixtures';

function readyNextAction() {
  const task = validTaskV2();
  task.steps = [buildNextActionStepV2({
    adapterId: 'blinkit',
    dependsOn: [],
    stepId: 'step:next-action',
  })];
  task.steps[0]!.status = 'ready';
  task.activeStepId = 'step:next-action';
  return task;
}

describe('authoritative next-action lifecycle', () => {
  it('persists only exact choices and conditionally exposes checkout', () => {
    expect(nextActionAllowedResponsesV2(false)).toEqual([
      'review_cart',
      'add_more',
      'stop',
    ]);
    expect(nextActionAllowedResponsesV2(true)).toEqual([
      'review_cart',
      'add_more',
      'review_checkout',
      'stop',
    ]);

    const waiting = settleReadyNextActionV2({
      at: 5,
      checkoutAvailable: true,
      expiresAt: 100,
      interactionId: 'interaction:next-action',
      journalEntryId: 'journal:next-action',
      presentationRef: 'presentation:next-action',
      task: readyNextAction(),
    });
    expect(waiting).toMatchObject({
      status: 'waiting_for_user',
      pendingInteraction: {
        kind: 'next_action',
        allowedResponses: [
          'review_cart',
          'add_more',
          'review_checkout',
          'stop',
        ],
      },
      steps: [{ kind: 'ask_next', status: 'waiting_for_user' }],
    });
  });

  it('atomically commits one selected lifecycle transition', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    const waiting = settleReadyNextActionV2({
      at: 5,
      checkoutAvailable: true,
      expiresAt: 100,
      interactionId: 'interaction:next-action',
      journalEntryId: 'journal:next-action',
      presentationRef: 'presentation:next-action',
      task: readyNextAction(),
    });
    await repository.create({
      task: waiting,
      event: {
        eventId: 'repository:waiting',
        taskId: waiting.taskId,
        taskRevision: waiting.revision,
        at: waiting.updatedAt,
        kind: 'waiting_for_next_action',
      },
    });

    const committed = await resolveNextActionChoiceV2({
      at: 10,
      choice: 'review_cart',
      continuationStepId: 'step:next-action:again',
      repository,
      responseRef: 'response:review-cart',
      task: waiting,
    });

    expect(committed.task).toMatchObject({
      revision: waiting.revision + 1,
      status: 'active',
      steps: [
        { kind: 'inspect_cart', status: 'ready' },
        {
          stepId: 'step:next-action:again',
          kind: 'ask_next',
          status: 'planned',
        },
      ],
    });
    expect(committed.task.journal.at(-1)).toMatchObject({
      type: 'resolve_interaction',
      dataRef: 'response:review-cart',
    });

    await expect(resolveNextActionChoiceV2({
      at: 11,
      choice: 'stop',
      repository,
      responseRef: 'response:loser',
      task: waiting,
    })).rejects.toThrow();
    expect((await repository.getById(waiting.taskId))?.task)
      .toEqual(committed.task);
  });

  it('is a no-op when no next action is ready', () => {
    const task = transitionPhoneTaskV2(validTaskV2(), {
      type: 'begin_step',
      stepId: 'step:first',
      operationId: 'operation:first',
      entryId: 'journal:begin',
      at: 2,
    });
    expect(settleReadyNextActionV2({
      at: 3,
      checkoutAvailable: false,
      expiresAt: 100,
      interactionId: 'interaction:unused',
      journalEntryId: 'journal:unused',
      presentationRef: 'presentation:unused',
      task,
    })).toEqual(task);
  });
});
