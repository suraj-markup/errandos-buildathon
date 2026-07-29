import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_BUDGETS_V2,
  PHONE_TASK_V2_VERSION,
  InMemoryPhoneTaskRepositoryV2,
  type PhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import { parseLocalIdentifier } from '../../../../../lib/workflow/identifiers';
import {
  resolveProductSelectionInteractionV2,
} from '../../../../../lib/voice-turn/product-selection-interaction';
import { RetainedTaskEventStreamV2 } from '../../../../../lib/progress/v2';
import {
  handleProductChoicePolicyRequestV2,
  type ProductChoicePolicyRouteDependenciesV2,
} from './route';

const taskId = 'task_policyroute1';
const clientId = 'pixel-overlay';

function task(): PhoneTaskV2 {
  return {
    version: PHONE_TASK_V2_VERSION,
    taskId,
    clientId,
    revision: 0,
    originalGoal: 'Add milk',
    goalKind: 'grocery',
    status: 'active',
    activeStepId: 'step:milk',
    steps: [{
      stepId: 'step:milk',
      adapterId: 'blinkit',
      kind: 'search_products',
      status: 'ready',
      dependsOn: [],
      input: { action: 'add_cart_item', request: 'milk', quantity: 1 },
      expectedPostcondition: { kind: 'cart_contains' },
      attempts: 0,
    }],
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function dependencies():
Promise<ProductChoicePolicyRouteDependenciesV2> {
  const repository = new InMemoryPhoneTaskRepositoryV2();
  await repository.create({
    task: task(),
    event: {
      eventId: 'task-created',
      taskId,
      taskRevision: 0,
      at: 1,
      kind: 'task_created',
    },
  });
  return {
    now: () => 10,
    repository,
    stream: new RetainedTaskEventStreamV2({ now: () => 10 }),
  };
}

function request(body: unknown): Request {
  return new Request(
    'http://localhost/api/device/task/product-choice-policy',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function setBody(
  policy: unknown,
  revision = 0,
): Record<string, unknown> {
  return {
    version: 2,
    clientId,
    taskId,
    taskRevision: revision,
    operation: 'set',
    policy,
  };
}

describe('device product choice policy route v2', () => {
  it('sets a strict task-scoped policy and exposes only bounded state', async () => {
    const deps = await dependencies();
    const response = await handleProductChoicePolicyRequestV2(
      request(setBody({
        mode: 'repeat_previous_preference',
        previousPreference: {
          category: 'toned milk',
          brand: 'Amul',
          packSize: '500 ml',
          productForm: 'liquid',
        },
      })),
      deps,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      version: 2,
      acknowledgement: 'accepted',
      taskId,
      taskRevision: 1,
      policy: {
        configured: true,
        hasPreviousPreference: true,
        mode: 'repeat_previous_preference',
        preferredBrandCount: 0,
      },
    });
    expect(JSON.stringify(body)).not.toContain('Amul');
    expect(JSON.stringify(body)).not.toContain('toned milk');
    expect((await deps.repository.getById(taskId))?.task.productChoicePolicy)
      .toMatchObject({
        mode: 'repeat_previous_preference',
        previousPreference: { brand: 'Amul' },
      });
    expect(deps.stream.readAfter({
      taskId: taskId as never,
    }).events[0]).toMatchObject({
      kind: 'selection_accepted',
      title: 'Product choice preference updated',
      safePresentation: {
        card: { type: 'compact_status' },
      },
    });
  });

  it('clears to visible ask-every-time state', async () => {
    const deps = await dependencies();
    await handleProductChoicePolicyRequestV2(
      request(setBody({ mode: 'lowest_price_matching_pack' })),
      deps,
    );
    const response = await handleProductChoicePolicyRequestV2(request({
      version: 2,
      clientId,
      taskId,
      taskRevision: 1,
      operation: 'clear',
    }), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      taskRevision: 2,
      policy: {
        configured: false,
        mode: 'ask_every_time',
      },
    });
    expect((await deps.repository.getById(taskId))?.task.productChoicePolicy)
      .toBeUndefined();
  });

  it('rejects stale revision, foreign client, unknown keys, and PII-like policy text', async () => {
    const deps = await dependencies();
    const stale = await handleProductChoicePolicyRequestV2(
      request(setBody({ mode: 'ask_every_time' }, 2)),
      deps,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'stale_task_revision',
      actualRevision: 0,
    });

    const foreign = await handleProductChoicePolicyRequestV2(request({
      ...setBody({ mode: 'ask_every_time' }),
      clientId: 'different-client',
    }), deps);
    expect(foreign.status).toBe(403);

    const unknown = await handleProductChoicePolicyRequestV2(request({
      ...setBody({ mode: 'ask_every_time' }),
      rawScreenshot: 'not-allowed',
    }), deps);
    expect(unknown.status).toBe(400);

    const pii = await handleProductChoicePolicyRequestV2(request(setBody({
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['person@example.com'],
    })), deps);
    expect(pii.status).toBe(400);
    expect((await deps.repository.getById(taskId))?.task.revision).toBe(0);
  });

  it('allows one winner when two policy changes race on one revision', async () => {
    const deps = await dependencies();
    const responses = await Promise.all([
      handleProductChoicePolicyRequestV2(
        request(setBody({ mode: 'lowest_price_matching_pack' })),
        deps,
      ),
      handleProductChoicePolicyRequestV2(
        request(setBody({
          mode: 'known_brand_then_lowest_price',
          preferredBrands: ['Amul'],
        })),
        deps,
      ),
    ]);
    expect(responses.map((response) => response.status).sort())
      .toEqual([200, 409]);
    expect((await deps.repository.getById(taskId))?.task.revision).toBe(1);
  });

  it.each(['tap', 'voice'] as const)(
    'gives a policy change and an explicit %s choice one CAS winner',
    async (source) => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const waiting = task();
    waiting.status = 'waiting_for_user';
    waiting.steps[0] = {
      ...waiting.steps[0]!,
      status: 'waiting_for_user',
    };
    waiting.pendingInteraction = {
      interactionId: 'interaction-policy-race',
      taskId,
      taskRevision: 0,
      kind: 'product_choice',
      allowedResponses: [{
        offerId: 'offer-milk-500',
        product: 'Amul Taaza Toned Milk',
        size: '500 ml',
        priceAmount: 29,
        priceCurrency: 'INR',
      }],
      presentationRef: 'presentation-policy-race',
      status: 'open',
      createdAt: 1,
      expiresAt: 1_000,
    };
    await repository.create({
      task: waiting,
      event: {
        eventId: 'task-created',
        taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const deps: ProductChoicePolicyRouteDependenciesV2 = {
      now: (): number => 10,
      repository,
      stream: new RetainedTaskEventStreamV2({ now: (): number => 10 }),
    };
    const [policyResponse, selection] = await Promise.all([
      handleProductChoicePolicyRequestV2(
        request(setBody({ mode: 'lowest_price_matching_pack' })),
        deps,
      ),
      resolveProductSelectionInteractionV2({
        clientId,
        interactionId: 'interaction-policy-race',
        offerId: 'offer-milk-500',
        selectionId: parseLocalIdentifier(
          'selection',
          `selection_policyrace${source}`,
        ),
        source,
        taskId: parseLocalIdentifier('task', taskId),
        taskRevision: 0,
      }, {
        now: (): number => 10,
        repository,
      }),
    ]);

    const policyWon = policyResponse.status === 200;
    expect(
      policyWon
        ? selection.acknowledgement === 'rejected'
        : selection.acknowledgement === 'accepted',
    ).toBe(true);
    expect(policyWon ? policyResponse.status : policyResponse.status)
      .toBe(policyWon ? 200 : 409);
    const persisted = (await repository.getById(taskId))!.task;
    expect(persisted.revision).toBe(1);
    expect(persisted.steps[0]?.status).not.toBe('running');
    expect(persisted.journal).not.toContainEqual(
      expect.objectContaining({ type: 'mutation_attempted' }),
    );
    },
  );
});
