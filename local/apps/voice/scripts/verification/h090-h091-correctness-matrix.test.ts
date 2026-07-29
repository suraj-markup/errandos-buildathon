import { describe, expect, it, vi } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { buildCodCheckoutProposal } from '../../lib/cod';
import {
  CheckoutConfirmationGrantLedgerV2,
  checkoutFinalActionDigestV2,
} from '../../lib/checkout/v2/confirmation-grants';
import type {
  CartSnapshotV2,
  DesiredCartStateV2,
} from '../../lib/execution/v2/contracts';
import { CartMutationExecutionTruthServiceV2 } from '../../lib/execution/v2/cart-mutation-execution-truth';
import { OperationIdempotencyRegistryV2 } from '../../lib/execution/v2/idempotency-records';
import {
  assessRestrictedScreen,
  sanitizeSemanticText,
} from '../../lib/grounding/privacy';
import { capabilityCatalogV2 } from '../../lib/policy/v2/capability-catalog';
import { evaluatePhoneActionPolicyV2 } from '../../lib/policy/v2/policy-engine';
import {
  RetainedTaskEventStreamV2,
  TaskEventCursorV2,
} from '../../lib/progress/v2/retained-task-event-stream';
import {
  resolveRealtimeRolloutPolicy,
  runGuardedRealtimeControl,
} from '../../lib/realtime/rollout-controller';
import {
  RealtimeControlSession,
  type RealtimeEventTransport,
} from '../../lib/realtime/control-session';
import { parseLocalIdentifier } from '../../lib/workflow/identifiers';
import {
  resolveV2InteractionForCompatibility,
} from '../../lib/workflow/v2/execution-bridge';
import {
  InvalidPhoneTaskV2TransitionError,
  transitionPhoneTaskV2,
} from '../../lib/workflow/v2/graph';
import {
  applyModelPlanPatchV2,
  type ModelPlanPatchV2,
} from '../../lib/workflow/v2/plan-patch';
import { assemblePlannerContextV2 } from '../../lib/workflow/v2/planner-context';
import { ProductionTaskRecoveryReconcilerV2 } from '../../lib/workflow/v2/production-recovery-reconciler';
import { recoverRepositoryOnStartupV2 } from '../../lib/workflow/v2/recovery';
import {
  InMemoryPhoneTaskRepositoryV2,
  TaskRevisionConflictV2Error,
} from '../../lib/workflow/v2/repository';
import { validTaskV2 } from '../../lib/workflow/v2/test-fixtures';
import { OpenAILlmPlannerV2 } from '../../lib/voice-turn/llm-planner-v2';
import type {
  OpenAIResponse,
  ResponsesProvider,
} from '../../lib/voice-turn/provider-adapters';
import {
  adversarialModelOutputs,
  h090H091CorrectnessMatrix,
} from '../../test-fixtures/h090-h091-model-cases';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const itemId = parseLocalIdentifier(
  'task_item',
  'task_item_12345678-1234-1234-1234-123456789abc',
);
const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);
const NOW = Date.parse('2026-07-28T06:00:00.000Z');

function response(value: Record<string, unknown>, id = 'planner-response'): OpenAIResponse {
  return {
    id,
    output: [{
      type: 'function_call',
      name: 'submit_phone_plan_v2',
      call_id: `${id}-call`,
      arguments: JSON.stringify(value),
    }],
  };
}

function providerSequence(
  ...values: readonly Record<string, unknown>[]
): ResponsesProvider & { createResponse: ReturnType<typeof vi.fn> } {
  const createResponse = vi.fn();
  values.forEach((value, index) => {
    createResponse.mockResolvedValueOnce(response(value, `planner-${index}`));
  });
  return { createResponse };
}

function plannerInput(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'pixel-overlay',
    explicitExactConfirmation: false,
    languageCode: 'en-IN',
    model: 'gpt-4.1-mini',
    requestId: 'h091-request',
    taskRevision: 4,
    taskStatus: 'active' as const,
    transcript: 'Continue',
    ...overrides,
  };
}

function verifiedFirstTask() {
  const running = transitionPhoneTaskV2(validTaskV2(), {
    type: 'begin_step',
    stepId: 'step:first',
    operationId: 'operation:first',
    entryId: 'journal:begin-first',
    at: 2,
  });
  return transitionPhoneTaskV2(running, {
    type: 'verify_step',
    stepId: 'step:first',
    resultRef: 'result:first',
    entryId: 'journal:verify-first',
    at: 3,
  });
}

function desiredCart(): DesiredCartStateV2 {
  return {
    version: 2,
    taskId,
    itemId,
    stepKey: 'item.0.add',
    offerId: 'offer_milk',
    targetQuantity: 1,
  };
}

function cartSnapshot(
  observationId: string,
  capturedAt: number,
  quantity: number,
): CartSnapshotV2 {
  return {
    version: 2,
    observationId,
    capturedAt,
    lines: quantity > 0
      ? [{ offerId: 'offer_milk', quantity }]
      : [],
  };
}

const money = (amount: number) => ({ amount, currency: 'INR' as const });

function checkoutTerms(
  overrides: Partial<AndroidCheckoutReviewV1> = {},
): AndroidCheckoutReviewV1 {
  return {
    addressLabel: 'Home',
    addressReference: 'address_home',
    etaMinutes: 12,
    fees: [{ amount: money(5), kind: 'handling', label: 'Handling' }],
    lines: [{
      lineTotal: money(33),
      name: 'Milk',
      productId: 'milk',
      quantity: 1,
      unitPrice: money(33),
    }],
    paymentMode: 'cod',
    providerFingerprint: 'c'.repeat(64),
    total: money(38),
    unavailableItems: [],
    ...overrides,
  };
}

describe('H090-H091 verification manifest', () => {
  it('has one unique entry for every required correctness and adversarial case', () => {
    expect(h090H091CorrectnessMatrix).toHaveLength(18);
    expect(new Set(h090H091CorrectnessMatrix.map(({ id }) => id)).size)
      .toBe(h090H091CorrectnessMatrix.length);
    expect(h090H091CorrectnessMatrix.filter(
      ({ expected }) => expected === 'known_gap',
    )).toEqual([]);
  });
});

describe('H090 automated correctness matrix', () => {
  it('H090-task-graph activates dependencies without changing verified work', () => {
    const verified = verifiedFirstTask();
    const next = verified.steps[1];

    expect(verified.steps[0]).toMatchObject({
      stepId: 'step:first',
      status: 'verified',
      lastResultRef: 'result:first',
    });
    expect(next).toMatchObject({
      stepId: 'step:second',
      status: 'ready',
      dependsOn: ['step:first'],
    });
  });

  it('H090-plan-patches rejects stale patches and preserves verified work', () => {
    const task = verifiedFirstTask();
    const verified = structuredClone(task.steps[0]);
    const patch: ModelPlanPatchV2 = {
      version: 2,
      patchId: 'patch:add-bread',
      taskId: task.taskId,
      baseRevision: task.revision,
      reasonRef: 'planner:h090',
      proposedAt: 3,
      operations: [{
        type: 'add_step',
        step: {
          stepId: 'step:bread',
          adapterId: 'test-adapter',
          kind: 'add_item',
          status: 'planned',
          dependsOn: ['step:first'],
          input: { subject: 'bread' },
          expectedPostcondition: { kind: 'item_added', subject: 'bread' },
          attempts: 0,
        },
        beforeStepIds: ['step:second'],
      }],
    };
    const next = applyModelPlanPatchV2({
      task,
      patch,
      appliedAt: 4,
      journalEntryId: 'journal:patch-bread',
    });

    expect(next.steps[0]).toEqual(verified);
    expect(next.steps.map(({ stepId }) => stepId))
      .toEqual(['step:first', 'step:bread', 'step:second']);
    expect(() => applyModelPlanPatchV2({
      task: next,
      patch,
      appliedAt: 5,
      journalEntryId: 'journal:stale-patch',
    })).toThrow('stale');
  });

  it('H090-context-truncation retains goal, graph, continuation, and newest turn', () => {
    const task = validTaskV2();
    task.originalGoal = 'Add milk and bread, then review checkout using COD';
    task.desiredTerminalOutcome = {
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    };
    const dialogue = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      text: `turn-${index}-${'x'.repeat(80)}`,
      at: index,
    }));
    const context = assemblePlannerContextV2({
      task,
      capabilities: Array.from({ length: 10 }, (_, index) => ({
        capabilityId: `capability:${index}`,
        description: `Capability ${index}`,
      })),
      recentDialogue: dialogue,
    }, {
      maxCapabilities: 2,
      maxDialogueCharacters: 220,
      maxDialogueTurns: 3,
      maxCharacters: 8_000,
    });

    expect(context.task.originalGoal).toBe(task.originalGoal);
    expect(context.task.desiredTerminalOutcome).toEqual({
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    });
    expect(context.graph.map(({ stepId }) => stepId))
      .toEqual(['step:first', 'step:second']);
    expect(context.recentDialogue.at(-1)?.text).toContain('turn-19');
    expect(context.recentDialogue.length).toBeLessThanOrEqual(3);
    expect(context.omitted).toMatchObject({
      capabilities: 8,
      dialogueTurns: dialogue.length - context.recentDialogue.length,
    });
  });

  it('H090-capability-policy blocks stale targeting and forces reconciliation', () => {
    expect(evaluatePhoneActionPolicyV2({
      action: {
        actionDigest: 'digest-payment',
        adapterId: 'blinkit',
        capability: 'select_payment_method',
        idempotencyKey: 'key-payment',
        sourceObservationId: 'observation-old',
      },
      availableCapabilities: [
        capabilityCatalogV2.select_payment_method,
      ],
      currentTaskRevision: 4,
      now: 1_000,
      observation: {
        adapterId: 'blinkit',
        capturedAt: 100,
        expiresAt: 999,
        observationId: 'observation-old',
        restricted: false,
      },
    })).toEqual({
      decision: 'block',
      reason: 'observation_stale',
    });
    expect(evaluatePhoneActionPolicyV2({
      action: {
        actionDigest: 'digest-add',
        adapterId: 'blinkit',
        capability: 'add_cart_item',
        idempotencyKey: 'key-add',
      },
      availableCapabilities: [capabilityCatalogV2.add_cart_item],
      currentTaskRevision: 4,
      unresolvedMutation: {
        operationId: 'operation:ambiguous',
        outcome: 'ambiguous',
      },
    })).toEqual({
      decision: 'reconcile',
      operationId: 'operation:ambiguous',
      reason: 'unresolved_mutation',
    });
  });

  it('H090-idempotency and H090-reconciliation execute once and require a fresh read', () => {
    const desired = desiredCart();
    const before = cartSnapshot('observation-before', 100, 0);
    const truth = new CartMutationExecutionTruthServiceV2(
      new OperationIdempotencyRegistryV2({
        newOperationId: () => operationId,
        now: () => 500,
      }),
    );

    expect(truth.prepare({ before, callId: 'call-a', desired }))
      .toMatchObject({ action: 'execute', retry: false });
    expect(truth.finish({
      before,
      desired,
      operationId,
      result: {
        kind: 'mutation_unverified',
        reason: 'verification_interrupted',
      },
    }).action).toBe('reconcile');
    expect(truth.prepare({ before, callId: 'call-b', desired }).action)
      .toBe('reconcile');
    expect(truth.reconcile({
      before,
      current: cartSnapshot('observation-stale', 100, 0),
      desired,
      operationId,
    }).action).toBe('inspect_again');
    expect(truth.reconcile({
      before,
      current: cartSnapshot('observation-success', 200, 1),
      desired,
      operationId,
    }).action).toBe('advance');
    expect(truth.prepare({
      before: cartSnapshot('observation-later', 300, 1),
      callId: 'call-c',
      desired,
    }).action).toBe('completed');
  });

  it('H090-progress-ordering is monotonic, cursor-safe, and duplicate-safe', () => {
    let event = 0;
    const stream = new RetainedTaskEventStreamV2({
      now: () => NOW,
      newEventId: () => `event-${event++}`,
    });
    const started = stream.publish({
      taskId,
      taskRevision: 1,
      kind: 'task_started',
      title: 'Task started',
      dedupeKey: 'task-started',
    });
    const verified = stream.publish({
      taskId,
      taskRevision: 2,
      kind: 'mutation_verified',
      title: 'Milk added',
      dedupeKey: 'milk-verified',
    });
    const moving = stream.publish({
      taskId,
      taskRevision: 2,
      kind: 'moving_to_next_step',
      title: 'Searching for bread',
      dedupeKey: 'moving-bread',
    });
    const duplicate = stream.publish({
      taskId,
      taskRevision: 2,
      kind: 'mutation_verified',
      title: 'Different duplicate copy',
      dedupeKey: 'milk-verified',
    });

    expect([started.sequence, verified.sequence, moving.sequence])
      .toEqual([0, 1, 2]);
    expect(duplicate).toEqual(verified);
    expect(stream.readAfter({ taskId, afterSequence: 0 }).events)
      .toEqual([verified, moving]);
    const cursor = new TaskEventCursorV2(taskId);
    expect(cursor.accept(started)).toEqual({ accepted: true, nextSequence: 1 });
    expect(cursor.accept(moving)).toEqual({
      accepted: false,
      reason: 'sequence_gap',
    });
    expect(cursor.accept(verified)).toEqual({ accepted: true, nextSequence: 2 });
    expect(cursor.accept(verified)).toEqual({
      accepted: false,
      reason: 'stale',
    });
  });

  it('H090-card-voice-race accepts exactly one response', async () => {
    const source = validTaskV2();
    source.taskId = taskId;
    const waiting = transitionPhoneTaskV2(source, {
      type: 'wait_for_user',
      stepId: 'step:first',
      entryId: 'interaction-opened:product-choice',
      at: NOW,
      interaction: {
        interactionId: 'interaction:product-choice',
        taskId,
        taskRevision: 1,
        kind: 'product_choice',
        allowedResponses: ['offer_milk_500', 'offer_milk_1000'],
        presentationRef: 'presentation:product-choice',
        status: 'open',
        createdAt: NOW,
        expiresAt: NOW + 60_000,
      },
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: () => NOW,
    });
    await repository.create({
      task: waiting,
      event: {
        eventId: 'task-waiting:product-choice',
        taskId,
        taskRevision: waiting.revision,
        at: NOW,
        kind: 'waiting_for_product_choice',
      },
    });

    const winner = await resolveV2InteractionForCompatibility({
      at: NOW + 1,
      repository,
      responseRef: 'product-choice:tap:milk-500',
      task: waiting,
    });
    expect(winner.task.revision).toBe(2);
    expect(winner.task.pendingInteraction).toBeUndefined();
    await expect(resolveV2InteractionForCompatibility({
      at: NOW + 2,
      repository,
      responseRef: 'product-choice:voice:milk-1000',
      task: waiting,
    })).rejects.toBeInstanceOf(TaskRevisionConflictV2Error);
  });

  it('H090-checkout-confirmation binds exact terms and consumes once', () => {
    const checkout = checkoutTerms();
    const proposal = buildCodCheckoutProposal(
      checkout,
      new Date(NOW),
      60_000,
    );
    const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => NOW });
    expect(() => ledger.issue({
      clientId: 'android-client-1',
      confirmationText: 'yes',
      ownerId: 'pixel-overlay',
      proposal,
      source: 'voice_coordinator',
      taskId,
      taskRevision: 8,
    })).toThrow('exact_confirmation_required');
    const grant = ledger.issue({
      clientId: 'android-client-1',
      confirmationText: 'Confirm COD order',
      ownerId: 'pixel-overlay',
      proposal,
      source: 'voice_coordinator',
      taskId,
      taskRevision: 8,
    });
    const authorization = {
      actionDigest: checkoutFinalActionDigestV2({
        clientId: 'android-client-1',
        ownerId: 'pixel-overlay',
        proposal,
        taskId,
        taskRevision: 8,
      }),
      clientId: 'android-client-1',
      currentTerms: checkout,
      grantId: grant.grantId,
      ownerId: 'pixel-overlay',
      paymentMode: 'cod',
      proposal,
      source: 'voice_coordinator' as const,
      taskId,
      taskRevision: 8,
    };
    expect(ledger.authorize({
      ...authorization,
      currentTerms: checkoutTerms({
        fees: [{ amount: money(7), kind: 'handling', label: 'Handling' }],
        total: money(40),
      }),
    })).toMatchObject({
      authorized: false,
      reason: 'proposal_changed',
    });
    expect(ledger.authorize(authorization)).toMatchObject({
      authorized: true,
      grant: { consumedAt: NOW },
    });
    expect(ledger.authorize(authorization)).toEqual({
      authorized: false,
      reason: 'already_consumed',
    });
  });

  it('H090-privacy rejects restricted screens and sensitive labels', () => {
    const source =
      '<hierarchy><node text="Enter the 6-digit verification code" /></hierarchy>';
    const result = assessRestrictedScreen({
      packageName: 'com.grofers.customerapp',
      source,
    });

    expect(result).toMatchObject({
      restricted: true,
      classes: expect.arrayContaining(['otp']),
      safeFallback: { kind: 'restricted_screen' },
    });
    expect(JSON.stringify(result)).not.toContain(source);
    expect(sanitizeSemanticText('Call +91 98765 43210')).toBeUndefined();
    expect(sanitizeSemanticText('Amul Taaza 500 ml')).toBe('Amul Taaza 500 ml');
  });

  it('H090-realtime-fallback invokes Responses once per failure or timeout', async () => {
    const policy = resolveRealtimeRolloutPolicy({
      broadTaskCohort: false,
      developerClient: true,
      flags: {
        realtimeControlV1: true,
        realtimePhoneToolsV1: false,
        realtimeShadowV1: true,
        screenshotObservationV1: false,
        visionGroundingV1: false,
      },
      requestedStage: 'developer_control',
    });
    const responses = vi.fn(async () => 'safe-fallback');

    await expect(runGuardedRealtimeControl({
      policy,
      realtime: async () => {
        throw new Error('provider failed');
      },
      responses,
      timeoutMs: 50,
    })).resolves.toMatchObject({
      fallbackReason: 'realtime_failure',
      pipeline: 'responses',
      value: 'safe-fallback',
    });
    await expect(runGuardedRealtimeControl({
      policy,
      realtime: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      responses,
      timeoutMs: 2,
    })).resolves.toMatchObject({
      fallbackReason: 'realtime_timeout',
      pipeline: 'responses',
      value: 'safe-fallback',
    });
    expect(responses).toHaveBeenCalledTimes(2);
  });

  it('H090-restart-recovery never replays final dispatch', async () => {
    const task = transitionPhoneTaskV2(validTaskV2(), {
      type: 'begin_step',
      stepId: 'step:first',
      operationId: 'operation:recovery',
      entryId: 'journal:begin-recovery',
      at: 2,
    });
    task.steps[0] = {
      ...task.steps[0]!,
      kind: 'add_cart_item',
      input: {
        request: 'Amul milk',
        quantity: 1,
        offerId: 'offer-milk',
      },
    };
    const source = new InMemoryPhoneTaskRepositoryV2({ now: () => 10 });
    await source.create({
      task,
      event: {
        eventId: 'repository:created',
        taskId: task.taskId,
        taskRevision: task.revision,
        at: 2,
        kind: 'task_created',
      },
      activeOperation: {
        operationId: 'operation:recovery',
        taskId: task.taskId,
        stepId: 'step:first',
        kind: 'add_cart_item',
        boundary: 'final_dispatch_attempted',
        status: 'running',
        updatedAt: 2,
      },
    });
    const restarted = new InMemoryPhoneTaskRepositoryV2({ now: () => 11 });
    await restarted.restoreSnapshot(await source.exportSnapshot());
    const replayMutation = vi.fn();
    const reports = await recoverRepositoryOnStartupV2({
      repository: restarted,
      reconciler: new ProductionTaskRecoveryReconcilerV2(replayMutation),
      now: () => 12,
    });

    expect(replayMutation).not.toHaveBeenCalled();
    expect(reports[0]).toMatchObject({
      outcome: 'final_dispatch_ambiguous',
    });
    expect((await restarted.getById(task.taskId))?.task.status)
      .toBe('ambiguous');
  });
});

describe('H091 adversarial model matrix', () => {
  it('H091-repeat-completed-add blocks the add and accepts one useful replan', async () => {
    const provider = providerSequence(
      adversarialModelOutputs.repeatedCompletedAdd,
      adversarialModelOutputs.safeCheckoutReplan,
    );
    const result = await new OpenAILlmPlannerV2(provider).plan(plannerInput({
      transcript: 'Now review checkout',
    }));

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(provider.createResponse.mock.calls[1]?.[0]?.input)
      .toContain('all_actions_rejected');
    expect(result.decision).toMatchObject({
      decision: 'ask_user',
      assistantMessage:
        'I can review checkout without repeating cart additions.',
    });
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('H091-claim-success rejects the claim and accepts one truthful replan', async () => {
    const provider = providerSequence(
      adversarialModelOutputs.ungroundedSuccessClaim,
      adversarialModelOutputs.safeConfirmationReplan,
    );
    const result = await new OpenAILlmPlannerV2(provider).plan(plannerInput());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(provider.createResponse.mock.calls[1]?.[0]?.input)
      .toContain('unsupported_transactional_success_claim');
    expect(result.decision.decision).toBe('ask_user');
    expect(result.translatedResponse.output_text)
      .not.toContain('placed successfully');
    expect(h090H091CorrectnessMatrix.find(
      ({ id }) => id === 'H091-claim-success',
    )?.expected).toBe('contained');
  });

  it('H091-raw-coordinates rejects the capability and accepts one useful replan', async () => {
    const provider = providerSequence(
      adversarialModelOutputs.rawCoordinates,
      adversarialModelOutputs.safeCoordinateReplan,
    );
    const result = await new OpenAILlmPlannerV2(provider).plan(plannerInput());

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(provider.createResponse.mock.calls[1]?.[0]?.input)
      .toContain('invalid_structured_decision');
    expect(result.decision.decision).toBe('ask_user');
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('H091-skip-confirmation blocks dispatch and accepts one useful replan', async () => {
    const provider = providerSequence(
      adversarialModelOutputs.skippedConfirmation,
      adversarialModelOutputs.safeConfirmationReplan,
    );
    const result = await new OpenAILlmPlannerV2(provider).plan(plannerInput({
      transcript: 'Yes',
    }));

    expect(provider.createResponse).toHaveBeenCalledTimes(2);
    expect(provider.createResponse.mock.calls[1]?.[0]?.input)
      .toContain('all_actions_rejected');
    expect(result.decision.decision).toBe('ask_user');
    expect(result.translatedResponse.output?.[0]?.type).toBe('message');
  });

  it('H091-late-response rejects a cancelled response as out of order', async () => {
    const transport: RealtimeEventTransport = {
      connect: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const session = new RealtimeControlSession(transport, {
      instructions: 'Use only typed, locally permitted actions.',
    });
    await session.connect();
    await session.submitTurn({ transcript: 'Add milk' });
    await expect(session.cancelResponse()).resolves.toBe(true);

    expect(() => session.receive({
      type: 'response.done',
      response: { output: 'late mutation proposal' },
    })).toThrow('Out-of-order Realtime event');
    expect(session.state).toBe('failed');
  });

  it('H091-stale-action rejects a stale patch without mutating the task', () => {
    const task = verifiedFirstTask();
    const snapshot = structuredClone(task);
    const patch: ModelPlanPatchV2 = {
      version: 2,
      patchId: 'patch:stale-model-output',
      taskId: task.taskId,
      baseRevision: task.revision - 1,
      reasonRef: 'planner:late',
      proposedAt: 3,
      operations: [{
        type: 'skip_step',
        stepId: 'step:second',
        reasonRef: 'reason:stale-model-output',
      }],
    };

    expect(() => applyModelPlanPatchV2({
      task,
      patch,
      appliedAt: 4,
      journalEntryId: 'journal:stale-model-output',
    })).toThrow('stale');
    expect(task).toEqual(snapshot);
    expect(() => transitionPhoneTaskV2(task, {
      type: 'skip_step',
      stepId: 'step:first',
      entryId: 'journal:rewrite-verified',
      at: 4,
    })).toThrow(InvalidPhoneTaskV2TransitionError);
  });
});
