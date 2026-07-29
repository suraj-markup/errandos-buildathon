import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ResponsesProvider,
  SpeechProvider,
} from './provider-adapters';
import type { RealtimeControlProvider } from '../realtime/provider-adapter';
import {
  executePhoneAction,
  type PhoneActionArguments,
  type PhoneActionExecutionContext,
} from '../phone-tool';
import { coordinateVoiceTurn } from './coordinator';
import {
  beginV2CompatibilityExecution,
  completeV2CompatibilityExecution,
  DEFAULT_TASK_BUDGETS_V2,
  markV2CompatibilityMutationAttempted,
  persistPhoneTaskTurnContextV2,
  phoneTaskRepositoryV2,
  recoverRepositoryOnStartupV2,
  transitionPhoneTaskV2,
  type PhoneTaskV2,
} from '../workflow/v2';
import {
  newLocalIdentifier,
  parseLocalIdentifier,
} from '../workflow/identifiers';
import { buildCodCheckoutProposal } from '../cod';
import {
  androidSettingsPackageV2,
  androidSettingsReadOnlyAdapterIdV2,
  createGeneralMobileProductionServiceV2,
} from '../general-mobile/v2';
import { RetainedTaskEventStreamV2 } from '../progress/v2/retained-task-event-stream';
import {
  enqueueProductionBackgroundPhoneOperationV2,
} from '../workflow/v2/background-phone-operation/production-adapter';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
} from '../workflow/v2/background-phone-operation/store';

function requestWithAudio(clientId: string): Request {
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

function speechProvider(
  transcript = 'Say hello without using the phone.',
): SpeechProvider {
  return {
    synthesize: vi.fn(async () => ({
      audioBase64: 'AQID',
      audioType: 'audio/mpeg',
    })),
    transcribe: vi.fn(async () => ({
      language_code: 'en-IN',
      transcript,
    })),
  };
}

function structuredFinishProvider(
  id: string,
  assistantMessage: string,
): ResponsesProvider {
  return {
    createResponse: vi.fn(async () => ({
      id,
      output: [{
        type: 'function_call',
        name: 'submit_phone_plan_v2',
        call_id: `${id}-call`,
        arguments: JSON.stringify({
          version: 2,
          intent: 'general',
          explicitProductChange: false,
          decision: 'finish',
          goal: {
            summary: 'Answer without phone execution',
            kind: 'conversation',
            terminalOutcome: 'ask_next',
            paymentPreference: null,
          },
          assistantMessage,
          patchOperationsJson: '[]',
          actions: [],
        }),
      }],
    })),
  };
}

function nativeProductTask(input: {
  actions: Array<{
    action: 'add_cart_item';
    quantity: number;
    request: string;
  }>;
  clientId: string;
  originalGoal: string;
}): PhoneTaskV2 {
  const now = Date.now();
  let previousStepId: string | undefined;
  const steps = input.actions.map((action, index) => {
    const stepId = newLocalIdentifier('task_item');
    const step = {
      stepId,
      adapterId: 'blinkit',
      kind: action.action,
      status: index === 0 ? 'ready' as const : 'planned' as const,
      dependsOn: previousStepId ? [previousStepId] : [],
      input: action,
      expectedPostcondition: {
        kind: 'cart_contains_requested_quantity',
        quantity: action.quantity,
        request: action.request,
      },
      attempts: 0,
    };
    previousStepId = stepId;
    return step;
  });
  return {
    version: 2,
    taskId: newLocalIdentifier('task'),
    clientId: input.clientId,
    revision: 0,
    originalGoal: input.originalGoal,
    goalKind: 'multi_item_acquisition',
    status: 'active',
    activeStepId: steps[0]!.stepId,
    steps,
    desiredTerminalOutcome: { kind: 'cart_ready' },
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: now,
    updatedAt: now,
  };
}

async function seedNativeProductTask(
  task: PhoneTaskV2,
): Promise<PhoneTaskV2> {
  const record = await phoneTaskRepositoryV2().create({
    task,
    event: {
      eventId: `test-created:${task.taskId}`,
      taskId: task.taskId,
      taskRevision: task.revision,
      at: task.createdAt,
      kind: 'task_created',
    },
  });
  return record.task;
}

async function seedRecoveredMutationTask(input: {
  clientId: string;
  outcome: 'verified_not_applied' | 'ambiguous';
}): Promise<{
  operationId: string;
  stepId: string;
  taskId: string;
}> {
  const initial = await seedNativeProductTask(nativeProductTask({
    actions: [{ action: 'add_cart_item', request: 'milk', quantity: 1 }],
    clientId: input.clientId,
    originalGoal: 'Add milk',
  }));
  const operationId = newLocalIdentifier('operation');
  const running = await beginV2CompatibilityExecution({
    operationId,
    repository: phoneTaskRepositoryV2(),
    stepId: initial.activeStepId!,
    task: initial,
  });
  await markV2CompatibilityMutationAttempted({
    operationId,
    repository: phoneTaskRepositoryV2(),
    stepId: initial.activeStepId!,
    taskId: parseLocalIdentifier('task', initial.taskId),
  });
  await recoverRepositoryOnStartupV2({
    repository: phoneTaskRepositoryV2(),
    reconciler: {
      reconcile: vi.fn(async () => ({
        outcome: input.outcome,
        evidenceRef:
          input.outcome === 'verified_not_applied'
            ? 'evidence:verified-not-applied'
            : 'evidence:ambiguous',
      })),
    },
  });
  return {
    operationId,
    stepId: running.activeOperation!.stepId,
    taskId: initial.taskId,
  };
}

function codProposal(overrides: {
  feeAmount?: number;
  totalAmount?: number;
} = {}) {
  const feeAmount = overrides.feeAmount ?? 5;
  const totalAmount = overrides.totalAmount ?? 38;
  return buildCodCheckoutProposal({
    addressLabel: 'Home',
    addressReference: 'address_home',
    etaMinutes: 12,
    fees: [{
      amount: { amount: feeAmount, currency: 'INR' },
      kind: 'handling',
      label: 'Handling',
    }],
    lines: [{
      lineTotal: { amount: 33, currency: 'INR' },
      name: 'Milk',
      productId: 'milk',
      quantity: 1,
      unitPrice: { amount: 33, currency: 'INR' },
    }],
    paymentMode: 'cod',
    providerFingerprint:
      overrides.feeAmount === undefined
        ? 'c'.repeat(64)
        : 'd'.repeat(64),
    total: { amount: totalAmount, currency: 'INR' },
    unavailableItems: [],
  }, new Date(), 5 * 60_000);
}

describe('voice turn coordinator', () => {
  beforeEach(() => {
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'false');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs speech, model, and presentation without invoking the HTTP route', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('SARVAM_API_KEY', '');
    const responses = structuredFinishProvider('model-response', 'Hello.');
    const speech = speechProvider();

    const response = await coordinateVoiceTurn(
      requestWithAudio(`coordinator-${crypto.randomUUID()}`),
      'request-coordinator-success',
      { providers: { responses, speech } },
    );
    const body = await response.json() as {
      assistantState: string;
      audioBase64?: string;
      audioSynthesis?: {
        cacheStatus?: string;
        status?: string;
        synthesisId?: string;
      };
      reply: string;
      toolEvents: string[];
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      assistantState: 'ready',
      audioSynthesis: {
        cacheStatus: 'miss',
        status: 'pending',
      },
      reply: 'Hello.',
      toolEvents: [],
    });
    expect(body.audioBase64).toBeUndefined();
    expect(body.audioSynthesis?.synthesisId).toEqual(expect.any(String));
    expect(speech.transcribe).toHaveBeenCalledOnce();
    expect(speech.synthesize).toHaveBeenCalledWith('Hello.', 'en-IN');
  });

  it('uses the structured LLM planner before local V2 policy', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async (request) => {
        expect(request).toMatchObject({
          tool_choice: {
            type: 'function',
            name: 'submit_phone_plan_v2',
          },
        });
        return {
          id: 'planner-response',
          output: [{
            type: 'function_call',
            name: 'submit_phone_plan_v2',
            call_id: 'planner-call',
            arguments: JSON.stringify({
              version: 2,
              intent: 'general',
              explicitProductChange: false,
              decision: 'finish',
              goal: {
                summary: 'Answer without using the phone',
                kind: 'conversation',
                terminalOutcome: 'ask_next',
                paymentPreference: null,
              },
              assistantMessage: 'Hello.',
              patchOperationsJson: '[]',
              actions: [],
            }),
          }],
        };
      }),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(`coordinator-v2-${crypto.randomUUID()}`),
      'request-coordinator-v2',
      { providers: { responses, speech: speechProvider() } },
    );
    const body = await response.json() as {
      plannerV2: {
        decision: string;
        intent: string;
        policy: unknown[];
        version: number;
      };
      reply: string;
      toolEvents: string[];
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      plannerV2: {
        decision: 'finish',
        intent: 'general',
        policy: [],
        version: 2,
      },
      reply: 'Hello.',
      toolEvents: [],
    });
  });

  it('creates and returns authoritative V2 task state for an LLM-planned action', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-add-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-add-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'propose_actions',
            goal: {
              summary: 'Add Amul milk and keep it in the cart',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'I will add Amul milk.',
            patchOperationsJson: '[]',
            actions: [{
              capability: 'add_cart_item',
              argumentsJson: JSON.stringify({
                request: 'Amul milk',
                offerId: null,
                quantity: 1,
              }),
              rationale: 'The user explicitly requested a cart addition.',
            }],
          }),
        }],
      })),
    };
    const executePhone = vi.fn(async (
      _action: PhoneActionArguments,
      _context?: PhoneActionExecutionContext,
    ) => ({
      ok: false,
      status: 'needs_clarification',
      request: 'Amul milk',
      quantity: 1,
      options: [{
        offerId: 'offer-milk-500',
        product: 'Amul Taaza Toned Milk',
        size: '500 ml',
        priceAmount: 29,
        priceCurrency: 'INR' as const,
      }],
    }) as any);
    const enqueueBackgroundPhoneOperation = vi.fn(async () => {
      throw new Error('The single action is not durably serializable.');
    });

    const response = await coordinateVoiceTurn(
      requestWithAudio(`coordinator-v2-task-${crypto.randomUUID()}`),
      'request-coordinator-v2-task',
      {
        enqueueBackgroundPhoneOperation,
        executePhone,
        providers: {
          responses,
          speech: speechProvider('Add Amul milk'),
        },
      },
    );
    const body = await response.json() as {
      plannerV2: { intent: string };
      taskV2: {
        desiredTerminalOutcome: { kind: string };
        originalGoal: string;
        pendingInteraction: { kind: string };
        status: string;
        steps: Array<{ kind: string; status: string }>;
        version: number;
      };
    };

    expect(response.status).toBe(200);
    expect(enqueueBackgroundPhoneOperation).toHaveBeenCalledOnce();
    expect(executePhone).toHaveBeenCalledOnce();
    expect(executePhone.mock.calls[0]?.[0]).toMatchObject({
      action: 'add_cart_item',
      quantity: 1,
      request: 'Amul milk',
    });
    expect(executePhone.mock.calls[0]?.[1]).toMatchObject({
      callId: 'planner-add-call',
      operationId: expect.stringMatching(/^operation_/),
      protocolVersion: 2,
      stepKey: expect.stringMatching(/^task_item_/),
      taskRevision: expect.any(Number),
    });
    expect(body).toMatchObject({
      plannerV2: { intent: 'add_product' },
      taskV2: {
        desiredTerminalOutcome: { kind: 'cart_ready' },
        originalGoal: 'Add Amul milk',
        pendingInteraction: { kind: 'product_choice' },
        status: 'waiting_for_user',
        steps: [{
          kind: 'add_cart_item',
          status: 'waiting_for_user',
        }],
        version: 2,
      },
    });
  });

  it('returns operation acceptance while the durable phone worker is blocked', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `background-accept-${crypto.randomUUID()}`;
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-background-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-background-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: false,
            decision: 'propose_actions',
            goal: {
              summary: 'Show milk options',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'ask_next',
              paymentPreference: null,
            },
            assistantMessage: 'I will check milk options.',
            patchOperationsJson: '[]',
            actions: [{
              capability: 'search_products',
              argumentsJson: JSON.stringify({
                request: 'milk',
              }),
              rationale: 'The user requested a read-only product search.',
            }],
          }),
        }],
      })),
    };
    let releaseWorker: ((result: unknown) => void) | undefined;
    let workerSettled = false;
    const blockedWorker = vi.fn(async () => {
      const result = await new Promise<unknown>((resolve) => {
        releaseWorker = resolve;
      });
      workerSettled = true;
      return result;
    });
    const synchronousPhoneExecutor = vi.fn();
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    const startedAt = performance.now();

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-background-accept',
      {
        enqueueBackgroundPhoneOperation: (input) =>
          enqueueProductionBackgroundPhoneOperationV2(input, {
            executePhone: blockedWorker as typeof executePhoneAction,
            repository: phoneTaskRepositoryV2(),
            store,
            stream,
          }),
        executePhone: synchronousPhoneExecutor,
        providers: {
          responses,
          speech: speechProvider('Show me milk options'),
        },
      },
    );
    const elapsedMs = performance.now() - startedAt;
    const body = await response.json() as {
      operationAccepted: { operationId: string; status: string };
      taskV2: {
        revision: number;
        status: string;
        steps: Array<{ status: string }>;
      };
      toolResults: Array<{ status: string }>;
    };

    expect(response.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(workerSettled).toBe(false);
    expect(synchronousPhoneExecutor).not.toHaveBeenCalled();
    expect(blockedWorker).toHaveBeenCalledOnce();
    expect(body).toMatchObject({
      operationAccepted: {
        operationId: expect.stringMatching(/^operation_/),
        status: 'accepted',
      },
      taskV2: {
        status: 'active',
        steps: [{ status: 'running' }],
      },
      toolResults: [{ status: 'operation_accepted' }],
    });

    releaseWorker?.({
      ok: false,
      options: [{ offerId: 'offer-milk', product: 'Milk' }],
      quantity: 1,
      request: 'milk',
      status: 'search_results',
    });
    await vi.waitFor(async () => {
      expect(
        (await store.get(
          parseLocalIdentifier(
            'operation',
            body.operationAccepted.operationId,
          ),
        ))?.status,
      ).toBe('completed');
    });
  });

  it('persists each verified multi-item mutation as a native V2 transition', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const actions = ['milk', 'bread'].map((request) => ({
      capability: 'add_cart_item',
      argumentsJson: JSON.stringify({
        request,
        offerId: null,
        quantity: 1,
      }),
      rationale: `Add ${request}.`,
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-multi-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-multi-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'propose_actions',
            goal: {
              summary: 'Add milk and bread',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'I will add milk and bread.',
            patchOperationsJson: '[]',
            actions,
          }),
        }],
      })),
    };
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      context?: PhoneActionExecutionContext,
    ) => ({
      ok: true,
      status: 'added',
      product: action.request,
      operation: { operationId: context?.operationId },
      verification: { outcome: 'verified_success' },
    }) as any);
    const enqueueBackgroundPhoneOperation = vi.fn(async () => {
      throw new Error('Multi-action plans must remain synchronous.');
    });

    const response = await coordinateVoiceTurn(
      requestWithAudio(`coordinator-v2-multi-${crypto.randomUUID()}`),
      'request-coordinator-v2-multi',
      {
        enqueueBackgroundPhoneOperation,
        executePhone,
        providers: {
          responses,
          speech: speechProvider('Add milk and bread'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: {
        status: string;
        steps: Array<{ kind: string; status: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(enqueueBackgroundPhoneOperation).not.toHaveBeenCalled();
    expect(executePhone).toHaveBeenCalledTimes(2);
    expect(executePhone.mock.calls.map((call) => call[1]?.operationId))
      .toEqual([
        expect.stringMatching(/^operation_/),
        expect.stringMatching(/^operation_/),
      ]);
    expect(body.taskV2).toMatchObject({
      status: 'active',
      steps: [
        { status: 'verified' },
        { status: 'verified' },
        { kind: 'inspect_cart', status: 'ready' },
        { kind: 'ask_next', status: 'planned' },
      ],
    });
  });

  it('gives programmatic checkout continuation a stable coordinator execution identity', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-auto-checkout-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-auto-checkout-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'propose_actions',
            goal: {
              summary: 'Add milk and continue to COD checkout',
              kind: 'checkout',
              terminalOutcome: 'order_placed',
              paymentPreference: 'cod',
            },
            assistantMessage: 'I will add milk and prepare checkout.',
            patchOperationsJson: '[]',
            actions: [{
              capability: 'add_cart_item',
              argumentsJson: JSON.stringify({
                request: 'milk',
                offerId: 'offer-milk',
                quantity: 1,
              }),
              rationale: 'Add the explicitly requested item.',
            }],
          }),
        }],
      })),
    };
    const proposal = codProposal();
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      _context?: PhoneActionExecutionContext,
    ) => (
      action.action === 'prepare_checkout'
        ? {
            checkout: proposal,
            confirmationPhrase: 'Confirm COD order',
            ok: false,
            status: 'confirmation_required',
          }
        : {
            ok: true,
            status: 'added',
            product: 'Milk',
            verification: { outcome: 'verified_success' },
          }
    ) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(`auto-checkout-${crypto.randomUUID()}`),
      'request-coordinator-v2-auto-checkout',
      {
        executePhone,
        providers: {
          responses,
          speech: speechProvider('Add milk and order it with COD'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone.mock.calls.map(([action]) => action.action)).toEqual([
      'add_cart_item',
      'prepare_checkout',
    ]);
    expect(executePhone.mock.calls[1]?.[1]).toMatchObject({
      callId: expect.stringMatching(
        /^coordinator:request-coordinator-v2-auto-checkout:/,
      ),
      protocolVersion: 2,
      stepKey: expect.any(String),
      taskRevision: expect.any(Number),
    });
    expect(executePhone.mock.calls[1]?.[1]?.stepKey).not.toBe('');
  });

  it('does not automatically retry a recovered verified-not-applied mutation on continue', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-no-auto-retry-${crypto.randomUUID()}`;
    const recovered = await seedRecoveredMutationTask({
      clientId,
      outcome: 'verified_not_applied',
    });
    const executePhone = vi.fn();

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-no-auto-retry',
      {
        executePhone,
        providers: {
          responses: structuredFinishProvider(
            'no-auto-retry-response',
            'The previous attempt was not applied.',
          ),
          speech: speechProvider('continue'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone).not.toHaveBeenCalled();
    expect((await phoneTaskRepositoryV2().getById(recovered.taskId))
      ?.task.steps[0]).toMatchObject({ status: 'failed' });
  });

  it('does not retry an ambiguous recovered mutation', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-ambiguous-retry-${crypto.randomUUID()}`;
    const recovered = await seedRecoveredMutationTask({
      clientId,
      outcome: 'ambiguous',
    });
    const executePhone = vi.fn();

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-ambiguous-retry',
      {
        executePhone,
        providers: {
          responses: structuredFinishProvider(
            'ambiguous-retry-response',
            'I cannot safely retry an ambiguous mutation.',
          ),
          speech: speechProvider('retry'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone).not.toHaveBeenCalled();
    expect((await phoneTaskRepositoryV2().getById(recovered.taskId))
      ?.task.steps[0]).toMatchObject({ status: 'ambiguous' });
  });

  it('executes one new operation after explicit retry of verified-not-applied recovery', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-explicit-retry-${crypto.randomUUID()}`;
    const recovered = await seedRecoveredMutationTask({
      clientId,
      outcome: 'verified_not_applied',
    });
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      context?: PhoneActionExecutionContext,
    ) => ({
      ok: true,
      product: action.request,
      status: 'added',
      operation: { operationId: context?.operationId },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    }) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-explicit-retry',
      {
        executePhone,
        providers: {
          responses: structuredFinishProvider(
            'explicit-retry-response',
            'Retrying once.',
          ),
          speech: speechProvider('retry'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone).toHaveBeenCalledOnce();
    const context = executePhone.mock.calls[0]?.[1];
    expect(context?.operationId).toMatch(/^operation_/);
    expect(context?.operationId).not.toBe(recovered.operationId);
    expect(context?.stepKey).toBe(`${recovered.stepId}:retry:2`);
    const task = (await phoneTaskRepositoryV2().getById(recovered.taskId))!.task;
    expect(task.steps[0]).toMatchObject({
      attempts: 2,
      status: 'verified',
    });
    expect(task.journal).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: recovered.stepId,
        type: 'retry_step',
      }),
    ]));
    expect((await phoneTaskRepositoryV2().getById(recovered.taskId))!.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          dataRef: recovered.stepId,
          kind: 'explicit_user_retry_authorized',
        }),
      ]));
  });

  it('retries only the latest recovered failure when two failed steps are reachable', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-latest-failure-${crypto.randomUUID()}`;
    const task = nativeProductTask({
      actions: [
        { action: 'add_cart_item', request: 'milk', quantity: 1 },
        { action: 'add_cart_item', request: 'bread', quantity: 1 },
      ],
      clientId,
      originalGoal: 'Add milk and bread',
    });
    const [earlier, latest] = task.steps;
    earlier!.status = 'failed';
    earlier!.attempts = 1;
    earlier!.dependsOn = [];
    latest!.status = 'failed';
    latest!.attempts = 1;
    latest!.dependsOn = [];
    task.activeStepId = latest!.stepId;
    task.journal.push(
      {
        entryId: `recovery:${earlier!.stepId}`,
        at: task.updatedAt + 1,
        type: 'recovery_verified_not_applied',
        stepId: earlier!.stepId,
        operationId: newLocalIdentifier('operation'),
      },
      {
        entryId: `recovery:${latest!.stepId}`,
        at: task.updatedAt + 2,
        type: 'recovery_verified_not_applied',
        stepId: latest!.stepId,
        operationId: newLocalIdentifier('operation'),
      },
    );
    task.updatedAt += 2;
    await seedNativeProductTask(task);
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      context?: PhoneActionExecutionContext,
    ) => ({
      ok: true,
      product: action.request,
      status: 'added',
      operation: { operationId: context?.operationId },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    }) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-latest-failure-retry',
      {
        executePhone,
        providers: {
          responses: structuredFinishProvider(
            'latest-failure-retry-response',
            'Retrying the latest failed item.',
          ),
          speech: speechProvider('retry'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone).toHaveBeenCalledOnce();
    expect(executePhone.mock.calls[0]?.[0]).toMatchObject({
      request: 'bread',
    });
    expect(executePhone.mock.calls[0]?.[1]?.stepKey).toBe(
      `${latest!.stepId}:retry:2`,
    );
    const stored = (await phoneTaskRepositoryV2().getById(task.taskId))!.task;
    expect(stored.steps.find((step) => step.stepId === earlier!.stepId))
      .toMatchObject({ attempts: 1, status: 'failed' });
    expect(stored.steps.find((step) => step.stepId === latest!.stepId))
      .toMatchObject({ attempts: 2, status: 'verified' });
  });

  it('does not let an old verified-not-applied recovery authorize a later failed epoch', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-stale-retry-${crypto.randomUUID()}`;
    const recovered = await seedRecoveredMutationTask({
      clientId,
      outcome: 'verified_not_applied',
    });
    const repository = phoneTaskRepositoryV2();
    const recoveredRecord = (await repository.getById(recovered.taskId))!;
    const retryAt = Math.max(Date.now(), recoveredRecord.task.updatedAt);
    const ready = transitionPhoneTaskV2(recoveredRecord.task, {
      type: 'retry_step',
      stepId: recovered.stepId,
      entryId: `test-retry:${recovered.stepId}`,
      at: retryAt,
    });
    const readyRecord = await repository.commit({
      expectedRevision: recoveredRecord.task.revision,
      task: ready,
      event: {
        eventId: `test-retry:${recovered.stepId}`,
        taskId: recovered.taskId,
        taskRevision: ready.revision,
        at: retryAt,
        kind: 'test_retry',
      },
    });
    const laterOperationId = newLocalIdentifier('operation');
    const runningRecord = await beginV2CompatibilityExecution({
      operationId: laterOperationId,
      repository,
      stepId: recovered.stepId,
      task: readyRecord.task,
    });
    await completeV2CompatibilityExecution({
      operationId: laterOperationId,
      repository,
      result: {
        status: 'execution_failed',
        verification: { mutationAttempted: false },
      },
      stepId: recovered.stepId,
      task: runningRecord.task,
    });
    const executePhone = vi.fn();

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-stale-explicit-retry',
      {
        executePhone,
        providers: {
          responses: structuredFinishProvider(
            'stale-explicit-retry-response',
            'That retry is not authorized by the old recovery result.',
          ),
          speech: speechProvider('retry'),
        },
      },
    );

    expect(response.status).toBe(200);
    expect(executePhone).not.toHaveBeenCalled();
    const task = (await repository.getById(recovered.taskId))!.task;
    expect(task.steps[0]).toMatchObject({
      attempts: 2,
      status: 'failed',
    });
    expect(task.journal
      .filter((entry) => entry.stepId === recovered.stepId)
      .at(-1)).toMatchObject({
      stepId: recovered.stepId,
      type: 'fail_step',
    });
  });

  it('applies an LLM patch to the production V2 graph without calling the phone', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-patch-${crypto.randomUUID()}`;
    await seedNativeProductTask(nativeProductTask({
      actions: [
        { action: 'add_cart_item', request: 'milk', quantity: 1 },
        { action: 'add_cart_item', request: 'eggs', quantity: 1 },
      ],
      clientId,
      originalGoal: 'Add milk and eggs',
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-patch-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-patch-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'patch_plan',
            goal: {
              summary: 'Also add bread',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'I added bread to the plan.',
            patchOperationsJson: JSON.stringify([{
              type: 'add_product',
              request: 'bread',
              quantity: 1,
            }]),
            actions: [],
          }),
        }],
      })),
    };
    const executePhone = vi.fn();

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-patch',
      {
        executePhone,
        providers: {
          responses,
          speech: speechProvider('Also add bread'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: {
        revision: number;
        steps: Array<{
          input: { request?: string };
          status: string;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(executePhone).not.toHaveBeenCalled();
    const persisted = await phoneTaskRepositoryV2().getByClientId(clientId);
    expect(persisted?.task.steps.map((step) =>
      (step.input as { request?: string }).request))
      .toEqual(['milk', 'eggs', 'bread']);
    expect(body.taskV2.steps.at(-1)?.status).toBe('planned');
  });

  it('patches an explicit correction into the existing V2 task', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-correction-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [
        { action: 'add_cart_item', request: 'milk', quantity: 1 },
        { action: 'add_cart_item', request: 'eggs', quantity: 1 },
      ],
      clientId,
      originalGoal: 'Add milk and eggs',
    }));
    const targetStepId = initial.steps[1]!.stepId;
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-correction-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-correction-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'patch_plan',
            goal: {
              summary: 'Use bread instead of eggs',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'I replaced eggs with bread.',
            patchOperationsJson: JSON.stringify([{
              type: 'replace_product',
              stepId: targetStepId,
              request: 'bread',
              quantity: 1,
            }]),
            actions: [],
          }),
        }],
      })),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-correction',
      {
        executePhone: vi.fn(),
        providers: {
          responses,
          speech: speechProvider('replace eggs with bread'),
        },
      },
    );

    expect(response.status).toBe(200);
    const persisted = await phoneTaskRepositoryV2().getByClientId(clientId);
    expect(persisted?.task.taskId).toBe(initial.taskId);
    expect(persisted?.task.steps.map((step) =>
      (step.input as { request?: string }).request))
      .toEqual(['milk', 'bread']);
  });

  it('replaces an active task only for an unrelated explicit task', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-replacement-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [{ action: 'add_cart_item', request: 'milk', quantity: 1 }],
      clientId,
      originalGoal: 'Add milk',
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-replacement-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-replacement-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'add_product',
            explicitProductChange: true,
            decision: 'propose_actions',
            goal: {
              summary: 'Add bread instead',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'Starting a new bread task.',
            patchOperationsJson: '[]',
            actions: [{
              capability: 'add_cart_item',
              argumentsJson: JSON.stringify({
                request: 'bread',
                offerId: null,
                quantity: 1,
              }),
              rationale: 'This is a new explicit product request.',
            }],
          }),
        }],
      })),
    };
    const executePhone = vi.fn(async () => ({
      ok: false,
      status: 'needs_clarification',
      request: 'bread',
      quantity: 1,
      options: [{
        offerId: 'offer-bread',
        product: 'Brown bread',
        priceAmount: 50,
        priceCurrency: 'INR' as const,
      }],
    }) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-replacement',
      {
        executePhone,
        providers: {
          responses,
          speech: speechProvider('add bread instead'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: { originalGoal: string; taskId: string };
    };

    expect(response.status).toBe(200);
    expect(body.taskV2.taskId).not.toBe(initial.taskId);
    expect(body.taskV2.originalGoal).toBe('add bread instead');
    expect((await phoneTaskRepositoryV2().getById(initial.taskId))?.task.status)
      .toBe('cancelled');
  });

  it('resolves a bound clarification answer before continuing its V2 step', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-clarification-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [{ action: 'add_cart_item', request: 'milk', quantity: 1 }],
      clientId,
      originalGoal: 'Add milk',
    }));
    const operationId = newLocalIdentifier('operation');
    const running = await beginV2CompatibilityExecution({
      operationId,
      repository: phoneTaskRepositoryV2(),
      stepId: initial.activeStepId!,
      task: initial,
    });
    await completeV2CompatibilityExecution({
      operationId,
      repository: phoneTaskRepositoryV2(),
      result: {
        status: 'needs_clarification',
        request: 'milk',
        options: [{
          offerId: 'offer-milk-500',
          product: 'Amul Taaza Toned Milk',
          size: '500 ml',
          priceAmount: 29,
          priceCurrency: 'INR',
        }],
      },
      stepId: initial.activeStepId!,
      task: running.task,
    });
    await persistPhoneTaskTurnContextV2({
      clientId,
      languageCode: 'en-IN',
      responseId: 'clarification-origin-response',
    });
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-clarification-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-clarification-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'product_choice',
            explicitProductChange: false,
            decision: 'finish',
            goal: {
              summary: 'Use the first visible milk option',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'Using the first milk option.',
            patchOperationsJson: '[]',
            actions: [],
          }),
        }],
      })),
    };
    const executePhone = vi.fn(async () => ({
      ok: true,
      status: 'added',
      product: 'Amul Taaza Toned Milk',
      verification: { outcome: 'verified_success' },
    }) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-clarification',
      {
        executePhone,
        providers: {
          responses,
          speech: speechProvider('the first one'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: {
        pendingInteraction?: unknown;
        status: string;
      };
    };

    expect(response.status).toBe(200);
    expect(responses.createResponse).not.toHaveBeenCalled();
    expect(executePhone).toHaveBeenCalledOnce();
    expect(body.taskV2.pendingInteraction).toBeUndefined();
    expect(body.taskV2.status).toBe('completed');
    const persisted = await phoneTaskRepositoryV2().getByClientId(clientId);
    expect(persisted?.events.some((event) =>
      event.kind === 'interaction_resolved')).toBe(true);
  });

  it('executes an add follow-up from the planner exact visible offer binding', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-model-choice-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [{
        action: 'add_cart_item',
        request: 'Vanilla Magic ice cream',
        quantity: 1,
      }],
      clientId,
      originalGoal: 'Add Vanilla Magic ice cream',
    }));
    const operationId = newLocalIdentifier('operation');
    const running = await beginV2CompatibilityExecution({
      operationId,
      repository: phoneTaskRepositoryV2(),
      stepId: initial.activeStepId!,
      task: initial,
    });
    await completeV2CompatibilityExecution({
      operationId,
      repository: phoneTaskRepositoryV2(),
      result: {
        status: 'needs_clarification',
        request: 'Vanilla Magic ice cream',
        options: [
          {
            offerId: 'offer-amul-magic',
            product: 'Amul Vanilla Magic Ice Cream Tub',
            priceAmount: 195,
            priceCurrency: 'INR',
          },
          {
            offerId: 'offer-pot-magic',
            product: 'Cream Pot Vanilla Magic Ice Cream Tub',
            priceAmount: 150,
            priceCurrency: 'INR',
          },
        ],
      },
      stepId: initial.activeStepId!,
      task: running.task,
    });
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-model-choice-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-model-choice-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'product_choice',
            explicitProductChange: false,
            decision: 'propose_actions',
            goal: {
              summary: 'Use the Amul option',
              kind: 'multi_item_acquisition',
              terminalOutcome: 'cart_ready',
              paymentPreference: null,
            },
            assistantMessage: 'मैं वही Amul वाला जोड़ रहा हूँ।',
            patchOperationsJson: '[]',
            actions: [{
              capability: 'select_product',
              argumentsJson: JSON.stringify({
                offerId: 'offer-amul-magic',
              }),
              rationale: 'The follow-up selects the first visible Amul option.',
            }],
          }),
        }],
      })),
    };
    const executePhone = vi.fn(async () => ({
      ok: true,
      status: 'added',
      product: 'Amul Vanilla Magic Ice Cream Tub',
      verification: { outcome: 'verified_success' },
    }) as any);

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-model-choice',
      {
        executePhone,
        providers: {
          responses,
          speech: speechProvider('हाँ वही वाला'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: { pendingInteraction?: unknown; status: string };
      toolEvents: string[];
    };

    expect(response.status).toBe(200);
    expect(executePhone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'add_cart_item',
        offerId: 'offer-amul-magic',
      }),
      expect.any(Object),
    );
    expect(body.toolEvents).toContain('add_cart_item');
    expect(body.taskV2.pendingInteraction).toBeUndefined();
    expect(body.taskV2.status).toBe('completed');
  });

  it('cancels a safe active V2 task for an explicit start-over', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-start-over-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [{ action: 'add_cart_item', request: 'milk', quantity: 1 }],
      clientId,
      originalGoal: 'Add milk',
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-start-over-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-start-over-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'cancel',
            explicitProductChange: false,
            decision: 'finish',
            goal: {
              summary: 'Start over',
              kind: 'cancel_task',
              terminalOutcome: 'ask_next',
              paymentPreference: null,
            },
            assistantMessage: 'I cancelled the old task.',
            patchOperationsJson: '[]',
            actions: [],
          }),
        }],
      })),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-start-over',
      {
        providers: {
          responses,
          speech: speechProvider('start over'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: { status: string; taskId: string };
    };

    expect(response.status).toBe(200);
    expect(body.taskV2).toMatchObject({
      status: 'cancelled',
      taskId: initial.taskId,
    });
    expect((await phoneTaskRepositoryV2().getById(initial.taskId))?.task.status)
      .toBe('cancelled');
  });

  it('preserves a running mutation when the user asks to start over', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-running-${crypto.randomUUID()}`;
    const initial = await seedNativeProductTask(nativeProductTask({
      actions: [{ action: 'add_cart_item', request: 'milk', quantity: 1 }],
      clientId,
      originalGoal: 'Add milk',
    }));
    const operationId = newLocalIdentifier('operation');
    const running = await beginV2CompatibilityExecution({
      operationId,
      repository: phoneTaskRepositoryV2(),
      stepId: initial.activeStepId!,
      task: initial,
    });
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => ({
        id: 'planner-running-start-over-response',
        output: [{
          type: 'function_call',
          name: 'submit_phone_plan_v2',
          call_id: 'planner-running-start-over-call',
          arguments: JSON.stringify({
            version: 2,
            intent: 'cancel',
            explicitProductChange: false,
            decision: 'finish',
            goal: {
              summary: 'Wait for mutation reconciliation',
              kind: 'reconciliation',
              terminalOutcome: 'ask_next',
              paymentPreference: null,
            },
            assistantMessage: 'I need to verify the current phone change first.',
            patchOperationsJson: '[]',
            actions: [],
          }),
        }],
      })),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-running-start-over',
      {
        providers: {
          responses,
          speech: speechProvider('start over'),
        },
      },
    );
    const body = await response.json() as {
      taskV2: {
        revision: number;
        status: string;
        steps: Array<{ status: string }>;
        taskId: string;
      };
    };

    expect(response.status).toBe(200);
    expect(body.taskV2).toMatchObject({
      revision: running.task.revision,
      status: 'active',
      steps: [{ status: 'running' }],
      taskId: initial.taskId,
    });
    const persisted = await phoneTaskRepositoryV2().getById(initial.taskId);
    expect(persisted?.activeOperation).toMatchObject({
      operationId,
      status: 'running',
    });
  });

  it('runs COD review and final commit through the durable checkout service', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-checkout-${crypto.randomUUID()}`;
    const transcripts = ['prepare COD checkout', 'Confirm COD order'];
    let transcriptIndex = 0;
    let plannerTurn = 0;
    const speech = speechProvider();
    speech.transcribe = vi.fn(async () => ({
      language_code: 'en-IN',
      transcript: transcripts[transcriptIndex++]!,
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => {
        plannerTurn += 1;
        const confirming = plannerTurn === 2;
        return {
          id: `planner-checkout-${plannerTurn}`,
          output: [{
            type: 'function_call',
            name: 'submit_phone_plan_v2',
            call_id: `planner-checkout-call-${plannerTurn}`,
            arguments: JSON.stringify({
              version: 2,
              intent: confirming ? 'confirm_order' : 'checkout',
              explicitProductChange: false,
              decision: 'propose_actions',
              goal: {
                summary: confirming
                  ? 'Place the reviewed COD order'
                  : 'Review the cart for COD checkout',
                kind: 'checkout',
                terminalOutcome: confirming
                  ? 'order_placed'
                  : 'checkout_reviewed',
                paymentPreference: 'cod',
              },
              assistantMessage: confirming
                ? 'Confirming the reviewed COD order.'
                : 'Preparing the COD checkout review.',
              patchOperationsJson: '[]',
              actions: [{
                capability: confirming
                  ? 'confirm_order'
                  : 'prepare_checkout',
                argumentsJson: '{}',
                rationale: confirming
                  ? 'The exact confirmation phrase is present.'
                  : 'The user requested a checkout review.',
              }],
            }),
          }],
        };
      }),
    };
    const proposal = codProposal();
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      _context?: PhoneActionExecutionContext,
    ) => {
      if (action.action === 'prepare_checkout') {
        return {
          checkout: proposal,
          confirmationPhrase: 'Confirm COD order',
          ok: false,
          status: 'confirmation_required',
        } as any;
      }
      if (action.action === 'confirm_checkout') {
        return {
          ok: true,
          providerReference: 'order-durable-1',
          status: 'ordered',
        } as any;
      }
      throw new Error(`Unexpected phone action ${action.action}`);
    });
    const providers = { responses, speech };

    const preparedResponse = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-checkout-prepare',
      { executePhone, providers },
    );
    const preparedBody = await preparedResponse.json() as {
      toolResults: Array<{
        checkout: {
          checkoutId: string;
          checkoutTaskRevision: number;
        };
        checkoutId: string;
        checkoutTaskRevision: number;
        safetyLabel: string;
        status: string;
      }>;
    };

    expect(preparedResponse.status).toBe(200);
    expect(preparedBody.toolResults[0]).toMatchObject({
      checkout: {
        checkoutId: expect.any(String),
        checkoutTaskRevision: 0,
      },
      checkoutId: expect.any(String),
      checkoutTaskRevision: 0,
      safetyLabel: 'NOT ORDERED',
      status: 'confirmation_required',
    });

    const orderedResponse = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-checkout-confirm',
      { executePhone, providers },
    );
    const orderedBody = await orderedResponse.json() as {
      toolResults: Array<{
        providerReference: string;
        status: string;
      }>;
    };

    expect(orderedResponse.status).toBe(200);
    expect(orderedBody.toolResults[0]).toMatchObject({
      providerReference: 'order-durable-1',
      status: 'ordered',
    });
    const phoneActions = executePhone.mock.calls.map(([action]) => action);
    expect(phoneActions.map((action) => action.action)).toEqual([
      'prepare_checkout',
      'prepare_checkout',
      'prepare_checkout',
      'confirm_checkout',
    ]);
    const commit = phoneActions.at(-1);
    expect(commit?.checkoutProposal).toMatchObject({
      checkout: proposal.checkout,
      idempotencyKey: expect.stringMatching(/^checkout\.v2\.[a-f0-9]{64}$/),
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
    });
    expect(executePhone.mock.calls.map((call) => call[1]?.callId)).toEqual([
      'planner-checkout-call-1',
      'call_local_confirm_request-coordinator-v2-checkout-confirm',
      'call_local_confirm_request-coordinator-v2-checkout-confirm',
      'call_local_confirm_request-coordinator-v2-checkout-confirm',
    ]);
    expect(executePhone.mock.calls.every(
      (call) => call[1]?.protocolVersion === 2,
    )).toBe(true);
    expect(executePhone.mock.calls.every(
      (call) =>
        typeof call[1]?.stepKey === 'string'
        && call[1].stepKey.length > 0
        && Number.isSafeInteger(call[1].taskRevision),
    )).toBe(true);
  });

  it('does not invoke provider commit when checkout terms changed', async () => {
    vi.stubEnv('JALDI_AUTHORITATIVE_TASK_STATE_V1', 'true');
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'true');
    const clientId = `coordinator-v2-checkout-change-${crypto.randomUUID()}`;
    const transcripts = ['prepare COD checkout', 'Confirm COD order'];
    let transcriptIndex = 0;
    let plannerTurn = 0;
    let prepareRead = 0;
    const speech = speechProvider();
    speech.transcribe = vi.fn(async () => ({
      language_code: 'en-IN',
      transcript: transcripts[transcriptIndex++]!,
    }));
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => {
        plannerTurn += 1;
        const confirming = plannerTurn === 2;
        return {
          id: `planner-checkout-change-${plannerTurn}`,
          output: [{
            type: 'function_call',
            name: 'submit_phone_plan_v2',
            call_id: `planner-checkout-change-call-${plannerTurn}`,
            arguments: JSON.stringify({
              version: 2,
              intent: confirming ? 'confirm_order' : 'checkout',
              explicitProductChange: false,
              decision: 'propose_actions',
              goal: {
                summary: confirming
                  ? 'Confirm the COD order'
                  : 'Review COD checkout',
                kind: 'checkout',
                terminalOutcome: confirming
                  ? 'order_placed'
                  : 'checkout_reviewed',
                paymentPreference: 'cod',
              },
              assistantMessage: 'Checking the COD checkout.',
              patchOperationsJson: '[]',
              actions: [{
                capability: confirming
                  ? 'confirm_order'
                  : 'prepare_checkout',
                argumentsJson: '{}',
                rationale: 'Continue the requested checkout flow.',
              }],
            }),
          }],
        };
      }),
    };
    const original = codProposal();
    const changed = codProposal({ feeAmount: 7, totalAmount: 40 });
    const executePhone = vi.fn(async (
      action: PhoneActionArguments,
      _context?: PhoneActionExecutionContext,
    ) => {
      if (action.action === 'prepare_checkout') {
        prepareRead += 1;
        return {
          checkout: prepareRead === 1 ? original : changed,
          confirmationPhrase: 'Confirm COD order',
          ok: false,
          status: 'confirmation_required',
        } as any;
      }
      if (action.action === 'confirm_checkout') {
        throw new Error('Provider commit must not run for changed terms.');
      }
      throw new Error(`Unexpected phone action ${action.action}`);
    });
    const providers = { responses, speech };

    expect((await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-checkout-change-prepare',
      { executePhone, providers },
    )).status).toBe(200);
    const changedResponse = await coordinateVoiceTurn(
      requestWithAudio(clientId),
      'request-coordinator-v2-checkout-change-confirm',
      { executePhone, providers },
    );
    const changedBody = await changedResponse.json() as {
      toolResults: Array<{
        changes: string[];
        status: string;
      }>;
    };

    expect(changedResponse.status).toBe(200);
    expect(changedBody.toolResults[0]).toMatchObject({
      changes: expect.arrayContaining([
        'fees',
        'total',
        'provider_fingerprint',
      ]),
      status: 'checkout_changed',
    });
    expect(executePhone.mock.calls.map(([action]) => action.action))
      .toEqual(['prepare_checkout', 'prepare_checkout']);
  });

  it('routes an explicit Settings screen explanation through the read-only companion', async () => {
    const observe = vi.fn(async () => ({
      status: 'ready' as const,
      explanation: 'Visible options include Network and internet, Bluetooth.',
      observation: {
        version: 2 as const,
        observationId: 'observation:settings-1',
        adapterId: androidSettingsReadOnlyAdapterIdV2,
        packageName: androidSettingsPackageV2,
        capturedAt: 10,
        expiresAt: 20,
        fingerprint: 'a'.repeat(64),
        restricted: false as const,
        restrictedClasses: [],
        elements: [{
          elementRef: 'element:network',
          observationId: 'observation:settings-1',
          role: 'button' as const,
          label: 'Network and internet',
        }],
      },
      pointTarget: {
        elementRef: 'element:network',
        observationId: 'observation:settings-1',
      },
    }));
    const responses = structuredFinishProvider(
      'settings-observe-response',
      'I will inspect it.',
    );

    const response = await coordinateVoiceTurn(
      requestWithAudio(`settings-observe-${crypto.randomUUID()}`),
      'request-settings-observe',
      {
        generalMobile: { observe },
        providers: {
          responses,
          speech: speechProvider(
            'Show me Network and internet in this Settings screen',
          ),
        },
      },
    );
    const body = await response.json() as {
      generalMobile: {
        explanation: string;
        pointTarget: { elementRef: string; observationId: string };
        status: string;
      };
      reply: string;
      toolEvents: string[];
    };

    expect(response.status).toBe(200);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: androidSettingsReadOnlyAdapterIdV2,
      focus: 'Network and internet',
      packageName: androidSettingsPackageV2,
    }));
    expect(body).toMatchObject({
      generalMobile: {
        explanation:
          'Visible options include Network and internet, Bluetooth.',
        pointTarget: {
          elementRef: 'element:network',
          observationId: 'observation:settings-1',
        },
        status: 'ready',
      },
      reply: 'Visible options include Network and internet, Bluetooth.',
      toolEvents: ['observe_settings'],
    });
  });

  it('does not infer Settings observation from ambiguous screen help', async () => {
    const observe = vi.fn();
    const responses = structuredFinishProvider(
      'ambiguous-screen-response',
      'What would you like help with?',
    );

    const response = await coordinateVoiceTurn(
      requestWithAudio(`ambiguous-screen-${crypto.randomUUID()}`),
      'request-ambiguous-screen',
      {
        generalMobile: { observe },
        providers: {
          responses,
          speech: speechProvider('Help me with this screen'),
        },
      },
    );
    const body = await response.json() as {
      generalMobile?: unknown;
      toolEvents: string[];
    };

    expect(response.status).toBe(200);
    expect(observe).not.toHaveBeenCalled();
    expect(body.generalMobile).toBeUndefined();
    expect(body.toolEvents).toEqual([]);
  });

  it('honors the Settings adapter kill switch on the coordinator path', async () => {
    const capture = vi.fn();
    const service = createGeneralMobileProductionServiceV2({
      androidSettingsPort: { capture },
    });
    service.controlAdapter({
      action: 'disable',
      actorId: 'coordinator-test',
      adapterId: androidSettingsReadOnlyAdapterIdV2,
      reason: 'Verify immediate production-path rollback.',
    });
    const responses = structuredFinishProvider(
      'settings-disabled-response',
      'Checking Settings.',
    );

    const response = await coordinateVoiceTurn(
      requestWithAudio(`settings-disabled-${crypto.randomUUID()}`),
      'request-settings-disabled',
      {
        generalMobile: service,
        providers: {
          responses,
          speech: speechProvider('Explain this Settings screen'),
        },
      },
    );
    const body = await response.json() as {
      generalMobile: { explanation: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
    expect(body.generalMobile).toMatchObject({
      explanation:
        'Settings screen help is unavailable right now. No phone setting was changed.',
      status: 'unavailable',
    });
  });

  it('passes request cancellation into Settings observation', async () => {
    const observe = vi.fn(async (input: { isCancelled?: () => boolean }) => ({
      status: 'cancelled' as const,
      explanation: input.isCancelled?.()
        ? 'Screen observation was cancelled.'
        : 'Cancellation was not propagated.',
    }));
    const responses = structuredFinishProvider(
      'settings-cancel-response',
      'Checking Settings.',
    );

    const response = await coordinateVoiceTurn(
      requestWithAudio(`settings-cancel-${crypto.randomUUID()}`),
      'request-settings-cancel',
      {
        generalMobile: { observe },
        providers: {
          responses,
          speech: speechProvider(
            'Cancel and explain this Settings screen',
          ),
        },
      },
    );
    const body = await response.json() as {
      generalMobile: { explanation: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(observe).toHaveBeenCalledOnce();
    expect(body.generalMobile).toMatchObject({
      explanation: 'Screen observation was cancelled.',
      status: 'cancelled',
    });
  });

  it('maps an injected provider failure without mutating workflow state', async () => {
    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => {
        throw new Error('model unavailable');
      }),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(`coordinator-failure-${crypto.randomUUID()}`),
      'request-coordinator-failure',
      { providers: { responses, speech: speechProvider() } },
    );
    const body = await response.json() as { error: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe('model unavailable');
  });

  it('keeps Realtime suppressed while the V2 planner stays authoritative', async () => {
    vi.stubEnv('JALDI_REALTIME_SHADOW_V1', 'true');
    vi.stubEnv('JALDI_REALTIME_CONTROL_V1', 'true');
    const responses = structuredFinishProvider(
      'responses-authority',
      'Hello from Responses.',
    );
    const realtime: RealtimeControlProvider = {
      cancelResponse: vi.fn(async () => false),
      createResponse: vi.fn(async () => ({
        response: {
          id: 'realtime-shadow',
          output_text: 'Hello from Realtime.',
        },
        version: 1 as const,
      })),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio('pixel-overlay'),
      'request-shadow-coordinator',
      { providers: { realtime, responses, speech: speechProvider() } },
    );
    const body = await response.json() as { reply: string };

    expect(response.status).toBe(200);
    expect(body.reply).toBe('Hello from Responses.');
    expect(realtime.cancelResponse).toHaveBeenCalledWith('pixel-overlay');
    expect(realtime.createResponse).not.toHaveBeenCalled();
  });
});
