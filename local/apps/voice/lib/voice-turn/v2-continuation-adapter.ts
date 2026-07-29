import {
  isSequentialProductAction,
  type SequentialProductAction,
} from '../product-workflow';
import type { PhoneTaskV2 } from '../workflow/v2';

type ProductOption = {
  offerId?: string;
  priceAmount?: number;
  priceCurrency?: 'INR';
  product?: string;
  price?: string;
  size?: string;
  spokenLabel?: string;
};

type VoiceTurnProductChoiceContinuationV2 = {
  interactionId: string;
  taskRevision: number;
  expiresAt: number;
  languageCode: string;
  responseId?: string;
  pendingGrocery: {
    intent: 'add' | 'search';
    options: ProductOption[];
    quantity: number;
    request: string;
  };
  queuedProducts: SequentialProductAction[];
};

function productOptions(value: unknown): ProductOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const options: ProductOption[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return undefined;
    }
    const option = candidate as Record<string, unknown>;
    if (
      option['offerId'] !== undefined
      && typeof option['offerId'] !== 'string'
    ) {
      return undefined;
    }
    if (
      option['priceAmount'] !== undefined
      && (
        typeof option['priceAmount'] !== 'number'
        || !Number.isFinite(option['priceAmount'])
      )
    ) {
      return undefined;
    }
    if (
      option['priceCurrency'] !== undefined
      && option['priceCurrency'] !== 'INR'
    ) {
      return undefined;
    }
    const textFields = ['price', 'product', 'size', 'spokenLabel'] as const;
    if (textFields.some((field) =>
      option[field] !== undefined && typeof option[field] !== 'string')) {
      return undefined;
    }
    options.push(structuredClone(option) as ProductOption);
  }
  return options;
}

function sequentialProductAction(
  value: unknown,
): value is SequentialProductAction {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && isSequentialProductAction(value as { action?: string }),
  );
}

export function voiceTurnProductChoiceContinuationV2(
  task: PhoneTaskV2,
): VoiceTurnProductChoiceContinuationV2 | undefined {
  const interaction = task.pendingInteraction;
  const activeStep = task.steps.find(
    ({ stepId }) => stepId === task.activeStepId,
  );
  if (
    task.status !== 'waiting_for_user'
    || interaction?.kind !== 'product_choice'
    || interaction.status !== 'open'
    || !activeStep
    || activeStep.status !== 'waiting_for_user'
    || !sequentialProductAction(activeStep.input)
  ) {
    return undefined;
  }
  const options = productOptions(interaction.allowedResponses);
  if (!options) return undefined;
  const activeAction = activeStep.input;
  const activeIndex = task.steps.findIndex(
    ({ stepId }) => stepId === task.activeStepId,
  );
  if (activeIndex < 0) return undefined;
  const queuedProducts = task.steps
    .slice(activeIndex + 1)
    .filter(({ status }) => ['planned', 'ready'].includes(status))
    .map(({ input }) => input)
    .filter(sequentialProductAction)
    .map((action) => structuredClone(action));
  return {
    interactionId: interaction.interactionId,
    taskRevision: interaction.taskRevision,
    expiresAt: interaction.expiresAt,
    languageCode: task.turnContext?.languageCode ?? 'en-IN',
    ...(task.turnContext?.responseId
      ? { responseId: task.turnContext.responseId }
      : {}),
    pendingGrocery: {
      intent: activeAction.action === 'search_products' ? 'search' : 'add',
      options,
      quantity: activeAction.quantity ?? 1,
      request: activeAction.request,
    },
    queuedProducts,
  };
}
