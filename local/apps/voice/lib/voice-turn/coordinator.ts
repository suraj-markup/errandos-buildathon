import { NextResponse } from 'next/server';
import {
  executePhoneAction,
  type PhoneActionArguments,
  type PhoneActionExecutionContext,
} from '../phone-tool';
import {
  parsePhoneToolCommand,
  PhoneCommandValidationError,
} from '../phone-command';
import type { PresentableToolResult } from '../voice-presentation';
import {
  isCodCheckoutProposal,
  isExplicitCodConfirmation,
  type CodCheckoutProposalV1,
  type CodCheckoutSnapshot,
} from '../cod';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import {
  confirmVoiceTurnCodCheckoutV2,
  prepareVoiceTurnCodCheckoutV2,
  recoverLatestCheckoutV2,
} from '../checkout/v2/runtime-adapter';
import type {
  DurableCheckoutRecoveryV2,
} from '../checkout/v2/recovery';
import type {
  PhoneToolCheckoutResultV2,
  VoiceTurnPreparedCodCheckoutV2,
} from '../checkout/v2/voice-turn-adapter';
import {
  executeSequentialProductQueue,
  isSequentialProductAction,
  productResultNeedsUserInput,
  type SequentialProductAction,
} from '../product-workflow';
import {
  isProductWorkflowCancellation,
  resolvePendingProductChoice,
} from '../product-choice';
import {
  errorDetails,
  logEvent,
  updateLogContext,
} from '../structured-logger';
import {
  recordUxTimingIntervalSafelyV1,
  uxTimingMetricsV1,
  type DeterministicUxTimingMetricsCollectorV1,
} from '../ux-timing-metrics';
import { loadVoiceFeatureFlags } from '../feature-flags';
import {
  prepareProductSelectionPresentation,
} from '../workflow/product-selection-presentation';
import {
  newLocalIdentifier,
  type LocalIdentifier,
} from '../workflow/identifiers';
import {
  BoundedResponseHistoryStore,
  isStartOverRequest,
} from '../bounded-history';
import {
  correlatedResult,
  correlationFields,
  createCorrelationContext,
  extendCorrelationContext,
  type CorrelationContextV1,
} from '../correlation';
import {
  createVoiceProviderAdapters,
  synthesizeWithFallback,
  type OpenAIOutputItem,
  type VoiceProviderAdapters,
} from './provider-adapters';
import {
  DeterministicVoicePresentationAdapter,
  type VoicePresentationAdapter,
} from './presentation-adapter';
import {
  getOrCreateLocalizedProgressSpeechCache,
  type LocalizedProgressSpeechCache,
  type LocalizedProgressSpeechResult,
} from './localized-progress-speech';
import { loadVoiceRuntimePolicy } from '../runtime-policy';
import { RealtimeCancellationDomains } from '../realtime/cancellation-domains';
import {
  shouldForceCheckoutContinuationV2,
} from '../policy/v2/checkout-intent';
import { capabilityCatalogV2 } from '../policy/v2/capability-catalog';
import {
  buildVerifiedItemCompletionEventsV2,
  taskEventStreamV2,
} from '../progress/v2';
import type { OperationAcceptedV2 } from '../progress/v2/contracts';
import {
  androidSettingsPackageV2,
  androidSettingsReadOnlyAdapterIdV2,
  authoritativeGeneralMobileProductionServiceV2,
  type GeneralMobileProductionServiceV2,
  type ReadOnlyCompanionResultV2,
} from '../general-mobile/v2';
import { parseLocalIdentifier } from '../workflow/identifiers';
import {
  assemblePlannerContextV2,
  applyLlmPlanPatchesV2,
  attachAutomaticFinalCartInspectionV2,
  beginV2CompatibilityExecution,
  completeV2CompatibilityExecution,
  DEFAULT_TASK_BUDGETS_V2,
  persistPhoneTaskTurnContextV2,
  phoneTaskRepositoryV2,
  resolveV2InteractionForCompatibility,
  type PhoneTaskStepV2,
  type PhoneTaskV2,
  type TaskRepositoryRecordV2,
} from '../workflow/v2';
import {
  voiceTurnProductChoiceContinuationV2,
} from './v2-continuation-adapter';
import {
  dispatchProductionContinuationV2,
  enqueueProductionBackgroundPhoneOperationV2,
} from '../workflow/v2/background-phone-operation/production-adapter';
import {
  classifyIncomingTaskTurnV2,
  hasUnresolvedMutationV2,
  type TaskTurnDispositionV2,
} from '../workflow/v2/task-lifecycle';
import { transitionPhoneTaskV2 } from '../workflow/v2/graph';
import {
  OpenAILlmPlannerV2,
  type LlmPlannerTurnResultV2,
} from './llm-planner-v2';
import {
  executeResolvedProductSelectionV2,
  resolveProductSelectionInteractionV2,
} from './product-selection-interaction';

type GroceryOption = {
  offerId?: string;
  priceAmount?: number;
  priceCurrency?: 'INR';
  product?: string;
  price?: string;
  size?: string;
  spokenLabel?: string;
};

type PendingGrocery = {
  intent: 'add' | 'search';
  options: GroceryOption[];
  quantity: number;
  request: string;
  selectedOption?: GroceryOption;
};

type DurablePendingCodV2 = CodCheckoutProposalV1 & {
  checkoutId: string;
  checkoutTaskId?: LocalIdentifier<'task'>;
  checkoutTaskRevision: number;
};

function durablePendingCodV2(
  value: CodCheckoutSnapshot | undefined,
): DurablePendingCodV2 | undefined {
  if (!value || !isCodCheckoutProposal(value)) return undefined;
  const candidate = value as Partial<DurablePendingCodV2>;
  return (
    typeof candidate.checkoutId === 'string'
    && candidate.checkoutId.length > 0
    && Number.isSafeInteger(candidate.checkoutTaskRevision)
    && (candidate.checkoutTaskRevision ?? -1) >= 0
  )
    ? candidate as DurablePendingCodV2
    : undefined;
}

function checkoutProposalFromPhoneResult(
  result: unknown,
): CodCheckoutProposalV1 | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const checkout = (result as { checkout?: unknown }).checkout;
  return checkout
    && typeof checkout === 'object'
    && isCodCheckoutProposal(checkout as CodCheckoutProposalV1)
      ? checkout as CodCheckoutProposalV1
      : undefined;
}

function pendingCodFromPreparedCheckout(
  prepared: VoiceTurnPreparedCodCheckoutV2,
): DurablePendingCodV2 {
  return {
    ...prepared.checkout,
    checkoutId: prepared.checkoutId,
    checkoutTaskRevision: prepared.checkoutTaskRevision,
  };
}

function pendingCodFromRecoveryV2(
  recovery: DurableCheckoutRecoveryV2,
): DurablePendingCodV2 | undefined {
  return recovery.status === 'review_pending'
    ? {
        ...recovery.checkout,
        checkoutId: recovery.checkoutId,
        checkoutTaskId: recovery.taskId,
        checkoutTaskRevision: recovery.taskRevision,
      }
    : undefined;
}

function sequentialProductActionV2(
  value: unknown,
): SequentialProductAction | undefined {
  return (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && isSequentialProductAction(value as { action?: string })
  )
    ? structuredClone(value as SequentialProductAction)
    : undefined;
}

function unresolvedProductActionsV2(
  task: PhoneTaskV2 | undefined,
): SequentialProductAction[] {
  if (!task || ['cancelled', 'completed'].includes(task.status)) return [];
  if (
    task.steps.some((step) =>
      ['failed', 'ambiguous', 'blocked'].includes(step.status))
  ) {
    return [];
  }
  return task.steps
    .filter((step) =>
      ['planned', 'ready'].includes(step.status))
    .map((step) => sequentialProductActionV2(step.input))
    .filter((action): action is SequentialProductAction => Boolean(action));
}

function createProductTaskV2(input: {
  actions: readonly SequentialProductAction[];
  clientId: string;
  desiredTerminalOutcome?: PhoneTaskV2['desiredTerminalOutcome'];
  originalGoal: string;
  now?: number;
}): PhoneTaskV2 {
  const now = input.now ?? Date.now();
  const taskId = newLocalIdentifier('task');
  let previousStepId: string | undefined;
  const steps: PhoneTaskStepV2[] = input.actions.map((action, index) => {
    const stepId = newLocalIdentifier('task_item');
    const step: PhoneTaskStepV2 = {
      stepId,
      adapterId: 'blinkit',
      kind: action.action,
      status: index === 0 ? 'ready' : 'planned',
      dependsOn: previousStepId ? [previousStepId] : [],
      input: structuredClone(action),
      expectedPostcondition: {
        kind: action.action === 'add_cart_item'
          ? 'cart_contains_requested_quantity'
          : 'product_options_observed',
        quantity: action.quantity ?? 1,
        request: action.request,
      },
      attempts: 0,
    };
    previousStepId = stepId;
    return step;
  });
  const task: PhoneTaskV2 = {
    version: 2,
    taskId,
    clientId: input.clientId,
    revision: 0,
    originalGoal: input.originalGoal,
    goalKind: 'multi_item_acquisition',
    status: 'active',
    ...(steps[0] ? { activeStepId: steps[0].stepId } : {}),
    steps,
    ...(input.desiredTerminalOutcome
      ? { desiredTerminalOutcome: input.desiredTerminalOutcome }
      : {}),
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: now,
    updatedAt: now,
  };
  return input.actions.length > 1
    ? attachAutomaticFinalCartInspectionV2(task)
    : task;
}

const voiceGlobal = globalThis as typeof globalThis & {
  errandosVoiceResponseHistory?: BoundedResponseHistoryStore;
};
const responseHistoryTtlMs = 10 * 60 * 1000;
const responseHistory =
  voiceGlobal.errandosVoiceResponseHistory
  ?? new BoundedResponseHistoryStore({
    inactiveTtlMs: responseHistoryTtlMs,
    maxResponseChainLength: 12,
    maxTurns: 8,
  });
voiceGlobal.errandosVoiceResponseHistory = responseHistory;

function isExplicitProductAddRequest(transcript: string): boolean {
  return /\b(add|buy|get|kardo|kar do|le lo)\b/i.test(transcript);
}

function acknowledgesCompletedProductAdd(transcript: string): boolean {
  const normalized = transcript.toLocaleLowerCase('en-IN');
  return (
    /\b(?:already added|you (?:have |already )?added|i can see (?:that )?(?:you )?(?:have )?added|it(?:'s| is) (?:already )?(?:added|in (?:the )?cart)|cart (?:already )?(?:has|shows))\b/i
      .test(normalized)
    || /(?:तुमने|आपने|मैं[^।.!?]*(?:देख|दिख))[^।.!?]*(?:add|ऐड|जोड़|डाल)[^।.!?]*(?:दिया|दी|हो गया)/iu
      .test(normalized)
    || /\b(?:tumne|aapne|main .*dekh).*(?:add|jod|daal|dal).*(?:diya|kar diya|ho gaya)\b/i
      .test(normalized)
  );
}

function continuesProductWorkflow(transcript: string): boolean {
  return /^(?:please\s+)?(?:continue|retry|try again|resume|go on|proceed)(?:\s+please)?[.!]?$/i
    .test(transcript.trim());
}

function explicitlyRetriesProductWorkflow(transcript: string): boolean {
  return /^(?:please\s+)?(?:retry|try again)(?:\s+please)?[.!]?$/i
    .test(transcript.trim());
}

function verifiedNotAppliedRetryStep(
  task: PhoneTaskV2 | undefined,
  transcript: string,
): PhoneTaskStepV2 | undefined {
  if (!task || !explicitlyRetriesProductWorkflow(transcript)) return undefined;
  const eligibleStepIds = new Set(task.steps.flatMap((step) => {
    if (step.status !== 'failed') return [];
    const currentStepTransition = [...task.journal]
      .reverse()
      .find((entry) => entry.stepId === step.stepId);
    return currentStepTransition?.type === 'recovery_verified_not_applied'
      ? [step.stepId]
      : [];
  }));
  const latestRecovery = [...task.journal]
    .reverse()
    .find((entry) =>
      entry.type === 'recovery_verified_not_applied'
      && Boolean(entry.stepId)
      && eligibleStepIds.has(entry.stepId!));
  return latestRecovery?.stepId
    ? task.steps.find((step) => step.stepId === latestRecovery.stepId)
    : undefined;
}

function explicitlyStartsOver(transcript: string): boolean {
  return /\b(?:restart|start again|start over|new list)\b/i
    .test(transcript.trim());
}

function explicitSettingsObservationFocus(
  transcript: string,
): string | undefined {
  if (!/\bsettings?\b/i.test(transcript)) return undefined;
  if (
    !/\b(?:explain|help|look|observe|point|show|tell|what(?:'s| is)|where(?:'s| is)|find)\b/i
      .test(transcript)
    || !/\b(?:screen|visible|option|setting|control|button|toggle|switch)\b/i
      .test(transcript)
  ) {
    return undefined;
  }
  const focus = /\b(?:where(?:'s| is)|find|point(?: me)? to|show me)\s+(.+?)(?:\s+in (?:this )?settings?(?: screen)?)?[?.!]*$/i
    .exec(transcript)?.[1]
    ?.trim();
  return focus?.slice(0, 120) || '';
}

type CoordinatorGeneralMobileObservationV2 =
  | (ReadOnlyCompanionResultV2 & { operationId: string })
  | {
      explanation: string;
      operationId: string;
      status: 'unavailable';
    };

function completeResponseHistorySafely(input: {
  clientId: string;
  responseCount: number;
  responseId: string;
  turnId: string;
}): boolean {
  try {
    return responseHistory.completeTurn(input);
  } catch (error) {
    logEvent('warn', 'model.response_chain_id_rejected', {
      ...errorDetails(error),
      responseIdCharacters: input.responseId.length,
    });
    return false;
  }
}

function isSameProductAction(
  left: SequentialProductAction | undefined,
  right: SequentialProductAction | undefined,
): boolean {
  if (!left || !right) return false;
  return left.action === right.action
    && left.request.trim().toLocaleLowerCase('en-IN')
      === right.request.trim().toLocaleLowerCase('en-IN');
}

function selectedOfferFor(
  option: GroceryOption,
): SequentialProductAction['selectedOffer'] | undefined {
  if (
    !option.offerId
    || !option.product
    || option.priceAmount === undefined
    || option.priceCurrency !== 'INR'
  ) {
    return undefined;
  }
  return {
    offerId: option.offerId,
    title: option.product,
    ...(option.size ? { packSize: option.size } : {}),
    priceAmount: option.priceAmount,
    priceCurrency: option.priceCurrency,
  };
}

function addActionForSelectedPendingOption(
  pending: PendingGrocery,
  option: GroceryOption | undefined,
  reconcileOnly = false,
): SequentialProductAction | undefined {
  if (!option?.offerId) return undefined;
  const selectedOffer = selectedOfferFor(option);
  return {
    action: 'add_cart_item',
    offerId: option.offerId,
    quantity: pending.quantity,
    ...(reconcileOnly ? { reconcileOnly: true } : {}),
    request:
      option.product
      || option.spokenLabel
      || pending.request,
    searchQuery: pending.request,
    ...(selectedOffer ? { selectedOffer } : {}),
  };
}

const languageRequirements: Record<string, string> = {
  'bn-IN': 'Bengali using Bengali script. Do not switch to Hindi or Hinglish.',
  'gu-IN': 'Gujarati using Gujarati script. Do not switch to Hindi or Hinglish.',
  'hi-IN': 'Hindi using Devanagari script, preserving natural English product or app names.',
  'kn-IN': 'Kannada using Kannada script. Do not switch to Hindi or Hinglish.',
  'ml-IN': 'Malayalam using Malayalam script. Do not switch to Hindi or Hinglish.',
  'mr-IN': 'Marathi using Devanagari script. Do not switch to Hindi or Hinglish.',
  'od-IN': 'Odia using Odia script. Do not switch to Hindi or Hinglish.',
  'pa-IN': 'Punjabi using Gurmukhi script. Do not switch to Hindi or Hinglish.',
  'ta-IN': 'Tamil using Tamil script. Do not switch to Hindi or Hinglish.',
  'te-IN': 'Telugu using Telugu script. Do not switch to Hindi or Hinglish.',
};

const phoneTools = [
  {
    type: 'function',
    name: 'inspect_cart',
    description: [
      'Read the verified current Blinkit cart without changing it.',
      'Use for requests asking what is in the cart, how many items it has, or its subtotal.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'set_cart_item_quantity',
    description: [
      'Set the final quantity of one exact product already present in the Blinkit cart.',
      'Use only an exact productId returned by inspect_cart; never invent or infer an ID.',
      'If no exact productId is available, inspect the cart and ask the user to choose first.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: {
          type: 'string',
          description: 'The exact opaque productId previously returned by inspect_cart.',
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'The requested final quantity.',
        },
      },
      required: ['productId', 'quantity'],
    },
  },
  {
    type: 'function',
    name: 'remove_cart_item',
    description: [
      'Remove one exact product already present in the Blinkit cart.',
      'Use only an exact productId returned by inspect_cart; never invent or infer an ID.',
      'If no exact productId is available, inspect the cart and ask the user to choose first.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        productId: {
          type: 'string',
          description: 'The exact opaque productId previously returned by inspect_cart.',
        },
      },
      required: ['productId'],
    },
  },
  {
    type: 'function',
    name: 'search_products',
    description: [
      'Search Blinkit without changing the cart.',
      'Use this for find, search, show, browse, availability, option, and price questions.',
      'Never use this tool for an explicit add, buy, or get request.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: {
          type: 'string',
          description: 'Only the product phrase, preserving any brand, flavor, and pack size.',
        },
      },
      required: ['request'],
    },
  },
  {
    type: 'function',
    name: 'add_cart_item',
    description: [
      'Add one exact grocery offer to the Blinkit cart at the requested final quantity.',
      'Use only for explicit add, buy, or get requests.',
      'If the request does not identify one offer, this returns visible options without changing the cart.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: {
          type: 'string',
          description: [
            'Only the product words spoken by the user.',
            'Preserve brand, flavor, and pack size exactly.',
            'Do not include action words or the requested item count.',
          ].join(' '),
        },
        offerId: {
          type: ['string', 'null'],
          description: [
            'The opaque offerId from a pending visible option.',
            'Use null on the first search.',
            'Never invent an offerId and never copy an ID from outside the pending options.',
          ].join(' '),
        },
        quantity: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'The requested final cart quantity. Use 1 when the user gives no quantity.',
        },
      },
      required: ['request', 'offerId', 'quantity'],
    },
  },
  {
    type: 'function',
    name: 'prepare_checkout',
    description: [
      'Open and review the existing Blinkit cart, select Cash on Delivery when available, and return the verified total and saved address label.',
      'This never presses the final Place Order button.',
      'Use when the user asks to prepare, review, checkout, or order the cart using COD.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'confirm_checkout',
    description: [
      'Press the final Blinkit Place Order button exactly once for previously reviewed, unchanged COD terms.',
      'Use only after a COD review when the user’s current speech explicitly says “Confirm COD order”.',
      'Never use for “yes”, “go ahead”, “add to cart”, or an initial checkout request.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'open_blinkit',
    description: [
      'Open Blinkit without searching or adding anything.',
      'Use only when the user explicitly asks to open or launch Blinkit and does not request a product.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'phone_status',
    description: 'Check whether the connected Android phone and Appium are reachable.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
];

export function phoneActionForCall(
  callName: string,
  serializedArguments: string | undefined,
  pendingGrocery?: PendingGrocery,
  pendingCod?: CodCheckoutSnapshot,
): PhoneActionArguments {
  const command = parsePhoneToolCommand(callName, serializedArguments, {
    protocolVersion: 2,
  });
  if (command.action === 'add_cart_item') {
    const pendingOption = command.offerId
      ? pendingGrocery?.options.find(
          (option) => option.offerId === command.offerId,
        )
      : undefined;
    const pendingSearchQuery = pendingOption
      ? pendingGrocery?.request
      : undefined;
    const selectedOffer = pendingOption
      ? selectedOfferFor(pendingOption)
      : undefined;
    return {
      ...command,
      ...(pendingSearchQuery ? { searchQuery: pendingSearchQuery } : {}),
      ...(selectedOffer ? { selectedOffer } : {}),
    };
  }
  if (command.action === 'confirm_checkout') {
    return {
      ...command,
      checkoutProposal: pendingCod && isCodCheckoutProposal(pendingCod)
        ? pendingCod
        : undefined,
    };
  }
  return command;
}

function toolArgumentsForLog(serialized: string | undefined): unknown {
  if (!serialized) return {};
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return {
      invalidJson: true,
      serializedCharacters: serialized.length,
    };
  }
}

export type VoiceTurnCoordinatorDependencies = {
  enqueueBackgroundPhoneOperation?:
    typeof enqueueProductionBackgroundPhoneOperationV2;
  executePhone?: typeof executePhoneAction;
  generalMobile?: Pick<GeneralMobileProductionServiceV2, 'observe'>;
  localizedProgressSpeech?: LocalizedProgressSpeechCache;
  presentation?: VoicePresentationAdapter;
  providers?: VoiceProviderAdapters;
  repository?: ReturnType<typeof phoneTaskRepositoryV2>;
  metrics?: DeterministicUxTimingMetricsCollectorV1;
  now?: () => number;
};

export async function coordinateVoiceTurn(
  request: Request,
  requestId: string,
  dependencies: VoiceTurnCoordinatorDependencies = {},
): Promise<Response> {
  const requestStartedAt = performance.now();
  const timingNow = dependencies.now ?? ((): number => performance.now());
  const timingMetrics = dependencies.metrics ?? uxTimingMetricsV1;
  let initialAcknowledgementStartedAt: number | undefined;
  let turnCorrelation: CorrelationContextV1 | undefined;
  logEvent('info', 'request.start', {
    contentLength: request.headers.get('content-length'),
    contentType: request.headers.get('content-type'),
    method: request.method,
  });
  const sarvamApiKey = process.env.SARVAM_API_KEY;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  if (
    !dependencies.providers
    && (!sarvamApiKey || !openAIApiKey)
  ) {
    logEvent('error', 'request.error', {
      durationMs: Math.round(performance.now() - requestStartedAt),
      errorMessage: 'voice_provider_configuration_missing',
    });
    return NextResponse.json(
      {
        error: 'The server voice providers are not configured.',
        requestId,
      },
      { status: 503 },
    );
  }
  const providers = dependencies.providers ?? createVoiceProviderAdapters({
    openAIApiKey: openAIApiKey!,
    sarvamApiKey: sarvamApiKey!,
  });
  const runtimePolicy = loadVoiceRuntimePolicy();
  const presentationAdapter = dependencies.presentation
    ?? new DeterministicVoicePresentationAdapter(
      providers.responses,
      runtimePolicy.boundedControlModel,
    );
  const localizedProgressSpeech =
    dependencies.localizedProgressSpeech
    ?? getOrCreateLocalizedProgressSpeechCache({
      maxTextCharacters: 600,
      synthesize: (text, languageCode) =>
        synthesizeWithFallback(providers.speech, text, languageCode),
    });
  const phoneExecutor = dependencies.executePhone ?? executePhoneAction;
  const enqueueBackgroundPhoneOperation =
    dependencies.enqueueBackgroundPhoneOperation
    ?? (
      dependencies.executePhone
        ? undefined
        : enqueueProductionBackgroundPhoneOperationV2
    );
  const taskRepository =
    dependencies.repository ?? phoneTaskRepositoryV2();

  try {
    const form = await request.formData();
    const audio = form.get('audio');
    const clientIdValue = form.get('clientId');
    const productChoiceOfferIdValue = form.get('productChoiceOfferId');
    const requestedClientId =
      typeof clientIdValue === 'string'
        ? clientIdValue.trim().slice(0, 80)
        : '';
    const clientId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
      .test(requestedClientId)
      ? requestedClientId
      : 'pixel-web';
    const productChoiceOfferId =
      typeof productChoiceOfferIdValue === 'string'
        && productChoiceOfferIdValue.trim()
        ? productChoiceOfferIdValue.trim().slice(0, 200)
        : undefined;
    turnCorrelation = createCorrelationContext({ clientId, requestId });
    updateLogContext({ clientId });
    if (providers.realtime) {
      const cancellation = new RealtimeCancellationDomains({
        // Android stops its local Sarvam MediaPlayer synchronously when a new
        // push-to-talk gesture begins, before this request is sent.
        playback: { stopPlayback: () => undefined },
        response: {
          cancelResponse: () => providers.realtime!.cancelResponse(clientId),
        },
      });
      try {
        const interrupted = await cancellation.interruptForPushToTalk();
        logEvent('info', 'realtime.push_to_talk_interruption', interrupted);
      } catch (error) {
        logEvent('warn', 'realtime.push_to_talk_interruption_failed', {
          ...errorDetails(error),
          phoneOperation: 'unchanged',
        });
      }
    }
    const inactiveHistoryCount = responseHistory.cleanup();
    if (inactiveHistoryCount > 0) {
      logEvent('info', 'workflow.inactive_sessions_cleaned', {
        responseHistoryCount: inactiveHistoryCount,
      });
    }

    const featureFlags = loadVoiceFeatureFlags();
    logEvent('info', 'workflow.feature_flags', {
      realtimeControlV1: featureFlags.realtimeControlV1,
      realtimeSafeToolsV1: featureFlags.realtimePhoneToolsV1,
      realtimeVoiceV1: featureFlags.realtimeVoiceV1,
      visualObservationV1: featureFlags.screenshotObservationV1,
    });
    let authoritativeTaskV2: PhoneTaskV2 | undefined;
    let authoritativeTaskRecordV2: TaskRepositoryRecordV2 | undefined;
    const persisted = await taskRepository.getByClientId(clientId);
    authoritativeTaskRecordV2 =
      persisted
      && !['cancelled', 'completed'].includes(persisted.task.status)
        ? persisted
        : undefined;
    authoritativeTaskV2 = authoritativeTaskRecordV2?.task;
    const nativeProductChoiceContinuationV2 =
      authoritativeTaskV2
        ? voiceTurnProductChoiceContinuationV2(authoritativeTaskV2)
        : undefined;
    const activeProductChoiceContinuationV2 =
      nativeProductChoiceContinuationV2
      && nativeProductChoiceContinuationV2.expiresAt > Date.now()
        ? nativeProductChoiceContinuationV2
        : undefined;
    const checkoutRecoveryV2 = await recoverLatestCheckoutV2({
      clientId,
      ownerId: clientId,
      ...(authoritativeTaskV2
        ? {
            taskId: parseLocalIdentifier(
              'task',
              authoritativeTaskV2.taskId,
            ),
          }
        : {}),
    });
    logEvent('info', 'workflow.checkout_recovery_v2', {
      status: checkoutRecoveryV2.status,
      ...('taskId' in checkoutRecoveryV2
        ? { taskId: checkoutRecoveryV2.taskId }
        : {}),
    });
    if (authoritativeTaskV2) {
      turnCorrelation = extendCorrelationContext(turnCorrelation, {
        taskId: parseLocalIdentifier('task', authoritativeTaskV2.taskId),
        ...(authoritativeTaskV2.activeStepId?.startsWith('task_item_')
          ? {
              itemId: parseLocalIdentifier(
                'task_item',
                authoritativeTaskV2.activeStepId,
              ),
            }
          : {}),
      });
      updateLogContext(correlationFields(turnCorrelation));
    }
    const activePendingGrocery: PendingGrocery | undefined =
      activeProductChoiceContinuationV2?.pendingGrocery;
    const tappedProductChoiceIndex = productChoiceOfferId && activePendingGrocery
      ? activePendingGrocery.options.findIndex(
          (option) => option.offerId === productChoiceOfferId,
        )
      : -1;
    const tappedProductChoice = tappedProductChoiceIndex >= 0
      ? activePendingGrocery?.options[tappedProductChoiceIndex]
      : undefined;
    if (productChoiceOfferId && !tappedProductChoice) {
      logEvent('warn', 'product_choice.rejected', {
        durationMs: Math.round(performance.now() - requestStartedAt),
        offerId: productChoiceOfferId,
        reason: activePendingGrocery
          ? 'offer_not_pending'
          : 'pending_choice_missing',
      });
      return NextResponse.json({
        error: 'That product choice is no longer available. Please ask again.',
        requestId,
      }, { status: 409 });
    }

    let transcript: string;
    let transcriptionLanguageCode: string | undefined;
    if (tappedProductChoice) {
      transcript = `Option ${tappedProductChoiceIndex + 1}: ${
        tappedProductChoice.spokenLabel
          || tappedProductChoice.product
          || 'product'
      }`;
      transcriptionLanguageCode =
        activeProductChoiceContinuationV2?.languageCode
        ?? authoritativeTaskV2?.turnContext?.languageCode;
      logEvent('info', 'product_choice.selected', {
        offerId: tappedProductChoice.offerId,
        optionNumber: tappedProductChoiceIndex + 1,
        request: activePendingGrocery?.request,
        selectionSource: 'overlay_tap',
      });
    } else {
      if (!(audio instanceof File) || audio.size === 0) {
        logEvent('warn', 'request.rejected', {
          durationMs: Math.round(performance.now() - requestStartedAt),
          reason: 'audio_missing',
        });
        return NextResponse.json({
          error: 'A recorded voice command or product choice is required.',
          requestId,
        }, { status: 400 });
      }

      const transcription = await providers.speech.transcribe(audio);
      const transcribedText = transcription.transcript?.trim();
      if (!transcribedText) {
        logEvent('warn', 'request.rejected', {
          durationMs: Math.round(performance.now() - requestStartedAt),
          reason: 'transcript_empty',
        });
        return NextResponse.json({
          error: 'I could not hear a clear command. Please try again.',
          requestId,
        }, { status: 422 });
      }
      transcript = transcribedText;
      transcriptionLanguageCode = transcription.language_code ?? undefined;
      logEvent('info', 'voice.transcript', {
        languageCode: transcriptionLanguageCode,
        transcript,
      });
    }

    const retainedLanguageCode =
      activeProductChoiceContinuationV2?.languageCode
      ?? authoritativeTaskV2?.turnContext?.languageCode;
    const detectedLanguage =
      transcriptionLanguageCode || retainedLanguageCode || 'en-IN';
    const isShortFollowUp = transcript.trim().split(/\s+/).length <= 3;
    const responseLanguage = isShortFollowUp && retainedLanguageCode
      ? retainedLanguageCode
      : detectedLanguage;
    const persistNativeV2TurnContext = async (
      responseId: string | undefined,
    ): Promise<void> => {
      if (
        !authoritativeTaskV2
        || hasUnresolvedMutationV2(authoritativeTaskV2)
        || ['cancelled', 'completed'].includes(authoritativeTaskV2.status)
      ) {
        return;
      }
      const persisted = await persistPhoneTaskTurnContextV2({
        clientId,
        languageCode: responseLanguage,
        ...(responseId ? { responseId } : {}),
      });
      if (!persisted) return;
      authoritativeTaskRecordV2 = persisted;
      authoritativeTaskV2 = persisted.task;
    };
    const responseHistoryTurn = responseHistory.beginTurn({
      clientId,
      expectedResponses: 2,
      startOver:
        isStartOverRequest(transcript)
        || explicitlyStartsOver(transcript),
      turnId: requestId,
    });
    if (responseHistoryTurn.resetReason) {
      logEvent('info', 'model.response_chain_reset', {
        reason: responseHistoryTurn.resetReason,
        responseCount: responseHistoryTurn.responseCount,
        turnCount: responseHistoryTurn.turnCount,
      });
    }
    const retainedPreviousResponseId =
      responseHistoryTurn.resetReason
        ? undefined
        : activeProductChoiceContinuationV2?.responseId
          ?? responseHistoryTurn.previousResponseId;
    const retryStep = verifiedNotAppliedRetryStep(
      authoritativeTaskV2,
      transcript,
    );
    if (retryStep && authoritativeTaskV2) {
      const at = Math.max(Date.now(), authoritativeTaskV2.updatedAt);
      const next = transitionPhoneTaskV2(authoritativeTaskV2, {
        type: 'retry_step',
        stepId: retryStep.stepId,
        entryId:
          `explicit-retry:${requestId}:${authoritativeTaskV2.revision + 1}`,
        at,
      });
      authoritativeTaskRecordV2 = await taskRepository.commit({
        expectedRevision: authoritativeTaskV2.revision,
        task: next,
        event: {
          eventId:
            `explicit-retry:${requestId}:${next.revision}`,
          taskId: next.taskId,
          taskRevision: next.revision,
          at,
          kind: 'explicit_user_retry_authorized',
          dataRef: retryStep.stepId,
        },
      });
      authoritativeTaskV2 = authoritativeTaskRecordV2.task;
      logEvent('info', 'workflow.explicit_retry_authorized', {
        stepId: retryStep.stepId,
        taskId: authoritativeTaskV2.taskId,
        taskRevision: authoritativeTaskV2.revision,
      });
    }
    const activePendingCod =
      checkoutRecoveryV2
        ? pendingCodFromRecoveryV2(checkoutRecoveryV2)
        : undefined;
    const explicitRetryAction = retryStep
      ? sequentialProductActionV2(retryStep.input)
      : undefined;
    const activeQueuedProducts = explicitRetryAction
      ? [explicitRetryAction]
      : activeProductChoiceContinuationV2?.queuedProducts
        ?? unresolvedProductActionsV2(authoritativeTaskV2);
    const checkoutContinuationRequested = Boolean(
      !activePendingGrocery
      && activeQueuedProducts.length === 0
      && shouldForceCheckoutContinuationV2({
        explicitProductChange: isExplicitProductAddRequest(transcript),
        hasPendingCheckout: Boolean(activePendingCod),
        transcript,
      }),
    );
    const pendingChoiceResolution = tappedProductChoice
      ? { kind: 'selected' as const, option: tappedProductChoice }
      : activePendingGrocery
        ? resolvePendingProductChoice(transcript, activePendingGrocery.options)
        : undefined;
    if (
      pendingChoiceResolution?.kind === 'selected'
      && activeProductChoiceContinuationV2
      && authoritativeTaskV2
      && pendingChoiceResolution.option.offerId
    ) {
      const selectionId = newLocalIdentifier('selection');
      const resolution = await resolveProductSelectionInteractionV2({
        clientId,
        interactionId: activeProductChoiceContinuationV2.interactionId,
        offerId: pendingChoiceResolution.option.offerId,
        selectionId,
        source: tappedProductChoice ? 'tap' : 'voice',
        taskId: parseLocalIdentifier('task', authoritativeTaskV2.taskId),
        taskRevision: activeProductChoiceContinuationV2.taskRevision,
      }, {
        now: Date.now,
        repository: taskRepository,
      });
      if (resolution.acknowledgement === 'rejected') {
        logEvent('warn', 'product_choice.atomic_resolution_lost', {
          actualRevision: resolution.actualRevision,
          interactionId: activeProductChoiceContinuationV2.interactionId,
          reason: resolution.reason,
          winnerOfferId: resolution.winner?.offerId,
          winnerSelectionId: resolution.winner?.selectionId,
          winnerSource: resolution.winner?.source,
        });
        return NextResponse.json(correlatedResult({
          acknowledgement: 'rejected',
          mutationDisposition: 'none',
          ok: false,
          reason: resolution.reason,
          requestId,
          selectionId,
          taskId: authoritativeTaskV2.taskId,
          taskRevision: activeProductChoiceContinuationV2.taskRevision,
          transcript,
          version: 2,
          status:
            resolution.reason === 'already_resolved'
              ? 'conflict'
              : 'rejected',
          ...(resolution.actualRevision === undefined
            ? {}
            : { actualRevision: resolution.actualRevision }),
          ...(resolution.winner ? { winner: resolution.winner } : {}),
        }, turnCorrelation), { status: resolution.status });
      }

      let resolvedTask = resolution.record.task;
      let operationId: LocalIdentifier<'operation'> | undefined;
      let executionResult: unknown;
      if (resolution.acknowledgement === 'accepted') {
        const execution = await executeResolvedProductSelectionV2(
          resolution,
          {
            ...(enqueueBackgroundPhoneOperation
              ? { enqueue: enqueueBackgroundPhoneOperation }
              : {}),
            ...(dependencies.executePhone
              ? { execute: dependencies.executePhone }
              : {}),
            now: Date.now,
            repository: taskRepository,
          },
        );
        resolvedTask = execution.record.task;
        operationId = execution.operationId;
        executionResult = execution.result;
      }
      authoritativeTaskV2 = resolvedTask;
      const presentableResult: PresentableToolResult =
        executionResult
        && typeof executionResult === 'object'
        && !Array.isArray(executionResult)
          ? executionResult as PresentableToolResult
          : {
              message:
                `Selected ${pendingChoiceResolution.option.spokenLabel
                  || pendingChoiceResolution.option.product
                  || 'that product'} and started adding it.`,
              ok: true,
              status: 'operation_accepted',
            };
      const deterministic = presentationAdapter.createDeterministic({
        fallbackReply: 'Selected.',
        languageCode: responseLanguage,
        modelResponse: {},
        result: presentableResult,
        toolResults: [presentableResult],
        transcript,
      });
      let audioSynthesis: LocalizedProgressSpeechResult;
      try {
        audioSynthesis = localizedProgressSpeech.request({
          clientId,
          generation: requestId,
          languageCode: responseLanguage,
          text: deterministic.reply,
        });
      } catch {
        audioSynthesis = {
          metadata: {
            cacheStatus: 'miss',
            requestLatencyMs: 0,
          },
          status: 'unavailable',
          synthesisId: `unavailable:${requestId}`,
        };
      }
      const voice = audioSynthesis.status === 'ready'
        ? audioSynthesis.audio
        : {};
      const taskEvents = taskEventStreamV2.readAfter({
        afterSequence: -1,
        taskId: parseLocalIdentifier('task', resolvedTask.taskId),
      });
      turnCorrelation = extendCorrelationContext(turnCorrelation, {
        ...(operationId ? { operationId } : {}),
        selectionId,
        taskId: parseLocalIdentifier('task', resolvedTask.taskId),
      });
      logEvent('info', 'product_choice.atomic_resolution_complete', {
        acknowledgement: resolution.acknowledgement,
        interactionId: activeProductChoiceContinuationV2.interactionId,
        offerId: resolution.winner.offerId,
        selectionId: resolution.winner.selectionId,
        selectionSource: resolution.winner.source,
      });
      return NextResponse.json(correlatedResult({
        acknowledgement: resolution.acknowledgement,
        assistantState: deterministic.assistantState,
        audioSynthesis: {
          cacheStatus: audioSynthesis.metadata.cacheStatus,
          requestLatencyMs: audioSynthesis.metadata.requestLatencyMs,
          status: audioSynthesis.status,
          synthesisId: audioSynthesis.synthesisId,
          ...(audioSynthesis.status === 'pending'
            ? { pollAfterMs: 150 }
            : {}),
        },
        languageCode: responseLanguage,
        mutationDisposition:
          resolution.acknowledgement === 'accepted'
            ? 'enqueued_once'
            : 'none',
        ok: true,
        ...(operationId ? { operationId } : {}),
        presentation: deterministic.presentation,
        reply: deterministic.reply,
        requestId,
        selectionId,
        taskEvents,
        taskV2: {
          activeStepId: resolvedTask.activeStepId,
          desiredTerminalOutcome: resolvedTask.desiredTerminalOutcome,
          goalKind: resolvedTask.goalKind,
          originalGoal: resolvedTask.originalGoal,
          pendingInteraction: resolvedTask.pendingInteraction,
          revision: resolvedTask.revision,
          status: resolvedTask.status,
          steps: resolvedTask.steps.map((step) => ({
            adapterId: step.adapterId,
            kind: step.kind,
            status: step.status,
            stepId: step.stepId,
          })),
          taskId: resolvedTask.taskId,
          version: 2,
        },
        toolEvents: ['add_cart_item'],
        toolResults: [presentableResult],
        transcript,
        version: 2,
        winner: resolution.winner,
        status: resolution.acknowledgement,
        ...voice,
      }, turnCorrelation));
    }
    const startsWorkflowOver = explicitlyStartsOver(transcript);
    const cancelsProductWorkflow =
      isProductWorkflowCancellation(transcript)
      || (
        startsWorkflowOver
        && !isExplicitProductAddRequest(transcript)
      );
    const operationCancellation =
      cancelsProductWorkflow && authoritativeTaskRecordV2?.activeOperation
        ? {
            outcome:
              authoritativeTaskRecordV2.activeOperation.boundary
                === 'final_dispatch_attempted'
                ? 'not_cancellable' as const
                : authoritativeTaskRecordV2.activeOperation.boundary
                  === 'mutation_attempted'
                  ? 'reconcile_required' as const
                  : 'cancelled' as const,
          }
        : undefined;
    const cancellationRequiresCompletion =
      operationCancellation?.outcome === 'reconcile_required'
      || operationCancellation?.outcome === 'not_cancellable';
    let acceptsWorkflowCancellation =
      cancelsProductWorkflow && !cancellationRequiresCompletion;
    const settingsObservationFocus =
      explicitSettingsObservationFocus(transcript);
    const acknowledgesPendingAdd = Boolean(
      activePendingGrocery?.intent === 'add'
      && activePendingGrocery.selectedOption
      && acknowledgesCompletedProductAdd(transcript),
    );
    const explicitlyAddsPendingChoice = isExplicitProductAddRequest(transcript)
      || /\bcart\b/i.test(transcript);
    const selectedPendingOption = pendingChoiceResolution?.kind === 'selected'
      ? pendingChoiceResolution.option
      : explicitlyAddsPendingChoice || acknowledgesPendingAdd
        ? activePendingGrocery?.selectedOption
        : undefined;
    const selectedSearchChoiceNeedsAddConfirmation = Boolean(
      activePendingGrocery?.intent === 'search'
        && pendingChoiceResolution?.kind === 'selected'
        && !explicitlyAddsPendingChoice,
    );
    let explicitlyAuthorizedPendingAdd =
      activePendingGrocery
      && (
        activePendingGrocery.intent === 'add'
        || explicitlyAddsPendingChoice
      )
        ? addActionForSelectedPendingOption(
            activePendingGrocery,
            selectedPendingOption,
            acknowledgesPendingAdd,
          )
        : undefined;
    let forcedProductAction: SequentialProductAction | undefined =
      explicitlyAuthorizedPendingAdd
        ? explicitlyAuthorizedPendingAdd
        : activePendingGrocery
          && pendingChoiceResolution?.kind === 'retry'
          ? activePendingGrocery.intent === 'add'
            ? {
                action: 'add_cart_item',
                ...(activePendingGrocery.selectedOption?.offerId
                  ? { offerId: activePendingGrocery.selectedOption.offerId }
                  : {}),
                quantity: activePendingGrocery.quantity,
                request:
                  activePendingGrocery.selectedOption?.product
                  || activePendingGrocery.selectedOption?.spokenLabel
                  || activePendingGrocery.request,
                ...(activePendingGrocery.selectedOption?.offerId
                  ? { searchQuery: activePendingGrocery.request }
                  : {}),
                ...(selectedOfferFor(activePendingGrocery.selectedOption ?? {})
                  ? {
                      selectedOffer: selectedOfferFor(
                        activePendingGrocery.selectedOption ?? {},
                      ),
                    }
                  : {}),
              }
            : {
                action: 'search_products',
                request: activePendingGrocery.request,
              }
          : undefined;
    const skipsPendingProduct = pendingChoiceResolution?.kind === 'skip';

    const detectedLanguageRequirement = transcriptionLanguageCode
      ? languageRequirements[transcriptionLanguageCode]
      : undefined;
    const currentLanguageInstruction = transcriptionLanguageCode === 'en-IN'
      ? 'For this turn, the detected language is English. Reply only in English.'
      : detectedLanguageRequirement
        ? `For this turn, reply only in ${detectedLanguageRequirement}`
        : 'Follow the user’s detected Indian language or code-mixed speaking style for this turn.';
    const instructions = [
      'You are JaldiAI, a concise voice-first assistant operating the owner’s Android phone.',
      'The user may speak an Indian language, English, or a code-mixed combination.',
      'Always reply in the same spoken language, script style, and code-mix as the user.',
      'If the transcript is entirely English, reply only in English.',
      'Use Hinglish only when the user mixes Hindi and English.',
      'For Hinglish input, reply in natural Hinglish rather than formal Hindi or English.',
      'Keep the spoken response under three short sentences.',
      'For find, search, show, browse, availability, option, or price requests, call search_products. It never changes the cart.',
      'For explicit add, buy, or get requests, call add_cart_item.',
      'For questions about the current cart or subtotal, call inspect_cart.',
      'For quantity changes or removal, use only an exact productId returned by a prior inspect_cart result.',
      'If the exact cart product is not known, call inspect_cart first and ask the user to identify the item; do not guess.',
      'When the user gives a product list, emit one product tool call per item in the same spoken order.',
      'The execution layer will search and resolve those product calls sequentially; never combine their clarification questions.',
      'Never change the cart for a read-only search request.',
      'Never call only open_blinkit when the user also names or requests a grocery item.',
      'Pass only the product phrase to product tools. Keep requested item count in the quantity field.',
      'Use quantity 1 when the user does not specify a quantity.',
      'Do not invent or silently choose a brand, flavor, pack, or size.',
      'When structured pending grocery options are provided, treat the new speech as the answer to that prior question.',
      'Resolve a matching follow-up only against the stored visible options.',
      'When a pending option is selected for addition, pass its exact opaque offerId to add_cart_item. Never invent an offerId.',
      'If the user says the pending product is already visibly added, do not add it again. The execution layer will reconcile the cart read-only.',
      'If multiple pending options remain and the user only says add to cart, ask which option; never choose one yourself.',
      'If the user cancels, says never mind, or starts an unrelated explicit product request, do not force the old pending choice.',
      'Use open_blinkit only for a bare request to open the app.',
      'Use prepare_checkout to review an existing cart for Cash on Delivery; it never places the order.',
      'After a COD review, read the total and saved address label and require the user to say the exact phrase “Confirm COD order”.',
      'Use confirm_checkout only when that exact phrase is present in the user’s current speech.',
      'Never treat yes, okay, go ahead, or add to cart as final purchase authorization.',
      'When a tool returns needs_clarification, say one short spoken question and mention the exact visible product or size options.',
      'When a tool returns confirmation_required, clearly speak the total, saved address label, and required confirmation phrase.',
      'When a tool returns not_found, ask the user to repeat or use another product name.',
      'Never imply an item was added when a tool asks for clarification.',
      'When a tool confirms added or already_in_cart, speak that exact result.',
      'Opening an app and read-only checks are safe.',
      'Never claim an order was placed unless a tool returns a verified provider reference.',
      'Before any purchase, say that explicit review is required.',
      currentLanguageInstruction,
    ].join(' ');

    const modelInput = activePendingGrocery
      ? [
          'The user is answering a pending grocery clarification.',
          `Original request: ${activePendingGrocery.request}`,
          `Original intent: ${activePendingGrocery.intent}`,
          `Requested quantity: ${activePendingGrocery.quantity}`,
          `Visible options: ${JSON.stringify(activePendingGrocery.options)}`,
          ...(activePendingGrocery.selectedOption
            ? [`Previously selected option: ${JSON.stringify(activePendingGrocery.selectedOption)}`]
            : []),
          `Products waiting after this one: ${JSON.stringify(activeQueuedProducts.map((item) => item.request))}`,
          `New spoken answer: ${transcript}`,
          ...(pendingChoiceResolution?.kind === 'selected'
            ? [
                `Deterministic option match: ${JSON.stringify(pendingChoiceResolution.option)}`,
                'Do not reinterpret or replace this deterministic option match.',
              ]
            : []),
          ...(skipsPendingProduct
            ? ['The user explicitly skipped the current product. Do not select it.']
            : []),
          'Use only these visible options when the answer refers to the pending request.',
          'If the original intent was add and the answer identifies one option, call add_cart_item with its exact offerId and the requested quantity.',
          'If the original intent was search, call add_cart_item only when the new answer explicitly asks to add, buy, or get an option.',
          'When the user gives a new quantity, use it instead of the earlier quantity.',
          'If the user only selects a searched option without asking to add it, briefly ask whether they want it added and do not call a tool.',
          'If the user cancels, do not call a tool.',
          'If the user gives an unrelated explicit product request, handle it as a new search or add request.',
          'If the answer does not uniquely identify one, ask a short follow-up and do not add anything.',
        ].join('\n')
      : activePendingCod
        ? [
            'A reviewed COD checkout is pending explicit confirmation.',
            `Reviewed terms: ${JSON.stringify(activePendingCod)}`,
            `New spoken answer: ${transcript}`,
            'Only call confirm_checkout if the new spoken answer contains the exact phrase “Confirm COD order”.',
            'Otherwise remind the user of that phrase and do not perform the final action.',
          ].join('\n')
        : activeQueuedProducts.length > 0
          ? [
              'A sequential product list is paused on its next unresolved item.',
              `Next queued product action: ${JSON.stringify(activeQueuedProducts[0])}`,
              `Products after it: ${JSON.stringify(activeQueuedProducts.slice(1).map((item) => item.request))}`,
              `New spoken answer: ${transcript}`,
              'If the user asks to retry or continue, call the exact queued product tool again.',
              'If the user cancels the list, do not call a tool.',
              'If the user starts an unrelated product request, handle it as a new workflow and replace the old queue.',
            ].join('\n')
      : transcript;

    const authoritativePendingSelectionTurn = Boolean(
      activePendingGrocery
      && !startsWorkflowOver
    );
    const projectedTaskV2 = authoritativeTaskV2;
    const taskHasUnresolvedMutationV2 = Boolean(
      projectedTaskV2 && hasUnresolvedMutationV2(projectedTaskV2),
    );
    if (taskHasUnresolvedMutationV2) {
      acceptsWorkflowCancellation = false;
    }
    const unresolvedTaskOperationIdV2 =
      authoritativeTaskRecordV2?.activeOperation?.operationId
      ?? projectedTaskV2?.steps.find((step) =>
        ['running', 'ambiguous', 'blocked'].includes(step.status)
        && Boolean(step.operationId))?.operationId
      ?? projectedTaskV2?.verifiedFacts.find((fact) =>
        fact.confidence === 'reconciliation_required')?.originOperationId;
    const unresolvedMutationV2 =
      projectedTaskV2
      && taskHasUnresolvedMutationV2
        ? {
            operationId:
              unresolvedTaskOperationIdV2
              ?? `task:${projectedTaskV2.taskId}:reconciliation`,
            outcome: 'ambiguous' as const,
          }
        : undefined;
    const recoveryHandoffRequiredV2 = Boolean(
      projectedTaskV2
      && (
        authoritativeTaskRecordV2?.activeOperation
        && !unresolvedMutationV2
      ),
    );
    const plannerContextV2 = projectedTaskV2
      ? assemblePlannerContextV2({
          task: projectedTaskV2,
          capabilities: Object.values(capabilityCatalogV2).map(
            (capability) => ({
              capabilityId: capability.capability,
              description: [
                `Effect: ${capability.effect}.`,
                `Idempotency: ${capability.idempotency}.`,
                capability.requiresConfirmation
                  ? 'Fresh confirmation required.'
                  : 'No confirmation required at this layer.',
              ].join(' '),
            }),
          ),
          recentDialogue: [{
            role: 'user',
            text: transcript,
            at: Date.now(),
          }],
        })
      : undefined;
    let v2PlannerResult: LlmPlannerTurnResultV2 | undefined;
    let v2TaskTurnDisposition: TaskTurnDispositionV2 | undefined;
    v2PlannerResult = await new OpenAILlmPlannerV2(
      providers.responses,
    ).plan({
        clientId,
        ...(plannerContextV2 ? { context: plannerContextV2 } : {}),
        explicitExactConfirmation: isExplicitCodConfirmation(transcript),
        languageCode: responseLanguage,
        model: runtimePolicy.boundedControlModel,
        ...(projectedTaskV2?.pendingInteraction
          ? { pendingInteraction: projectedTaskV2.pendingInteraction }
          : {}),
        recoveryHandoffRequired: recoveryHandoffRequiredV2,
        requestId,
        ...(projectedTaskV2 ? { taskId: projectedTaskV2.taskId } : {}),
        taskRevision: projectedTaskV2?.revision ?? 0,
        taskStatus: projectedTaskV2?.status ?? 'active',
        transcript,
        ...(unresolvedMutationV2
          ? { unresolvedMutation: unresolvedMutationV2 }
          : {}),
    });
    initialAcknowledgementStartedAt = timingNow();
    const structuredModelChoice = activePendingGrocery
      ? v2PlannerResult.policyResults
          .filter(({ decision }) => decision.decision === 'allow')
          .find(({ action }) => action.capability === 'select_product')
      : undefined;
    const structuredModelOfferId =
      typeof structuredModelChoice?.action.arguments['offerId'] === 'string'
        ? structuredModelChoice.action.arguments['offerId']
        : undefined;
    const structuredModelOption = structuredModelOfferId
      ? activePendingGrocery?.options.find(
          ({ offerId }) => offerId === structuredModelOfferId,
        )
      : undefined;
    if (
      !forcedProductAction
      && activePendingGrocery?.intent === 'add'
      && structuredModelOption
    ) {
      const modelBoundAction = addActionForSelectedPendingOption(
        activePendingGrocery,
        structuredModelOption,
      );
      if (modelBoundAction) {
        explicitlyAuthorizedPendingAdd = modelBoundAction;
        forcedProductAction = modelBoundAction;
        logEvent('info', 'product_choice.model_bound', {
          offerId: structuredModelOfferId,
          request: activePendingGrocery.request,
          source: 'structured_select_product_action',
        });
      }
    }
    if (
      !forcedProductAction
      && activePendingGrocery?.intent === 'add'
      && [
        'clarification_answer',
        'confirm_order',
        'product_choice',
      ].includes(v2PlannerResult.decision.intent)
    ) {
      const modelChoice = resolvePendingProductChoice(
        v2PlannerResult.decision.assistantMessage,
        activePendingGrocery.options,
      );
      if (modelChoice.kind === 'selected') {
        const modelBoundAction = addActionForSelectedPendingOption(
          activePendingGrocery,
          modelChoice.option,
        );
        if (modelBoundAction) {
          explicitlyAuthorizedPendingAdd = modelBoundAction;
          forcedProductAction = modelBoundAction;
          logEvent('info', 'product_choice.model_bound', {
            offerId: modelChoice.option.offerId,
            request: activePendingGrocery.request,
            source: 'structured_planner_assistant_message',
          });
        }
      }
    }
    if (authoritativeTaskV2) {
        const plannerResponseRef =
          `planner-response:${v2PlannerResult.response.id ?? requestId}`;
        if (startsWorkflowOver) {
          v2TaskTurnDisposition = classifyIncomingTaskTurnV2(
            authoritativeTaskV2,
            { kind: 'start_over' },
          );
        } else if (
          authoritativeTaskV2.pendingInteraction
          && [
            'clarification_answer',
            'confirm_order',
            'product_choice',
          ].includes(v2PlannerResult.decision.intent)
        ) {
          v2TaskTurnDisposition = classifyIncomingTaskTurnV2(
            authoritativeTaskV2,
            {
              kind: 'clarification_answer',
              interactionId:
                authoritativeTaskV2.pendingInteraction.interactionId,
              taskRevision:
                authoritativeTaskV2.pendingInteraction.taskRevision,
              responseRef: plannerResponseRef,
            },
          );
        } else if (v2PlannerResult.decision.planPatches.length > 0) {
          const patchDispositions =
            v2PlannerResult.decision.planPatches.map((patch, index) => (
              patch.type === 'replace_product'
              || patch.type === 'skip_step'
                ? classifyIncomingTaskTurnV2(authoritativeTaskV2!, {
                    kind: 'correction',
                    targetStepId: patch.stepId,
                    correctionRef:
                      `planner-patch:${requestId}:${index}`,
                  })
                : classifyIncomingTaskTurnV2(authoritativeTaskV2!, {
                    kind: 'addition',
                    additionRef: `planner-patch:${requestId}:${index}`,
                  })
            ));
          v2TaskTurnDisposition = patchDispositions.find(
            (disposition) => disposition.action === 'reject',
          ) ?? patchDispositions[0];
        } else if (
          v2PlannerResult.decision.explicitProductChange
          && v2PlannerResult.decision.decision === 'propose_actions'
        ) {
          v2TaskTurnDisposition = classifyIncomingTaskTurnV2(
            authoritativeTaskV2,
            {
              kind: 'unrelated_task',
              replacementGoalRef: plannerResponseRef,
            },
          );
        }

        const canResolveV2Interaction =
          authoritativeTaskV2.pendingInteraction?.kind !== 'product_choice'
          || Boolean(forcedProductAction);
        if (
          v2TaskTurnDisposition?.action === 'resolve_interaction'
          && canResolveV2Interaction
        ) {
          authoritativeTaskRecordV2 =
            await resolveV2InteractionForCompatibility({
              repository: taskRepository,
              ...(explicitlyAuthorizedPendingAdd
                ? { resolvedStepInput: explicitlyAuthorizedPendingAdd }
                : {}),
              responseRef: v2TaskTurnDisposition.responseRef,
              task: authoritativeTaskV2,
            });
          authoritativeTaskV2 = authoritativeTaskRecordV2.task;
          logEvent('info', 'workflow.v2.interaction_resolved', {
            interactionId: v2TaskTurnDisposition.interactionId,
            revision: authoritativeTaskV2.revision,
            taskId: authoritativeTaskV2.taskId,
          });
        } else if (v2TaskTurnDisposition?.action === 'resolve_interaction') {
          logEvent('warn', 'workflow.v2.interaction_resolution_deferred', {
            interactionId: v2TaskTurnDisposition.interactionId,
            reason: 'product_choice_not_bound_to_visible_offer',
            taskId: authoritativeTaskV2.taskId,
          });
        } else if (v2TaskTurnDisposition?.action === 'cancel_task') {
          const at = Math.max(Date.now(), authoritativeTaskV2.updatedAt);
          const next = transitionPhoneTaskV2(authoritativeTaskV2, {
            type: 'cancel_task',
            entryId:
              `start-over:${requestId}:${authoritativeTaskV2.revision + 1}`,
            at,
          });
          authoritativeTaskRecordV2 = await taskRepository.commit({
            expectedRevision: authoritativeTaskV2.revision,
            task: next,
            event: {
              eventId: `start-over:${requestId}:${next.revision}`,
              taskId: next.taskId,
              taskRevision: next.revision,
              at,
              kind: 'start_over',
            },
          });
          authoritativeTaskV2 = authoritativeTaskRecordV2.task;
          logEvent('info', 'workflow.v2.cancelled', {
            reason: 'start_over',
            revision: authoritativeTaskV2.revision,
            taskId: authoritativeTaskV2.taskId,
          });
        } else if (v2TaskTurnDisposition?.action === 'reject') {
          logEvent('warn', 'workflow.v2.turn_rejected', {
            reason: v2TaskTurnDisposition.reason,
            taskId: authoritativeTaskV2.taskId,
            turnIntent: v2PlannerResult.decision.intent,
          });
        }
    }
    if (
      v2PlannerResult.decision.planPatches.length > 0
      && authoritativeTaskV2
      && v2TaskTurnDisposition?.action === 'patch_existing'
      && !recoveryHandoffRequiredV2
      && !authoritativeTaskV2.pendingInteraction
    ) {
      authoritativeTaskRecordV2 = await applyLlmPlanPatchesV2({
        proposals: v2PlannerResult.decision.planPatches,
        repository: taskRepository,
        task: authoritativeTaskV2,
      });
      authoritativeTaskV2 = authoritativeTaskRecordV2.task;
      logEvent('info', 'planner.v2.patch_applied', {
        patchCount: v2PlannerResult.decision.planPatches.length,
        revision: authoritativeTaskV2.revision,
        taskId: authoritativeTaskV2.taskId,
      });
    }
    let aiResponse = v2PlannerResult.translatedResponse;
    logEvent('info', 'realtime.control_decision', {
      configuredStage: 'phone_task_v2',
      effectiveStage: 'phone_task_v2',
      pipeline: 'llm_planner_v2',
      speechProvider: 'sarvam',
    });

    const returnedToolCalls = aiResponse.output?.filter(
      (item) => item.type === 'function_call',
    ) ?? [];
    const checkoutContinuationModelCallId = checkoutContinuationRequested
      ? (
          returnedToolCalls.length === 1
            ? returnedToolCalls[0]?.call_id
            : returnedToolCalls.find((call) =>
                call.name === 'prepare_checkout')?.call_id
        )
      : undefined;
    if (authoritativePendingSelectionTurn && returnedToolCalls.length > 0) {
      logEvent('warn', 'model.pending_tool_calls_ignored', {
        reason: 'authoritative_pending_selection_owned_locally',
        toolCallCount: returnedToolCalls.length,
        toolNames: returnedToolCalls.map((call) => call.name),
      });
    }
    let toolCalls = authoritativePendingSelectionTurn
      ? []
      : returnedToolCalls;
    if (activePendingCod && isExplicitCodConfirmation(transcript)) {
      logEvent('info', 'workflow.checkout_confirmation_rerouted', {
        ignoredModelToolCount: toolCalls.length,
        ignoredModelToolNames: toolCalls.map((call) => call.name),
        reason: 'durable_checkout_authority_owned_locally',
      });
      toolCalls = [{
        arguments: '{}',
        call_id: `call_local_confirm_${requestId}`,
        name: 'confirm_checkout',
        type: 'function_call',
      }];
    }
    logEvent('info', 'model.response', {
      responseId: aiResponse.id,
      toolCallCount: toolCalls.length,
      toolCalls: toolCalls.map((call) => ({
        callId: call.call_id,
        toolArguments: toolArgumentsForLog(call.arguments),
        toolName: call.name,
      })),
    });
    if (checkoutContinuationRequested) {
      logEvent('info', 'workflow.checkout_intent_rerouted', {
        ignoredModelToolCount: toolCalls.length,
        ignoredModelToolNames: toolCalls.map((call) => call.name),
        reason: 'checkout_continuation_owned_locally',
      });
      toolCalls = [{
        arguments: '{}',
        call_id: `call_local_checkout_${requestId}`,
        name: 'prepare_checkout',
        type: 'function_call',
      }];
    }
    const toolEvents: string[] = [];
    const toolResults: unknown[] = [];
    const executedActions: Array<PhoneActionArguments | undefined> = [];
    let operationAcceptedV2: OperationAcceptedV2 | undefined;
    let generalMobileObservation:
      | CoordinatorGeneralMobileObservationV2
      | undefined;
    if (settingsObservationFocus !== undefined) {
      const operationId = newLocalIdentifier('operation');
      try {
        const observation = await (
          dependencies.generalMobile
          ?? authoritativeGeneralMobileProductionServiceV2()
        ).observe({
          adapterId: androidSettingsReadOnlyAdapterIdV2,
          clientId,
          ...(settingsObservationFocus
            ? { focus: settingsObservationFocus }
            : {}),
          isCancelled: () => acceptsWorkflowCancellation,
          operationId,
          packageName: androidSettingsPackageV2,
        });
        generalMobileObservation = { ...observation, operationId };
      } catch (error) {
        logEvent('warn', 'general_mobile.settings_observation_unavailable', {
          ...errorDetails(error),
          adapterId: androidSettingsReadOnlyAdapterIdV2,
          operationId,
        });
        generalMobileObservation = {
          explanation:
            'Settings screen help is unavailable right now. No phone setting was changed.',
          operationId,
          status: 'unavailable',
        };
      }
      toolEvents.push('observe_settings');
      executedActions.push(undefined);
      toolResults.push({
        ...generalMobileObservation,
        message: generalMobileObservation.explanation,
        ok: generalMobileObservation.status === 'ready',
      });
    }
    let queuedProducts = [...activeQueuedProducts];
    let toolOutputs: Array<{
      type: 'function_call_output';
      call_id: string;
      output: string;
    }> = [];

    if (
      (
        toolCalls.length > 0
        || forcedProductAction
        || selectedSearchChoiceNeedsAddConfirmation
        || skipsPendingProduct
        || (
          acceptsWorkflowCancellation
          && (
            activePendingGrocery
            || activeQueuedProducts.length > 0
            || activePendingCod
            || authoritativeTaskV2
          )
        )
        || (
          authoritativeTaskV2
          && continuesProductWorkflow(transcript)
        )
      )
      && aiResponse.id
    ) {
      const parsedCalls: Array<{
        action: PhoneActionArguments;
        call: OpenAIOutputItem & { call_id: string; name: string };
      }> = [];
      const outputByCallId = new Map<string, unknown>();

      for (const call of toolCalls) {
        if (!call.call_id || !call.name) continue;

        try {
          parsedCalls.push({
            action: phoneActionForCall(
              call.name,
              call.arguments,
              activePendingGrocery,
              activePendingCod,
            ),
            call: call as OpenAIOutputItem & { call_id: string; name: string },
          });
        } catch (error) {
          const message = error instanceof PhoneCommandValidationError
            ? error.message
            : 'The requested phone command was invalid.';
          const result = {
            ok: false,
            status: 'invalid_command',
            message,
          };
          toolEvents.push(call.name);
          executedActions.push(undefined);
          toolResults.push(result);
          outputByCallId.set(call.call_id, result);
          logEvent('warn', 'tool.rejected', {
            callId: call.call_id,
            toolArguments: toolArgumentsForLog(call.arguments),
            toolName: call.name,
            ...result,
          });
        }
      }

      const modelProductCalls = parsedCalls.filter(({ action }) =>
        isSequentialProductAction(action));
      let nonProductCalls = parsedCalls.filter(({ action }) =>
        !isSequentialProductAction(action));
      let productCalls = [...modelProductCalls];
      const standaloneProductActions: SequentialProductAction[] = [];
      let productGoalCompletedThisTurn = false;

      if (
        !activePendingGrocery
        && isExplicitProductAddRequest(transcript)
      ) {
        const normalizedSearchCount = productCalls.filter(
          ({ action }) => action.action === 'search_products',
        ).length;
        productCalls = productCalls.map((entry) => ({
          ...entry,
          action: entry.action.action === 'search_products'
            ? {
                action: 'add_cart_item',
                quantity: 1,
                request: entry.action.request,
                searchQuery: entry.action.searchQuery,
              }
            : entry.action,
        }));
        if (normalizedSearchCount > 0) {
          logEvent('info', 'workflow.product_intent_normalized', {
            from: 'search_products',
            normalizedCount: normalizedSearchCount,
            to: 'add_cart_item',
          });
        }
      }

      if (
        activePendingCod
        && !isExplicitProductAddRequest(transcript)
        && productCalls.length > 0
      ) {
        const result = {
          checkout: activePendingCod,
          confirmationPhrase: 'Confirm COD order',
          ok: false,
          status: 'confirmation_required',
          message:
            'The reviewed checkout is still not ordered. Say “Confirm COD order” to authorize only these reviewed terms.',
        };
        toolEvents.push('checkout_confirmation_guard');
        executedActions.push(undefined);
        toolResults.push(result);
        for (const entry of productCalls) {
          outputByCallId.set(entry.call.call_id, {
            ...result,
            status: 'ignored_historical_product_call',
          });
        }
        logEvent('warn', 'workflow.historical_product_calls_suppressed', {
          ignoredProductCallCount: productCalls.length,
          reason: 'checkout_confirmation_pending',
        });
        productCalls = [];
      }

      if (acceptsWorkflowCancellation) {
        queuedProducts = [];
        if (
          authoritativeTaskV2
          && !['cancelled', 'completed'].includes(authoritativeTaskV2.status)
        ) {
          const at = Math.max(Date.now(), authoritativeTaskV2.updatedAt);
          const cancelled = transitionPhoneTaskV2(authoritativeTaskV2, {
            type: 'cancel_task',
            entryId:
              `cancel:${requestId}:${authoritativeTaskV2.revision + 1}`,
            at,
          });
          authoritativeTaskRecordV2 = await taskRepository.commit({
            expectedRevision: authoritativeTaskV2.revision,
            task: cancelled,
            event: {
              eventId: `cancel:${requestId}:${cancelled.revision}`,
              taskId: cancelled.taskId,
              taskRevision: cancelled.revision,
              at,
              kind: startsWorkflowOver ? 'start_over' : 'cancel',
            },
          });
          authoritativeTaskV2 = authoritativeTaskRecordV2.task;
        }
        for (const entry of parsedCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'ignored',
            message: 'The user cancelled the active workflow.',
          });
        }
        productCalls = [];
        nonProductCalls = [];
      } else if (
        selectedSearchChoiceNeedsAddConfirmation
        && activePendingGrocery
        && pendingChoiceResolution?.kind === 'selected'
      ) {
        const selected = pendingChoiceResolution.option;
        toolEvents.push('select_product');
        executedActions.push(undefined);
        toolResults.push({
          ok: true,
          status: 'add_confirmation_required',
          product: selected.product,
          size: selected.size,
          spokenLabel: selected.spokenLabel,
          message: `You selected ${selected.spokenLabel || selected.product || 'that product'}. Say “add it” to change the cart.`,
        });
        logEvent('info', 'tool.deterministic', {
          resultStatus: 'add_confirmation_required',
          selectedOption: selected,
          toolName: 'select_product',
        });
        for (const entry of modelProductCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'add_confirmation_required',
            message: 'An explicit add request is required before changing the cart.',
          });
        }
        for (const entry of nonProductCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'ignored',
            message: 'The pending product selection requires an explicit add request.',
          });
        }
        productCalls = [];
        nonProductCalls = [];
      } else if (skipsPendingProduct && activePendingGrocery) {
        toolEvents.push('skip_product');
        executedActions.push(undefined);
        toolResults.push({
          ok: true,
          status: 'product_skipped',
          request: activePendingGrocery.request,
          message: activeQueuedProducts.length > 0
            ? `Skipped ${activePendingGrocery.request}.`
            : `Skipped ${activePendingGrocery.request}. The product list is complete.`,
        });
        logEvent('info', 'tool.deterministic', {
          request: activePendingGrocery.request,
          resultStatus: 'product_skipped',
          toolName: 'skip_product',
        });
        if (
          authoritativeTaskV2
          && authoritativeTaskV2.activeStepId
          && !['cancelled', 'completed'].includes(authoritativeTaskV2.status)
        ) {
          const at = Math.max(Date.now(), authoritativeTaskV2.updatedAt);
          const skipped = transitionPhoneTaskV2(authoritativeTaskV2, {
            type: 'skip_step',
            stepId: authoritativeTaskV2.activeStepId,
            entryId:
              `skip:${requestId}:${authoritativeTaskV2.revision + 1}`,
            at,
          });
          authoritativeTaskRecordV2 = await taskRepository.commit({
            expectedRevision: authoritativeTaskV2.revision,
            task: skipped,
            event: {
              eventId: `skip:${requestId}:${skipped.revision}`,
              taskId: skipped.taskId,
              taskRevision: skipped.revision,
              at,
              kind: 'step_skipped',
            },
          });
          authoritativeTaskV2 = authoritativeTaskRecordV2.task;
        }
        queuedProducts = [];
        for (const entry of modelProductCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'ignored',
            message: 'The current product was skipped deterministically.',
          });
        }
        for (const entry of nonProductCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'ignored',
            message: 'The current product was skipped deterministically.',
          });
        }
        productCalls = [];
        nonProductCalls = [];
      } else if (forcedProductAction) {
        if (modelProductCalls[0]) {
          productCalls = [{
            ...modelProductCalls[0],
            action: forcedProductAction,
          }];
          for (const entry of modelProductCalls.slice(1)) {
            outputByCallId.set(entry.call.call_id, {
              ok: true,
              status: 'ignored',
              message: 'The pending product choice was resolved deterministically.',
            });
          }
        } else {
          standaloneProductActions.push(forcedProductAction);
        }
        for (const entry of nonProductCalls) {
          outputByCallId.set(entry.call.call_id, {
            ok: true,
            status: 'ignored',
            message: 'The pending product response was handled deterministically.',
          });
        }
        nonProductCalls = [];
      }

      const resolvesPendingProduct = !activePendingGrocery
        || Boolean(forcedProductAction)
        || skipsPendingProduct
        || productCalls.some(({ action }) =>
          action.action === 'add_cart_item'
          && Boolean(action.offerId)
          && activePendingGrocery.options.some((option) => option.offerId === action.offerId));
      const queuedHead = activeQueuedProducts[0];
      let firstIncomingProduct = productCalls[0]?.action as
        | SequentialProductAction
        | undefined;
      const replacesAuthoritativeTask = Boolean(
        authoritativeTaskV2
        && productCalls.length > 0
        && v2TaskTurnDisposition?.action === 'replace_task'
        && (
          activePendingGrocery
            ? !resolvesPendingProduct
            : queuedHead
              && !isSameProductAction(firstIncomingProduct, queuedHead)
              && !continuesProductWorkflow(transcript)
        ),
      );
      if (replacesAuthoritativeTask) {
        queuedProducts = [];
      } else if (
        authoritativeTaskV2
        && !activePendingGrocery
        && queuedHead
      ) {
        if (isSameProductAction(firstIncomingProduct, queuedHead)) {
          const acceptedCall = productCalls[0]!;
          for (const ignoredCall of productCalls.slice(1)) {
            outputByCallId.set(ignoredCall.call.call_id, {
              ok: true,
              status: 'ignored',
              message: 'The authoritative task owns the remaining product order.',
            });
          }
          productCalls = [{
            ...acceptedCall,
            action: queuedHead,
          }];
          firstIncomingProduct = queuedHead;
        } else if (continuesProductWorkflow(transcript)) {
          standaloneProductActions.push(...activeQueuedProducts);
          for (const ignoredCall of productCalls) {
            outputByCallId.set(ignoredCall.call.call_id, {
              ok: true,
              status: 'ignored',
              message: 'The authoritative task resumed its active product.',
            });
          }
          productCalls = [];
          firstIncomingProduct = undefined;
        }
      }
      const resumesPausedQueue = Boolean(
        firstIncomingProduct
          && queuedHead
          && firstIncomingProduct.action === queuedHead.action
          && firstIncomingProduct.request === queuedHead.request,
      );
      const inheritedQueue = activePendingGrocery
        ? resolvesPendingProduct ? activeQueuedProducts : []
        : resumesPausedQueue ? activeQueuedProducts.slice(1) : [];
      const sequentialActions = skipsPendingProduct
        ? [...activeQueuedProducts]
        : [
            ...standaloneProductActions,
            ...productCalls.map(({ action }) => action as SequentialProductAction),
            ...inheritedQueue,
          ];

      if (sequentialActions.length > 0) {
        if (
          !authoritativeTaskV2
          || ['cancelled', 'completed'].includes(authoritativeTaskV2.status)
          || replacesAuthoritativeTask
        ) {
          const previousTask = authoritativeTaskV2;
          const nextTask = createProductTaskV2({
            actions: sequentialActions,
            clientId,
            desiredTerminalOutcome: {
              kind: v2PlannerResult.decision.goal.terminalOutcome,
              ...(v2PlannerResult.decision.goal.paymentPreference
                ? {
                    paymentPreference:
                      v2PlannerResult.decision.goal.paymentPreference,
                  }
                : {}),
            },
            originalGoal: transcript,
          });
          const createdEvent = {
            eventId: `task-created:${requestId}:${nextTask.taskId}`,
            taskId: nextTask.taskId,
            taskRevision: nextTask.revision,
            at: nextTask.createdAt,
            kind: 'task_created',
          };
          if (
            previousTask
            && !['cancelled', 'completed'].includes(previousTask.status)
          ) {
            const at = Math.max(Date.now(), previousTask.updatedAt);
            const replacement = await taskRepository.replaceForClient({
              currentTaskId: previousTask.taskId,
              expectedRevision: previousTask.revision,
              nextTask,
              reason: startsWorkflowOver ? 'start_over' : 'unrelated_task',
              replacedEvent: {
                eventId: `task-replaced:${requestId}:${previousTask.taskId}`,
                taskId: previousTask.taskId,
                taskRevision: previousTask.revision + 1,
                at,
                kind: 'task_replaced',
              },
              createdEvent,
            });
            authoritativeTaskRecordV2 = replacement.created;
            logEvent('info', 'workflow.authoritative_replaced', {
              previousTaskId: previousTask.taskId,
              reason: 'unrelated_explicit_product_request',
            });
          } else {
            authoritativeTaskRecordV2 =
              await taskRepository.create({
                task: nextTask,
                event: createdEvent,
              });
          }
          authoritativeTaskV2 = authoritativeTaskRecordV2.task;
        }
        turnCorrelation = extendCorrelationContext(turnCorrelation, {
          taskId: parseLocalIdentifier('task', authoritativeTaskV2.taskId),
          ...(authoritativeTaskV2.activeStepId?.startsWith('task_item_')
            ? {
                itemId: parseLocalIdentifier(
                  'task_item',
                  authoritativeTaskV2.activeStepId,
                ),
              }
            : {}),
        });
        updateLogContext(correlationFields(turnCorrelation));
        const sequence = await executeSequentialProductQueue(
          sequentialActions,
          async (action) => {
            const incomingProductCall = productCalls.find(
              (entry) => entry.action === action,
            );
            const v2ReadyStep = authoritativeTaskV2?.steps.find(
              (step) => step.status === 'ready',
            );
            const v2StepId =
              v2ReadyStep?.stepId
              ?? authoritativeTaskV2?.activeStepId;
            const v2StepIndex = authoritativeTaskV2?.steps.findIndex(
              (step) => step.stepId === v2StepId,
            ) ?? -1;
            const v2OperationId =
              authoritativeTaskV2
              && v2StepId
              && authoritativeTaskV2.steps.some(
                (step) =>
                  step.stepId === v2StepId
                  && step.status === 'ready',
              )
                ? newLocalIdentifier('operation')
                : undefined;
            let beganV2Execution = false;
            if (
              v2OperationId
              && v2StepId
              && authoritativeTaskV2
            ) {
              authoritativeTaskRecordV2 =
                await beginV2CompatibilityExecution({
                  operationId: v2OperationId,
                  repository: taskRepository,
                  stepId: v2StepId,
                  task: authoritativeTaskV2,
                });
              authoritativeTaskV2 = authoritativeTaskRecordV2.task;
              beganV2Execution = true;
            }
            const compatibilityRevision =
              authoritativeTaskV2?.revision
              ?? 0;
            const executionStep = authoritativeTaskV2?.steps.find(
              (step) => step.stepId === v2StepId,
            );
            const executionStepKey =
              v2StepId && (executionStep?.attempts ?? 0) > 1
              ? `${v2StepId}:retry:${executionStep!.attempts}`
              : v2StepId
              ?? `task:${authoritativeTaskV2?.taskId ?? clientId}:revision:${compatibilityRevision}:${action.action}`;
            const executionCallId =
              incomingProductCall?.call.call_id
              ?? `coordinator:${requestId}:${executionStepKey}:${compatibilityRevision}`;
            const executionContext: PhoneActionExecutionContext = {
              callId: executionCallId,
              protocolVersion: 2,
              stepKey: executionStepKey,
              taskRevision: compatibilityRevision,
              ...(v2OperationId
                ? { operationId: v2OperationId }
                : {}),
              ...(authoritativeTaskV2
                ? {
                    taskId: authoritativeTaskV2.taskId,
                  }
                : {}),
              ...(v2StepId?.startsWith('task_item_')
                ? {
                    itemId: parseLocalIdentifier('task_item', v2StepId),
                    itemPosition: {
                      current: v2StepIndex + 1,
                      total: authoritativeTaskV2!.steps.length,
                    },
                  }
                : {}),
            };
            if (
              enqueueBackgroundPhoneOperation
              && sequentialActions.length === 1
              && beganV2Execution
              && v2OperationId
              && v2StepId
              && authoritativeTaskV2
            ) {
              try {
                const accepted = await enqueueBackgroundPhoneOperation({
                  operationId: v2OperationId,
                  requestPayload: {
                    version: 1,
                    action,
                  },
                  stepId: v2StepId,
                  taskId: parseLocalIdentifier(
                    'task',
                    authoritativeTaskV2.taskId,
                  ),
                  taskRevision: authoritativeTaskV2.revision,
                });
                operationAcceptedV2 = accepted.operationAccepted;
                return {
                  message:
                    'The phone operation was accepted and is continuing in the background.',
                  ok: true,
                  operation: {
                    operationId: v2OperationId,
                  },
                  operationAccepted: accepted.operationAccepted,
                  status: 'operation_accepted',
                };
              } catch (error) {
                logEvent('warn', 'workflow.background_phone_enqueue_fallback', {
                  ...errorDetails(error),
                  action: action.action,
                  operationId: v2OperationId,
                  reason: 'bounded_synchronous_fallback',
                  stepId: v2StepId,
                  taskId: authoritativeTaskV2.taskId,
                });
              }
            }
            const result = await phoneExecutor(action, executionContext);
            if (
              beganV2Execution
              && v2OperationId
              && v2StepId
              && authoritativeTaskV2
            ) {
              authoritativeTaskRecordV2 =
                await completeV2CompatibilityExecution({
                  operationId: v2OperationId,
                  repository: taskRepository,
                  result,
                  stepId: v2StepId,
                  task: authoritativeTaskV2,
                });
              authoritativeTaskV2 = authoritativeTaskRecordV2.task;
            }
            return result as typeof result & { status?: string };
          },
          {
            onResult: ({ action, nextAction, result }) => {
              const resultRecord = result as Record<string, unknown>;
              const verification =
                resultRecord['verification']
                && typeof resultRecord['verification'] === 'object'
                  ? resultRecord['verification'] as Record<string, unknown>
                  : undefined;
              if (
                !authoritativeTaskV2
                || !['added', 'already_in_cart'].includes(result.status ?? '')
                || verification?.['outcome'] !== 'verified_success'
              ) {
                return;
              }
              const operationValue =
                resultRecord['operation']
                && typeof resultRecord['operation'] === 'object'
                  ? resultRecord['operation'] as Record<string, unknown>
                  : undefined;
              let operationId: LocalIdentifier<'operation'>;
              try {
                operationId = parseLocalIdentifier(
                  'operation',
                  operationValue?.['operationId'],
                );
              } catch {
                return;
              }
              const itemIndex = authoritativeTaskV2.steps.findIndex((step) =>
                step.operationId === operationId);
              const item = authoritativeTaskV2.steps[itemIndex];
              const next = nextAction
                ? {
                    kind: 'search' as const,
                    label: nextAction.request,
                  }
                : (
                    authoritativeTaskV2.desiredTerminalOutcome
                    && ['checkout_reviewed', 'order_placed'].includes(
                      authoritativeTaskV2.desiredTerminalOutcome.kind,
                    )
                  )
                  ? { kind: 'review_cart' as const }
                  : { kind: 'wait_for_user' as const };
              for (const event of buildVerifiedItemCompletionEventsV2({
                itemLabel:
                  (
                    typeof resultRecord['product'] === 'string'
                      ? resultRecord['product']
                      : undefined
                  )
                  ?? action.selectedOffer?.title
                  ?? action.request,
                itemPosition: item
                  ? {
                      current: itemIndex + 1,
                      total: authoritativeTaskV2.steps.length,
                    }
                  : undefined,
                next,
                operationId,
                ...(item ? { stepId: item.stepId } : {}),
                taskId: parseLocalIdentifier(
                  'task',
                  authoritativeTaskV2.taskId,
                ),
                taskRevision: authoritativeTaskV2.revision,
              })) {
                taskEventStreamV2.publish(event);
              }
            },
          },
        );
        if (
          authoritativeTaskV2
          && !operationAcceptedV2
          && enqueueBackgroundPhoneOperation
            === enqueueProductionBackgroundPhoneOperationV2
        ) {
          await dispatchProductionContinuationV2(
            authoritativeTaskV2.taskId,
          );
        }
        sequence.executedActions.forEach((action, index) => {
          const result = sequence.results[index];
          toolEvents.push(action.action);
          executedActions.push(action);
          toolResults.push(result);
          logEvent('info', 'tool.complete', {
            result,
            toolArguments: action,
            toolName: action.action,
          });
          const incoming = productCalls.find((entry) => entry.action === action);
          if (incoming) outputByCallId.set(incoming.call.call_id, result);
        });
        if (!operationAcceptedV2) {
          const lastResult = sequence.results.at(-1) as
            | Record<string, unknown>
            | undefined;
          const lastVerification =
            lastResult?.['verification']
            && typeof lastResult['verification'] === 'object'
              ? lastResult['verification'] as Record<string, unknown>
              : undefined;
          productGoalCompletedThisTurn = Boolean(
            authoritativeTaskV2?.status === 'completed'
            && ['added', 'already_in_cart'].includes(
              String(lastResult?.['status'] ?? ''),
            )
            && lastVerification?.['outcome'] === 'verified_success',
          );
        }

        const blockedResult = sequence.results.at(-1);
        const blockedOnChoice = [
          'needs_clarification',
          'search_results',
        ].includes(blockedResult?.status ?? '');
        queuedProducts = sequence.blockedAction
          && productResultNeedsUserInput(blockedResult ?? {})
          && !blockedOnChoice
          && !activePendingGrocery
          ? [sequence.blockedAction, ...sequence.remainingActions]
          : sequence.remainingActions;

        for (const entry of productCalls) {
          if (!outputByCallId.has(entry.call.call_id)) {
            outputByCallId.set(entry.call.call_id, {
              ok: true,
              status: 'queued',
              message: 'Queued behind the product that currently needs the user’s attention.',
            });
          }
        }
      } else if (
        activePendingGrocery
        && productCalls.length > 0
        && !resolvesPendingProduct
      ) {
        queuedProducts = [];
      }

      if (
        authoritativeTaskV2
        && authoritativeTaskV2.status !== 'completed'
      ) {
        const prematureCheckoutCalls = nonProductCalls.filter(({ action }) =>
          action.action === 'prepare_checkout');
        if (prematureCheckoutCalls.length > 0) {
          for (const entry of prematureCheckoutCalls) {
            outputByCallId.set(entry.call.call_id, {
              ok: false,
              status: 'blocked',
              message:
                'Checkout cannot start until every requested product is resolved.',
            });
          }
          nonProductCalls = nonProductCalls.filter(({ action }) =>
            action.action !== 'prepare_checkout');
          logEvent('warn', 'workflow.checkout_blocked_until_products_complete', {
            blockedCallCount: prematureCheckoutCalls.length,
            taskId: authoritativeTaskV2.taskId,
          });
        }
      }

      const phoneExecutionContext = (
        action: PhoneActionArguments,
        callId?: string,
      ): PhoneActionExecutionContext => {
        const taskRevision =
          authoritativeTaskV2?.revision
          ?? 0;
        const taskId = authoritativeTaskV2?.taskId;
        const stepKey =
          authoritativeTaskV2?.activeStepId
          ?? `task:${taskId ?? clientId}:revision:${taskRevision}:${action.action}`;
        return {
          callId:
            callId
            ?? `coordinator:${requestId}:${stepKey}:${taskRevision}`,
          protocolVersion: 2,
          stepKey,
          taskRevision,
          ...(taskId ? { taskId } : {}),
        };
      };

      const executePreparedCheckout = async (
        action: PhoneActionArguments,
        callId?: string,
      ): Promise<unknown> => {
        const phoneResult = await phoneExecutor(
          action,
          phoneExecutionContext(action, callId),
        );

        const proposal = checkoutProposalFromPhoneResult(phoneResult);
        if (!proposal) {
          return prepareVoiceTurnCodCheckoutV2({
            clientId,
            ownerId: clientId,
            taskId:
              authoritativeTaskV2
                ? parseLocalIdentifier('task', authoritativeTaskV2.taskId)
                : newLocalIdentifier('task'),
            taskRevision: authoritativeTaskV2?.revision ?? 0,
            phoneResult: phoneResult as PhoneToolCheckoutResultV2,
          });
        }
        const checkoutTaskId = authoritativeTaskV2
          ? parseLocalIdentifier('task', authoritativeTaskV2.taskId)
          : newLocalIdentifier('task');
        const prepared = await prepareVoiceTurnCodCheckoutV2({
          clientId,
          ownerId: clientId,
          taskId: checkoutTaskId,
          taskRevision: authoritativeTaskV2?.revision ?? 0,
          phoneResult: phoneResult as PhoneToolCheckoutResultV2,
        });
        if (prepared.status !== 'confirmation_required') return prepared;
        return {
          ...prepared,
          checkout: pendingCodFromPreparedCheckout(prepared),
        };
      };

      const executeConfirmedCheckout = async (
        action: PhoneActionArguments,
        callId?: string,
      ): Promise<unknown> => {
        const pending = durablePendingCodV2(activePendingCod);
        const checkoutTaskId =
          pending?.checkoutTaskId
          ?? (
            authoritativeTaskV2
              ? parseLocalIdentifier('task', authoritativeTaskV2.taskId)
              : undefined
          );
        if (!pending || !checkoutTaskId) {
          return {
            ok: false,
            status: 'confirmation_required',
            message:
              'Prepare and review a fresh checkout before confirming the order.',
          };
        }
        const authority = {
          clientId,
          ownerId: clientId,
          taskId: checkoutTaskId,
          taskRevision: pending.checkoutTaskRevision,
        };
        const readCurrentTerms = async (): Promise<AndroidCheckoutReviewV1> => {
          const result = await phoneExecutor(
            { action: 'prepare_checkout' },
            phoneExecutionContext(
              { action: 'prepare_checkout' },
              callId,
            ),
          );
          const proposal = checkoutProposalFromPhoneResult(result);
          if (!proposal) {
            throw new Error(
              'The phone did not return current checkout terms.',
            );
          }
          return proposal.checkout;
        };
        return confirmVoiceTurnCodCheckoutV2({
          ...authority,
          checkoutId: pending.checkoutId,
          confirmationText: transcript,
          readCurrentTerms,
          commit: async ({ checkoutProposal }) => (
            await phoneExecutor(
              { ...action, checkoutProposal },
              phoneExecutionContext(action, callId),
            )
          ) as PhoneToolCheckoutResultV2,
        });
      };

      const autoPrepareCodCheckout = Boolean(
        productGoalCompletedThisTurn
        && authoritativeTaskV2?.status === 'completed'
        && ['checkout_reviewed', 'order_placed'].includes(
          authoritativeTaskV2.desiredTerminalOutcome?.kind ?? '',
        )
        && authoritativeTaskV2.desiredTerminalOutcome?.paymentPreference === 'cod'
        && !nonProductCalls.some(({ action }) =>
          action.action === 'prepare_checkout'),
      );
      if (autoPrepareCodCheckout && authoritativeTaskV2) {
        const action: PhoneActionArguments = { action: 'prepare_checkout' };
        const result = await executePreparedCheckout(action);
        toolEvents.push('prepare_checkout');
        executedActions.push(action);
        toolResults.push(result);
        logEvent('info', 'workflow.checkout_goal_continued', {
          desiredTerminalOutcome:
            authoritativeTaskV2.desiredTerminalOutcome?.kind,
          paymentPreference:
            authoritativeTaskV2.desiredTerminalOutcome?.paymentPreference,
          result,
          taskId: authoritativeTaskV2.taskId,
        });
      }

      for (const { action, call } of nonProductCalls) {
        const executionCallId =
          checkoutContinuationModelCallId ?? call.call_id;
        const result =
          action.action === 'confirm_checkout'
            && (
              !activePendingCod
                || !isExplicitCodConfirmation(transcript)
            )
            ? {
                ok: false,
                status: 'confirmation_required',
                message: 'The final order is locked. Say “Confirm COD order” after reviewing the total and address.',
              }
            : action.action === 'prepare_checkout'
              ? await executePreparedCheckout(action, executionCallId)
              : action.action === 'confirm_checkout'
                ? await executeConfirmedCheckout(action, executionCallId)
            : await phoneExecutor(
                action,
                phoneExecutionContext(action, executionCallId),
              );
        toolEvents.push(action.action ?? call.name);
        executedActions.push(action);
        toolResults.push(result);
        outputByCallId.set(call.call_id, result);
        logEvent('info', 'tool.complete', {
          callId: call.call_id,
          result,
          toolArguments: action,
          toolName: action.action ?? call.name,
        });
      }

      toolOutputs = toolCalls.flatMap((call) => {
        if (!call.call_id || !outputByCallId.has(call.call_id)) return [];
        return [{
          type: 'function_call_output' as const,
          call_id: call.call_id,
          output: JSON.stringify(outputByCallId.get(call.call_id)),
        }];
      });
      if (checkoutContinuationRequested) {
        // The local checkout call does not belong to the provider response, so
        // never submit its synthetic call ID back to the provider or retain
        // the obsolete response chain that proposed a different action.
        toolOutputs = [];
        responseHistory.startOver(clientId);
      }
    }

    const presentableResults = toolResults as PresentableToolResult[];
    const resultWithPendingState = presentableResults.find((result) =>
      ['needs_clarification', 'search_results', 'confirmation_required'].includes(
        result.status ?? '',
      )) ?? presentableResults.at(-1);
    const firstToolResult = resultWithPendingState as {
      checkout?: CodCheckoutSnapshot;
      options?: GroceryOption[];
      quantity?: number;
      request?: string;
      status?: string;
    } | undefined;
    if (acceptsWorkflowCancellation) queuedProducts = [];

    // Commit execution truth before any optional provider work. A model
    // follow-up, localization, or TTS failure must not erase the remaining
    // product queue or the choice currently awaiting the user.
    let continuableResponseId = toolOutputs.length === 0
      ? aiResponse.id ?? retainedPreviousResponseId
      : retainedPreviousResponseId;
    if (toolOutputs.length === 0 && aiResponse.id) {
      completeResponseHistorySafely({
        clientId,
        responseCount: 1,
        responseId: aiResponse.id,
        turnId: requestId,
      });
    }
    await persistNativeV2TurnContext(continuableResponseId);

    const cancellationReply = cancellationRequiresCompletion
      ? operationCancellation?.outcome === 'reconcile_required'
        ? 'I cannot confirm cancellation because a phone change may have started. I am finishing the verification.'
        : 'I cannot cancel safely because final dispatch may have started. Check the final status.'
      : undefined;

    await persistNativeV2TurnContext(continuableResponseId);
    const productSelection = prepareProductSelectionPresentation({
      task: authoritativeTaskV2,
    });
    const resultOperation = toolResults
      .map((result) => (
        result && typeof result === 'object'
          ? (result as Record<string, unknown>)['operation']
          : undefined
      ))
      .find((operation) => operation && typeof operation === 'object') as
        | Record<string, unknown>
        | undefined;
    const finalTaskItem = authoritativeTaskV2?.steps.find((step) =>
      step.stepId === authoritativeTaskV2?.activeStepId);
    turnCorrelation = extendCorrelationContext(turnCorrelation, {
      ...(authoritativeTaskV2
        ? {
            taskId: parseLocalIdentifier(
              'task',
              authoritativeTaskV2.taskId,
            ),
          }
        : {}),
      ...(finalTaskItem?.stepId.startsWith('task_item_')
        ? {
            itemId: parseLocalIdentifier(
              'task_item',
              finalTaskItem.stepId,
            ),
          }
        : {}),
      ...(typeof resultOperation?.['itemId'] === 'string'
        ? { itemId: resultOperation['itemId'] }
        : {}),
      ...(typeof resultOperation?.['operationId'] === 'string'
        ? { operationId: resultOperation['operationId'] }
        : {}),
      ...(productSelection
        ? {
            selectionId: productSelection.selectionId,
            taskId: productSelection.taskId,
          }
        : {}),
    });
    updateLogContext(correlationFields(turnCorrelation));
    if (productSelection) {
      logEvent('info', 'product_selection.presentation_bound', {
        interactionId: productSelection.interactionId,
        selectionId: productSelection.selectionId,
        taskId: productSelection.taskId,
        taskRevision: productSelection.taskRevision,
      });
    }
    const fallbackReply =
      acceptsWorkflowCancellation ? 'Cancelled.' : 'Done.';
    const finalResult = firstToolResult
      ?? presentableResults.at(-1)
      ?? { message: fallbackReply, ok: true, status: 'ready' };
    const presentationInput = {
      fallbackReply,
      languageCode: responseLanguage,
      modelResponse: aiResponse,
      ...(productSelection ? { productSelection } : {}),
      ...(cancellationReply || generalMobileObservation?.explanation
        ? {
            replyOverride:
              cancellationReply ?? generalMobileObservation!.explanation,
          }
        : {}),
      result: finalResult,
      toolResults: presentableResults,
      transcript,
    };
    const {
      assistantState,
      presentation,
      reply,
    } = presentationAdapter.createDeterministic(presentationInput);
    let audioSynthesis: LocalizedProgressSpeechResult;
    try {
      audioSynthesis = localizedProgressSpeech.request({
        clientId,
        generation: requestId,
        languageCode: responseLanguage,
        text: reply,
      });
    } catch (error) {
      logEvent('warn', 'presentation.synthesis_unavailable', {
        ...errorDetails(error),
        clientId,
        generation: requestId,
      });
      audioSynthesis = {
        metadata: {
          cacheStatus: 'miss',
          requestLatencyMs: 0,
        },
        status: 'unavailable',
        synthesisId: `unavailable:${requestId}`,
      };
    }
    void (
      audioSynthesis.status === 'pending'
        ? localizedProgressSpeech.waitFor(audioSynthesis.synthesisId)
        : Promise.resolve(audioSynthesis)
    ).then((settled) => {
      if (!settled) return;
      logEvent(
        settled.status === 'ready' ? 'info' : 'warn',
        'presentation.synthesis_settled',
        {
          cacheStatus: settled.metadata.cacheStatus,
          clientId,
          generation: requestId,
          requestLatencyMs: settled.metadata.requestLatencyMs,
          ...(settled.metadata.synthesisLatencyMs === undefined
            ? {}
            : {
                synthesisLatencyMs:
                  settled.metadata.synthesisLatencyMs,
              }),
          status: settled.status,
          synthesisId: settled.synthesisId,
        },
      );
    });
    const voice =
      audioSynthesis.status === 'ready'
        ? audioSynthesis.audio
        : {};
    const responseQueuedProducts =
      authoritativeTaskV2
        ? unresolvedProductActionsV2(authoritativeTaskV2)
        : queuedProducts;
    const taskEvents = authoritativeTaskV2
      ? taskEventStreamV2.readAfter({
          afterSequence: -1,
          taskId: parseLocalIdentifier(
            'task',
            authoritativeTaskV2.taskId,
          ),
        })
      : undefined;
    logEvent('info', 'request.complete', {
      assistantState,
      durationMs: Math.round(performance.now() - requestStartedAt),
      languageCode: responseLanguage,
      presentationCard: presentation.card.type,
      presentationMode: presentation.mode,
      productQueueRemaining: responseQueuedProducts.length,
      reply,
      synthesisCacheStatus: audioSynthesis.metadata.cacheStatus,
      synthesisRequestLatencyMs:
        audioSynthesis.metadata.requestLatencyMs,
      synthesisStatus: audioSynthesis.status,
      toolEvents,
      toolResultStatuses: presentableResults.map((result) => result.status),
    });

    const responseBody = {
      ok: true,
      requestId,
      transcript,
      reply,
      languageCode: responseLanguage,
      toolEvents,
      toolResults,
      assistantState,
      presentation,
      audioSynthesis: {
        cacheStatus: audioSynthesis.metadata.cacheStatus,
        requestLatencyMs: audioSynthesis.metadata.requestLatencyMs,
        ...(audioSynthesis.metadata.synthesisLatencyMs === undefined
          ? {}
          : {
              synthesisLatencyMs:
                audioSynthesis.metadata.synthesisLatencyMs,
            }),
        status: audioSynthesis.status,
        synthesisId: audioSynthesis.synthesisId,
        ...(audioSynthesis.status === 'pending'
          ? { pollAfterMs: 150 }
          : {}),
      },
      productQueue: {
        remainingCount: responseQueuedProducts.length,
        ...(responseQueuedProducts[0]
          ? { nextProduct: responseQueuedProducts[0].request }
          : {}),
      },
      ...(operationAcceptedV2
        ? { operationAccepted: operationAcceptedV2 }
        : {}),
      ...(taskEvents ? { taskEvents } : {}),
      ...(generalMobileObservation
        ? { generalMobile: generalMobileObservation }
        : {}),
      ...(authoritativeTaskV2
        ? {
          taskV2: {
            activeStepId: authoritativeTaskV2.activeStepId,
            desiredTerminalOutcome:
              authoritativeTaskV2.desiredTerminalOutcome,
            goalKind: authoritativeTaskV2.goalKind,
            originalGoal: authoritativeTaskV2.originalGoal,
            pendingInteraction:
              authoritativeTaskV2.pendingInteraction,
            revision: authoritativeTaskV2.revision,
            status: authoritativeTaskV2.status,
            steps: authoritativeTaskV2.steps.map((step) => ({
              adapterId: step.adapterId,
              kind: step.kind,
              status: step.status,
              stepId: step.stepId,
            })),
            taskId: authoritativeTaskV2.taskId,
            version: 2,
          },
        }
        : {}),
      ...(v2PlannerResult
        ? {
          plannerV2: {
            decision: v2PlannerResult.decision.decision,
            explicitProductChange:
              v2PlannerResult.decision.explicitProductChange,
            goal: v2PlannerResult.decision.goal,
            intent: v2PlannerResult.decision.intent,
            policy: v2PlannerResult.policyResults.map((result) => ({
              capability: result.action.capability,
              decision: result.decision.decision,
              ...('reason' in result.decision
                ? { reason: result.decision.reason }
                : {}),
            })),
            version: 2,
          },
        }
        : {}),
      ...voice,
    };
    if (initialAcknowledgementStartedAt !== undefined) {
      recordUxTimingIntervalSafelyV1(timingMetrics, {
        clientId,
        endedAt: timingNow(),
        outcome: 'completed',
        phase: 'initial_acknowledgement',
        startedAt: initialAcknowledgementStartedAt,
        targetMs: 1_000,
        ...(authoritativeTaskV2
          ? {
              taskId: parseLocalIdentifier(
                'task',
                authoritativeTaskV2.taskId,
              ),
            }
          : {}),
      });
      initialAcknowledgementStartedAt = undefined;
    }
    return NextResponse.json(
      turnCorrelation
        ? correlatedResult(responseBody, turnCorrelation)
        : responseBody,
    );
  } catch (error) {
    if (initialAcknowledgementStartedAt !== undefined) {
      recordUxTimingIntervalSafelyV1(timingMetrics, {
        endedAt: timingNow(),
        outcome: 'error',
        phase: 'initial_acknowledgement',
        startedAt: initialAcknowledgementStartedAt,
        targetMs: 1_000,
      });
      initialAcknowledgementStartedAt = undefined;
    }
    const message = error instanceof Error ? error.message : 'The voice turn failed.';
    logEvent('error', 'request.error', {
      durationMs: Math.round(performance.now() - requestStartedAt),
      ...errorDetails(error),
    });
    const errorBody = { error: message, requestId };
    return NextResponse.json(
      turnCorrelation
        ? correlatedResult(errorBody, turnCorrelation)
        : errorBody,
      { status: 502 },
    );
  }
}
