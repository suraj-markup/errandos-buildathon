import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PhoneActionExecutionContext,
} from '../../../../lib/phone-tool';

const executePhoneAction = vi.fn();
const verifiedMutation = {
  directControl: 'changed',
  mutationAttempted: true,
  outcome: 'verified_success',
  reconciliation: 'verified',
  unrelatedCartPreserved: true,
} as const;

vi.mock('../../../../lib/phone-tool', () => ({
  executePhoneAction,
}));

type LegacyPlannerToolCall = {
  arguments: string;
  call_id: string;
  name: string;
  type: 'function_call';
};

function structuredPlannerResponse(input: {
  explicitProductChange?: boolean;
  id: string;
  output: LegacyPlannerToolCall[];
}): Response {
  return Response.json({
    id: input.id,
    output: [{
      arguments: JSON.stringify({
        version: 2,
        intent: 'add_product',
        explicitProductChange: input.explicitProductChange ?? true,
        decision: 'propose_actions',
        goal: {
          summary: 'Add the requested milk and ice cream without ordering.',
          kind: 'multi_item_acquisition',
          terminalOutcome: 'cart_ready',
          paymentPreference: null,
        },
        assistantMessage: 'I will add both items and stop before checkout.',
        patchOperationsJson: '[]',
        actions: input.output.map((action) => ({
          capability: action.name,
          argumentsJson: action.arguments,
          rationale: 'The route regression fixture requests this action.',
        })),
      }),
      call_id: input.output[0]?.call_id ?? `${input.id}-planner`,
      name: 'submit_phone_plan_v2',
      type: 'function_call',
    }],
  });
}

function voiceRequest(clientId: string): Request {
  const form = new FormData();
  form.set('audio', new File(['voice'], 'command.m4a', {
    type: 'audio/mp4',
  }));
  form.set('clientId', clientId);
  return new Request('http://localhost/api/voice/turn', {
    body: form,
    method: 'POST',
  });
}

type ProductSelectionBinding = {
  clientId: string;
  interactionId: string;
  selectionId: string;
  taskId: string;
  taskRevision: number;
  version: 2;
};

function choiceRequest(
  binding: ProductSelectionBinding,
  offerId: string,
): Request {
  return new Request('http://localhost/api/device/selection', {
    body: JSON.stringify({
      ...binding,
      offerId,
      source: 'tap',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

type ExecutedAction = {
  action?: string;
  offerId?: string;
  request?: string;
};

async function runMilkIceCreamContinuationFixture(): Promise<{
  actions: ExecutedAction[];
  duplicateSelectionAcknowledgement: string;
  finalTaskStatus: string | undefined;
  phoneCallsBeforeDuplicate: number;
  progressKinds: string[];
  voiceTurnCount: number;
}> {
  const clientId = `ux015-multi-item-${crypto.randomUUID()}`;
  const transcripts = [
    'Add Amul milk and Amul ice cream to my cart. Do not place an order.',
  ];
  let transcriptIndex = 0;
  let toolEnabledModelTurn = 0;

  executePhoneAction
    .mockResolvedValueOnce({
      ok: false,
      options: [{
        offerId: 'milk-500',
        price: '₹29',
        priceAmount: 29,
        priceCurrency: 'INR',
        product: 'Amul Taaza Toned Milk',
        size: '500 ml',
        spokenLabel: 'Amul Taaza 500 ml',
      }],
      quantity: 1,
      request: 'Amul milk',
      status: 'needs_clarification',
    })
    .mockImplementationOnce(async (
      _action: unknown,
      context?: PhoneActionExecutionContext,
    ) => {
      await context?.markMutationAttempted?.();
      return {
        ok: true,
        operation: {
          operationId: 'operation_11111111-1111-4111-8111-111111111111',
        },
        product: 'Amul Taaza Toned Milk',
        quantity: 1,
        request: 'Amul milk',
        size: '500 ml',
        status: 'added',
        verification: verifiedMutation,
      };
    })
    .mockResolvedValueOnce({
      ok: true,
      options: [{
        offerId: 'ice-cream-750',
        price: '₹99',
        priceAmount: 99,
        priceCurrency: 'INR',
        product: 'Amul Vanilla Ice Cream',
        size: '750 ml',
        spokenLabel: 'Amul Vanilla 750 ml',
      }],
      quantity: 1,
      request: 'Amul ice cream',
      status: 'search_results',
    })
    .mockImplementationOnce(async (
      _action: unknown,
      context?: PhoneActionExecutionContext,
    ) => {
      await context?.markMutationAttempted?.();
      return {
        ok: true,
        operation: {
          operationId: 'operation_22222222-2222-4222-8222-222222222222',
        },
        product: 'Amul Vanilla Ice Cream',
        quantity: 1,
        request: 'Amul ice cream',
        size: '750 ml',
        status: 'added',
        verification: verifiedMutation,
      };
    })
    .mockResolvedValueOnce({
      cart: {
        lines: [
          {
            lineTotal: { amount: 29, currency: 'INR' },
            product: 'Amul Taaza Toned Milk',
            productId: 'cart-milk-500',
            quantity: 1,
            size: '500 ml',
            unitPrice: { amount: 29, currency: 'INR' },
          },
          {
            lineTotal: { amount: 99, currency: 'INR' },
            product: 'Amul Vanilla Ice Cream',
            productId: 'cart-ice-cream-750',
            quantity: 1,
            size: '750 ml',
            unitPrice: { amount: 99, currency: 'INR' },
          },
        ],
        subtotal: { amount: 128, currency: 'INR' },
      },
      ok: true,
      status: 'cart_status',
    });

  vi.stubGlobal('fetch', vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/speech-to-text')) {
      return Response.json({
        language_code: 'en-IN',
        transcript: transcripts[transcriptIndex++]!,
      });
    }
    if (url.includes('/v1/responses')) {
      const body = JSON.parse(String(init?.body)) as {
        tools?: unknown[];
      };
      if (!body.tools) {
        return Response.json({
          id: `h001-followup-${crypto.randomUUID()}`,
          output_text: 'Continue.',
        });
      }

      toolEnabledModelTurn += 1;
      if (toolEnabledModelTurn === 1) {
        return structuredPlannerResponse({
          id: 'h001-initial-list',
          output: [
            {
              arguments: JSON.stringify({
                offerId: null,
                quantity: 1,
                request: 'Amul milk',
              }),
              call_id: 'h001-milk',
              name: 'add_cart_item',
              type: 'function_call',
            },
            {
              arguments: JSON.stringify({
                offerId: null,
                quantity: 1,
                request: 'Amul ice cream',
              }),
              call_id: 'h001-ice-cream',
              name: 'add_cart_item',
              type: 'function_call',
            },
          ],
        });
      }
      throw new Error(
        'Automatic continuation must not require another planner turn.',
      );
    }
    if (url.includes('/text-to-speech/stream')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }));

  const { POST } = await import('./route');
  const initialResponse = await POST(voiceRequest(clientId));
  const initialBody = await initialResponse.json() as {
    presentation: {
      card: { selection: ProductSelectionBinding };
    };
    taskV2: { taskId: string };
  };
  const { POST: selectProduct } = await import(
    '../../device/selection/route'
  );
  const { phoneTaskRepositoryV2 } = await import(
    '../../../../lib/workflow/v2/runtime-repository'
  );
  const waitForBackgroundStep = async (minimumCalls: number) => {
    await vi.waitFor(async () => {
      const task = (
        await phoneTaskRepositoryV2().getByClientId(clientId)
      )?.task;
      if (executePhoneAction.mock.calls.length < minimumCalls) {
        throw new Error(JSON.stringify({
          actualCalls: executePhoneAction.mock.calls.length,
          expectedCalls: minimumCalls,
          status: task?.status,
          steps: task?.steps.map(({ kind, status }) => ({ kind, status })),
        }));
      }
      expect(task?.steps.some((step) => step.status === 'running')).toBe(false);
    });
  };

  const milkSelectionResponse = await selectProduct(
    choiceRequest(initialBody.presentation.card.selection, 'milk-500'),
  );
  expect(milkSelectionResponse.status).toBe(200);
  await waitForBackgroundStep(3);
  const pendingIceCreamTask = (
    await phoneTaskRepositoryV2().getByClientId(clientId)
  )?.task;
  expect(executePhoneAction).toHaveBeenCalledTimes(3);
  expect(pendingIceCreamTask).toMatchObject({
    pendingInteraction: {
      kind: 'product_choice',
      status: 'open',
    },
  });
  const pendingIceCreamInteraction =
    pendingIceCreamTask!.pendingInteraction!;
  const iceCreamSelectionBinding: ProductSelectionBinding = {
    clientId,
    interactionId: pendingIceCreamInteraction.interactionId,
    selectionId: `selection_${crypto.randomUUID()}`,
    taskId: pendingIceCreamTask!.taskId,
    taskRevision: pendingIceCreamTask!.revision,
    version: 2,
  };
  const iceCreamSelectionResponse = await selectProduct(
    choiceRequest(iceCreamSelectionBinding, 'ice-cream-750'),
  );
  expect(iceCreamSelectionResponse.status).toBe(200);
  await waitForBackgroundStep(5);
  const completedTask = (
    await phoneTaskRepositoryV2().getByClientId(clientId)
  )?.task;
  const { parseLocalIdentifier } = await import(
    '../../../../lib/workflow/identifiers'
  );
  const { taskEventStreamV2 } = await import(
    '../../../../lib/progress/v2'
  );
  const progressKinds = taskEventStreamV2.readAfter({
    afterSequence: -1,
    taskId: parseLocalIdentifier('task', initialBody.taskV2.taskId),
  }).events.map((event) => event.kind);

  const phoneCallsBeforeDuplicate = executePhoneAction.mock.calls.length;
  const duplicateResponse = await selectProduct(
    choiceRequest(iceCreamSelectionBinding, 'ice-cream-750'),
  );
  const duplicateBody = await duplicateResponse.json() as {
    acknowledgement: string;
  };
  await new Promise<void>((resolve) => setImmediate(resolve));
  const actions = executePhoneAction.mock.calls.map(
    ([action]) => action as ExecutedAction,
  );
  return {
    actions,
    duplicateSelectionAcknowledgement: duplicateBody.acknowledgement,
    finalTaskStatus: completedTask?.status,
    phoneCallsBeforeDuplicate,
    progressKinds,
    voiceTurnCount: transcriptIndex,
  };
}

describe('UX015 multi-item automatic continuation regression', () => {
  beforeEach(() => {
    for (const key of [
      'errandosAuthoritativeTaskRepository',
      'errandosBackgroundPhoneOperationManagerV2',
      'errandosBackgroundPhoneOperationStoreV2',
      'errandosPhoneTaskRepositoryV2',
      'errandosTaskEventStreamV2',
      'errandosVoiceResponseHistory',
    ]) {
      Reflect.deleteProperty(globalThis, key);
    }
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    vi.stubEnv('JALDI_REALTIME_CONTROL_V1', 'false');
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    vi.stubEnv('SARVAM_API_KEY', 'test-sarvam-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it(
    'continues through choices to one final cart read and awaits next action',
    async () => {
      const fixture = await runMilkIceCreamContinuationFixture();
      const finalInspections = fixture.actions.filter(
        ({ action }) => action === 'inspect_cart',
      );
      const checkoutOrOrderCalls = fixture.actions.filter(({ action }) =>
        action === 'prepare_checkout'
        || action === 'confirm_checkout'
        || action === 'dispatch_order',
      );

      expect(fixture.voiceTurnCount).toBe(1);
      expect(fixture.actions).toEqual([
        expect.objectContaining({
          action: 'add_cart_item',
          request: 'Amul milk',
        }),
        expect.objectContaining({
          action: 'add_cart_item',
          offerId: 'milk-500',
          request: 'Amul Taaza Toned Milk',
        }),
        expect.objectContaining({
          action: 'search_products',
          request: 'Amul ice cream',
        }),
        expect.objectContaining({
          action: 'add_cart_item',
          offerId: 'ice-cream-750',
          request: 'Amul Vanilla Ice Cream',
        }),
        { action: 'inspect_cart' },
      ]);
      expect(finalInspections).toHaveLength(1);
      expect(checkoutOrOrderCalls).toHaveLength(0);
      expect(fixture.finalTaskStatus).toBe('waiting_for_user');
      expect(fixture.duplicateSelectionAcknowledgement).toBe('duplicate');
      expect(fixture.actions).toHaveLength(fixture.phoneCallsBeforeDuplicate);
      expect(fixture.progressKinds.filter((kind) =>
        kind === 'mutation_verified')).toHaveLength(2);
    },
    15_000,
  );
});
