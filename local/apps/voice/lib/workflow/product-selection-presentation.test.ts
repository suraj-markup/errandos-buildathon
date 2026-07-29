import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from './v2';
import { validTaskV2 } from './v2/test-fixtures';
import { prepareProductSelectionPresentation } from './product-selection-presentation';

function awaitingTask() {
  const task = validTaskV2();
  task.taskId = 'task_12345678';
  task.clientId = 'pixel-overlay';
  task.activeStepId = 'step:first';
  task.steps[0] = {
    ...task.steps[0]!,
    adapterId: 'blinkit',
    kind: 'add_cart_item',
    input: {
      action: 'add_cart_item',
      quantity: 1,
      request: 'milk',
    },
  };
  return transitionPhoneTaskV2(task, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:product-choice',
    at: 200,
    interaction: {
      interactionId: 'interaction_12345678',
      taskId: task.taskId,
      taskRevision: 1,
      kind: 'product_choice',
      allowedResponses: [{
        offerId: 'milk-500',
        priceAmount: 29,
        priceCurrency: 'INR',
        product: 'Amul Taaza Toned Milk',
        size: '500 ml',
        spokenLabel: 'Amul Taaza 500 ml',
      }],
      presentationRef: 'presentation:milk',
      status: 'open',
      createdAt: 200,
      expiresAt: 300_200,
    },
  });
}

describe('prepareProductSelectionPresentation', () => {
  it('derives the card binding from the open V2 product-choice interaction', () => {
    const task = awaitingTask();
    const binding = prepareProductSelectionPresentation({ task });

    expect(binding).toMatchObject({
      clientId: 'pixel-overlay',
      expiresAt: new Date(300_200).toISOString(),
      interactionId: 'interaction_12345678',
      taskId: 'task_12345678',
      taskRevision: 1,
      version: 2,
    });
    expect(binding?.selectionId).toMatch(/^selection_/);
  });

  it('keeps one interaction/revision while issuing a new retry key per card', () => {
    const task = awaitingTask();
    const first = prepareProductSelectionPresentation({ task });
    const second = prepareProductSelectionPresentation({ task });

    expect(second?.interactionId).toBe(first?.interactionId);
    expect(second?.taskRevision).toBe(first?.taskRevision);
    expect(second?.expiresAt).toBe(first?.expiresAt);
    expect(second?.selectionId).not.toBe(first?.selectionId);
  });

  it('omits bindings for stale, resolved, or unsafe interactions', () => {
    const task = awaitingTask();
    expect(prepareProductSelectionPresentation({
      task: {
        ...task,
        revision: task.revision + 1,
      },
    })).toBeUndefined();
    expect(prepareProductSelectionPresentation({
      task: {
        ...task,
        pendingInteraction: undefined,
        status: 'active',
      },
    })).toBeUndefined();
    expect(prepareProductSelectionPresentation({
      task: {
        ...task,
        pendingInteraction: {
          ...task.pendingInteraction!,
          allowedResponses: [{
            offerId: 'milk-500',
            product: 'Milk',
          }],
        },
      },
    })).toBeUndefined();
    expect(prepareProductSelectionPresentation({
      task: {
        ...task,
        pendingInteraction: {
          ...task.pendingInteraction!,
          allowedResponses: [
            ...(task.pendingInteraction!.allowedResponses as unknown[]),
            ...(task.pendingInteraction!.allowedResponses as unknown[]),
          ],
        },
      },
    })).toBeUndefined();
  });
});
