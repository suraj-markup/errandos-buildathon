import type {
  CheckoutPaymentChoiceIdV2,
  CheckoutPaymentChoiceResolutionV2,
  CheckoutPaymentPresentationV2,
  CurrentPaymentMethodV2,
} from './contracts';

function bounded(value: string, name: string, max = 160): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${name} must contain 1-${max} characters.`);
  }
  return normalized;
}

function publicPaymentLabel(value: string): string {
  const normalized = bounded(value, 'payment label', 120)
    .replace(/\b\d{5,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!normalized) return 'Saved payment method';
  return normalized;
}

export function createCheckoutPaymentPresentationV2(input: {
  codAvailable: boolean;
  currentPayment: CurrentPaymentMethodV2;
  expiresAt: number;
  interactionId?: string;
  now?: number;
  taskId: CheckoutPaymentPresentationV2['taskId'];
  taskRevision: number;
}): CheckoutPaymentPresentationV2 {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new Error('Payment choices require a future expiry.');
  }
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 0) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  bounded(input.currentPayment.methodRef, 'payment method reference', 200);
  const currentLabel = publicPaymentLabel(input.currentPayment.label);
  const currentIsCod = input.currentPayment.kind === 'cod';
  return {
    version: 2,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    interactionId:
      input.interactionId ?? `checkout_payment_${crypto.randomUUID()}`,
    expiresAt: input.expiresAt,
    mode: 'payment_options',
    safetyLabel: 'NOT ORDERED',
    currentPayment: {
      kind: input.currentPayment.kind,
      publicLabel: currentLabel,
    },
    choices: [
      {
        choiceId: 'continue_current',
        enabled: true,
        label: `Continue with ${currentLabel}`,
        selected: true,
      },
      ...(!currentIsCod
        ? [{
            choiceId: 'use_cod' as const,
            enabled: input.codAvailable,
            label: 'Use Cash on Delivery',
            selected: false,
            ...(!input.codAvailable
              ? { disabledReason: 'cod_unavailable' as const }
              : {}),
          }]
        : []),
      {
        choiceId: 'add_more',
        enabled: true,
        label: 'Add more items',
        selected: false,
      },
      {
        choiceId: 'stop',
        enabled: true,
        label: 'Stop here',
        selected: false,
      },
    ],
  };
}

export function resolveCheckoutPaymentChoiceV2(input: {
  choiceId: CheckoutPaymentChoiceIdV2 | string;
  interactionId: string;
  now?: number;
  presentation: CheckoutPaymentPresentationV2;
  taskRevision: number;
}): CheckoutPaymentChoiceResolutionV2 {
  const now = input.now ?? Date.now();
  if (input.taskRevision !== input.presentation.taskRevision) {
    return { accepted: false, reason: 'stale_revision' };
  }
  if (input.interactionId !== input.presentation.interactionId) {
    return { accepted: false, reason: 'stale_interaction' };
  }
  if (now >= input.presentation.expiresAt) {
    return { accepted: false, reason: 'expired' };
  }
  const choice = input.presentation.choices.find(
    (candidate) => candidate.choiceId === input.choiceId,
  );
  if (!choice) return { accepted: false, reason: 'invalid_choice' };
  if (!choice.enabled) {
    return { accepted: false, reason: 'choice_unavailable' };
  }
  switch (choice.choiceId) {
    case 'continue_current':
      return {
        accepted: true,
        choiceId: choice.choiceId,
        command: { kind: 'prepare_checkout', payment: 'current' },
      };
    case 'use_cod':
      return {
        accepted: true,
        choiceId: choice.choiceId,
        command: { kind: 'prepare_checkout', payment: 'cod' },
      };
    case 'add_more':
      return {
        accepted: true,
        choiceId: choice.choiceId,
        command: { kind: 'add_more' },
      };
    case 'stop':
      return {
        accepted: true,
        choiceId: choice.choiceId,
        command: { kind: 'stop' },
      };
  }
}
