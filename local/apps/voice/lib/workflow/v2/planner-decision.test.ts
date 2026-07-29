import { describe, expect, it } from 'vitest';
import {
  parseLlmPlannerDecisionV2,
  policyIntentForPlannerDecisionV2,
} from './planner-decision';

function decision() {
  return {
    version: 2,
    intent: 'add_product',
    explicitProductChange: true,
    decision: 'propose_actions',
    goal: {
      summary: 'Add milk and then review checkout',
      kind: 'multi_item_acquisition',
      terminalOutcome: 'checkout_reviewed',
      paymentPreference: 'cod',
    },
    assistantMessage: 'I will add milk and then review checkout.',
    actions: [{
      capability: 'add_cart_item',
      argumentsJson: JSON.stringify({
        offerId: null,
        quantity: 1,
        request: 'milk',
      }),
      rationale: 'The user explicitly asked to add milk.',
    }],
  };
}

describe('LLM planner decision V2', () => {
  it('parses structured goal, intent, and proposed actions', () => {
    expect(parseLlmPlannerDecisionV2(decision())).toMatchObject({
      intent: 'add_product',
      explicitProductChange: true,
      goal: {
        terminalOutcome: 'checkout_reviewed',
        paymentPreference: 'cod',
      },
      actions: [{
        capability: 'add_cart_item',
        arguments: {
          offerId: null,
          quantity: 1,
          request: 'milk',
        },
      }],
    });
  });

  it('maps clarification answers to the product-choice policy cohort', () => {
    const parsed = parseLlmPlannerDecisionV2({
      ...decision(),
      intent: 'clarification_answer',
    });
    expect(policyIntentForPlannerDecisionV2(parsed)).toBe('product_choice');
  });

  it('normalizes useful executable actions to an action decision', () => {
    expect(parseLlmPlannerDecisionV2({
      ...decision(),
      decision: 'finish',
    }).decision).toBe('propose_actions');
  });

  it('rejects unknown capabilities and oversized action lists', () => {
    expect(() => parseLlmPlannerDecisionV2({
      ...decision(),
      actions: [{
        capability: 'tap_raw_coordinates',
        argumentsJson: '{}',
        rationale: 'Unsafe.',
      }],
    })).toThrow(/capability/);
    expect(() => parseLlmPlannerDecisionV2({
      ...decision(),
      actions: Array.from({ length: 13 }, () => decision().actions[0]),
    })).toThrow(/unbounded/);
  });

  it('parses bounded semantic plan patches separately from phone actions', () => {
    const parsed = parseLlmPlannerDecisionV2({
      ...decision(),
      decision: 'patch_plan',
      actions: [],
      patchOperationsJson: JSON.stringify([{
        type: 'replace_product',
        stepId: 'step:milk',
        request: 'oat milk',
        quantity: 2,
      }]),
    });
    expect(parsed.planPatches).toEqual([{
      type: 'replace_product',
      stepId: 'step:milk',
      request: 'oat milk',
      quantity: 2,
    }]);
  });
});
