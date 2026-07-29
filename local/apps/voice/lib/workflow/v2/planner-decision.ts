import {
  phoneCapabilitiesV2,
  type PhoneCapabilityV2,
  type PlannerTurnIntentV2,
} from '../../policy/v2/types';
import type { DesiredTerminalOutcomeV2 } from './contracts';

export const plannerIntentsV2 = [
  'add_product',
  'cancel',
  'checkout',
  'clarification_answer',
  'confirm_order',
  'general',
  'modify_cart',
  'observe',
  'product_choice',
] as const;

export type LlmPlannerIntentV2 = (typeof plannerIntentsV2)[number];

export const plannerDecisionKindsV2 = [
  'ask_user',
  'finish',
  'patch_plan',
  'propose_actions',
] as const;

export type LlmPlannerDecisionKindV2 =
  (typeof plannerDecisionKindsV2)[number];

export type LlmGoalUnderstandingV2 = {
  summary: string;
  kind: string;
  terminalOutcome: DesiredTerminalOutcomeV2['kind'];
  paymentPreference?: DesiredTerminalOutcomeV2['paymentPreference'];
};

export type LlmProposedActionV2 = {
  capability: PhoneCapabilityV2;
  arguments: Record<string, unknown>;
  rationale: string;
};

export type LlmPlanPatchOperationV2 =
  | {
      type: 'add_product';
      request: string;
      quantity: number;
      beforeStepId?: string;
    }
  | {
      type: 'replace_product';
      stepId: string;
      request: string;
      quantity: number;
    }
  | {
      type: 'skip_step';
      stepId: string;
      reason: string;
    }
  | {
      type: 'propose_checkout';
      paymentPreference?: DesiredTerminalOutcomeV2['paymentPreference'];
    };

export type LlmPlannerDecisionV2 = {
  version: 2;
  intent: LlmPlannerIntentV2;
  explicitProductChange: boolean;
  decision: LlmPlannerDecisionKindV2;
  goal: LlmGoalUnderstandingV2;
  assistantMessage: string;
  actions: LlmProposedActionV2[];
  planPatches: LlmPlanPatchOperationV2[];
};

const capabilitySet = new Set<string>(phoneCapabilitiesV2);
const intentSet = new Set<string>(plannerIntentsV2);
const decisionSet = new Set<string>(plannerDecisionKindsV2);
const terminalOutcomes = new Set([
  'ask_next',
  'cart_ready',
  'checkout_reviewed',
  'order_placed',
]);
const paymentPreferences = new Set([
  'ask_user',
  'cod',
  'provider_saved',
]);

function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maximum
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > 16_000) {
    throw new Error('Invalid planner action arguments.');
  }
  return record(JSON.parse(value), 'planner action arguments');
}

function parsePlanPatches(value: unknown): LlmPlanPatchOperationV2[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || value.length > 32_000) {
    throw new Error('Invalid planner patch operations.');
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new Error('Invalid or unbounded planner patch operations.');
  }
  return parsed.map((entry) => {
    const patch = record(entry, 'planner patch operation');
    const type = patch['type'];
    if (type === 'add_product') {
      return {
        type,
        request: boundedText(patch['request'], 'patch product request', 500),
        quantity: boundedQuantity(patch['quantity']),
        ...(patch['beforeStepId']
          ? {
              beforeStepId: boundedText(
                patch['beforeStepId'],
                'patch insertion target',
                256,
              ),
            }
          : {}),
      };
    }
    if (type === 'replace_product') {
      return {
        type,
        stepId: boundedText(patch['stepId'], 'patch target step', 256),
        request: boundedText(patch['request'], 'patch product request', 500),
        quantity: boundedQuantity(patch['quantity']),
      };
    }
    if (type === 'skip_step') {
      return {
        type,
        stepId: boundedText(patch['stepId'], 'patch target step', 256),
        reason: boundedText(patch['reason'], 'patch skip reason', 500),
      };
    }
    if (type === 'propose_checkout') {
      const preference = patch['paymentPreference'];
      if (
        preference !== undefined
        && (
          typeof preference !== 'string'
          || !paymentPreferences.has(preference)
        )
      ) {
        throw new Error('Invalid patch payment preference.');
      }
      return {
        type,
        ...(preference
          ? {
              paymentPreference:
                preference as DesiredTerminalOutcomeV2['paymentPreference'],
            }
          : {}),
      };
    }
    throw new Error('Unsupported planner patch operation.');
  });
}

function boundedQuantity(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 99) {
    throw new Error('Invalid patch product quantity.');
  }
  return value as number;
}

function actionText(
  arguments_: Record<string, unknown>,
  field: string,
  capability: string,
): string {
  const value = arguments_[field];
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 500
  ) {
    throw new Error(
      `Invalid ${capability} arguments: ${field} is required.`,
    );
  }
  return value.trim();
}

function actionQuantity(
  arguments_: Record<string, unknown>,
  capability: string,
): number {
  const value = arguments_['quantity'];
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > 20
  ) {
    throw new Error(
      `Invalid ${capability} arguments: quantity must be between 1 and 20.`,
    );
  }
  return value as number;
}

function validateActionArguments(
  capability: PhoneCapabilityV2,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const arguments_ = structuredClone(source);
  if (capability === 'add_cart_item') {
    arguments_['request'] = actionText(arguments_, 'request', capability);
    arguments_['quantity'] = actionQuantity(arguments_, capability);
  } else if (capability === 'search_products') {
    arguments_['request'] = actionText(arguments_, 'request', capability);
  } else if (capability === 'set_cart_item_quantity') {
    arguments_['productId'] = actionText(arguments_, 'productId', capability);
    arguments_['quantity'] = actionQuantity(arguments_, capability);
  } else if (capability === 'remove_cart_item') {
    arguments_['productId'] = actionText(arguments_, 'productId', capability);
  } else if (capability === 'select_product') {
    arguments_['offerId'] = actionText(arguments_, 'offerId', capability);
  }
  return arguments_;
}

export function parseLlmPlannerDecisionV2(
  value: unknown,
): LlmPlannerDecisionV2 {
  const input = record(value, 'LLM planner decision');
  if (input['version'] !== 2) {
    throw new Error('Unsupported LLM planner decision version.');
  }
  const intent = input['intent'];
  const decision = input['decision'];
  if (
    typeof intent !== 'string'
    || !intentSet.has(intent)
    || typeof decision !== 'string'
    || !decisionSet.has(decision)
    || typeof input['explicitProductChange'] !== 'boolean'
  ) {
    throw new Error('Invalid LLM planner intent or decision.');
  }

  const goalInput = record(input['goal'], 'LLM goal understanding');
  const terminalOutcome = boundedText(
    goalInput['terminalOutcome'],
    'terminal outcome',
    80,
  );
  if (!terminalOutcomes.has(terminalOutcome)) {
    throw new Error('Invalid terminal outcome.');
  }
  const paymentPreference = goalInput['paymentPreference'];
  if (
    paymentPreference !== null
    && paymentPreference !== undefined
    && (
      typeof paymentPreference !== 'string'
      || !paymentPreferences.has(paymentPreference)
    )
  ) {
    throw new Error('Invalid payment preference.');
  }

  if (!Array.isArray(input['actions']) || input['actions'].length > 12) {
    throw new Error('Invalid or unbounded planner action list.');
  }
  const actions = input['actions'].map((value) => {
    const action = record(value, 'planner action');
    const capability = action['capability'];
    if (
      typeof capability !== 'string'
      || !capabilitySet.has(capability)
    ) {
      throw new Error('Invalid planner capability.');
    }
    return {
      capability: capability as PhoneCapabilityV2,
      arguments: validateActionArguments(
        capability as PhoneCapabilityV2,
        parseArguments(action['argumentsJson']),
      ),
      rationale: boundedText(
        action['rationale'],
        'planner action rationale',
        1_000,
      ),
    };
  });
  let planPatches: LlmPlanPatchOperationV2[];
  try {
    planPatches = parsePlanPatches(input['patchOperationsJson']);
  } catch (error) {
    if (actions.length === 0) throw error;
    planPatches = [];
  }
  if (actions.length > 0 && planPatches.length > 0) {
    throw new Error('A planner decision cannot mix actions and plan patches.');
  }
  const normalizedDecision =
    actions.length > 0
      ? 'propose_actions'
      : planPatches.length > 0
        ? 'patch_plan'
        : decision;
  if (normalizedDecision === 'propose_actions' && actions.length === 0) {
    throw new Error('An action proposal cannot be empty.');
  }
  if (normalizedDecision === 'patch_plan' && planPatches.length === 0) {
    throw new Error('A plan patch decision cannot be empty.');
  }

  return {
    version: 2,
    intent: intent as LlmPlannerIntentV2,
    explicitProductChange: input['explicitProductChange'],
    decision: normalizedDecision as LlmPlannerDecisionKindV2,
    goal: {
      summary: boundedText(goalInput['summary'], 'goal summary', 2_000),
      kind: boundedText(goalInput['kind'], 'goal kind', 120),
      terminalOutcome,
      ...(paymentPreference
        ? {
          paymentPreference:
            paymentPreference as DesiredTerminalOutcomeV2['paymentPreference'],
        }
        : {}),
    },
    assistantMessage: boundedText(
      input['assistantMessage'],
      'planner assistant message',
      2_000,
    ),
    actions,
    planPatches,
  };
}

export function policyIntentForPlannerDecisionV2(
  decision: LlmPlannerDecisionV2,
): PlannerTurnIntentV2 {
  if (decision.intent === 'clarification_answer') {
    return 'product_choice';
  }
  return decision.intent;
}
