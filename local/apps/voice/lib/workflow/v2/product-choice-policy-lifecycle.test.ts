import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_BUDGETS_V2,
  PHONE_TASK_V2_VERSION,
  type PhoneTaskV2,
} from './contracts';
import {
  commitProductChoicePolicyV2,
  parseProductChoicePolicyUpdateV2,
  productChoicePolicyStateV2,
} from './product-choice-policy-lifecycle';
import {
  InMemoryPhoneTaskRepositoryV2,
  TaskRevisionConflictV2Error,
} from './repository';

function task(): PhoneTaskV2 {
  return {
    version: PHONE_TASK_V2_VERSION,
    taskId: 'task_policy0001',
    clientId: 'pixel-overlay',
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

async function repositoryWithTask(): Promise<InMemoryPhoneTaskRepositoryV2> {
  const repository = new InMemoryPhoneTaskRepositoryV2();
  await repository.create({
    task: task(),
    event: {
      eventId: 'task-created',
      taskId: task().taskId,
      taskRevision: 0,
      at: 1,
      kind: 'task_created',
    },
  });
  return repository;
}

describe('product choice policy lifecycle v2', () => {
  it('persists and clears strict bounded policy state through task CAS', async () => {
    const repository = await repositoryWithTask();
    const policy = parseProductChoicePolicyUpdateV2(task(), {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['Amul'],
      priceCeiling: { amount: 100, currency: 'INR' },
    });
    const set = await commitProductChoicePolicyV2({
      at: 2,
      expectedRevision: 0,
      policy,
      repository,
      taskId: task().taskId,
    });
    expect(productChoicePolicyStateV2(set.task.productChoicePolicy)).toEqual({
      configured: true,
      hasPreviousPreference: false,
      mode: 'known_brand_then_lowest_price',
      preferredBrandCount: 1,
      priceCeiling: { amount: 100, currency: 'INR' },
    });

    const cleared = await commitProductChoicePolicyV2({
      at: 3,
      expectedRevision: 1,
      repository,
      taskId: task().taskId,
    });
    expect(cleared.task.productChoicePolicy).toBeUndefined();
    expect(productChoicePolicyStateV2(undefined)).toEqual({
      configured: false,
      hasPreviousPreference: false,
      mode: 'ask_every_time',
      preferredBrandCount: 0,
    });
  });

  it('allows exactly one policy writer for a task revision', async () => {
    const repository = await repositoryWithTask();
    const first = {
      mode: 'lowest_price_matching_pack' as const,
    };
    const second = {
      mode: 'known_brand_then_lowest_price' as const,
      preferredBrands: ['Amul'],
    };
    const outcomes = await Promise.allSettled([
      commitProductChoicePolicyV2({
        expectedRevision: 0,
        policy: first,
        repository,
        taskId: task().taskId,
      }),
      commitProductChoicePolicyV2({
        expectedRevision: 0,
        policy: second,
        repository,
        taskId: task().taskId,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled'))
      .toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason)
      .toBeInstanceOf(TaskRevisionConflictV2Error);
  });

  it('replaces and clears policy state without leaking an older preference', async () => {
    const repository = await repositoryWithTask();
    const repeat = parseProductChoicePolicyUpdateV2(task(), {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: 'Amul',
        packSize: '500 ml',
        productForm: 'liquid',
      },
    });
    const initial = await commitProductChoicePolicyV2({
      at: 2,
      expectedRevision: 0,
      policy: repeat,
      repository,
      taskId: task().taskId,
    });
    const bounded = parseProductChoicePolicyUpdateV2(initial.task, {
      mode: 'suggested_with_price_limit',
      priceCeiling: { amount: 75, currency: 'INR' },
    });
    const replaced = await commitProductChoicePolicyV2({
      at: 3,
      expectedRevision: 1,
      policy: bounded,
      repository,
      taskId: task().taskId,
    });
    expect(replaced.task.productChoicePolicy).toEqual({
      mode: 'suggested_with_price_limit',
      priceCeiling: { amount: 75, currency: 'INR' },
    });
    expect(replaced.task.productChoicePolicy).not.toHaveProperty(
      'previousPreference',
    );

    const cleared = await commitProductChoicePolicyV2({
      at: 4,
      expectedRevision: 2,
      repository,
      taskId: task().taskId,
    });
    expect(cleared.task.productChoicePolicy).toBeUndefined();
    expect(cleared.task.journal).toHaveLength(0);
  });

  it('rejects unknown fields and preference text that resembles PII', () => {
    expect(() => parseProductChoicePolicyUpdateV2(task(), {
      mode: 'lowest_price_matching_pack',
      hiddenInstruction: 'pick first',
    })).toThrow();
    expect(() => parseProductChoicePolicyUpdateV2(task(), {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['person@example.com'],
    })).toThrow();
  });
});
