import { describe, expect, it } from 'vitest';
import type {
  ProductChoicePolicyV2,
} from './contracts';
import {
  effectiveProductChoicePolicyV2,
  evaluateProductChoicePolicyV2,
  type ProductChoicePolicyDecisionV2,
  type ProductChoicePolicyOptionV2,
  type ProductChoicePolicyRequestV2,
} from './product-choice-policy';

const request: ProductChoicePolicyRequestV2 = {
  category: 'toned milk',
  label: 'Amul toned milk 500 ml',
  packSize: '500 ml',
  productForm: 'liquid',
};

function option(input: Partial<ProductChoicePolicyOptionV2> = {}):
ProductChoicePolicyOptionV2 {
  return {
    offerId: 'offer_amul_500',
    title: 'Amul Taaza Toned Milk',
    brand: 'Amul',
    category: 'toned milk',
    packSize: '500 ml',
    priceAmount: 29,
    priceCurrency: 'INR',
    productForm: 'liquid',
    ...input,
  };
}

function evaluate(
  policy: ProductChoicePolicyV2 | undefined,
  options: readonly ProductChoicePolicyOptionV2[] = [option()],
  requested: ProductChoicePolicyRequestV2 = request,
): ProductChoicePolicyDecisionV2 {
  return evaluateProductChoicePolicyV2({
    options,
    policy,
    request: requested,
  });
}

describe('deterministic product-choice policy v2', () => {
  it('defaults missing policy to ask-every-time and never mutates input', () => {
    const options = [option()];
    const before = structuredClone(options);

    expect(effectiveProductChoicePolicyV2(undefined)).toEqual({
      mode: 'ask_every_time',
    });
    expect(evaluate(undefined, options)).toEqual({
      decision: 'ask',
      reason: 'ask_every_time',
    });
    expect(options).toEqual(before);
  });

  it('selects the deterministic lowest price only within exact form and pack', () => {
    expect(evaluate(
      { mode: 'lowest_price_matching_pack' },
      [
        option({ offerId: 'offer_expensive', priceAmount: 31 }),
        option({ offerId: 'offer_lowest_b', priceAmount: 28 }),
        option({ offerId: 'offer_lowest_a', priceAmount: 28 }),
        option({
          offerId: 'offer_wrong_pack',
          packSize: '1 l',
          priceAmount: 20,
        }),
      ],
    )).toEqual({
      decision: 'select',
      offerId: 'offer_lowest_a',
      policy: 'lowest_price_matching_pack',
    });
  });

  it.each([
    [
      'category',
      { ...request, category: 'toned milk' },
      [option({ category: 'milk powder' })],
      'material_category_mismatch',
    ],
    [
      'form',
      { ...request, productForm: undefined },
      [
        option({ offerId: 'offer_liquid', productForm: 'liquid' }),
        option({ offerId: 'offer_powder', productForm: 'powder' }),
      ],
      'material_form_uncertain',
    ],
    [
      'pack',
      { ...request, packSize: undefined },
      [
        option({ offerId: 'offer_500', packSize: '500 ml' }),
        option({ offerId: 'offer_1l', packSize: '1 l' }),
      ],
      'pack_size_uncertain',
    ],
  ] as const)(
    'pauses on a material %s uncertainty',
    (_label, requested, options, reason) => {
      expect(evaluate(
        { mode: 'lowest_price_matching_pack' },
        options,
        requested,
      )).toEqual({ decision: 'ask', reason });
    },
  );

  it('prefers a configured known brand, then price, and otherwise asks', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['Amul', 'Mother Dairy'],
    };
    expect(evaluate(policy, [
      option({ offerId: 'offer_unknown', brand: 'Other', priceAmount: 20 }),
      option({ offerId: 'offer_known', brand: 'Mother Dairy', priceAmount: 30 }),
    ])).toMatchObject({
      decision: 'select',
      offerId: 'offer_known',
    });
    expect(evaluate(policy, [
      option({ brand: 'Other' }),
    ])).toEqual({
      decision: 'ask',
      reason: 'known_brand_unavailable',
    });
  });

  it('repeats only the exact persisted category/form/pack/brand preference', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: 'Amul',
        packSize: '500 ml',
        productForm: 'liquid',
      },
    };
    expect(evaluate(policy, [
      option({ offerId: 'offer_other', brand: 'Other', priceAmount: 20 }),
      option({ offerId: 'offer_repeat', priceAmount: 29 }),
    ])).toMatchObject({
      decision: 'select',
      offerId: 'offer_repeat',
    });
    expect(evaluate(policy, [
      option({ brand: 'Other' }),
    ])).toEqual({
      decision: 'ask',
      reason: 'preference_unavailable',
    });
  });

  it('uses one explicit suggestion only below the configured price ceiling', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'suggested_with_price_limit',
      priceCeiling: { amount: 30, currency: 'INR' },
    };
    expect(evaluate(policy, [
      option({ offerId: 'offer_normal', priceAmount: 25 }),
      option({ offerId: 'offer_suggested', suggested: true, priceAmount: 29 }),
    ])).toMatchObject({
      decision: 'select',
      offerId: 'offer_suggested',
    });
    expect(evaluate(policy, [
      option({ suggested: true, priceAmount: 31 }),
    ])).toEqual({
      decision: 'ask',
      reason: 'price_ceiling_exceeded',
    });
    expect(evaluate(policy, [
      option({ offerId: 'offer_a', suggested: true }),
      option({ offerId: 'offer_b', suggested: true }),
    ])).toEqual({
      decision: 'ask',
      reason: 'suggestion_unavailable',
    });
  });

  it('follows a corrected suggestion without retaining the prior offer', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'suggested_with_price_limit',
      priceCeiling: { amount: 35, currency: 'INR' },
    };
    const original = [
      option({
        offerId: 'offer_original',
        suggested: true,
        priceAmount: 29,
      }),
      option({
        offerId: 'offer_corrected',
        suggested: false,
        priceAmount: 31,
      }),
    ];
    const corrected = original.map((candidate) => ({
      ...candidate,
      suggested: candidate.offerId === 'offer_corrected',
    }));

    expect(evaluate(policy, original)).toEqual({
      decision: 'select',
      offerId: 'offer_original',
      policy: 'suggested_with_price_limit',
    });
    expect(evaluate(policy, corrected)).toEqual({
      decision: 'select',
      offerId: 'offer_corrected',
      policy: 'suggested_with_price_limit',
    });
    expect(original.map((candidate) => candidate.suggested))
      .toEqual([true, false]);
  });

  it('re-evaluates corrected pack size and price ceiling from current input', () => {
    const options = [
      option({
        offerId: 'offer_500',
        packSize: '500 ml',
        priceAmount: 29,
      }),
      option({
        offerId: 'offer_1l',
        packSize: '1 l',
        priceAmount: 54,
      }),
    ];

    expect(evaluate(
      { mode: 'lowest_price_matching_pack' },
      options,
    )).toMatchObject({
      decision: 'select',
      offerId: 'offer_500',
    });
    expect(evaluate(
      { mode: 'lowest_price_matching_pack' },
      options,
      {
        ...request,
        label: 'Amul toned milk 1 l',
        packSize: '1 l',
      },
    )).toMatchObject({
      decision: 'select',
      offerId: 'offer_1l',
    });

    const suggested = [
      option({
        offerId: 'offer_1l',
        packSize: '1 l',
        priceAmount: 54,
        suggested: true,
      }),
    ];
    expect(evaluate(
      {
        mode: 'suggested_with_price_limit',
        priceCeiling: { amount: 50, currency: 'INR' },
      },
      suggested,
      {
        ...request,
        label: 'Amul toned milk 1 l',
        packSize: '1 l',
      },
    )).toEqual({
      decision: 'ask',
      reason: 'price_ceiling_exceeded',
    });
    expect(evaluate(
      {
        mode: 'suggested_with_price_limit',
        priceCeiling: { amount: 60, currency: 'INR' },
      },
      suggested,
      {
        ...request,
        label: 'Amul toned milk 1 l',
        packSize: '1 l',
      },
    )).toMatchObject({
      decision: 'select',
      offerId: 'offer_1l',
    });
  });

  it('reuses a prior preference only for its exact material form', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: 'Amul',
        packSize: '500 ml',
        productForm: 'liquid',
      },
    };
    expect(evaluate(policy, [
      option({
        offerId: 'offer_prior_preference',
        priceAmount: 29,
      }),
      option({
        offerId: 'offer_cheaper_other_brand',
        brand: 'Other',
        priceAmount: 20,
      }),
    ])).toMatchObject({
      decision: 'select',
      offerId: 'offer_prior_preference',
    });
    expect(evaluate(policy, [
      option({
        offerId: 'offer_powder',
        productForm: 'powder',
      }),
    ], {
      ...request,
      productForm: 'powder',
    })).toEqual({
      decision: 'ask',
      reason: 'preference_unavailable',
    });
  });

  it.each([
    ['medicine', 'medicine', 'Paracetamol tablet'],
    ['age-restricted goods', 'beer', 'Craft beer'],
    ['meat cuts', 'chicken', 'Chicken breast'],
    ['dietary variants', 'milk', 'Lactose free milk'],
    ['Hindi medicine', 'दवा', 'पैरासिटामोल गोली'],
    ['Hindi alcohol', 'शराब', 'रेड वाइन'],
    ['Hindi tobacco', 'तंबाकू', 'तंबाकू'],
    ['Gujarati medicine', 'દવા', 'પેરાસિટામોલ'],
    ['Bengali alcohol', 'মদ', 'রেড ওয়াইন'],
    ['Tamil tobacco', 'புகையிலை', 'புகையிலை'],
    ['transliterated medicine', 'dawai', 'paracetamol'],
    ['transliterated alcohol', 'sharab', 'red wine'],
  ])('never silently selects %s', (_label, category, title) => {
    expect(evaluate(
      { mode: 'lowest_price_matching_pack' },
      [option({ category, title })],
      { category, label: title },
    )).toEqual({
      decision: 'ask',
      reason: 'sensitive_choice',
    });
  });

  it('fails closed for malformed requests and empty, duplicate, or malformed options', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'lowest_price_matching_pack',
    };
    expect(evaluate(policy, [option()], {
      category: '',
      label: 'milk',
    })).toEqual({
      decision: 'ask',
      reason: 'invalid_request',
    });
    expect(evaluate({
      mode: 'suggested_with_price_limit',
    } as ProductChoicePolicyV2)).toEqual({
      decision: 'ask',
      reason: 'invalid_policy',
    });
    expect(evaluate(policy, [])).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(evaluate(policy, [option(), option()])).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(evaluate(policy, [option({ priceAmount: Number.NaN })])).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(evaluate(policy, [
      option({ suggested: 'yes' as unknown as boolean }),
    ])).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(evaluate(policy, [
      option({ offerId: 1 as unknown as string }),
    ])).toEqual({
      decision: 'ask',
      reason: 'invalid_options',
    });
    expect(evaluate(policy, [option()], {
      ...request,
      category: 1 as unknown as string,
    })).toEqual({
      decision: 'ask',
      reason: 'invalid_request',
    });
  });

  it('rejects PII-shaped durable preference text even when called directly', () => {
    expect(evaluate({
      mode: 'known_brand_then_lowest_price',
      preferredBrands: ['suraj@example.com'],
    })).toEqual({
      decision: 'ask',
      reason: 'invalid_policy',
    });
    expect(evaluate({
      mode: 'repeat_previous_preference',
      previousPreference: {
        category: 'toned milk',
        brand: '9876543210',
      },
    })).toEqual({
      decision: 'ask',
      reason: 'invalid_policy',
    });
  });

  it('does not treat missing form or pack metadata as equal to known metadata', () => {
    const policy: ProductChoicePolicyV2 = {
      mode: 'lowest_price_matching_pack',
    };
    expect(evaluate(policy, [
      option({ offerId: 'known_form' }),
      option({ offerId: 'unknown_form', productForm: undefined }),
    ], {
      category: request.category,
      label: request.label,
      packSize: request.packSize,
    })).toEqual({
      decision: 'ask',
      reason: 'material_form_uncertain',
    });
    expect(evaluate(policy, [
      option({ offerId: 'known_pack' }),
      option({ offerId: 'unknown_pack', packSize: undefined }),
    ], {
      category: request.category,
      label: request.label,
      productForm: request.productForm,
    })).toEqual({
      decision: 'ask',
      reason: 'pack_size_uncertain',
    });
  });
});
