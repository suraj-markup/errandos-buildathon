import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from '../../workflow/v2';
import { validTaskV2 } from '../../workflow/v2/test-fixtures';
import {
  completionChoicePromptForTaskV2,
  ensureCompletionChoicePromptEventV2,
} from './completion-interaction-events';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

function waitingTask() {
  const task = validTaskV2();
  task.taskId = 'task_12345678-1234-1234-1234-123456789abc';
  return transitionPhoneTaskV2(task, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:payment-choice',
    at: 2,
    interaction: {
      interactionId: 'interaction_12345678',
      taskId: task.taskId,
      taskRevision: 1,
      kind: 'payment_choice',
      allowedResponses: ['current_method', 'cod', 'add_more', 'stop'],
      presentationRef: 'presentation:payment-choice',
      status: 'open',
      createdAt: 2,
      expiresAt: 100,
    },
  });
}

describe('completion interaction retained events v2', () => {
  it('projects only repository-allowed choices without exposing payment details', () => {
    const prompt = completionChoicePromptForTaskV2({
      now: 50,
      task: waitingTask(),
    });

    expect(prompt).toMatchObject({
      currentPaymentLabel: 'current payment method',
      choices: [
        { choiceId: 'add_more', enabled: true },
        { choiceId: 'use_current_payment', enabled: true },
        { choiceId: 'use_cod', enabled: true },
        { choiceId: 'stop', enabled: true },
      ],
    });
    expect(prompt?.currentPaymentLabel).not.toMatch(/\d/);
  });

  it('projects the exact safe cart actions for next-action prompts', () => {
    const task = waitingTask();
    task.pendingInteraction!.kind = 'next_action';
    task.pendingInteraction!.allowedResponses = [
      'add_more',
      'review_checkout',
      'stop',
    ];

    expect(completionChoicePromptForTaskV2({
      now: 50,
      task,
    })?.choices).toEqual([
      { choiceId: 'review_cart', enabled: true, label: 'Review cart' },
      { choiceId: 'add_more', enabled: true, label: 'Keep shopping' },
      {
        choiceId: 'review_checkout',
        enabled: true,
        label: 'Review checkout',
      },
      { choiceId: 'stop', enabled: true, label: 'Stop' },
    ]);
  });

  it('publishes one idempotent visual prompt and omits expired interactions', () => {
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => 'event_prompt',
      now: () => 50,
    });
    const task = waitingTask();
    const first = ensureCompletionChoicePromptEventV2({
      now: 50,
      stream,
      task,
    });
    const duplicate = ensureCompletionChoicePromptEventV2({
      now: 50,
      stream,
      task,
    });

    expect(duplicate).toEqual(first);
    expect(stream.readAfter({
      afterSequence: -1,
      taskId: first!.taskId,
    }).events).toHaveLength(1);
    expect(first).toMatchObject({
      announcement: { channel: 'visual_only' },
      interaction: { interactionId: 'interaction_12345678' },
      kind: 'waiting_for_user',
    });
    expect(ensureCompletionChoicePromptEventV2({
      now: 100,
      stream,
      task,
    })).toBeUndefined();
  });
});
