import type {
  OverlayProductSelectionBindingV2,
} from '@errandos/contracts';
import {
  newLocalIdentifier,
  parseLocalIdentifier,
} from './identifiers';
import type { PhoneTaskV2 } from './v2';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactProductChoice(value: unknown): boolean {
  const option = record(value);
  if (!option) return false;
  const title = option['title'] ?? option['product'] ?? option['spokenLabel'];
  return (
    typeof option['offerId'] === 'string'
    && option['offerId'].length > 0
    && option['offerId'].length <= 256
    && typeof title === 'string'
    && title.trim().length > 0
    && title.trim() === title
    && title.length <= 300
    && typeof option['priceAmount'] === 'number'
    && Number.isFinite(option['priceAmount'])
    && option['priceAmount'] >= 0
    && option['priceCurrency'] === 'INR'
  );
}

export function prepareProductSelectionPresentation(input: {
  task: PhoneTaskV2 | undefined;
}): OverlayProductSelectionBindingV2 | undefined {
  const task = input.task;
  const interaction = task?.pendingInteraction;
  const activeStep = task?.steps.find((step) =>
    step.stepId === task.activeStepId);
  const allowedResponses = Array.isArray(interaction?.allowedResponses)
    ? interaction.allowedResponses
    : undefined;
  const offerIds = allowedResponses
    ? allowedResponses.map((option) => record(option)?.['offerId'])
    : [];
  if (
    !task
    || task.status !== 'waiting_for_user'
    || !activeStep
    || activeStep.status !== 'waiting_for_user'
    || !interaction
    || interaction.kind !== 'product_choice'
    || interaction.status !== 'open'
    || interaction.taskId !== task.taskId
    || interaction.taskRevision !== task.revision
    || !allowedResponses
    || allowedResponses.length === 0
    || new Set(offerIds).size !== offerIds.length
    || allowedResponses.some((option) =>
      !exactProductChoice(option))
  ) {
    return undefined;
  }

  let taskId: OverlayProductSelectionBindingV2['taskId'];
  try {
    taskId = parseLocalIdentifier('task', task.taskId);
  } catch {
    return undefined;
  }
  return {
    clientId: task.clientId,
    expiresAt: new Date(interaction.expiresAt).toISOString(),
    interactionId: interaction.interactionId,
    selectionId: newLocalIdentifier('selection'),
    taskId,
    taskRevision: task.revision,
    version: 2,
  };
}
