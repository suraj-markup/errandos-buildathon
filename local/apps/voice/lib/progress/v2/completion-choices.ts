import type { LocalIdentifier } from '../../workflow/identifiers';
import type {
  CompletionChoiceIdV2,
  CompletionChoicePromptV2,
  CompletionChoiceV2,
} from './contracts';

export type CompletionChoiceCommandV2 =
  | { kind: 'review_cart' }
  | { kind: 'add_more' }
  | { kind: 'review_checkout'; paymentPreference: 'ask_user' }
  | { kind: 'review_checkout'; paymentPreference: 'provider_saved' }
  | { kind: 'review_checkout'; paymentPreference: 'cod' }
  | { kind: 'stop' };

export type CompletionChoiceResolutionV2 =
  | {
      accepted: true;
      choiceId: CompletionChoiceIdV2;
      command: CompletionChoiceCommandV2;
      source: 'speech' | 'tap';
    }
  | {
      accepted: false;
      reason:
        | 'ambiguous'
        | 'choice_unavailable'
        | 'expired'
        | 'invalid_choice'
        | 'stale_revision';
    };

function publicPaymentLabel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const label = value
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 80);
  return label || undefined;
}

export function createCompletionChoicePromptV2(input: {
  codAvailable: boolean;
  currentPaymentLabel?: string;
  expiresAt: number;
  interactionId?: string;
  now?: number;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): CompletionChoicePromptV2 {
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
    throw new Error('Completion choices require a future expiry.');
  }
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 0) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  const currentPaymentLabel = publicPaymentLabel(input.currentPaymentLabel);
  const choices: CompletionChoiceV2[] = [
    { choiceId: 'review_cart', enabled: true, label: 'Review cart' },
    { choiceId: 'add_more', enabled: true, label: 'Keep shopping' },
    {
      choiceId: 'review_checkout',
      enabled: true,
      label: 'Review checkout',
    },
    {
      choiceId: 'use_current_payment',
      enabled: Boolean(currentPaymentLabel),
      label: currentPaymentLabel
        ? `Continue with ${currentPaymentLabel}`
        : 'Use current payment',
      ...(!currentPaymentLabel
        ? { disabledReason: 'Current payment method is unavailable.' }
        : {}),
    },
    {
      choiceId: 'use_cod',
      enabled: input.codAvailable,
      label: 'Review with Cash on Delivery',
      ...(!input.codAvailable
        ? { disabledReason: 'Cash on Delivery is unavailable.' }
        : {}),
    },
    { choiceId: 'stop', enabled: true, label: 'Stop' },
  ];
  return {
    version: 2,
    interactionId:
      input.interactionId ?? `interaction_${crypto.randomUUID()}`,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    expiresAt: input.expiresAt,
    ...(currentPaymentLabel ? { currentPaymentLabel } : {}),
    choices,
  };
}

const fixedSpeechAliases: Readonly<
  Record<Exclude<CompletionChoiceIdV2, 'use_current_payment'>, RegExp>
> = {
  review_cart: /\b(?:review|open|show)\s+(?:the\s+)?cart\b/i,
  add_more: /\b(?:add more|add another|more items?)\b/i,
  review_checkout: /\b(?:review|open|prepare|show)\s+(?:the\s+)?checkout\b/i,
  use_cod: /\b(?:cod|cash on delivery|pay on delivery)\b/i,
  stop: /\b(?:stop|done|nothing else|that's all|that is all)\b/i,
};

function selectedFromSpeech(
  speech: string,
  prompt: CompletionChoicePromptV2,
): CompletionChoiceIdV2[] {
  const normalized = speech.trim();
  const matches: CompletionChoiceIdV2[] = (
    Object.entries(fixedSpeechAliases) as Array<
      [Exclude<CompletionChoiceIdV2, 'use_current_payment'>, RegExp]
    >
  )
    .filter(([, pattern]) => pattern.test(normalized))
    .map(([choiceId]) => choiceId);
  const payment = prompt.currentPaymentLabel?.toLocaleLowerCase('en-IN');
  if (
    /\b(?:current|saved|same)\s+(?:payment|method|card)\b/i.test(normalized)
    || (
      payment
      && normalized.toLocaleLowerCase('en-IN').includes(payment)
    )
  ) {
    matches.push('use_current_payment');
  }
  return [...new Set(matches)];
}

function commandFor(choiceId: CompletionChoiceIdV2): CompletionChoiceCommandV2 {
  switch (choiceId) {
    case 'review_cart':
      return { kind: 'review_cart' };
    case 'add_more':
      return { kind: 'add_more' };
    case 'review_checkout':
      return { kind: 'review_checkout', paymentPreference: 'ask_user' };
    case 'use_current_payment':
      return {
        kind: 'review_checkout',
        paymentPreference: 'provider_saved',
      };
    case 'use_cod':
      return { kind: 'review_checkout', paymentPreference: 'cod' };
    case 'stop':
      return { kind: 'stop' };
  }
}

export function resolveCompletionChoiceV2(input: {
  choiceId?: CompletionChoiceIdV2 | string;
  now?: number;
  prompt: CompletionChoicePromptV2;
  source: 'speech' | 'tap';
  speech?: string;
  taskRevision: number;
}): CompletionChoiceResolutionV2 {
  const now = input.now ?? Date.now();
  if (input.taskRevision !== input.prompt.taskRevision) {
    return { accepted: false, reason: 'stale_revision' };
  }
  if (now >= input.prompt.expiresAt) {
    return { accepted: false, reason: 'expired' };
  }
  const matches = input.source === 'tap'
    ? input.choiceId
      ? [input.choiceId]
      : []
    : selectedFromSpeech(input.speech ?? '', input.prompt);
  if (matches.length === 0) {
    return { accepted: false, reason: 'invalid_choice' };
  }
  if (matches.length > 1) {
    return { accepted: false, reason: 'ambiguous' };
  }
  const choice = input.prompt.choices.find(
    (candidate) => candidate.choiceId === matches[0],
  );
  if (!choice) return { accepted: false, reason: 'invalid_choice' };
  if (!choice.enabled) {
    return { accepted: false, reason: 'choice_unavailable' };
  }
  return {
    accepted: true,
    choiceId: choice.choiceId,
    command: commandFor(choice.choiceId),
    source: input.source,
  };
}
