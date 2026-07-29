import { describe, expect, it } from 'vitest';
import type { SequentialProductAction } from '../product-workflow';
import {
  transitionPhoneTaskV2,
  type PhoneTaskV2,
} from '../workflow/v2';
import { validTaskV2 } from '../workflow/v2/test-fixtures';
import { voiceTurnProductChoiceContinuationV2 } from './v2-continuation-adapter';

const add = (request: string): SequentialProductAction => ({
  action: 'add_cart_item',
  quantity: 1,
  request,
});

function waitingTask(): PhoneTaskV2 {
  const source = validTaskV2();
  source.clientId = 'pixel-overlay';
  source.steps = [
    {
      ...source.steps[0]!,
      stepId: 'step:milk',
      kind: 'add_cart_item',
      input: add('milk'),
    },
    {
      ...source.steps[1]!,
      stepId: 'step:bread',
      kind: 'add_cart_item',
      dependsOn: ['step:milk'],
      input: add('bread'),
    },
  ];
  source.activeStepId = 'step:milk';
  source.turnContext = {
    languageCode: 'hi-IN',
    responseId: 'response-choice',
    updatedAt: 1,
  };
  return transitionPhoneTaskV2(source, {
    type: 'wait_for_user',
    stepId: 'step:milk',
    entryId: 'journal:product-choice',
    at: 2,
    interaction: {
      interactionId: 'interaction:milk',
      taskId: source.taskId,
      taskRevision: 1,
      kind: 'product_choice',
      allowedResponses: [{
        offerId: 'offer-1',
        priceAmount: 29,
        priceCurrency: 'INR',
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

describe('V2 voice-turn continuation adapter', () => {
  it('restores the exact pending grocery and remaining queue from V2', () => {
    expect(voiceTurnProductChoiceContinuationV2(waitingTask())).toMatchObject({
      languageCode: 'hi-IN',
      responseId: 'response-choice',
      pendingGrocery: {
        intent: 'add',
        options: [{ offerId: 'offer-1', product: 'Amul Milk' }],
        quantity: 1,
        request: 'milk',
      },
      queuedProducts: [{ action: 'add_cart_item', request: 'bread' }],
    });
  });

  it('fails closed for malformed interaction options', () => {
    const waiting = waitingTask();
    waiting.pendingInteraction!.allowedResponses = [{ offerId: 7 }];

    expect(voiceTurnProductChoiceContinuationV2(waiting)).toBeUndefined();
  });

  it('restores a durable product choice even when turn context raced the background result', () => {
    const waiting = waitingTask();
    waiting.turnContext = undefined;

    expect(voiceTurnProductChoiceContinuationV2(waiting)).toMatchObject({
      languageCode: 'en-IN',
      pendingGrocery: {
        options: [{ offerId: 'offer-1', product: 'Amul Milk' }],
        request: 'milk',
      },
    });
  });
});
