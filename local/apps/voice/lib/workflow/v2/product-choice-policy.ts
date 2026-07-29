import type {
  ProductChoicePolicyModeV2,
  ProductChoicePolicyV2,
} from './contracts';
import {
  isSafeProductChoicePolicyTextV2,
  normalizeProductChoicePolicyTextV2,
} from './product-choice-policy-text';

export type ProductChoiceSensitivityV2 =
  | 'none'
  | 'age_restricted'
  | 'dietary_variant'
  | 'meat_cut'
  | 'medicine'
  | 'other_sensitive';

export type ProductChoicePolicyRequestV2 = {
  category: string;
  label: string;
  packSize?: string;
  productForm?: string;
  sensitivity?: ProductChoiceSensitivityV2;
};

export type ProductChoicePolicyOptionV2 = {
  offerId: string;
  title: string;
  category: string;
  priceAmount: number;
  priceCurrency: 'INR';
  brand?: string;
  packSize?: string;
  productForm?: string;
  sensitivity?: ProductChoiceSensitivityV2;
  suggested?: boolean;
};

export type ProductChoicePolicyDecisionV2 =
  | {
      decision: 'ask';
      reason:
        | 'ask_every_time'
        | 'invalid_policy'
        | 'invalid_request'
        | 'invalid_options'
        | 'known_brand_unavailable'
        | 'material_category_mismatch'
        | 'material_form_uncertain'
        | 'pack_size_uncertain'
        | 'preference_unavailable'
        | 'price_ceiling_exceeded'
        | 'sensitive_choice'
        | 'suggestion_unavailable';
    }
  | {
      decision: 'select';
      offerId: string;
      policy: Exclude<ProductChoicePolicyModeV2, 'ask_every_time'>;
    };

const DEFAULT_PRODUCT_CHOICE_POLICY_V2: Readonly<ProductChoicePolicyV2> = {
  mode: 'ask_every_time',
};

const PRODUCT_CHOICE_POLICY_MODES_V2 =
  new Set<ProductChoicePolicyModeV2>([
    'ask_every_time',
    'lowest_price_matching_pack',
    'known_brand_then_lowest_price',
    'repeat_previous_preference',
    'suggested_with_price_limit',
  ]);

const PRODUCT_CHOICE_SENSITIVITIES_V2 =
  new Set<ProductChoiceSensitivityV2>([
    'none',
    'age_restricted',
    'dietary_variant',
    'meat_cut',
    'medicine',
    'other_sensitive',
  ]);

function normalized(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = normalizeProductChoicePolicyTextV2(value);
  return result || undefined;
}

function sensitivity(
  value: ProductChoiceSensitivityV2 | undefined,
): ProductChoiceSensitivityV2 {
  return value ?? 'none';
}

function same(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return normalized(left) === normalized(right);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalized).filter(
    (value): value is string => value !== undefined,
  ))];
}

function deterministicLowestPrice(
  options: readonly ProductChoicePolicyOptionV2[],
): ProductChoicePolicyOptionV2 {
  return [...options].sort((left, right) =>
    left.priceAmount - right.priceAmount
    || left.offerId.localeCompare(right.offerId, 'en-IN'))[0]!;
}

function protectedRequest(
  request: ProductChoicePolicyRequestV2,
  options: readonly ProductChoicePolicyOptionV2[],
): boolean {
  const semanticText = [
    request.category,
    request.label,
    request.productForm,
    ...options.flatMap((option) => [
      option.category,
      option.title,
      option.productForm,
    ]),
  ].filter((value): value is string => value !== undefined).join(' ');
  const normalizedText = normalized(semanticText) ?? '';
  const protectedTerms = [
    // English categories and common semantic variants.
    'alcohol',
    'alcoholic',
    'beer',
    'beers',
    'bidi',
    'capsule',
    'capsules',
    'cigarette',
    'cigarettes',
    'drug',
    'gutkha',
    'medicine',
    'medicines',
    'medication',
    'medications',
    'nicotine',
    'pharmacy',
    'pill',
    'pills',
    'spirits',
    'syrup',
    'tablet',
    'tablets',
    'tobacco',
    'vape',
    'whiskey',
    'whisky',
    'wine',
    'wines',
    // Material dietary/meat variants.
    'boneless',
    'breast',
    'drumstick',
    'gluten free',
    'keema',
    'keto',
    'lactose free',
    'mince',
    'non vegetarian',
    'sugar free',
    'thigh',
    'vegan',
    'vegetarian',
    'wing',
    'with bone',
    // Hindi and common transliterations.
    'औषधि',
    'गोली',
    'दवा',
    'दवाई',
    'दारू',
    'मदिरा',
    'शराब',
    'सिगरेट',
    'तंबाकू',
    'तम्बाकू',
    'बीड़ी',
    'daru',
    'dava',
    'dawai',
    'madira',
    'sharab',
    'tambaku',
    // Gujarati.
    'દવા',
    'દારૂ',
    'તમાકુ',
    // Bengali.
    'ওষুধ',
    'মদ',
    'তামাক',
    // Tamil.
    'மருந்து',
    'மது',
    'புகையிலை',
    // Telugu.
    'మందు',
    'మద్యం',
    'పొగాకు',
    // Kannada.
    'ಔಷಧ',
    'ಮದ್ಯ',
    'ತಂಬಾಕು',
    // Malayalam.
    'മരുന്ന്',
    'മദ്യം',
    'പുകയില',
    // Punjabi.
    'ਦਵਾਈ',
    'ਸ਼ਰਾਬ',
    'ਤੰਬਾਕੂ',
  ].map(normalizeProductChoicePolicyTextV2);
  const searchableText = ` ${normalizedText} `;
  const protectedSemanticCategory = protectedTerms.some((term) =>
    searchableText.includes(` ${term} `));
  return sensitivity(request.sensitivity) !== 'none'
    || options.some((option) => sensitivity(option.sensitivity) !== 'none')
    || protectedSemanticCategory;
}

function validOptions(
  options: readonly ProductChoicePolicyOptionV2[],
): boolean {
  if (!Array.isArray(options) || options.length === 0 || options.length > 10) {
    return false;
  }
  const offerIds = new Set<string>();
  for (const option of options) {
    if (
      !option
      || typeof option !== 'object'
      || typeof option.offerId !== 'string'
      || !option.offerId.trim()
      || option.offerId.trim() !== option.offerId
      || option.offerId.length > 200
      || typeof option.title !== 'string'
      || !option.title.trim()
      || option.title.trim() !== option.title
      || option.title.length > 300
      || typeof option.category !== 'string'
      || !option.category.trim()
      || option.category.trim() !== option.category
      || option.category.length > 120
      || (option.brand !== undefined
        && (
          typeof option.brand !== 'string'
          || !option.brand.trim()
          || option.brand.trim() !== option.brand
          || option.brand.length > 80
        ))
      || (option.packSize !== undefined
        && (
          typeof option.packSize !== 'string'
          || !option.packSize.trim()
          || option.packSize.trim() !== option.packSize
          || option.packSize.length > 80
        ))
      || (option.productForm !== undefined
        && (
          typeof option.productForm !== 'string'
          || !option.productForm.trim()
          || option.productForm.trim() !== option.productForm
          || option.productForm.length > 80
        ))
      || (
        option.sensitivity !== undefined
        && !PRODUCT_CHOICE_SENSITIVITIES_V2.has(option.sensitivity)
      )
      || (
        option.suggested !== undefined
        && typeof option.suggested !== 'boolean'
      )
      || option.priceCurrency !== 'INR'
      || typeof option.priceAmount !== 'number'
      || !Number.isFinite(option.priceAmount)
      || option.priceAmount < 0
      || offerIds.has(option.offerId)
    ) {
      return false;
    }
    offerIds.add(option.offerId);
  }
  return true;
}

function validPolicy(policy: ProductChoicePolicyV2): boolean {
  if (
    !policy
    || typeof policy !== 'object'
    || !PRODUCT_CHOICE_POLICY_MODES_V2.has(policy.mode)
  ) return false;
  if (
    policy.priceCeiling
    && (
      typeof policy.priceCeiling !== 'object'
      || policy.priceCeiling.currency !== 'INR'
      || typeof policy.priceCeiling.amount !== 'number'
      || !Number.isFinite(policy.priceCeiling.amount)
      || policy.priceCeiling.amount <= 0
      || policy.priceCeiling.amount > 1_000_000
    )
  ) {
    return false;
  }
  if (
    policy.preferredBrands
    && (
      !Array.isArray(policy.preferredBrands)
      || policy.preferredBrands.length === 0
      || policy.preferredBrands.length > 10
      || policy.preferredBrands.some((brand) =>
        typeof brand !== 'string'
        || !brand.trim()
        || brand.trim() !== brand
        || brand.length > 80
        || !isSafeProductChoicePolicyTextV2(brand))
    )
  ) {
    return false;
  }
  if (policy.preferredBrands) {
    const brands = policy.preferredBrands.map(normalized);
    if (new Set(brands).size !== brands.length) return false;
  }
  if (policy.previousPreference) {
    const previous = policy.previousPreference;
    if (!previous || typeof previous !== 'object') return false;
    const values = [
      [previous.category, 120],
      [previous.brand, 80],
      [previous.packSize, 80],
      [previous.productForm, 80],
    ] as const;
    if (
      values.some(([value, maximum]) =>
        value !== undefined
        && (
          typeof value !== 'string'
          || !value.trim()
          || value.trim() !== value
          || value.length > maximum
          || !isSafeProductChoicePolicyTextV2(value)
        ))
      || (
        !previous.brand
        && !previous.packSize
        && !previous.productForm
      )
    ) {
      return false;
    }
  }
  if (
    policy.mode === 'known_brand_then_lowest_price'
    && !policy.preferredBrands
  ) {
    return false;
  }
  if (
    policy.mode === 'repeat_previous_preference'
    && !policy.previousPreference
  ) {
    return false;
  }
  return !(
    policy.mode === 'suggested_with_price_limit'
    && !policy.priceCeiling
  );
}

function validRequest(request: ProductChoicePolicyRequestV2): boolean {
  return Boolean(request)
    && typeof request === 'object'
    && typeof request.category === 'string'
    && request.category.trim().length > 0
    && request.category.trim() === request.category
    && request.category.length <= 120
    && typeof request.label === 'string'
    && request.label.trim().length > 0
    && request.label.trim() === request.label
    && request.label.length <= 500
    && (
      request.packSize === undefined
      || (
        typeof request.packSize === 'string'
        && request.packSize.trim().length > 0
        && request.packSize.trim() === request.packSize
        && request.packSize.length <= 80
      )
    )
    && (
      request.productForm === undefined
      || (
        typeof request.productForm === 'string'
        && request.productForm.trim().length > 0
        && request.productForm.trim() === request.productForm
        && request.productForm.length <= 80
      )
    )
    && (
      request.sensitivity === undefined
      || PRODUCT_CHOICE_SENSITIVITIES_V2.has(request.sensitivity)
    );
}

function candidatesMatchingMaterialForm(
  request: ProductChoicePolicyRequestV2,
  options: readonly ProductChoicePolicyOptionV2[],
): ProductChoicePolicyDecisionV2 | ProductChoicePolicyOptionV2[] {
  if (!request.category.trim()) {
    return { decision: 'ask', reason: 'material_category_mismatch' };
  }
  const categoryMatches = options.filter((option) =>
    same(option.category, request.category));
  if (categoryMatches.length === 0) {
    return { decision: 'ask', reason: 'material_category_mismatch' };
  }

  let formMatches = categoryMatches;
  if (request.productForm) {
    formMatches = categoryMatches.filter((option) =>
      option.productForm !== undefined
      && same(option.productForm, request.productForm));
    if (formMatches.length === 0) {
      return { decision: 'ask', reason: 'material_form_uncertain' };
    }
  } else {
    const forms = unique(categoryMatches.map((option) => option.productForm));
    const missingForm = categoryMatches.some((option) =>
      option.productForm === undefined);
    if (forms.length > 1 || (forms.length === 1 && missingForm)) {
      return { decision: 'ask', reason: 'material_form_uncertain' };
    }
  }

  if (request.packSize) {
    const packMatches = formMatches.filter((option) =>
      option.packSize !== undefined
      && same(option.packSize, request.packSize));
    return packMatches.length > 0
      ? packMatches
      : { decision: 'ask', reason: 'pack_size_uncertain' };
  }
  const packs = unique(formMatches.map((option) => option.packSize));
  const missingPack = formMatches.some((option) => option.packSize === undefined);
  if (packs.length > 1 || (packs.length === 1 && missingPack)) {
    return { decision: 'ask', reason: 'pack_size_uncertain' };
  }
  return formMatches;
}

function previousPreferenceMatches(
  policy: ProductChoicePolicyV2,
  option: ProductChoicePolicyOptionV2,
): boolean {
  const previous = policy.previousPreference;
  if (!previous || !same(previous.category, option.category)) return false;
  if (previous.brand && !same(previous.brand, option.brand)) return false;
  if (previous.packSize && !same(previous.packSize, option.packSize)) {
    return false;
  }
  if (
    previous.productForm
    && !same(previous.productForm, option.productForm)
  ) {
    return false;
  }
  return true;
}

function selectedByPolicy(
  policy: ProductChoicePolicyV2,
  candidates: readonly ProductChoicePolicyOptionV2[],
): ProductChoicePolicyDecisionV2 | ProductChoicePolicyOptionV2 {
  switch (policy.mode) {
    case 'ask_every_time':
      return { decision: 'ask', reason: 'ask_every_time' };
    case 'lowest_price_matching_pack':
      return deterministicLowestPrice(candidates);
    case 'known_brand_then_lowest_price': {
      const preferred = new Set(
        (policy.preferredBrands ?? []).map(normalized).filter(
          (brand): brand is string => brand !== undefined,
        ),
      );
      const known = candidates.filter((option) =>
        preferred.has(normalized(option.brand) ?? ''));
      return known.length > 0
        ? deterministicLowestPrice(known)
        : { decision: 'ask', reason: 'known_brand_unavailable' };
    }
    case 'repeat_previous_preference': {
      const repeated = candidates.filter((option) =>
        previousPreferenceMatches(policy, option));
      return repeated.length > 0
        ? deterministicLowestPrice(repeated)
        : { decision: 'ask', reason: 'preference_unavailable' };
    }
    case 'suggested_with_price_limit': {
      const suggested = candidates.filter((option) => option.suggested);
      return suggested.length === 1
        ? suggested[0]!
        : { decision: 'ask', reason: 'suggestion_unavailable' };
    }
  }
}

export function effectiveProductChoicePolicyV2(
  policy: ProductChoicePolicyV2 | undefined,
): Readonly<ProductChoicePolicyV2> {
  return policy ?? DEFAULT_PRODUCT_CHOICE_POLICY_V2;
}

/**
 * Makes a deterministic recommendation only. The caller owns authoritative
 * persistence and execution; this function never mutates its inputs or runs a
 * phone action.
 */
export function evaluateProductChoicePolicyV2(input: {
  options: readonly ProductChoicePolicyOptionV2[];
  policy?: ProductChoicePolicyV2;
  request: ProductChoicePolicyRequestV2;
}): ProductChoicePolicyDecisionV2 {
  const policy = effectiveProductChoicePolicyV2(input.policy);
  if (policy.mode === 'ask_every_time') {
    return { decision: 'ask', reason: 'ask_every_time' };
  }
  if (!validPolicy(policy)) {
    return { decision: 'ask', reason: 'invalid_policy' };
  }
  if (!validRequest(input.request)) {
    return { decision: 'ask', reason: 'invalid_request' };
  }
  if (!validOptions(input.options)) {
    return { decision: 'ask', reason: 'invalid_options' };
  }
  if (protectedRequest(input.request, input.options)) {
    return { decision: 'ask', reason: 'sensitive_choice' };
  }
  const matching = candidatesMatchingMaterialForm(input.request, input.options);
  if (!Array.isArray(matching)) return matching;
  const selected = selectedByPolicy(policy, matching);
  if ('decision' in selected) return selected;
  if (
    policy.priceCeiling
    && selected.priceAmount > policy.priceCeiling.amount
  ) {
    return { decision: 'ask', reason: 'price_ceiling_exceeded' };
  }
  return {
    decision: 'select',
    offerId: selected.offerId,
    policy: policy.mode,
  };
}
