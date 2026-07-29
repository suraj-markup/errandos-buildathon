import { describe, expect, it, vi } from 'vitest';
import { OverlayPresentationSchemaV1 } from '@errandos/contracts';
import {
  AppiumSessionPool,
  type AppiumHttpClient,
} from '@errandos/provider-connectors';
import {
  BlinkitExecutionService,
  type BlinkitExecutionSubstageMetric,
} from '../../../blinkit-execution';
import {
  executePhoneActionWithService,
  type ReversibleBlinkitExecutionPort,
} from '../../../phone-tool';
import { RetainedTaskEventStreamV2 } from '../../../progress/v2/retained-task-event-stream';
import {
  DeterministicUxTimingMetricsCollectorV1,
} from '../../../ux-timing-metrics';
import { parseLocalIdentifier } from '../../identifiers';
import {
  DEFAULT_TASK_BUDGETS_V2,
  PHONE_TASK_V2_VERSION,
  type PhoneTaskV2,
} from '../contracts';
import {
  beginV2CompatibilityExecution,
  markV2CompatibilityMutationAttempted,
} from '../execution-bridge';
import { transitionPhoneTaskV2 } from '../graph';
import { buildNextActionStepV2 } from '../next-action-lifecycle';
import { recoverRepositoryOnStartupV2 } from '../recovery';
import { InMemoryPhoneTaskRepositoryV2 } from '../repository';
import {
  enqueueProductionBackgroundPhoneOperationV2,
} from './production-adapter';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
} from './store';

const taskId = parseLocalIdentifier('task', 'task_production01');
const operationId = parseLocalIdentifier(
  'operation',
  'operation_production01',
);
const itemId = parseLocalIdentifier('task_item', 'task_item_production01');
const stepId = 'step:product';

function initialTask(kind = 'add_cart_item'): PhoneTaskV2 {
  return {
    version: PHONE_TASK_V2_VERSION,
    taskId,
    clientId: 'production-adapter-test',
    revision: 0,
    originalGoal: 'Add the selected milk',
    goalKind: 'grocery',
    status: 'active',
    activeStepId: stepId,
    steps: [{
      stepId,
      adapterId: 'blinkit',
      kind,
      status: 'ready',
      dependsOn: [],
      input: {},
      expectedPostcondition: {},
      attempts: 0,
    }],
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function begunTask(
  repository: InMemoryPhoneTaskRepositoryV2,
  kind = 'add_cart_item',
): Promise<PhoneTaskV2> {
  const task = initialTask(kind);
  await repository.create({
    task,
    event: {
      eventId: 'task-created',
      taskId,
      taskRevision: 0,
      at: 1,
      kind: 'task_created',
    },
  });
  return (
    await beginV2CompatibilityExecution({
      operationId,
      repository,
      stepId,
      task,
    })
  ).task;
}

function exactAddPayload(): unknown {
  return {
    version: 1,
    action: {
      action: 'add_cart_item',
      offerId: 'offer-milk-500',
      quantity: 1,
      request: 'Amul milk',
      searchQuery: 'milk',
      selectedOffer: {
        offerId: 'offer-milk-500',
        title: 'Amul Taaza Toned Milk',
        packSize: '500 ml',
        priceAmount: 29,
        priceCurrency: 'INR',
      },
    },
  };
}

async function waitForOperation(
  store: InMemoryBackgroundPhoneOperationStoreV2,
  status: 'completed' | 'failed' | 'ambiguous',
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await store.get(operationId))?.status).toBe(status);
  });
}

describe('production background phone operation adapter', () => {
  it('persists a policy-selected exact offer and continues without re-searching', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const source = initialTask('search_products');
    source.steps[0]!.input = {
      action: 'add_cart_item',
      request: 'milk',
      quantity: 2,
    };
    source.productChoicePolicy = {
      mode: 'lowest_price_matching_pack',
    };
    await repository.create({
      task: source,
      event: {
        eventId: 'task-created',
        taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const running = (await beginV2CompatibilityExecution({
      operationId,
      repository,
      stepId,
      task: source,
    })).task;
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const actions: string[] = [];
    const executePhone = vi.fn(async (
      action: { action?: string },
      context: { markMutationAttempted?: () => Promise<void> },
    ): Promise<unknown> => {
      actions.push(String(action.action));
      if (action.action === 'search_products') {
        return {
          ok: true,
          status: 'search_results',
          policyContext: {
            category: 'toned milk',
            packSize: '500 ml',
            productForm: 'liquid',
          },
          options: [{
            offerId: 'offer-milk-500',
            product: 'Amul Taaza Toned Milk',
            category: 'toned milk',
            brand: 'Amul',
            size: '500 ml',
            productForm: 'liquid',
            priceAmount: 29,
            priceCurrency: 'INR',
          }],
        };
      }
      await context.markMutationAttempted?.();
      return {
        ok: true,
        status: 'added',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: running.revision,
        stepId,
        requestPayload: {
          version: 1,
          action: { action: 'search_products', request: 'milk' },
        },
      },
      {
        executePhone: executePhone as never,
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await vi.waitFor(async () => {
      expect((await repository.getById(taskId))?.task.steps[0]?.status)
        .toBe('verified');
    });

    expect(actions).toEqual(['search_products', 'add_cart_item']);
    expect((await repository.getById(taskId))?.task.steps[0]?.input)
      .toMatchObject({
        action: 'add_cart_item',
        offerId: 'offer-milk-500',
        quantity: 2,
        selectedOffer: {
          offerId: 'offer-milk-500',
          packSize: '500 ml',
          priceAmount: 29,
          priceCurrency: 'INR',
          title: 'Amul Taaza Toned Milk',
        },
      });
  });

  it('executes an allowlisted exact action and commits authoritative V2 truth', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    const executePhone = vi.fn(
      async (_action, context): Promise<unknown> => {
        await context.markMutationAttempted?.();
        return {
        ok: true,
        status: 'added',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
        };
      },
    );

    const accepted = await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        itemId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      { executePhone, repository, store, stream },
    );

    expect(accepted).toMatchObject({
      disposition: 'enqueued',
      operationAccepted: {
        operationId,
        status: 'accepted',
      },
    });
    await waitForOperation(store, 'completed');
    expect(executePhone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'add_cart_item',
        offerId: 'offer-milk-500',
      }),
      expect.objectContaining({
        callId: `background:${operationId}`,
        itemId,
        operationId,
        protocolVersion: 2,
        stepId,
        stepKey: stepId,
        taskId,
        taskRevision: task.revision + 1,
        markMutationAttempted: expect.any(Function),
      }),
    );
    expect(await repository.getById(taskId)).toMatchObject({
      task: {
        status: 'completed',
        steps: [{
          operationId,
          status: 'verified',
        }],
      },
    });
  });

  it('persists intent before provider work and attempted at the physical boundary', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const observedStatuses: string[] = [];

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      {
        executePhone: async (_action, context): Promise<unknown> => {
          observedStatuses.push((await store.get(operationId))!.status);
          await context?.markMutationAttempted?.();
          observedStatuses.push((await store.get(operationId))!.status);
          return {
            ok: true,
            status: 'added',
            verification: {
              mutationAttempted: true,
              outcome: 'verified_success',
            },
          };
        },
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'completed');

    expect(observedStatuses).toEqual(['running', 'mutation_attempted']);
  });

  it('keeps stale-offer reselection before the durable mutation boundary', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const executePhone = vi.fn(async (): Promise<unknown> => ({
      ok: false,
      status: 'reselection_required',
      verification: {
        mutationAttempted: false,
        outcome: 'failed_before_mutation',
      },
    }));

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      {
        executePhone,
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'failed');

    expect(executePhone).toHaveBeenCalledOnce();
    const record = await repository.getById(taskId);
    expect(record?.task.steps[0]).toMatchObject({
      attempts: 1,
      status: 'failed',
    });
    expect(record?.task.journal.map((entry) => entry.type))
      .not.toContain('mutation_attempted');
    expect(record?.events.map((event) => event.kind))
      .not.toContain('mutation_attempted');
  });

  it('preserves distinct production correlation IDs into provider metrics', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository, 'search_products');
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const metrics: BlinkitExecutionSubstageMetric[] = [];
    const pool = new AppiumSessionPool({
      createSession: async () => ({
        close: vi.fn(async () => undefined),
        currentPackage: vi.fn(async () => 'com.grofers.customerapp'),
      }),
    });
    const driver = {
      currentScreen: vi.fn(async () => ({
        kind: 'search_results' as const,
        searchAction: 'available' as const,
      })),
      search: vi.fn(async () => [{
        available: true,
        offerId: 'offer-potato',
        packSize: '1 kg',
        price: { amount: 27, currency: 'INR' as const },
        title: 'Potato (Alugadde)',
      }]),
    };
    const service = new BlinkitExecutionService({
      appiumSessionPool:
        pool as unknown as AppiumSessionPool<AppiumHttpClient>,
      createDriver: () => driver as never,
      publishStatus: vi.fn(async () => false),
      recordSubstageMetric: (metric) => metrics.push(metric),
      sessionDeviceKey: 'production-correlation-device',
    });

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        itemId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: {
          version: 1,
          action: {
            action: 'search_products',
            request: 'potato',
          },
        },
      },
      {
        executePhone: (action, context) => executePhoneActionWithService(
          action,
          service as ReversibleBlinkitExecutionPort,
          context,
        ),
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'completed');

    expect(driver.search).toHaveBeenCalledOnce();
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics.every((metric) => (
      metric.taskId === taskId
      && metric.itemId === itemId
      && metric.stepId === stepId
      && metric.operationId === operationId
    ))).toBe(true);
    expect(new Set([taskId, itemId, stepId, operationId]).size).toBe(4);
    await pool.dispose();
  });

  it.each([
    ['after task marker', false, 'ambiguous'],
    ['after both markers', true, 'ambiguous'],
  ] as const)(
    'restart %s reconciles read-only and never requeues provider mutation',
    async (_label, backgroundMarked, terminalStatus) => {
      const sourceRepository = new InMemoryPhoneTaskRepositoryV2();
      const task = await begunTask(sourceRepository);
      const sourceStore = new InMemoryBackgroundPhoneOperationStoreV2();
      await sourceStore.enqueue({
        operationId,
        acceptedAt: 10,
        request: {
          taskId,
          itemId,
          taskRevision: task.revision,
          stepId,
          operationKind: 'add_cart_item',
          requestPayload: exactAddPayload(),
        },
      });
      await sourceStore.claim(operationId, 11);
      await markV2CompatibilityMutationAttempted({
        at: 12,
        operationId,
        repository: sourceRepository,
        stepId,
        taskId,
      });
      if (backgroundMarked) {
        await sourceStore.markMutationAttempted(operationId, 13);
      }

      const restartedRepository = new InMemoryPhoneTaskRepositoryV2();
      await restartedRepository.restoreSnapshot(
        await sourceRepository.exportSnapshot(),
      );
      const restartedStore = new InMemoryBackgroundPhoneOperationStoreV2();
      await restartedStore.restoreSnapshot(await sourceStore.exportSnapshot());
      const executePhone = vi.fn();
      await enqueueProductionBackgroundPhoneOperationV2(
        {
          operationId,
          itemId,
          taskId,
          taskRevision: task.revision,
          stepId,
          requestPayload: exactAddPayload(),
        },
        {
          executePhone,
          repository: restartedRepository,
          store: restartedStore,
          stream: new RetainedTaskEventStreamV2(),
        },
      );
      await waitForOperation(restartedStore, terminalStatus);
      expect(executePhone).not.toHaveBeenCalled();
      expect(await restartedStore.listQueued()).toEqual([]);

      const reconcile = vi.fn(async () => ({
        outcome: 'verified_not_applied' as const,
        evidenceRef: 'evidence:cart-unchanged',
      }));
      const recovery = await recoverRepositoryOnStartupV2({
        now: () => 20,
        reconciler: { reconcile },
        repository: restartedRepository,
      });

      expect(reconcile).toHaveBeenCalledOnce();
      expect(recovery).toEqual([
        expect.objectContaining({ outcome: 'mutation_not_applied' }),
      ]);
      expect((await restartedRepository.getById(taskId))?.task.steps[0])
        .toMatchObject({ status: 'failed' });
    },
  );

  it.each([
    {
      version: 1,
      action: {
        action: 'confirm_checkout',
        checkoutProposal: { confirmationPhrase: 'place order' },
      },
    },
    {
      version: 1,
      action: {
        action: 'phone_status',
        screenshotBase64: 'sensitive-screen',
      },
    },
    {
      version: 1,
      action: {
        action: 'search_products',
        request: 'milk',
        accessToken: 'secret-token',
      },
    },
  ])('rejects final-dispatch, screenshot, and secret-bearing payloads', async (
    requestPayload,
  ) => {
    await expect(enqueueProductionBackgroundPhoneOperationV2({
      operationId,
      taskId,
      taskRevision: 1,
      stepId,
      requestPayload,
    })).rejects.toThrow();
  });

  it('fails stale authorization before executing any phone action', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const executePhone = vi.fn(
      async (): Promise<unknown> => ({ status: 'added' }),
    );

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision + 1,
        stepId,
        requestPayload: exactAddPayload(),
      },
      {
        executePhone,
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'failed');

    expect(executePhone).not.toHaveBeenCalled();
    expect((await repository.getById(taskId))?.task.steps[0]).toMatchObject({
      operationId,
      status: 'running',
    });
  });

  it('directly verifies an allowlisted read operation in authoritative state', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository, 'inspect_cart');
    const store = new InMemoryBackgroundPhoneOperationStoreV2();

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: {
          version: 1,
          action: { action: 'inspect_cart' },
        },
      },
      {
        executePhone: async (): Promise<unknown> => ({
          ok: true,
          status: 'cart_empty',
        }),
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'completed');

    expect((await repository.getById(taskId))?.task.steps[0]).toMatchObject({
      kind: 'inspect_cart',
      operationId,
      status: 'verified',
    });
  });

  it('publishes a strict terminal cart summary without a phantom interaction', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository, 'inspect_cart');
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    let now = 100;
    const clock = (): number => {
      now += 10;
      return now;
    };
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const stream = new RetainedTaskEventStreamV2({ now: clock });

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: {
          version: 1,
          action: { action: 'inspect_cart' },
        },
      },
      {
        executePhone: async (): Promise<unknown> => ({
          ok: true,
          status: 'cart_status',
          cart: {
            addressLabel: 'Home',
            lines: [{
              productId: 'milk_500ml',
              product: 'Amul Taaza Toned Milk',
              spokenLabel: 'Amul milk',
              quantity: 1,
              price: '₹29',
            }],
            subtotal: '₹29',
          },
        }),
        metrics,
        now: clock,
        repository,
        store,
        stream,
      },
    );
    await waitForOperation(store, 'completed');

    const event = stream.readAfter({ taskId }).events.at(-1);
    expect(event).toMatchObject({
      kind: 'completed',
      terminal: true,
      safePresentation: {
        card: {
          type: 'cart_summary',
          ordered: false,
          cart: {
            verified: true,
          },
        },
      },
    });
    expect(event).not.toHaveProperty('interaction');
    expect(OverlayPresentationSchemaV1.safeParse(event?.safePresentation))
      .toMatchObject({ success: true });
    const committedTask = (await repository.getById(taskId))!.task;
    expect(metrics.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          durationMs: committedTask.terminalAt! - committedTask.createdAt,
          operationId,
          outcome: 'completed',
          phase: 'task_completion',
          taskId,
        }),
      ]),
    );
  });

  it('persists the final-cart interaction before publishing its choices', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const initial = initialTask('inspect_cart');
    initial.steps.push(buildNextActionStepV2({
      adapterId: 'blinkit',
      dependsOn: [stepId],
      stepId: 'step:next-action',
    }));
    await repository.create({
      task: initial,
      event: {
        eventId: 'task-created',
        taskId,
        taskRevision: 0,
        at: 1,
        kind: 'task_created',
      },
    });
    const task = (
      await beginV2CompatibilityExecution({
        operationId,
        repository,
        stepId,
        task: initial,
      })
    ).task;
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: {
          version: 1,
          action: { action: 'inspect_cart' },
        },
      },
      {
        executePhone: async () => ({
          ok: true,
          status: 'cart_status',
          cart: {
            addressLabel: 'Home',
            lines: [{
              productId: 'milk',
              product: 'Milk',
              spokenLabel: 'Milk',
              quantity: 1,
              price: '₹29',
            }],
            subtotal: '₹29',
          },
        }),
        repository,
        store,
        stream,
      },
    );
    await waitForOperation(store, 'completed');

    const stored = (await repository.getById(taskId))!.task;
    expect(stored).toMatchObject({
      status: 'waiting_for_user',
      pendingInteraction: {
        kind: 'next_action',
        allowedResponses: [
          'review_cart',
          'add_more',
          'review_checkout',
          'stop',
        ],
      },
    });
    expect(stream.readAfter({ taskId }).events.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'waiting_for_user',
        taskRevision: stored.revision,
        interaction: expect.objectContaining({
          interactionId: stored.pendingInteraction!.interactionId,
          taskRevision: stored.revision,
        }),
        safePresentation: expect.objectContaining({
          card: expect.objectContaining({
            type: 'cart_summary',
            ordered: false,
            cart: expect.objectContaining({
              verified: true,
            }),
          }),
        }),
      }),
    );
    expect(stream.readAfter({ taskId }).events.at(-1))
      .not.toHaveProperty('terminal');
  });

  it('classifies a post-execution revision change as ambiguous without replay', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const executePhone = vi.fn(async (): Promise<unknown> => {
      const current = (await repository.getById(taskId))!.task;
      const cancelled = transitionPhoneTaskV2(current, {
        type: 'cancel_task',
        entryId: 'cancelled-concurrently',
        at: current.updatedAt + 1,
      });
      await repository.commit({
        expectedRevision: current.revision,
        task: cancelled,
        event: {
          eventId: 'cancelled-concurrently',
          taskId,
          taskRevision: cancelled.revision,
          at: cancelled.updatedAt,
          kind: 'cancel_task',
        },
      });
      return {
        status: 'added',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      {
        executePhone,
        repository,
        store,
        stream: new RetainedTaskEventStreamV2(),
      },
    );
    await waitForOperation(store, 'ambiguous');

    expect(executePhone).toHaveBeenCalledTimes(1);
    expect((await repository.getById(taskId))?.task.status).toBe('cancelled');
  });

  it('records a thrown mutation as authoritative ambiguity', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      {
        executePhone: async (_action, context): Promise<never> => {
          await context?.markMutationAttempted?.();
          throw new Error('simulated transport loss');
        },
        repository,
        store,
        stream,
      },
    );
    await waitForOperation(store, 'ambiguous');

    expect(await repository.getById(taskId)).toMatchObject({
      task: {
        status: 'paused',
        pendingInteraction: {
          kind: 'recovery_handoff',
          allowedResponses: {
            operationId,
            stepId,
            actions: [
              { actionId: 'check_cart_again', safety: 'read_only' },
              { actionId: 'stop_task', safety: 'stop_only' },
            ],
          },
        },
        steps: [{
          operationId,
          status: 'ambiguous',
        }],
      },
    });
    expect(JSON.stringify(await repository.getById(taskId)))
      .not.toContain('retry_verified_not_applied');
    expect(await store.exportSnapshot()).not.toContain(
      'simulated transport loss',
    );
    expect(stream.readAfter({
      afterSequence: -1,
      taskId,
    }).events.at(-1)).toMatchObject({
      kind: 'ambiguous',
      operationId,
      stepId,
      taskId,
      taskRevision: 4,
      recoveryInteraction: {
        version: 2,
        operationId,
        stepId,
        taskId,
        taskRevision: 4,
      },
    });
  });

  it('retains pack and price conflicts without publishing mutation verified', async () => {
    const repository = new InMemoryPhoneTaskRepositoryV2();
    const task = await begunTask(repository);
    const store = new InMemoryBackgroundPhoneOperationStoreV2();
    const stream = new RetainedTaskEventStreamV2();
    const executePhone = vi.fn(async (_action, context): Promise<unknown> => {
      await context.markMutationAttempted?.();
      return {
        ok: false,
        status: 'execution_failed',
        verification: {
        conflicts: [
          {
            field: 'pack_size',
            expected: '500 ml',
            observed: '750 ml',
          },
          {
            field: 'price',
            expected: 'INR:2900',
            observed: 'INR:3000',
          },
        ],
        identityResolution: 'ambiguous',
        mutationAttempted: true,
          outcome: 'ambiguous',
        },
      };
    });

    await enqueueProductionBackgroundPhoneOperationV2(
      {
        operationId,
        itemId,
        taskId,
        taskRevision: task.revision,
        stepId,
        requestPayload: exactAddPayload(),
      },
      { executePhone, repository, store, stream },
    );
    await waitForOperation(store, 'ambiguous');

    expect(executePhone).toHaveBeenCalledOnce();
    const events = stream.readAfter({ afterSequence: -1, taskId }).events;
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'ambiguous',
        item: expect.objectContaining({
          packSize: '750 ml',
          price: 'INR:3000',
          conflicts: [
            {
              field: 'pack_size',
              expected: '500 ml',
              observed: '750 ml',
            },
            {
              field: 'price',
              expected: 'INR:2900',
              observed: 'INR:3000',
            },
          ],
        }),
      }),
    ]));
    expect(events.some((event) => event.kind === 'mutation_verified')).toBe(false);
  });
});
