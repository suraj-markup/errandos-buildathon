import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  createCheckoutPaymentPresentationV2,
  resolveCheckoutPaymentChoiceV2,
} from './payment-presentation';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);

describe('checkout payment presentation v2', () => {
  it('presents Mastercard as current and allows switching to COD', () => {
    const presentation = createCheckoutPaymentPresentationV2({
      codAvailable: true,
      currentPayment: {
        kind: 'card',
        label: 'Mastercard 5555555555554444',
        methodRef: 'provider_payment_1',
      },
      expiresAt: 2_000,
      interactionId: 'interaction_checkout_1',
      now: 1_000,
      taskId,
      taskRevision: 7,
    });

    expect(presentation).toMatchObject({
      mode: 'payment_options',
      safetyLabel: 'NOT ORDERED',
      currentPayment: {
        kind: 'card',
        publicLabel: 'Mastercard',
      },
    });
    expect(presentation.choices).toEqual([
      expect.objectContaining({
        choiceId: 'continue_current',
        enabled: true,
        selected: true,
      }),
      expect.objectContaining({
        choiceId: 'use_cod',
        enabled: true,
      }),
      expect.objectContaining({ choiceId: 'add_more', enabled: true }),
      expect.objectContaining({ choiceId: 'stop', enabled: true }),
    ]);
    expect(resolveCheckoutPaymentChoiceV2({
      choiceId: 'use_cod',
      interactionId: presentation.interactionId,
      now: 1_100,
      presentation,
      taskRevision: 7,
    })).toEqual({
      accepted: true,
      choiceId: 'use_cod',
      command: { kind: 'prepare_checkout', payment: 'cod' },
    });
    expect(resolveCheckoutPaymentChoiceV2({
      choiceId: 'continue_current',
      interactionId: presentation.interactionId,
      now: 1_100,
      presentation,
      taskRevision: 7,
    })).toEqual({
      accepted: true,
      choiceId: 'continue_current',
      command: { kind: 'prepare_checkout', payment: 'current' },
    });
  });

  it('does not offer a duplicate COD alternative when COD is current', () => {
    const presentation = createCheckoutPaymentPresentationV2({
      codAvailable: true,
      currentPayment: {
        kind: 'cod',
        label: 'Cash on Delivery',
        methodRef: 'provider_payment_cod',
      },
      expiresAt: 2_000,
      interactionId: 'interaction_checkout_cod',
      now: 1_000,
      taskId,
      taskRevision: 8,
    });

    expect(presentation.choices.map(({ choiceId }) => choiceId)).toEqual([
      'continue_current',
      'add_more',
      'stop',
    ]);
  });

  it('shows unavailable COD as disabled and cannot resolve it', () => {
    const presentation = createCheckoutPaymentPresentationV2({
      codAvailable: false,
      currentPayment: {
        kind: 'upi',
        label: 'Saved UPI',
        methodRef: 'provider_payment_2',
      },
      expiresAt: 2_000,
      interactionId: 'interaction_checkout_2',
      now: 1_000,
      taskId,
      taskRevision: 3,
    });

    expect(presentation.choices.find(({ choiceId }) => choiceId === 'use_cod'))
      .toMatchObject({
        enabled: false,
        disabledReason: 'cod_unavailable',
      });
    expect(resolveCheckoutPaymentChoiceV2({
      choiceId: 'use_cod',
      interactionId: presentation.interactionId,
      now: 1_100,
      presentation,
      taskRevision: 3,
    })).toEqual({ accepted: false, reason: 'choice_unavailable' });
  });

  it('rejects stale interaction, revision, and expiry', () => {
    const presentation = createCheckoutPaymentPresentationV2({
      codAvailable: true,
      currentPayment: {
        kind: 'wallet',
        label: 'Saved wallet',
        methodRef: 'provider_payment_3',
      },
      expiresAt: 2_000,
      interactionId: 'interaction_checkout_3',
      now: 1_000,
      taskId,
      taskRevision: 4,
    });
    const base = {
      choiceId: 'stop',
      presentation,
    };
    expect(resolveCheckoutPaymentChoiceV2({
      ...base,
      interactionId: 'interaction_old',
      now: 1_100,
      taskRevision: 4,
    })).toEqual({ accepted: false, reason: 'stale_interaction' });
    expect(resolveCheckoutPaymentChoiceV2({
      ...base,
      interactionId: presentation.interactionId,
      now: 1_100,
      taskRevision: 5,
    })).toEqual({ accepted: false, reason: 'stale_revision' });
    expect(resolveCheckoutPaymentChoiceV2({
      ...base,
      interactionId: presentation.interactionId,
      now: 2_000,
      taskRevision: 4,
    })).toEqual({ accepted: false, reason: 'expired' });
  });
});
