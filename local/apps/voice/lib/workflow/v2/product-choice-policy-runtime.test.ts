import { describe, expect, it } from 'vitest';
import { parseLocalIdentifier } from '../identifiers';
import {
  DEFAULT_TASK_BUDGETS_V2,
  PHONE_TASK_V2_VERSION,
  type PhoneTaskV2,
  type ProductChoicePolicyV2,
} from './contracts';
import { beginV2CompatibilityExecution } from './execution-bridge';
import {
  commitSearchProductChoicePolicyV2,
} from './product-choice-policy-runtime';
import { InMemoryPhoneTaskRepositoryV2 } from './repository';

const taskId = parseLocalIdentifier('task', 'task_policysearch1');
const operationId = parseLocalIdentifier(
  'operation',
  'operation_policysearch1',
);
const stepId = 'step:milk';

function sourceTask(policy?: ProductChoicePolicyV2): PhoneTaskV2 {
  return {
    version: PHONE_TASK_V2_VERSION,
    taskId,
    clientId: 'pixel-overlay',
    revision: 0,
    originalGoal: 'Add milk',
    goalKind: 'grocery',
    status: 'active',
    activeStepId: stepId,
    steps: [{
      stepId,
      adapterId: 'blinkit',
      kind: 'search_products',
      status: 'ready',
      dependsOn: [],
      input: { action: 'add_cart_item', request: 'milk', quantity: 2 },
      expectedPostcondition: { kind: 'cart_contains' },
      attempts: 0,
    }],
    ...(policy ? { productChoicePolicy: policy } : {}),
    verifiedFacts: [],
    journal: [],
    budgets: { ...DEFAULT_TASK_BUDGETS_V2 },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function runningTask(policy?: ProductChoicePolicyV2): Promise<{
  repository: InMemoryPhoneTaskRepositoryV2;
  task: PhoneTaskV2;
}> {
  const repository = new InMemoryPhoneTaskRepositoryV2();
  const task = sourceTask(policy);
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
  const running = await beginV2CompatibilityExecution({
    operationId,
    repository,
    stepId,
    task,
    at: 2,
  });
  return { repository, task: running.task };
}

function option(
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    offerId: 'offer-milk-500',
    product: 'Amul Taaza Toned Milk',
    category: 'toned milk',
    brand: 'Amul',
    size: '500 ml',
    productForm: 'liquid',
    priceAmount: 29,
    priceCurrency: 'INR',
    ...input,
  };
}

function result(
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    status: 'search_results',
    policyContext: {
      category: 'toned milk',
      packSize: '500 ml',
      productForm: 'liquid',
    },
    options: [option(), option({
      offerId: 'offer-milk-500-expensive',
      priceAmount: 32,
    })],
    ...input,
  };
}

describe('production product choice policy completion v2', () => {
  it('defaults to asking and commits one open exact choice interaction', async () => {
    const running = await runningTask();
    const completion = await commitSearchProductChoicePolicyV2({
      operationId,
      repository: running.repository,
      result: result(),
      stepId,
      task: running.task,
    });
    expect(completion).toMatchObject({
      decision: { decision: 'ask', reason: 'ask_every_time' },
      selected: false,
    });
    expect(completion?.record.task).toMatchObject({
      status: 'waiting_for_user',
      pendingInteraction: {
        kind: 'product_choice',
        status: 'open',
      },
    });
    expect(completion?.record.task.journal.filter((entry) =>
      entry.type === 'product_choice_policy_selected'
      || entry.type === 'wait_for_user')).toHaveLength(1);
  });

  it('persists the exact selected offer before continuation and never re-searches', async () => {
    const running = await runningTask({
      mode: 'lowest_price_matching_pack',
    });
    const completion = await commitSearchProductChoicePolicyV2({
      operationId,
      repository: running.repository,
      result: result(),
      stepId,
      task: running.task,
    });
    expect(completion).toMatchObject({
      decision: {
        decision: 'select',
        offerId: 'offer-milk-500',
      },
      selected: true,
    });
    expect(completion?.record.task.steps[0]).toMatchObject({
      kind: 'add_cart_item',
      status: 'ready',
      input: {
        action: 'add_cart_item',
        offerId: 'offer-milk-500',
        quantity: 2,
        searchQuery: 'milk',
        selectedOffer: {
          offerId: 'offer-milk-500',
          title: 'Amul Taaza Toned Milk',
          packSize: '500 ml',
          priceAmount: 29,
          priceCurrency: 'INR',
        },
      },
    });
    expect(JSON.stringify(completion?.record.task.steps[0]?.input))
      .not.toContain('search_products');
    expect(completion?.record.task.journal.filter((entry) =>
      entry.type === 'product_choice_policy_selected')).toHaveLength(1);
  });

  it('asks when category/form/pack metadata is incomplete', async () => {
    const running = await runningTask({
      mode: 'lowest_price_matching_pack',
    });
    const completion = await commitSearchProductChoicePolicyV2({
      operationId,
      repository: running.repository,
      result: result({
        options: [option({ productForm: undefined })],
      }),
      stepId,
      task: running.task,
    });
    expect(completion?.decision).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(completion?.selected).toBe(false);
  });

  it.each([
    [
      'sensitive',
      { mode: 'lowest_price_matching_pack' } as ProductChoicePolicyV2,
      result({
        options: [option({ sensitivity: 'medicine' })],
      }),
      'sensitive_choice',
    ],
    [
      'price',
      {
        mode: 'suggested_with_price_limit',
        priceCeiling: { amount: 20, currency: 'INR' },
      } as ProductChoicePolicyV2,
      result({
        options: [option({ suggested: true })],
      }),
      'price_ceiling_exceeded',
    ],
  ])('asks on %s policy safety failure', async (
    _label,
    policy,
    phoneResult,
    reason,
  ) => {
    const running = await runningTask(policy);
    const completion = await commitSearchProductChoicePolicyV2({
      operationId,
      repository: running.repository,
      result: phoneResult,
      stepId,
      task: running.task,
    });
    expect(completion?.decision).toEqual({ decision: 'ask', reason });
    expect(completion?.selected).toBe(false);
  });
});
