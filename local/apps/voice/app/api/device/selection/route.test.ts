import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FileBackedPhoneTaskRepositoryV2,
  InMemoryPhoneTaskRepositoryV2,
  transitionPhoneTaskV2,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
} from '../../../../lib/workflow/v2';
import { validTaskV2 } from '../../../../lib/workflow/v2/test-fixtures';
import type {
  ResponsesProvider,
  SpeechProvider,
} from '../../../../lib/voice-turn/provider-adapters';
import {
  handleVoiceTurnRequest,
} from '../../voice/turn/route';
import { handleProductSelectionRequest } from './route';

const temporaryDirectories: string[] = [];
const taskId = `task_${crypto.randomUUID()}` as const;
const interactionId = `clarification_${crypto.randomUUID()}`;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

function waitingTask(input: {
  expiresAt?: number;
  revision?: number;
} = {}): PhoneTaskV2 {
  const source = validTaskV2();
  source.taskId = taskId;
  source.clientId = 'pixel-overlay';
  source.activeStepId = 'step:milk';
  source.steps = [{
    stepId: 'step:milk',
    adapterId: 'blinkit',
    kind: 'add_cart_item',
    status: 'ready',
    dependsOn: [],
    input: {
      action: 'add_cart_item',
      quantity: 2,
      request: 'milk',
    },
    expectedPostcondition: { kind: 'cart_contains_product' },
    attempts: 0,
  }];
  source.revision = input.revision ?? 0;
  source.updatedAt = 1;
  return transitionPhoneTaskV2(source, {
    type: 'wait_for_user',
    stepId: 'step:milk',
    entryId: 'journal:product-choice',
    at: 2,
    interaction: {
      interactionId,
      taskId,
      taskRevision: (input.revision ?? 0) + 1,
      kind: 'product_choice',
      allowedResponses: [{
        offerId: 'offer_milk_500',
        priceAmount: 29,
        priceCurrency: 'INR',
        product: 'Amul Taaza Toned Milk',
        size: '500 ml',
        spokenLabel: 'Amul Taaza 500 ml',
      }, {
        offerId: 'offer_milk_1l',
        priceAmount: 55,
        priceCurrency: 'INR',
        product: 'Amul Taaza Toned Milk',
        size: '1 L',
        spokenLabel: 'Amul Taaza 1 litre',
      }],
      presentationRef: 'presentation:milk',
      status: 'open',
      createdAt: 2,
      expiresAt: input.expiresAt ?? 100,
    },
  });
}

async function createTask(
  repository: PhoneTaskRepositoryV2,
  task: PhoneTaskV2 = waitingTask(),
): Promise<void> {
  await repository.create({
    task,
    event: {
      eventId: 'repository-event:waiting',
      taskId: task.taskId,
      taskRevision: task.revision,
      at: task.updatedAt,
      kind: 'waiting_for_product_choice',
    },
  });
}

async function fixture(input: {
  now?: number;
  repository?: PhoneTaskRepositoryV2;
  task?: PhoneTaskV2;
} = {}) {
  const now = input.now ?? 50;
  const repository = input.repository
    ?? new InMemoryPhoneTaskRepositoryV2({ now: () => now });
  const task = input.task ?? waitingTask();
  await createTask(repository, task);
  const execute = vi.fn().mockResolvedValue({
    ok: true,
    status: 'added',
    verification: {
      directControl: 'changed',
      mutationAttempted: true,
      outcome: 'verified_success',
      reconciliation: 'verified',
      unrelatedCartPreserved: true,
    },
  });
  return {
    dependencies: {
      execute,
      now: () => now,
      repository,
    },
    execute,
    repository,
    task,
  };
}

function selectionRequest(input: {
  clientId?: string;
  interactionId?: string;
  offerId?: string;
  selectionId?: string;
  source?: 'tap' | 'voice';
  taskId?: string;
  taskRevision?: number;
  version?: number;
} = {}): Request {
  return new Request('http://localhost/api/device/selection', {
    body: JSON.stringify({
      clientId: input.clientId ?? 'pixel-overlay',
      interactionId: input.interactionId ?? interactionId,
      offerId: input.offerId ?? 'offer_milk_500',
      selectionId: input.selectionId
        ?? `selection_${crypto.randomUUID()}`,
      source: input.source ?? 'tap',
      taskId: input.taskId ?? taskId,
      taskRevision: input.taskRevision ?? 1,
      version: input.version ?? 2,
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function responseBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function voiceRequest(clientId: string): Request {
  const form = new FormData();
  form.set('audio', new File(['voice'], 'choice.m4a', {
    type: 'audio/mp4',
  }));
  form.set('clientId', clientId);
  return new Request('http://localhost/api/voice/turn', {
    body: form,
    headers: { 'x-request-id': 'request-route-race-voice' },
    method: 'POST',
  });
}

describe('device V2 product-selection endpoint', () => {
  it('atomically resolves the interaction, persists the selected step input, and executes it once', async () => {
    const test = await fixture();
    const response = await handleProductSelectionRequest(
      selectionRequest(),
      test.dependencies,
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toMatchObject({
      acknowledgement: 'accepted',
      interactionId,
      mutationDisposition: 'enqueued_once',
      resolution: {
        offer: {
          offerId: 'offer_milk_500',
          packSize: '500 ml',
          priceAmount: 29,
        },
      },
      taskRevision: 4,
      version: 2,
    });
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(test.execute).toHaveBeenCalledWith({
      action: 'add_cart_item',
      offerId: 'offer_milk_500',
      quantity: 2,
      request: 'Amul Taaza Toned Milk',
      searchQuery: 'milk',
      selectedOffer: {
        offerId: 'offer_milk_500',
        packSize: '500 ml',
        priceAmount: 29,
        priceCurrency: 'INR',
        title: 'Amul Taaza Toned Milk',
      },
    }, expect.objectContaining({
      protocolVersion: 2,
      stepKey: 'step:milk',
      taskId,
      taskRevision: 3,
    }));
    const stored = await test.repository.getById(taskId);
    expect(stored?.task.steps[0]).toMatchObject({
      input: {
        action: 'add_cart_item',
        offerId: 'offer_milk_500',
      },
      status: 'verified',
    });
    expect(stored?.task.journal.map((entry) => entry.type)).toEqual([
      'wait_for_user',
      'resolve_interaction',
      'begin_step',
      'verify_step',
    ]);
  });

  it('turns a visible search phase into one exact selected add', async () => {
    const task = waitingTask();
    task.steps[0]!.kind = 'search_products';
    const test = await fixture({ task });

    const response = await handleProductSelectionRequest(
      selectionRequest(),
      test.dependencies,
    );

    expect(response.status).toBe(200);
    expect(test.execute).toHaveBeenCalledOnce();
    expect(test.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'add_cart_item',
        offerId: 'offer_milk_500',
      }),
      expect.any(Object),
    );
    expect((await test.repository.getById(taskId))?.task.steps[0])
      .toMatchObject({
        kind: 'add_cart_item',
        status: 'verified',
      });
  });

  it.each([
    ['tap', 'voice'],
    ['voice', 'tap'],
  ] as const)(
    'serializes a %s/%s race at the V2 repository revision',
    async (firstSource, secondSource) => {
      let entered = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const repository = new InMemoryPhoneTaskRepositoryV2({
        now: () => 50,
        beforeCommit: async (operation) => {
          if (operation !== 'commit') return;
          entered += 1;
          if (entered === 2) release();
          await gate;
        },
      });
      const test = await fixture({ repository });
      const responses = await Promise.all([
        handleProductSelectionRequest(selectionRequest({
          selectionId: `selection_${crypto.randomUUID()}`,
          source: firstSource,
        }), test.dependencies),
        handleProductSelectionRequest(selectionRequest({
          selectionId: `selection_${crypto.randomUUID()}`,
          source: secondSource,
        }), test.dependencies),
      ]);
      const bodies = await Promise.all(responses.map(responseBody));

      expect(bodies.filter(
        (body) => body['acknowledgement'] === 'accepted',
      )).toHaveLength(1);
      expect(bodies.filter(
        (body) => body['acknowledgement'] === 'rejected',
      )).toHaveLength(1);
      expect(bodies.find(
        (body) => body['acknowledgement'] === 'rejected',
      )).toMatchObject({ reason: 'already_resolved' });
      expect(test.execute).toHaveBeenCalledTimes(1);
    },
  );

  it('returns one authoritative winner from a real voice-route/card-route race without calling OpenAI', async () => {
    const now = Date.now();
    let armed = false;
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new InMemoryPhoneTaskRepositoryV2({
      now: () => now,
      beforeCommit: async (operation) => {
        if (!armed || operation !== 'commit') return;
        entered += 1;
        if (entered === 2) release();
        await gate;
      },
    });
    const task = waitingTask({ expiresAt: now + 60_000 });
    await createTask(repository, task);
    armed = true;

    const responses: ResponsesProvider = {
      createResponse: vi.fn(async () => {
        throw new Error('OpenAI must not run for an exact visible choice.');
      }),
    };
    const speech: SpeechProvider = {
      synthesize: vi.fn(async () => ({
        audioBase64: 'AQID',
        audioType: 'audio/mpeg',
      })),
      transcribe: vi.fn(async () => ({
        language_code: 'en-IN',
        transcript: 'the first one',
      })),
    };
    const execute = vi.fn(async () => ({
      ok: true,
      product: 'selected product',
      status: 'added',
      verification: { outcome: 'verified_success' },
    }) as any);

    const [voiceResponse, cardResponse] = await Promise.all([
      handleVoiceTurnRequest(voiceRequest('pixel-overlay'), {
        coordinator: {
          executePhone: execute,
          providers: { responses, speech },
          repository,
        },
        recover: vi.fn(async () => undefined),
      }),
      handleProductSelectionRequest(selectionRequest({
        offerId: 'offer_milk_1l',
        selectionId: `selection_${crypto.randomUUID()}`,
        source: 'tap',
      }), {
        execute,
        now: () => now,
        repository,
      }),
    ]);
    const bodies = await Promise.all([
      responseBody(voiceResponse),
      responseBody(cardResponse),
    ]);
    const accepted = bodies.find(
      (body) => body['acknowledgement'] === 'accepted',
    );
    const rejected = bodies.find(
      (body) => body['acknowledgement'] === 'rejected',
    );

    expect([voiceResponse.status, cardResponse.status].sort()).toEqual([
      200,
      409,
    ]);
    expect(accepted).toBeDefined();
    expect(accepted).toMatchObject({
      acknowledgement: 'accepted',
      mutationDisposition: 'enqueued_once',
      ok: true,
      status: 'accepted',
    });
    expect(rejected).toMatchObject({
      acknowledgement: 'rejected',
      mutationDisposition: 'none',
      ok: false,
      reason: 'already_resolved',
      status: 'conflict',
      winner: accepted?.['winner'],
    });
    expect(accepted?.['winner']).toMatchObject({
      offerId: expect.stringMatching(/^offer_milk_(?:500|1l)$/),
      responseRef: expect.stringMatching(/^product-choice-v2:/),
      selectionId: expect.stringMatching(/^selection_/),
      source: expect.stringMatching(/^(?:tap|voice)$/),
    });
    expect(responses.createResponse).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('makes an exact retry duplicate and rejects a different winner', async () => {
    const test = await fixture();
    const selectionId = `selection_${crypto.randomUUID()}`;
    const request = () => selectionRequest({ selectionId });

    expect((await handleProductSelectionRequest(
      request(),
      test.dependencies,
    )).status).toBe(200);
    const duplicate = await handleProductSelectionRequest(
      request(),
      test.dependencies,
    );
    expect(await responseBody(duplicate)).toMatchObject({
      acknowledgement: 'duplicate',
      mutationDisposition: 'none',
      ok: true,
      selectionId,
      status: 'duplicate',
    });

    const conflict = await handleProductSelectionRequest(
      selectionRequest({ offerId: 'offer_milk_1l' }),
      test.dependencies,
    );
    expect(conflict.status).toBe(409);
    expect(await responseBody(conflict)).toMatchObject({
      acknowledgement: 'rejected',
      mutationDisposition: 'none',
      ok: false,
      reason: 'already_resolved',
      status: 'conflict',
      winner: expect.objectContaining({
        offerId: 'offer_milk_500',
        selectionId,
      }),
    });
    expect(test.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves duplicate detection across a repository restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'selection-v2-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'tasks.json');
    const firstRepository = new FileBackedPhoneTaskRepositoryV2(
      filePath,
      { now: () => 50 },
    );
    const first = await fixture({ repository: firstRepository });
    const selectionId = `selection_${crypto.randomUUID()}`;
    expect((await handleProductSelectionRequest(
      selectionRequest({ selectionId }),
      first.dependencies,
    )).status).toBe(200);

    const restartedRepository = new FileBackedPhoneTaskRepositoryV2(
      filePath,
      { now: () => 50 },
    );
    const retryExecute = vi.fn();
    const retry = await handleProductSelectionRequest(
      selectionRequest({ selectionId }),
      {
        execute: retryExecute,
        now: () => 50,
        repository: restartedRepository,
      },
    );

    expect(await responseBody(retry)).toMatchObject({
      acknowledgement: 'duplicate',
      mutationDisposition: 'none',
    });
    expect(retryExecute).not.toHaveBeenCalled();
    expect((await restartedRepository.getById(taskId))?.task.revision)
      .toBe(4);
  });

  it('rejects stale revision, wrong binding, expiry, and unknown offers without execution', async () => {
    const stale = await fixture();
    const staleResponse = await handleProductSelectionRequest(
      selectionRequest({ taskRevision: 0 }),
      stale.dependencies,
    );
    expect(staleResponse.status).toBe(409);
    expect(await responseBody(staleResponse)).toMatchObject({
      actualRevision: 1,
      reason: 'stale_task_revision',
    });

    const wrongInteraction = await fixture();
    const wrongResponse = await handleProductSelectionRequest(
      selectionRequest({ interactionId: 'interaction_wrong_12345678' }),
      wrongInteraction.dependencies,
    );
    expect(wrongResponse.status).toBe(404);
    expect(await responseBody(wrongResponse)).toMatchObject({
      reason: 'unknown_interaction',
    });

    const expired = await fixture({
      now: 50,
      task: waitingTask({ expiresAt: 50 }),
    });
    const expiredResponse = await handleProductSelectionRequest(
      selectionRequest(),
      expired.dependencies,
    );
    expect(expiredResponse.status).toBe(409);
    expect(await responseBody(expiredResponse)).toMatchObject({
      reason: 'expired',
    });

    const unknown = await fixture();
    const unknownResponse = await handleProductSelectionRequest(
      selectionRequest({ offerId: 'offer_not_on_card' }),
      unknown.dependencies,
    );
    expect(unknownResponse.status).toBe(422);
    expect(await responseBody(unknownResponse)).toMatchObject({
      reason: 'unknown_offer',
    });

    expect(stale.execute).not.toHaveBeenCalled();
    expect(wrongInteraction.execute).not.toHaveBeenCalled();
    expect(expired.execute).not.toHaveBeenCalled();
    expect(unknown.execute).not.toHaveBeenCalled();
  });

  it('rejects malformed V1 metadata and client/task mismatches', async () => {
    const test = await fixture();
    const malformed = await handleProductSelectionRequest(
      selectionRequest({ version: 1 }),
      test.dependencies,
    );
    expect(malformed.status).toBe(400);
    expect(await responseBody(malformed)).toMatchObject({
      reason: 'malformed_selection_request',
    });

    const wrongClient = await handleProductSelectionRequest(
      selectionRequest({ clientId: 'other-client' }),
      test.dependencies,
    );
    expect(wrongClient.status).toBe(403);
    expect(await responseBody(wrongClient)).toMatchObject({
      reason: 'client_task_mismatch',
    });

    const unknownTask = await handleProductSelectionRequest(
      selectionRequest({ taskId: `task_${crypto.randomUUID()}` }),
      test.dependencies,
    );
    expect(unknownTask.status).toBe(404);
    expect(await responseBody(unknownTask)).toMatchObject({
      reason: 'unknown_task',
    });
  });
});
