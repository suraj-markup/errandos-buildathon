import { createHash } from 'node:crypto';
import {
  capabilityCatalogV2,
} from '../policy/v2/capability-catalog';
import { compileCapabilitiesV2 } from '../policy/v2/capability-compiler';
import { evaluatePhoneActionPolicyV2 } from '../policy/v2/policy-engine';
import type {
  ConfirmationGrantSummaryV2,
  PhoneCapabilityV2,
  PolicyDecisionV2,
  PolicyTaskStatusV2,
} from '../policy/v2/types';
import { logEvent } from '../structured-logger';
import type { PlannerContextV2 } from '../workflow/v2/planner-context';
import {
  parseLlmPlannerDecisionV2,
  plannerDecisionKindsV2,
  plannerIntentsV2,
  policyIntentForPlannerDecisionV2,
  type LlmPlannerDecisionV2,
  type LlmProposedActionV2,
} from '../workflow/v2/planner-decision';
import type {
  OpenAIOutputItem,
  OpenAIResponse,
  ResponsesProvider,
} from './provider-adapters';

const plannerToolName = 'submit_phone_plan_v2';

const executableBlinkitCapabilitiesV2: readonly PhoneCapabilityV2[] = [
  'add_cart_item',
  'ask_user',
  'cancel_task',
  'confirm_order',
  'inspect_cart',
  'launch_app',
  'patch_plan',
  'prepare_checkout',
  'reconcile_operation',
  'remove_cart_item',
  'search_products',
  'select_product',
  'set_cart_item_quantity',
];

const coordinatorToolForCapability: Partial<
  Record<PhoneCapabilityV2, string>
> = {
  add_cart_item: 'add_cart_item',
  confirm_order: 'confirm_checkout',
  inspect_cart: 'inspect_cart',
  launch_app: 'open_blinkit',
  prepare_checkout: 'prepare_checkout',
  remove_cart_item: 'remove_cart_item',
  search_products: 'search_products',
  set_cart_item_quantity: 'set_cart_item_quantity',
};

type LlmPlannerPolicyResultV2 = {
  action: LlmProposedActionV2;
  decision: PolicyDecisionV2;
};

export type LlmPlannerTurnResultV2 = {
  decision: LlmPlannerDecisionV2;
  policyResults: LlmPlannerPolicyResultV2[];
  response: OpenAIResponse;
  translatedResponse: OpenAIResponse;
};

type LlmPlannerTurnInputV2 = {
  clientId: string;
  confirmationGrant?: ConfirmationGrantSummaryV2;
  context?: PlannerContextV2;
  explicitExactConfirmation: boolean;
  languageCode: string;
  model: string;
  pendingInteraction?: PlannerContextV2['pendingInteraction'];
  recoveryHandoffRequired?: boolean;
  unresolvedMutation?: {
    operationId: string;
    outcome: 'ambiguous' | 'mutation_unverified';
  };
  requestId: string;
  taskId?: string;
  taskRevision: number;
  taskStatus: PolicyTaskStatusV2;
  transcript: string;
};

type TransactionalSuccessClaimV2 =
  | 'cart_mutation'
  | 'checkout'
  | 'order';

const verifiedCartEvidence =
  /\b(?:cart|basket|item|product|mutation|step_verified|quantity)\b/i;
const verifiedCheckoutEvidence =
  /\b(?:checkout|proposal|terms|payment|review)\b/i;
const verifiedOrderEvidence =
  /\b(?:order|receipt|provider_reference|dispatch|commit)\b/i;

function successClaimIsQualified(message: string): boolean {
  return [
    /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:verify|confirm|claim)\b/i,
    /\b(?:not|never)\s+(?:been\s+)?(?:added|removed|updated|placed|confirmed|completed|prepared|reviewed)\b/i,
    /\b(?:ambiguous|uncertain|unverified|unknown)\b/i,
    /\b(?:whether|if)\b.{0,60}\b(?:added|removed|updated|placed|confirmed|completed|prepared|reviewed)\b/i,
  ].some((pattern) => pattern.test(message));
}

function transactionalSuccessClaim(
  decision: LlmPlannerDecisionV2,
): TransactionalSuccessClaimV2 | undefined {
  if (
    decision.decision === 'finish'
    && /^(?:done|completed|complete|all set|हो गया)[.!]?$/iu
      .test(decision.assistantMessage.trim())
  ) {
    if (decision.goal.terminalOutcome === 'order_placed') return 'order';
    if (decision.goal.terminalOutcome === 'checkout_reviewed') return 'checkout';
    if (decision.goal.terminalOutcome === 'cart_ready') return 'cart_mutation';
  }

  const message = decision.assistantMessage;
  if (successClaimIsQualified(message)) return undefined;
  if (
    /\b(?:order|purchase)\b.{0,60}\b(?:was|is|has been)?\s*(?:successfully\s+)?(?:placed|confirmed|completed)\b/i
      .test(message)
    || /\b(?:successfully\s+)?(?:placed|confirmed|completed)\b.{0,40}\b(?:order|purchase)\b/i
      .test(message)
    || /ऑर्डर.{0,40}(?:हो गया|कर दिया|प्लेस हो गया)/u.test(message)
  ) {
    return 'order';
  }
  if (
    /\bcheckout\b.{0,60}\b(?:is|was|has been)?\s*(?:ready|reviewed|prepared|completed|successful)\b/i
      .test(message)
    || /\b(?:reviewed|prepared|completed)\b.{0,40}\bcheckout\b/i.test(message)
    || /चेकआउट.{0,40}(?:तैयार|पूरा|हो गया)/u.test(message)
  ) {
    return 'checkout';
  }
  if (
    /^(?:successfully\s+)?(?:added|removed|updated)\b/i.test(message)
    || /\b(?:has|have)\s+been\s+(?:successfully\s+)?(?:added|removed|updated)\b/i
      .test(message)
    || /\b(?:was|is)\s+(?:successfully\s+)?(?:added|removed|updated)\b/i
      .test(message)
    || /\b(?:added|removed|updated)\b.{0,40}\b(?:cart|basket)\b/i.test(message)
    || /(?:जोड़ दिया|हटा दिया|कार्ट अपडेट हो गया)/u.test(message)
  ) {
    return 'cart_mutation';
  }
  return undefined;
}

function verifiedFactSupports(
  input: LlmPlannerTurnInputV2,
  claim: TransactionalSuccessClaimV2,
): boolean {
  const pattern = claim === 'order'
    ? verifiedOrderEvidence
    : claim === 'checkout'
      ? verifiedCheckoutEvidence
      : verifiedCartEvidence;
  return input.context?.verifiedFacts.some((fact) => {
    if (fact.confidence !== 'verified') return false;
    if (
      fact.freshness.kind === 'expires_at'
      && fact.freshness.expiresAt <= Date.now()
    ) {
      return false;
    }
    return pattern.test([
      fact.factId,
      fact.kind,
      fact.valueRef,
    ].join(' '));
  }) ?? false;
}

function verifiedGraphSupports(
  input: LlmPlannerTurnInputV2,
  claim: TransactionalSuccessClaimV2,
): boolean {
  const verifiedSteps = input.context?.graph.filter(
    (step) => step.status === 'verified',
  ) ?? [];
  const pattern = claim === 'order'
    ? /\b(?:confirm_order|dispatch_order|place_order|order_dispatch)\b/i
    : claim === 'checkout'
      ? /\b(?:checkout|proposal|payment_review)\b/i
      : /\b(?:add_cart_item|remove_cart_item|set_cart_item_quantity|cart_contains|item_added)\b/i;
  const matchingVerifiedStep = verifiedSteps.some((step) => pattern.test([
    step.kind,
    step.inputSummary,
    step.expectedPostconditionSummary,
  ].join(' ')));
  if (!matchingVerifiedStep) return false;
  if (claim !== 'order') return true;
  return input.context?.task.status === 'completed'
    && input.context.task.desiredTerminalOutcome?.kind === 'order_placed';
}

function claimHasAuthoritativeEvidence(
  input: LlmPlannerTurnInputV2,
  claim: TransactionalSuccessClaimV2,
): boolean {
  if (
    input.unresolvedMutation
    || input.taskStatus === 'ambiguous'
    || input.context?.task.status === 'ambiguous'
  ) {
    return false;
  }
  if (
    claim === 'order'
    && (
      input.pendingInteraction?.kind === 'checkout_confirmation'
      || input.context?.pendingInteraction?.kind === 'checkout_confirmation'
    )
  ) {
    return false;
  }
  return verifiedFactSupports(input, claim)
    || verifiedGraphSupports(input, claim);
}

function unsupportedTransactionalSuccessClaim(
  input: LlmPlannerTurnInputV2,
  decision: LlmPlannerDecisionV2,
): TransactionalSuccessClaimV2 | undefined {
  const claim = transactionalSuccessClaim(decision);
  return claim && !claimHasAuthoritativeEvidence(input, claim)
    ? claim
    : undefined;
}

function safeMessageForClaim(claim: TransactionalSuccessClaimV2): string {
  if (claim === 'order') {
    return [
      "I can't verify that an order was placed.",
      'No order should be assumed from this response.',
      'I can check the verified task status.',
    ].join(' ');
  }
  if (claim === 'checkout') {
    return [
      "I can't verify that checkout is ready yet.",
      'I can review the current checkout state safely.',
    ].join(' ');
  }
  return [
    "I can't verify that the cart changed yet.",
    'I can inspect the cart or continue safely.',
  ].join(' ');
}

function pendingMessageForClaim(claim: TransactionalSuccessClaimV2): string {
  if (claim === 'order') {
    return [
      'I will perform only the permitted order action.',
      'I will report success only after authoritative verification.',
    ].join(' ');
  }
  if (claim === 'checkout') {
    return 'I will review the current checkout state and verify the result.';
  }
  return 'I will apply the permitted cart change and verify the result.';
}

function containUnsupportedSuccessClaim(
  decision: LlmPlannerDecisionV2,
  claim: TransactionalSuccessClaimV2,
): LlmPlannerDecisionV2 {
  if (
    decision.decision === 'propose_actions'
    || decision.decision === 'patch_plan'
  ) {
    return {
      ...decision,
      assistantMessage: pendingMessageForClaim(claim),
    };
  }
  return {
    ...decision,
    decision: 'ask_user',
    assistantMessage: safeMessageForClaim(claim),
    actions: [],
    planPatches: [],
  };
}

function actionDigest(action: LlmProposedActionV2): string {
  return createHash('sha256')
    .update(JSON.stringify({
      arguments: action.arguments,
      capability: action.capability,
    }))
    .digest('hex');
}

function plannerTool() {
  return {
    type: 'function',
    name: plannerToolName,
    description: [
      'Return the complete structured V2 understanding and plan for this turn.',
      'This tool proposes intent and actions; it does not execute or verify phone work.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'integer', enum: [2] },
        intent: { type: 'string', enum: [...plannerIntentsV2] },
        explicitProductChange: { type: 'boolean' },
        decision: { type: 'string', enum: [...plannerDecisionKindsV2] },
        goal: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string' },
            kind: { type: 'string' },
            terminalOutcome: {
              type: 'string',
              enum: [
                'ask_next',
                'cart_ready',
                'checkout_reviewed',
                'order_placed',
              ],
            },
            paymentPreference: {
              type: ['string', 'null'],
              enum: ['ask_user', 'cod', 'provider_saved', null],
            },
          },
          required: [
            'summary',
            'kind',
            'terminalOutcome',
            'paymentPreference',
          ],
        },
        assistantMessage: { type: 'string' },
        patchOperationsJson: {
          type: 'string',
          description: [
            'A JSON array of at most eight semantic future-work patches.',
            'Use [] unless decision is patch_plan.',
            'Supported types: add_product, replace_product, skip_step, propose_checkout.',
          ].join(' '),
        },
        actions: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              capability: {
                type: 'string',
                enum: executableBlinkitCapabilitiesV2,
              },
              argumentsJson: {
                type: 'string',
                description:
                  'A JSON object containing only typed arguments for the capability.',
              },
              rationale: { type: 'string' },
            },
            required: ['capability', 'argumentsJson', 'rationale'],
          },
        },
      },
      required: [
        'version',
        'intent',
        'explicitProductChange',
        'decision',
        'goal',
        'assistantMessage',
        'patchOperationsJson',
        'actions',
      ],
    },
  };
}

function plannerInstructions(languageCode: string): string {
  return [
    'You are the LLM planner in JaldiAI PhoneTaskV2.',
    'You own intent understanding, goal interpretation, dialogue, and proposing the next useful action.',
    'The local V2 task repository owns completed work, pending work, and verified facts.',
    'The local policy engine—not you—decides whether proposed actions are currently executable.',
    'Never rewrite, repeat, or contradict a verified step.',
    'Never claim a mutation, checkout, or order succeeded from conversation text.',
    'A checkout-only turn must not recreate historical product actions.',
    'A clarification answer resolves the open interaction; it is not a new search unless the user explicitly changes the request.',
    'For a product_choice interaction, map the user’s answer only to one of pendingInteraction.allowedResponses and propose select_product with that response’s exact offerId.',
    'If the user’s answer does not uniquely identify one allowed response, ask the user again. Never search again merely because the answer is conversational or multilingual.',
    'Use propose_actions only when at least one phone action is needed.',
    'Use ask_user for missing choices, patch_plan for additions/corrections to future work, and finish only when structured task facts support it.',
    'For patch_plan, put semantic patch operations in patchOperationsJson and do not include phone actions.',
    'Never target a verified step for replacement or skipping.',
    'For a list, propose one product action per requested item in spoken order.',
    'Use add_cart_item for explicit add/buy/get requests and search_products for read-only search.',
    'Use prepare_checkout for review; use confirm_order only for a fresh exact final confirmation.',
    'Return argumentsJson as a valid JSON object.',
    `Respond to the user in language ${languageCode}.`,
    'Call submit_phone_plan_v2 exactly once.',
  ].join(' ');
}

function plannerInput(
  input: LlmPlannerTurnInputV2,
  policyFeedback?: unknown,
): string {
  return JSON.stringify({
    version: 2,
    currentUserTurn: input.transcript,
    languageCode: input.languageCode,
    taskContext: input.context ?? null,
    pendingInteraction: input.pendingInteraction ?? null,
    explicitExactConfirmation: input.explicitExactConfirmation,
    recoveryHandoffRequired: Boolean(input.recoveryHandoffRequired),
    unresolvedMutation: input.unresolvedMutation ?? null,
    supportedAdapter: {
      adapterId: 'blinkit',
      capabilities: executableBlinkitCapabilitiesV2,
      note:
        'General-mobile reasoning is allowed, but this compatibility executor currently exposes only these typed Blinkit capabilities.',
    },
    ...(policyFeedback ? { policyFeedback } : {}),
  });
}

function extractPlannerDecision(
  response: OpenAIResponse,
): LlmPlannerDecisionV2 {
  const calls = response.output?.filter(
    (item) => item.type === 'function_call' && item.name === plannerToolName,
  ) ?? [];
  if (calls.length !== 1 || !calls[0]?.arguments) {
    throw new Error('The V2 planner did not return exactly one structured decision.');
  }
  return parseLlmPlannerDecisionV2(JSON.parse(calls[0].arguments));
}

function plannerValidationMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : 'The structured planner response was invalid.';
}

const fallbackCommandWords = new Set([
  'a', 'add', 'and', 'aur', 'basket', 'buy', 'cart', 'checkout', 'cod',
  'dikhao', 'ek', 'find', 'for', 'get', 'karke', 'karna', 'karo', 'me',
  'mein', 'my', 'order', 'phir', 'please', 'review', 'search', 'show',
  'te', 'then', 'the', 'to',
  'आप', 'ऐड', 'एड', 'एक', 'और', 'का', 'करके', 'करना', 'करो', 'कार्ट',
  'को', 'खोजो', 'जोड़ो', 'ढूंढो', 'तुम', 'ते', 'दिखाओ', 'फिर', 'में',
  'मेरे', 'लिए', 'से',
]);

function fallbackProductRequests(transcript: string): string[] {
  const segments = transcript
    .replace(/[।.!?]/gu, ' ')
    .split(/\s+(?:and|aur|और|te|ਤੇ)\s+|[,;]/giu);
  return segments
    .map((segment) =>
      segment
        .split(/\s+/u)
        .filter((word) => {
          const normalized = word
            .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
            .toLocaleLowerCase('en-US');
          return normalized && !fallbackCommandWords.has(normalized);
        })
        .join(' ')
        .trim()
        .slice(0, 500)
    )
    .filter((request, index, all) =>
      request.length > 1
      && /\p{L}/u.test(request)
      && all.indexOf(request) === index
    )
    .slice(0, 8);
}

function locallyRepairMissingProductRequests(
  response: OpenAIResponse,
  input: LlmPlannerTurnInputV2,
): LlmPlannerDecisionV2 | undefined {
  const calls = response.output?.filter(
    (item) => item.type === 'function_call' && item.name === plannerToolName,
  ) ?? [];
  if (calls.length !== 1 || !calls[0]?.arguments) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(calls[0].arguments);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = structuredClone(raw) as Record<string, unknown>;
  if (!Array.isArray(candidate['actions'])) return undefined;

  const missing: Array<{
    action: Record<string, unknown>;
    arguments: Record<string, unknown>;
  }> = [];
  for (const value of candidate['actions']) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const action = value as Record<string, unknown>;
    if (
      action['capability'] !== 'add_cart_item'
      && action['capability'] !== 'search_products'
    ) {
      continue;
    }
    if (typeof action['argumentsJson'] !== 'string') return undefined;
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(action['argumentsJson']);
    } catch {
      return undefined;
    }
    if (
      !argumentsValue
      || typeof argumentsValue !== 'object'
      || Array.isArray(argumentsValue)
    ) {
      return undefined;
    }
    const arguments_ = argumentsValue as Record<string, unknown>;
    const request = arguments_['request'];
    if (typeof request === 'string' && request.trim()) continue;
    if (request !== undefined && request !== null && request !== '') {
      return undefined;
    }
    missing.push({ action, arguments: arguments_ });
  }
  if (missing.length === 0) return undefined;

  const requests = fallbackProductRequests(input.transcript);
  if (requests.length !== missing.length) return undefined;
  missing.forEach((entry, index) => {
    entry.arguments['request'] = requests[index]!;
    entry.action['argumentsJson'] = JSON.stringify(entry.arguments);
  });

  try {
    const repaired = parseLlmPlannerDecisionV2(candidate);
    logEvent('info', 'planner.v2.local_repair', {
      repairedActionCount: missing.length,
      repair: 'missing_product_request',
    });
    return repaired;
  } catch {
    return undefined;
  }
}

function deterministicInvalidPlannerFallback(
  input: LlmPlannerTurnInputV2,
): LlmPlannerDecisionV2 | undefined {
  const explicitAdd =
    /\b(?:add|buy|get|cart|basket|cod|checkout|order)\b|(?:जोड़|कार्ट|ऐड|एड|खरीद)/iu
      .test(input.transcript);
  const explicitSearch =
    /\b(?:search|find|show)\b|(?:खोज|ढूंढ|दिखा)/iu.test(input.transcript);
  if (!explicitAdd && !explicitSearch) return undefined;
  const requests = fallbackProductRequests(input.transcript);
  if (requests.length === 0) return undefined;
  const checkoutRequested =
    /\b(?:cod|checkout|order)\b|(?:चेकआउट|ऑर्डर)/iu.test(input.transcript);
  const capability: PhoneCapabilityV2 = explicitAdd
    ? 'add_cart_item'
    : 'search_products';
  return {
    version: 2,
    intent: explicitAdd ? 'add_product' : 'observe',
    explicitProductChange: explicitAdd,
    decision: 'propose_actions',
    goal: {
      summary: input.transcript.trim().slice(0, 500),
      kind: 'multi_item_acquisition',
      terminalOutcome: checkoutRequested ? 'checkout_reviewed' : 'cart_ready',
      ...(checkoutRequested ? { paymentPreference: 'cod' } : {}),
    },
    assistantMessage: input.languageCode.startsWith('hi')
      ? 'मैं इन वस्तुओं पर सुरक्षित रूप से काम कर रहा हूँ।'
      : 'I am continuing with these items safely.',
    actions: requests.map((request) => ({
      capability,
      arguments: {
        request,
        ...(explicitAdd ? { quantity: 1 } : {}),
      },
      rationale:
        'Deterministic recovery after repeated malformed structured output.',
    })),
    planPatches: [],
  };
}

function safeInvalidPlannerDecision(
  input: LlmPlannerTurnInputV2,
): LlmPlannerDecisionV2 {
  const deterministic = deterministicInvalidPlannerFallback(input);
  if (deterministic) return deterministic;
  return {
    version: 2,
    intent: 'general',
    explicitProductChange: false,
    decision: 'ask_user',
    goal: {
      summary: input.transcript.trim().slice(0, 500) || 'Clarify the request',
      kind: 'conversation',
      terminalOutcome: 'ask_next',
    },
    assistantMessage:
      'I could not structure that request safely. Please repeat the items once.',
    actions: [],
    planPatches: [],
  };
}

function localIdempotencyKey(
  input: LlmPlannerTurnInputV2,
  action: LlmProposedActionV2,
  digest: string,
): string {
  return [
    'v2',
    input.taskId ?? input.clientId,
    input.taskRevision,
    action.capability,
    digest.slice(0, 24),
  ].join(':');
}

function confirmationGrantFor(
  input: LlmPlannerTurnInputV2,
  action: LlmProposedActionV2,
  digest: string,
): ConfirmationGrantSummaryV2 | undefined {
  if (input.confirmationGrant) return input.confirmationGrant;
  if (
    action.capability !== 'confirm_order'
    || !input.explicitExactConfirmation
    || input.pendingInteraction?.kind !== 'checkout_confirmation'
  ) {
    return undefined;
  }
  return {
    actionDigest: digest,
    adapterId: 'blinkit',
    expiresAt: Date.now() + 30_000,
    taskRevision: input.taskRevision,
  };
}

function evaluateActions(
  input: LlmPlannerTurnInputV2,
  decision: LlmPlannerDecisionV2,
): LlmPlannerPolicyResultV2[] {
  const availableCapabilities = compileCapabilitiesV2({
    adapterCapabilities: input.recoveryHandoffRequired
      ? ['ask_user', 'cancel_task', 'observe']
      : executableBlinkitCapabilitiesV2,
    adapterId: 'blinkit',
    explicitProductChange: decision.explicitProductChange,
    ...(input.pendingInteraction
      ? { pendingInteraction: input.pendingInteraction.kind }
      : {}),
    taskStatus: input.taskStatus,
    turnIntent: policyIntentForPlannerDecisionV2(decision),
    ...(input.unresolvedMutation
      ? { unresolvedMutation: input.unresolvedMutation }
      : {}),
  });
  return decision.actions.map((action) => {
    const digest = actionDigest(action);
    const descriptor = capabilityCatalogV2[action.capability];
    const policyAction = {
      actionDigest: digest,
      adapterId: 'blinkit',
      capability: action.capability,
      ...(descriptor.idempotency === 'none'
        ? {}
        : {
          idempotencyKey: localIdempotencyKey(
            input,
            action,
            digest,
          ),
        }),
    };
    return {
      action,
      decision: evaluatePhoneActionPolicyV2({
        action: policyAction,
        availableCapabilities,
        ...(confirmationGrantFor(input, action, digest)
          ? {
            confirmationGrant:
              confirmationGrantFor(input, action, digest),
          }
          : {}),
        currentTaskRevision: input.taskRevision,
        recoveryHandoffRequired: input.recoveryHandoffRequired,
        ...(input.unresolvedMutation
          ? { unresolvedMutation: input.unresolvedMutation }
          : {}),
      }),
    };
  });
}

function translatedOutput(
  plannerCallId: string,
  decision: LlmPlannerDecisionV2,
  policyResults: LlmPlannerPolicyResultV2[],
): OpenAIOutputItem[] {
  const allowed = policyResults
    .filter((result) => result.decision.decision === 'allow')
    .flatMap((result, index) => {
      const toolName = coordinatorToolForCapability[result.action.capability];
      if (!toolName) return [];
      return [{
        type: 'function_call',
        call_id: index === 0
          ? plannerCallId
          : `${plannerCallId}_${index}`,
        name: toolName,
        arguments: JSON.stringify(result.action.arguments),
      }];
    });
  if (allowed.length > 0) return allowed;
  return [{
    type: 'message',
    content: [{
      type: 'output_text',
      text: decision.assistantMessage,
    }],
  }];
}

export class OpenAILlmPlannerV2 {
  constructor(private readonly responses: ResponsesProvider) {}

  async plan(
    input: LlmPlannerTurnInputV2,
  ): Promise<LlmPlannerTurnResultV2> {
    const requestPlan = (policyFeedback?: unknown) =>
      this.responses.createResponse({
        model: input.model,
        instructions: plannerInstructions(input.languageCode),
        input: plannerInput(input, policyFeedback),
        tools: [plannerTool()],
        tool_choice: {
          type: 'function',
          name: plannerToolName,
        },
        parallel_tool_calls: false,
      });
    let response = await requestPlan();
    let decision: LlmPlannerDecisionV2;
    let replanned = false;
    try {
      decision = extractPlannerDecision(response);
    } catch (error) {
      const locallyRepaired =
        locallyRepairMissingProductRequests(response, input);
      if (locallyRepaired) {
        decision = locallyRepaired;
      } else {
        replanned = true;
        const validationError = plannerValidationMessage(error);
        logEvent('warn', 'planner.v2.replan', {
          reason: 'invalid_structured_decision',
          validationError,
        });
        response = await requestPlan({
          reason: 'invalid_structured_decision',
          validationError,
          instruction: [
            'Return one valid structured decision.',
            `Correct this exact validation error: ${validationError}`,
            'For add_cart_item include request and integer quantity.',
            'For search_products include request.',
            'If actions are present, use decision propose_actions.',
            'Do not repeat the malformed output.',
          ].join(' '),
        });
        try {
          decision = extractPlannerDecision(response);
        } catch (retryError) {
          logEvent('warn', 'planner.v2.invalid_response_contained', {
            validationError: plannerValidationMessage(retryError),
          });
          decision = safeInvalidPlannerDecision(input);
        }
      }
    }
    let unsupportedClaim = unsupportedTransactionalSuccessClaim(
      input,
      decision,
    );
    if (!replanned && unsupportedClaim) {
      replanned = true;
      logEvent('warn', 'planner.v2.replan', {
        claim: unsupportedClaim,
        reason: 'unsupported_transactional_success_claim',
      });
      response = await requestPlan({
        reason: 'unsupported_transactional_success_claim',
        claim: unsupportedClaim,
        instruction: [
          'Do not claim cart, checkout, or order success without matching',
          'authoritative verified facts. Return one truthful useful next step.',
        ].join(' '),
      });
      decision = extractPlannerDecision(response);
      unsupportedClaim = unsupportedTransactionalSuccessClaim(input, decision);
    }
    if (unsupportedClaim) {
      logEvent('warn', 'planner.v2.success_claim_contained', {
        claim: unsupportedClaim,
      });
      decision = containUnsupportedSuccessClaim(decision, unsupportedClaim);
    }
    let policyResults = evaluateActions(input, decision);
    const patchUnavailableReason =
      decision.planPatches.length > 0
        ? input.recoveryHandoffRequired
          ? 'recovery_handoff_required'
          : input.unresolvedMutation
            ? 'unresolved_mutation'
            : input.pendingInteraction
              ? 'pending_interaction'
              : undefined
        : undefined;
    if (!replanned && patchUnavailableReason) {
      replanned = true;
      logEvent('warn', 'planner.v2.replan', {
        reason: 'plan_patch_unavailable',
        patchUnavailableReason,
      });
      response = await requestPlan({
        reason: 'plan_patch_unavailable',
        patchUnavailableReason,
        instruction:
          'Do not patch the graph now. Resolve the interaction, reconcile, or hand off safely.',
      });
      decision = extractPlannerDecision(response);
      const replannedClaim = unsupportedTransactionalSuccessClaim(
        input,
        decision,
      );
      if (replannedClaim) {
        logEvent('warn', 'planner.v2.success_claim_contained', {
          claim: replannedClaim,
        });
        decision = containUnsupportedSuccessClaim(decision, replannedClaim);
      }
      policyResults = evaluateActions(input, decision);
    }
    const allowedActionCount = policyResults.filter(
      (result) => result.decision.decision === 'allow',
    ).length;
    if (
      !replanned
      && decision.decision === 'propose_actions'
      && decision.actions.length > 0
      && allowedActionCount === 0
    ) {
      replanned = true;
      const rejected = policyResults.map((result) => ({
        capability: result.action.capability,
        decision: result.decision.decision,
        ...('reason' in result.decision
          ? { reason: result.decision.reason }
          : {}),
      }));
      logEvent('warn', 'planner.v2.replan', {
        reason: 'all_actions_rejected',
        rejected,
      });
      response = await requestPlan({
        reason: 'all_actions_rejected',
        rejected,
        instruction:
          'Replan once using only currently permitted work. Ask the user or finish safely if no action is allowed.',
      });
      decision = extractPlannerDecision(response);
      const replannedClaim = unsupportedTransactionalSuccessClaim(
        input,
        decision,
      );
      if (replannedClaim) {
        logEvent('warn', 'planner.v2.success_claim_contained', {
          claim: replannedClaim,
        });
        decision = containUnsupportedSuccessClaim(decision, replannedClaim);
      }
      policyResults = evaluateActions(input, decision);
    }
    const responseId = response.id ?? `planner_${input.requestId}`;
    const plannerCallId = response.output?.find(
      (item) =>
        item.type === 'function_call'
        && item.name === plannerToolName,
    )?.call_id ?? `call_${responseId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    logEvent('info', 'planner.v2.decision', {
      actionCount: decision.actions.length,
      allowedActionCount: policyResults.filter(
        (result) => result.decision.decision === 'allow',
      ).length,
      decision: decision.decision,
      goalKind: decision.goal.kind,
      intent: decision.intent,
      policyDecisions: policyResults.map((result) => ({
        capability: result.action.capability,
        decision: result.decision.decision,
        ...('reason' in result.decision
          ? { reason: result.decision.reason }
          : {}),
      })),
      replanned,
      terminalOutcome: decision.goal.terminalOutcome,
    });
    return {
      decision,
      policyResults,
      response,
      translatedResponse: {
        id: responseId,
        output: translatedOutput(plannerCallId, decision, policyResults),
        output_text: decision.assistantMessage,
      },
    };
  }
}
