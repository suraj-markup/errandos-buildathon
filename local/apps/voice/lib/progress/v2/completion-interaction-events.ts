import { createHash } from 'node:crypto';
import type { PhoneTaskV2 } from '../../workflow/v2';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  createCompletionChoicePromptV2,
} from './completion-choices';
import type {
  CompletionChoiceIdV2,
  CompletionChoicePromptV2,
  SemanticTaskEventV2,
} from './contracts';
import type {
  RetainedTaskEventStreamV2,
} from './retained-task-event-stream';

const completionKinds = new Set(['next_action', 'payment_choice']);

function allowedChoiceIds(value: unknown): Set<CompletionChoiceIdV2> {
  if (!Array.isArray(value)) return new Set();
  const result = new Set<CompletionChoiceIdV2>();
  for (const candidate of value) {
    switch (candidate) {
      case 'review_cart':
        result.add('review_cart');
        break;
      case 'add_more':
        result.add('add_more');
        break;
      case 'review_checkout':
        result.add('review_checkout');
        break;
      case 'current_method':
      case 'use_current_payment':
        result.add('use_current_payment');
        break;
      case 'cod':
      case 'use_cod':
        result.add('use_cod');
        break;
      case 'stop':
        result.add('stop');
        break;
    }
  }
  return result;
}

export function completionChoicePromptForTaskV2(input: {
  now?: number;
  task: PhoneTaskV2;
}): CompletionChoicePromptV2 | undefined {
  const now = input.now ?? Date.now();
  const interaction = input.task.pendingInteraction;
  if (
    input.task.status !== 'waiting_for_user'
    || !interaction
    || interaction.status !== 'open'
    || !completionKinds.has(interaction.kind)
    || interaction.taskId !== input.task.taskId
    || interaction.taskRevision !== input.task.revision
    || interaction.expiresAt <= now
  ) {
    return undefined;
  }
  const allowed = allowedChoiceIds(interaction.allowedResponses);
  const paymentChoice = interaction.kind === 'payment_choice';
  const prompt = createCompletionChoicePromptV2({
    codAvailable: allowed.has('use_cod'),
    ...(allowed.has('use_current_payment')
      ? { currentPaymentLabel: 'current payment method' }
      : {}),
    expiresAt: interaction.expiresAt,
    interactionId: interaction.interactionId,
    now,
    taskId: parseLocalIdentifier('task', input.task.taskId),
    taskRevision: input.task.revision,
  });
  return {
    ...prompt,
    choices: prompt.choices
      .filter((choice) => paymentChoice
        ? [
            'add_more',
            'use_current_payment',
            'use_cod',
            'stop',
          ].includes(choice.choiceId)
        : [
            'review_cart',
            'add_more',
            'review_checkout',
            'stop',
          ].includes(choice.choiceId))
      .map((choice) => {
        const enabled =
          (!paymentChoice && choice.choiceId === 'review_cart')
          || allowed.has(choice.choiceId);
        const { disabledReason, ...fields } = choice;
        return {
          ...fields,
          enabled,
          ...(!enabled
            ? {
                disabledReason:
                  disabledReason ?? 'This choice is unavailable.',
              }
            : {}),
        };
      }),
  };
}

function dedupeKey(interactionId: string, taskRevision: number): string {
  const digest = createHash('sha256')
    .update(`${interactionId}:${taskRevision}`)
    .digest('hex');
  return `completion-prompt:${digest}`;
}

export function ensureCompletionChoicePromptEventV2(input: {
  now?: number;
  stream: RetainedTaskEventStreamV2;
  task: PhoneTaskV2;
}): SemanticTaskEventV2 | undefined {
  const interaction = completionChoicePromptForTaskV2({
    ...(input.now === undefined ? {} : { now: input.now }),
    task: input.task,
  });
  if (!interaction) return undefined;
  const paymentChoice =
    input.task.pendingInteraction?.kind === 'payment_choice';
  return input.stream.publish({
    dedupeKey: dedupeKey(interaction.interactionId, interaction.taskRevision),
    interaction,
    kind: 'waiting_for_user',
    ...(input.task.activeStepId
      ? { stepId: input.task.activeStepId }
      : {}),
    taskId: interaction.taskId,
    taskRevision: input.task.revision,
    title: paymentChoice
      ? 'Choose payment for review'
      : 'Choose what to do next',
    detail: 'Tap a choice, or answer by voice.',
    announcement: {
      channel: 'visual_only',
      text: paymentChoice
        ? 'Choose a payment option for review.'
        : 'Choose what to do next.',
    },
  });
}
