import { describe, expect, it, vi } from 'vitest';
import type { PlannerContextV2 } from '../workflow/v2/planner-context';
import { OpenAILlmPlannerV2 } from './llm-planner-v2';
import type { ResponsesProvider } from './provider-adapters';

function providerFor(value: Record<string, unknown>): ResponsesProvider {
  return {
    async createResponse() {
      return {
        id: 'resp_planner',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner_call',
          arguments: JSON.stringify(value),
        }],
      };
    },
  };
}

function providerForSequence(
  ...values: Record<string, unknown>[]
): ResponsesProvider & { createResponse: ReturnType<typeof vi.fn> } {
  const createResponse = vi.fn();
  values.forEach((value, index) => {
    createResponse.mockResolvedValueOnce({
      id: `resp_planner_${index}`,
      output: [{
        type: 'function_call',
        name: 'submit_phone_plan_v2',
        call_id: `planner_call_${index}`,
        arguments: JSON.stringify(value),
      }],
    });
  });
  return { createResponse };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    intent: 'add_product',
    explicitProductChange: true,
    decision: 'propose_actions',
    goal: {
      summary: 'Add milk',
      kind: 'multi_item_acquisition',
      terminalOutcome: 'cart_ready',
      paymentPreference: null,
    },
    assistantMessage: 'I will add milk.',
    patchOperationsJson: '[]',
    actions: [{
      capability: 'add_cart_item',
      argumentsJson: JSON.stringify({
        request: 'milk',
        offerId: null,
        quantity: 1,
      }),
      rationale: 'Explicit add request.',
    }],
    ...overrides,
  };
}

function input() {
  return {
    clientId: 'pixel-overlay',
    explicitExactConfirmation: false,
    languageCode: 'en-IN',
    model: 'gpt-4.1-mini',
    requestId: 'request-1',
    taskRevision: 0,
    taskStatus: 'active' as const,
    transcript: 'Add milk',
  };
}

function verifiedContext(
  kind: 'cart_mutation' | 'checkout' | 'order',
): PlannerContextV2 {
  const order = kind === 'order';
  const checkout = kind === 'checkout';
  return {
    version: 2,
    task: {
      taskId: 'task:test',
      revision: 4,
      originalGoal: order
        ? 'Place the reviewed order'
        : checkout
          ? 'Review checkout'
          : 'Add milk',
      goalKind: 'commerce',
      status: order ? 'completed' : 'active',
      desiredTerminalOutcome: {
        kind: order
          ? 'order_placed'
          : checkout
            ? 'checkout_reviewed'
            : 'cart_ready',
      },
    },
    graph: [{
      stepId: `step:${kind}`,
      adapterId: 'blinkit',
      kind: order
        ? 'dispatch_order'
        : checkout
          ? 'review_checkout'
          : 'add_cart_item',
      status: 'verified',
      dependsOn: [],
      attempts: 1,
      inputSummary: '{}',
      expectedPostconditionSummary: order
        ? '{"kind":"order_dispatch_verified"}'
        : checkout
          ? '{"kind":"checkout_terms_observed"}'
          : '{"kind":"cart_contains_requested_quantity"}',
    }],
    verifiedFacts: [],
    capabilities: [],
    recentDialogue: [],
    omitted: {
      capabilities: 0,
      dialogueTurns: 0,
      verifiedFacts: 0,
    },
    estimatedCharacters: 1,
  };
}

describe('OpenAI LLM planner V2', () => {
  it('turns structured intent into a locally allowed compatibility action', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision()),
    ).plan(input());

    expect(result.decision).toMatchObject({
      intent: 'add_product',
      goal: { terminalOutcome: 'cart_ready' },
    });
    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'allow',
    });
    expect(result.translatedResponse.output?.[0]).toMatchObject({
      type: 'function_call',
      call_id: 'planner_call',
      name: 'add_cart_item',
    });
  });

  it('repairs one safely derivable missing product request without a second model call', async () => {
    const provider = providerForSequence(decision({
      actions: [{
        capability: 'add_cart_item',
        argumentsJson: JSON.stringify({
          offerId: null,
          quantity: 1,
        }),
        rationale: 'Add the explicitly requested product.',
      }],
    }));

    const result = await new OpenAILlmPlannerV2(provider).plan({
      ...input(),
      transcript: 'Add Amul milk',
    });

    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    expect(result.decision.actions).toMatchObject([{
      capability: 'add_cart_item',
      arguments: {
        request: 'Amul milk',
        quantity: 1,
      },
    }]);
    expect(result.translatedResponse.output?.[0]).toMatchObject({
      name: 'add_cart_item',
      arguments: JSON.stringify({
        offerId: null,
        quantity: 1,
        request: 'Amul milk',
      }),
    });
  });

  it('preserves a multi-item LLM plan in spoken order', async () => {
    const first = decision().actions[0]!;
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        goal: {
          summary: 'Add milk and bread',
          kind: 'multi_item_acquisition',
          terminalOutcome: 'cart_ready',
          paymentPreference: null,
        },
        actions: [
          first,
          {
            ...first,
            argumentsJson: JSON.stringify({
              request: 'bread',
              offerId: null,
              quantity: 1,
            }),
            rationale: 'The second requested item is bread.',
          },
        ],
      })),
    ).plan({
      ...input(),
      transcript: 'Add milk and bread',
    });

    expect(result.translatedResponse.output?.map((item) =>
      JSON.parse(item.arguments ?? '{}')['request'])).toEqual([
      'milk',
      'bread',
    ]);
    expect(result.translatedResponse.output?.map((item) => item.call_id))
      .toEqual(['planner_call', 'planner_call_1']);
  });

  it('recovers an explicit two-item COD request after repeated malformed plans', async () => {
    const malformed = decision({
      actions: [{
        capability: 'add_cart_item',
        argumentsJson: JSON.stringify({ quantity: 1 }),
        rationale: 'Add the requested product.',
      }],
    });
    const provider = providerForSequence(malformed, malformed);

    const result = await new OpenAILlmPlannerV2(provider).plan({
      ...input(),
      languageCode: 'hi-IN',
      transcript:
        'Amul milk aur Amul ice cream search karke cart mein add karo phir COD checkout review dikhao',
    });

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision).toMatchObject({
      decision: 'propose_actions',
      explicitProductChange: true,
      goal: {
        terminalOutcome: 'checkout_reviewed',
        paymentPreference: 'cod',
      },
      actions: [
        {
          capability: 'add_cart_item',
          arguments: { request: 'Amul milk', quantity: 1 },
        },
        {
          capability: 'add_cart_item',
          arguments: { request: 'Amul ice cream', quantity: 1 },
        },
      ],
    });
    expect(result.translatedResponse.output?.map((item) => item.name))
      .toEqual(['add_cart_item', 'add_cart_item']);
  });

  it('contains a historical add proposed during checkout', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        intent: 'checkout',
        explicitProductChange: false,
        goal: {
          summary: 'Review checkout',
          kind: 'checkout_continuation',
          terminalOutcome: 'checkout_reviewed',
          paymentPreference: 'cod',
        },
      })),
    ).plan({
      ...input(),
      transcript: 'Now review checkout',
    });

    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'block',
      reason: 'capability_unavailable',
    });
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('gives one structured policy rejection back to the LLM for bounded replanning', async () => {
    const createResponse = vi.fn()
      .mockResolvedValueOnce({
        id: 'first-plan',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'first-call',
          arguments: JSON.stringify(decision({
            intent: 'checkout',
            explicitProductChange: false,
            goal: {
              summary: 'Review checkout',
              kind: 'checkout_continuation',
              terminalOutcome: 'checkout_reviewed',
              paymentPreference: 'cod',
            },
          })),
        }],
      })
      .mockResolvedValueOnce({
        id: 'replanned',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'second-call',
          arguments: JSON.stringify(decision({
            intent: 'checkout',
            explicitProductChange: false,
            decision: 'ask_user',
            goal: {
              summary: 'Review checkout',
              kind: 'checkout_continuation',
              terminalOutcome: 'checkout_reviewed',
              paymentPreference: 'cod',
            },
            assistantMessage: 'I can review checkout without repeating cart additions.',
            actions: [],
          })),
        }],
      });
    const result = await new OpenAILlmPlannerV2({
      createResponse,
    }).plan({
      ...input(),
      transcript: 'Review checkout',
    });

    expect(createResponse).toHaveBeenCalledTimes(2);
    expect(createResponse.mock.calls[1]?.[0]['input'])
      .toContain('all_actions_rejected');
    expect(result.decision.decision).toBe('ask_user');
    expect(result.policyResults).toEqual([]);
  });

  it('does not expose final dispatch without a pending exact confirmation', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        intent: 'confirm_order',
        explicitProductChange: false,
        goal: {
          summary: 'Place the reviewed order',
          kind: 'checkout_confirmation',
          terminalOutcome: 'order_placed',
          paymentPreference: 'cod',
        },
        actions: [{
          capability: 'confirm_order',
          argumentsJson: '{}',
          rationale: 'The user asked to confirm.',
        }],
      })),
    ).plan({
      ...input(),
      transcript: 'Yes',
    });

    expect(result.policyResults[0]?.decision).toMatchObject({
      decision: 'block',
    });
  });

  it('allows final dispatch only for the exact phrase bound to a pending review', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        intent: 'confirm_order',
        explicitProductChange: false,
        goal: {
          summary: 'Place the reviewed order',
          kind: 'checkout_confirmation',
          terminalOutcome: 'order_placed',
          paymentPreference: 'cod',
        },
        actions: [{
          capability: 'confirm_order',
          argumentsJson: '{}',
          rationale: 'Fresh exact confirmation.',
        }],
      })),
    ).plan({
      ...input(),
      explicitExactConfirmation: true,
      pendingInteraction: {
        interactionId: 'checkout-confirmation:task-1',
        taskId: 'task-1',
        taskRevision: 4,
        kind: 'checkout_confirmation',
        allowedResponses: ['confirm', 'cancel'],
        presentationRef: 'presentation:checkout',
        status: 'open',
        createdAt: 10,
        expiresAt: 100,
      },
      taskId: 'task-1',
      taskRevision: 4,
      taskStatus: 'waiting_for_user',
      transcript: 'Confirm COD order',
    });

    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'allow',
    });
    expect(result.translatedResponse.output?.[0]).toMatchObject({
      call_id: 'planner_call',
      name: 'confirm_checkout',
      type: 'function_call',
    });
  });

  it('translates checkout review to the canonical coordinator action', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        intent: 'checkout',
        explicitProductChange: false,
        goal: {
          summary: 'Review checkout',
          kind: 'checkout_continuation',
          terminalOutcome: 'checkout_reviewed',
          paymentPreference: 'cod',
        },
        actions: [{
          capability: 'prepare_checkout',
          argumentsJson: '{}',
          rationale: 'The user requested checkout review.',
        }],
      })),
    ).plan({
      ...input(),
      transcript: 'Prepare COD checkout',
    });

    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'allow',
    });
    expect(result.translatedResponse.output?.[0]).toMatchObject({
      call_id: 'planner_call',
      name: 'prepare_checkout',
      type: 'function_call',
    });
  });

  it('requires recovery handoff when V2 state survives without its compatibility executor', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision()),
    ).plan({
      ...input(),
      recoveryHandoffRequired: true,
    });

    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'handoff',
      reason: 'recovery_state_requires_handoff',
    });
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('blocks a repeated mutation while an earlier mutation is unresolved', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision()),
    ).plan({
      ...input(),
      unresolvedMutation: {
        operationId: 'operation_unresolved',
        outcome: 'ambiguous',
      },
    });

    expect(result.policyResults[0]?.decision).toEqual({
      decision: 'reconcile',
      operationId: 'operation_unresolved',
      reason: 'unresolved_mutation',
    });
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('returns a bounded semantic patch without translating it to a raw V1 tool', async () => {
    const result = await new OpenAILlmPlannerV2(
      providerFor(decision({
        intent: 'add_product',
        decision: 'patch_plan',
        assistantMessage: 'I added bread to the remaining plan.',
        actions: [],
        patchOperationsJson: JSON.stringify([{
          type: 'add_product',
          request: 'bread',
          quantity: 1,
        }]),
      })),
    ).plan({
      ...input(),
      taskId: 'task-active',
      taskRevision: 3,
      transcript: 'Also add bread',
    });

    expect(result.decision.planPatches).toEqual([{
      type: 'add_product',
      request: 'bread',
      quantity: 1,
    }]);
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('replans one ungrounded order-success finish into a truthful useful response', async () => {
    const unsafe = decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Place the order',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'Your order was placed successfully.',
      actions: [],
    });
    const safe = decision({
      intent: 'observe',
      explicitProductChange: false,
      decision: 'ask_user',
      goal: {
        summary: 'Check verified order state',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage:
        "I can't verify that an order was placed. I can check the verified task status.",
      actions: [],
    });
    const provider = providerForSequence(unsafe, safe);

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(provider.createResponse.mock.calls[1]?.[0]['input'])
      .toContain('unsupported_transactional_success_claim');
    expect(result.decision).toMatchObject({
      decision: 'ask_user',
      assistantMessage:
        "I can't verify that an order was placed. I can check the verified task status.",
    });
    expect(result.translatedResponse.output_text)
      .not.toContain('successfully');
  });

  it('sanitizes a repeated unsupported success claim after one bounded replan', async () => {
    const unsafe = decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Place the order',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'The order has been confirmed.',
      actions: [],
    });
    const provider = providerForSequence(unsafe, {
      ...unsafe,
      assistantMessage: 'The order was placed successfully.',
    });

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision).toMatchObject({
      decision: 'ask_user',
      actions: [],
      assistantMessage:
        "I can't verify that an order was placed. No order should be assumed from this response. I can check the verified task status.",
    });
    expect(result.translatedResponse.output_text)
      .toBe(result.decision.assistantMessage);
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('sanitizes repeated success prose while preserving a permitted action', async () => {
    const unsafeAction = decision({
      assistantMessage: 'Milk has been added to the cart.',
    });
    const provider = providerForSequence(unsafeAction, unsafeAction);

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision).toMatchObject({
      decision: 'propose_actions',
      assistantMessage:
        'I will apply the permitted cart change and verify the result.',
    });
    expect(result.policyResults[0]?.decision).toEqual({ decision: 'allow' });
    expect(result.translatedResponse.output?.[0]).toMatchObject({
      type: 'function_call',
      name: 'add_cart_item',
    });
  });

  it('contains an unsupported checkout-success message even when it is not finish', async () => {
    const unsafe = decision({
      intent: 'checkout',
      explicitProductChange: false,
      decision: 'ask_user',
      goal: {
        summary: 'Review checkout',
        kind: 'checkout_continuation',
        terminalOutcome: 'checkout_reviewed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'Checkout is ready and successfully completed.',
      actions: [],
    });
    const safe = decision({
      intent: 'checkout',
      explicitProductChange: false,
      decision: 'ask_user',
      goal: {
        summary: 'Review checkout',
        kind: 'checkout_continuation',
        terminalOutcome: 'checkout_reviewed',
        paymentPreference: 'cod',
      },
      assistantMessage:
        "I can't verify that checkout is ready yet. I can review it safely.",
      actions: [],
    });
    const provider = providerForSequence(unsafe, safe);

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision.assistantMessage)
      .toBe("I can't verify that checkout is ready yet. I can review it safely.");
  });

  it('contains an unsupported cart-mutation success claim', async () => {
    const unsafe = decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Add milk',
        kind: 'multi_item_acquisition',
        terminalOutcome: 'cart_ready',
        paymentPreference: null,
      },
      assistantMessage: 'Milk has been added to the cart.',
      actions: [],
    });
    const safe = decision({
      intent: 'observe',
      explicitProductChange: false,
      decision: 'ask_user',
      goal: {
        summary: 'Inspect cart state',
        kind: 'multi_item_acquisition',
        terminalOutcome: 'cart_ready',
        paymentPreference: null,
      },
      assistantMessage:
        "I can't verify that the cart changed yet. I can inspect it safely.",
      actions: [],
    });
    const provider = providerForSequence(unsafe, safe);

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision).toMatchObject({
      decision: 'ask_user',
      assistantMessage:
        "I can't verify that the cart changed yet. I can inspect it safely.",
    });
  });

  it('allows cart and order success only with matching authoritative evidence', async () => {
    const cartProvider = providerForSequence(decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Add milk',
        kind: 'multi_item_acquisition',
        terminalOutcome: 'cart_ready',
        paymentPreference: null,
      },
      assistantMessage: 'Milk has been added to the cart.',
      actions: [],
    }));
    const cart = await new OpenAILlmPlannerV2(cartProvider).plan({
      ...input(),
      context: verifiedContext('cart_mutation'),
    });
    expect(cartProvider.createResponse).toHaveBeenCalledOnce();
    expect(cart.decision.decision).toBe('finish');
    expect(cart.translatedResponse.output_text)
      .toBe('Milk has been added to the cart.');

    const orderProvider = providerForSequence(decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Place the order',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'Your order was placed successfully.',
      actions: [],
    }));
    const order = await new OpenAILlmPlannerV2(orderProvider).plan({
      ...input(),
      context: verifiedContext('order'),
      taskStatus: 'completed',
    });
    expect(orderProvider.createResponse).toHaveBeenCalledOnce();
    expect(order.decision.decision).toBe('finish');
    expect(order.translatedResponse.output_text)
      .toBe('Your order was placed successfully.');
  });

  it('allows an order-success finish with a current verified receipt fact', async () => {
    const context = verifiedContext('order');
    context.graph = [];
    context.verifiedFacts = [{
      factId: 'fact:order-receipt',
      kind: 'order_receipt',
      originOperationId: 'operation:order',
      observedAt: Date.now(),
      freshness: {
        kind: 'expires_at',
        expiresAt: Date.now() + 60_000,
      },
      valueRef: 'provider_reference:verified',
      confidence: 'verified',
    }];
    const provider = providerForSequence(decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Place the order',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'Your order was placed successfully.',
      actions: [],
    }));

    const result = await new OpenAILlmPlannerV2(provider).plan({
      ...input(),
      context,
      taskStatus: 'completed',
    });

    expect(provider.createResponse).toHaveBeenCalledOnce();
    expect(result.decision.decision).toBe('finish');
    expect(result.translatedResponse.output_text)
      .toBe('Your order was placed successfully.');
  });

  it('does not let stale or uncertain evidence authorize a success claim', async () => {
    const context = verifiedContext('order');
    context.verifiedFacts = [{
      factId: 'fact:receipt',
      kind: 'order_receipt',
      originOperationId: 'operation:order',
      observedAt: 1,
      freshness: { kind: 'expires_at', expiresAt: 2 },
      valueRef: 'provider_reference:stale',
      confidence: 'verified',
    }];
    context.graph = [];
    const unsafe = decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Place the order',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'Your order was placed successfully.',
      actions: [],
    });
    const safe = decision({
      intent: 'observe',
      explicitProductChange: false,
      decision: 'ask_user',
      goal: {
        summary: 'Check order status',
        kind: 'checkout_confirmation',
        terminalOutcome: 'order_placed',
        paymentPreference: 'cod',
      },
      assistantMessage: 'The previous evidence is stale, so I will check status.',
      actions: [],
    });
    const provider = providerForSequence(unsafe, safe);

    const result = await new OpenAILlmPlannerV2(provider).plan({
      ...input(),
      context,
      unresolvedMutation: {
        operationId: 'operation:uncertain',
        outcome: 'ambiguous',
      },
    });

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(result.decision.assistantMessage)
      .toBe('The previous evidence is stale, so I will check status.');
  });

  it('preserves a normal non-transactional conversational finish', async () => {
    const provider = providerForSequence(decision({
      intent: 'general',
      explicitProductChange: false,
      decision: 'finish',
      goal: {
        summary: 'Answer the user',
        kind: 'conversation',
        terminalOutcome: 'ask_next',
        paymentPreference: null,
      },
      assistantMessage: "You're welcome.",
      actions: [],
    }));

    const result = await new OpenAILlmPlannerV2(provider).plan(input());

    expect(provider.createResponse).toHaveBeenCalledOnce();
    expect(result.decision.decision).toBe('finish');
    expect(result.translatedResponse.output_text).toBe("You're welcome.");
  });
});
