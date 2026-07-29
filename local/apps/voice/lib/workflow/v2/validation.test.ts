import { describe, expect, it } from 'vitest';
import type { PhoneTaskV2 } from './contracts';
import { validTaskV2 } from './test-fixtures';
import { parsePhoneTaskV2 } from './validation';

describe('PhoneTaskV2 validation', () => {
  it('parses a valid domain-neutral task', () => {
    expect(parsePhoneTaskV2(validTaskV2())).toEqual(validTaskV2());
  });

  it.each([
    ['duplicate steps', (task: PhoneTaskV2): void => {
      task.steps[1]!.stepId = task.steps[0]!.stepId;
    }],
    ['missing dependency', (task: PhoneTaskV2): void => {
      task.steps[1]!.dependsOn = ['step:missing'];
    }],
    ['cyclic dependency', (task: PhoneTaskV2): void => {
      task.steps[0]!.dependsOn = ['step:second'];
    }],
    ['attempt budget', (task: PhoneTaskV2): void => {
      task.steps[0]!.attempts = task.budgets.maxAttemptsPerStep + 1;
    }],
    ['foreign interaction', (task: PhoneTaskV2): void => {
      task.status = 'waiting_for_user';
      task.pendingInteraction = {
        interactionId: 'interaction:one',
        taskId: 'task:other',
        taskRevision: 0,
        kind: 'next_action',
        allowedResponses: ['continue'],
        presentationRef: 'presentation:one',
        status: 'open',
        createdAt: 1,
        expiresAt: 2,
      };
    }],
  ])('rejects %s', (_name, mutate) => {
    const task = structuredClone(validTaskV2());
    mutate(task);
    expect(() => parsePhoneTaskV2(task)).toThrow();
  });

  it('requires all steps to be terminal before task completion', () => {
    const task = validTaskV2();
    task.status = 'completed';
    task.terminalAt = 2;
    expect(() => parsePhoneTaskV2(task)).toThrow('unfinished steps');
  });

  it('round-trips a bounded product-choice policy and accepts legacy absence', () => {
    expect(parsePhoneTaskV2(validTaskV2()).productChoicePolicy).toBeUndefined();
    const task = validTaskV2();
    task.productChoicePolicy = {
      mode: 'repeat_previous_preference',
      priceCeiling: { amount: 100, currency: 'INR' },
      preferredBrands: ['Amul'],
      previousPreference: {
        category: 'toned milk',
        brand: 'Amul',
        packSize: '500 ml',
        productForm: 'liquid',
      },
    };
    expect(parsePhoneTaskV2(task).productChoicePolicy)
      .toEqual(task.productChoicePolicy);
  });

  it.each([
    ['unknown mode', {
      mode: 'choose_anything',
    }],
    ['unknown field', {
      mode: 'ask_every_time',
      hiddenInstruction: 'pick the first result',
    }],
    ['unbounded brands', {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: Array.from({ length: 11 }, (_, index) => `brand-${index}`),
    }],
    ['missing known brands', {
      mode: 'known_brand_then_lowest_price',
    }],
    ['missing repeated preference', {
      mode: 'repeat_previous_preference',
    }],
    ['missing suggested ceiling', {
      mode: 'suggested_with_price_limit',
    }],
    ['invalid ceiling', {
      mode: 'lowest_price_matching_pack',
      priceCeiling: { amount: Number.POSITIVE_INFINITY, currency: 'INR' },
    }],
    ['NFKC-equivalent duplicate brands', {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['Amul', 'Ａｍｕｌ'],
    }],
    ['email in preferred brands', {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['suraj@example.com'],
    }],
    ['phone in previous preference', {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: '9876543210',
      },
    }],
    ['payment card in previous preference', {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        packSize: '4111 1111 1111 1111',
      },
    }],
    ['address in previous preference', {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        productForm: 'Home address 123',
      },
    }],
    ['regional phone digits in previous preference', {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: '९८७६५४३२१०',
      },
    }],
    ['regional address in previous preference', {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        productForm: 'મારું સરનામું',
      },
    }],
  ])('rejects an invalid product-choice policy: %s', (_label, policy) => {
    const task = validTaskV2() as unknown as Record<string, unknown>;
    task['productChoicePolicy'] = policy;
    expect(() => parsePhoneTaskV2(task)).toThrow();
  });

  it('allows bounded product metadata that contains ordinary digits', () => {
    const task = validTaskV2();
    task.productChoicePolicy = {
      mode: 'repeat_previous_preference',
      preferredBrands: ['7UP'],
      previousPreference: {
        category: 'soft drink',
        brand: '7UP',
        packSize: '500 ml',
        productForm: 'bottle',
      },
    };

    expect(parsePhoneTaskV2(task).productChoicePolicy)
      .toEqual(task.productChoicePolicy);

    task.productChoicePolicy.previousPreference = {
      category: 'street food',
      brand: 'Road House',
      packSize: '500 ml',
      productForm: 'flat bread',
    };
    expect(parsePhoneTaskV2(task).productChoicePolicy)
      .toEqual(task.productChoicePolicy);
  });
});
