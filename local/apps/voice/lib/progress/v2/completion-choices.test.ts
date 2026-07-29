import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  createCompletionChoicePromptV2,
  resolveCompletionChoiceV2,
} from './completion-choices';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);

function prompt(codAvailable = true) {
  return createCompletionChoicePromptV2({
    codAvailable,
    currentPaymentLabel: 'Mastercard 12345678',
    expiresAt: 1_000,
    interactionId: 'interaction_12345678',
    now: 100,
    taskId,
    taskRevision: 4,
  });
}

describe('interactive completion choices v2', () => {
  it('offers exact safe cart actions without an order action', () => {
    const value = prompt();

    expect(value.currentPaymentLabel).toBe('Mastercard');
    expect(value.choices.map((choice) => choice.choiceId)).toEqual([
      'review_cart',
      'add_more',
      'review_checkout',
      'use_current_payment',
      'use_cod',
      'stop',
    ]);
    expect(value.choices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        choiceId: 'review_cart',
        label: 'Review cart',
      }),
      expect.objectContaining({
        choiceId: 'add_more',
        label: 'Keep shopping',
      }),
      expect.objectContaining({ choiceId: 'stop', label: 'Stop' }),
    ]));
    expect(value.choices.some((choice) =>
      /order|place order/i.test(`${choice.choiceId} ${choice.label}`),
    )).toBe(false);
    expect(value.choices.every((choice) => choice.enabled)).toBe(true);
  });

  it('resolves tap and speech through the same bound interaction', () => {
    const value = prompt();

    expect(resolveCompletionChoiceV2({
      choiceId: 'use_cod',
      now: 200,
      prompt: value,
      source: 'tap',
      taskRevision: 4,
    })).toEqual({
      accepted: true,
      choiceId: 'use_cod',
      command: {
        kind: 'review_checkout',
        paymentPreference: 'cod',
      },
      source: 'tap',
    });
    expect(resolveCompletionChoiceV2({
      now: 200,
      prompt: value,
      source: 'speech',
      speech: 'Use cash on delivery',
      taskRevision: 4,
    })).toEqual({
      accepted: true,
      choiceId: 'use_cod',
      command: {
        kind: 'review_checkout',
        paymentPreference: 'cod',
      },
      source: 'speech',
    });
  });

  it('rejects unavailable, stale, expired, and ambiguous answers', () => {
    const noCod = prompt(false);

    expect(resolveCompletionChoiceV2({
      choiceId: 'use_cod',
      now: 200,
      prompt: noCod,
      source: 'tap',
      taskRevision: 4,
    })).toEqual({ accepted: false, reason: 'choice_unavailable' });
    expect(resolveCompletionChoiceV2({
      choiceId: 'stop',
      now: 200,
      prompt: noCod,
      source: 'tap',
      taskRevision: 5,
    })).toEqual({ accepted: false, reason: 'stale_revision' });
    expect(resolveCompletionChoiceV2({
      choiceId: 'stop',
      now: 1_000,
      prompt: noCod,
      source: 'tap',
      taskRevision: 4,
    })).toEqual({ accepted: false, reason: 'expired' });
    expect(resolveCompletionChoiceV2({
      now: 200,
      prompt: prompt(),
      source: 'speech',
      speech: 'Review checkout with COD',
      taskRevision: 4,
    })).toEqual({ accepted: false, reason: 'ambiguous' });
  });
});
