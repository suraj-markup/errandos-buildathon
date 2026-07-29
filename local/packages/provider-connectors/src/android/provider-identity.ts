export type ProviderIdentityPrice =
  | number
  | string
  | {
    currency: string;
    amount: number;
  };

export interface ProviderProductIdentity {
  provider?: string;
  offerId?: string;
  productId?: string;
  title: string;
  aliases?: readonly string[];
  packSize?: string;
  price?: ProviderIdentityPrice;
}

export type ProviderIdentityField =
  | 'provider'
  | 'offerId'
  | 'productId'
  | 'title'
  | 'packSize'
  | 'price';

export type ProviderIdentityComparisonOutcome = 'match' | 'conflict' | 'not_comparable';
export type ProviderIdentityAnchor = 'offer_id' | 'product_id' | 'title_or_alias';

export interface ProviderIdentityComparisonEvidence {
  field: ProviderIdentityField;
  outcome: ProviderIdentityComparisonOutcome;
  reason: string;
  expected?: string;
  observed?: string;
}

export interface ProviderIdentityCandidateEvidence {
  candidateIndex: number;
  compatible: boolean;
  anchors: readonly ProviderIdentityAnchor[];
  blockingConflicts: readonly ProviderIdentityField[];
  comparisons: readonly ProviderIdentityComparisonEvidence[];
}

export interface ProviderIdentityMatch<T extends ProviderProductIdentity> {
  candidate: T;
  candidateIndex: number;
  evidence: ProviderIdentityCandidateEvidence;
}

export type ProviderIdentityReconciliation<T extends ProviderProductIdentity> =
  | {
    status: 'unique';
    reason: 'unique_identity_match';
    match: ProviderIdentityMatch<T>;
    evidence: readonly ProviderIdentityCandidateEvidence[];
  }
  | {
    status: 'none';
    reason: 'no_compatible_identity';
    evidence: readonly ProviderIdentityCandidateEvidence[];
  }
  | {
    status: 'ambiguous';
    reason: 'multiple_compatible_identities';
    matches: readonly ProviderIdentityMatch<T>[];
    evidence: readonly ProviderIdentityCandidateEvidence[];
  };

interface NormalizedPrice {
  currency: string;
  minorAmount: number;
}

const BLINKIT_TITLE_ALIAS_GROUPS = [
  ['potato', 'alugadde'],
] as const;

/**
 * Reconciles one accepted provider offer against fresh product or cart
 * observations. A match needs an identity anchor (ID or title/alias), while
 * conflicting comparable IDs, provider, pack, or price always block it.
 *
 * Price is deliberately supporting evidence: equal prices cannot identify an
 * item without an ID or title anchor.
 */
export function reconcileProviderProductIdentity<T extends ProviderProductIdentity>(
  expected: ProviderProductIdentity,
  candidates: readonly T[],
): ProviderIdentityReconciliation<T> {
  const evaluated = candidates.map((candidate, candidateIndex) =>
    evaluateCandidate(expected, candidate, candidateIndex));
  const matches = evaluated
    .filter(({ evidence }) => evidence.compatible)
    .map(({ candidate, evidence }): ProviderIdentityMatch<T> => ({
      candidate,
      candidateIndex: evidence.candidateIndex,
      evidence,
    }));
  const evidence = evaluated.map((entry) => entry.evidence);

  if (matches.length === 1) {
    return {
      status: 'unique',
      reason: 'unique_identity_match',
      match: matches[0]!,
      evidence,
    };
  }
  if (matches.length === 0) {
    return {
      status: 'none',
      reason: 'no_compatible_identity',
      evidence,
    };
  }
  return {
    status: 'ambiguous',
    reason: 'multiple_compatible_identities',
    matches,
    evidence,
  };
}

function evaluateCandidate<T extends ProviderProductIdentity>(
  expected: ProviderProductIdentity,
  candidate: T,
  candidateIndex: number,
): { candidate: T; evidence: ProviderIdentityCandidateEvidence } {
  const provider = compareOptionalText('provider', expected.provider, candidate.provider, normalizeText);
  const offerId = compareOptionalText('offerId', expected.offerId, candidate.offerId, normalizeStableId);
  const productId = compareOptionalText('productId', expected.productId, candidate.productId, normalizeStableId);
  const title = compareTitles(expected, candidate);
  const packSize = comparePackSizes(expected.packSize, candidate.packSize);
  const price = comparePrices(expected.price, candidate.price);
  const comparisons = [provider, offerId, productId, title, packSize, price];

  const anchors: ProviderIdentityAnchor[] = [];
  if (offerId.outcome === 'match') anchors.push('offer_id');
  if (productId.outcome === 'match') anchors.push('product_id');
  if (title.outcome === 'match') anchors.push('title_or_alias');

  const blockingFields = new Set<ProviderIdentityField>(['provider', 'offerId', 'productId', 'packSize', 'price']);
  const blockingConflicts = comparisons
    .filter((comparison) => comparison.outcome === 'conflict' && blockingFields.has(comparison.field))
    .map((comparison) => comparison.field);

  return {
    candidate,
    evidence: {
      candidateIndex,
      compatible: anchors.length > 0 && blockingConflicts.length === 0,
      anchors,
      blockingConflicts,
      comparisons,
    },
  };
}

function compareTitles(
  expected: ProviderProductIdentity,
  observed: ProviderProductIdentity,
): ProviderIdentityComparisonEvidence {
  const provider = normalizeText(expected.provider ?? observed.provider ?? '');
  const expectedForms = normalizedTitleForms(expected, provider);
  const observedForms = normalizedTitleForms(observed, provider);
  const shared = [...expectedForms].find((form) => observedForms.has(form));
  return {
    field: 'title',
    outcome: shared ? 'match' : 'conflict',
    reason: shared ? `shared normalized title or alias: ${shared}` : 'no normalized title or alias agrees',
    expected: [...expectedForms].join(' | '),
    observed: [...observedForms].join(' | '),
  };
}

function normalizedTitleForms(identity: ProviderProductIdentity, provider: string): Set<string> {
  const forms = new Set<string>();
  for (const value of [identity.title, ...(identity.aliases ?? [])]) {
    addNormalized(forms, value);
    addNormalized(forms, value.replace(/\([^)]*\)/g, ' '));
    for (const parenthetical of value.matchAll(/\(([^)]*)\)/g)) {
      if (parenthetical[1]) addNormalized(forms, parenthetical[1]);
    }
  }

  if (provider === 'blinkit') {
    for (const group of BLINKIT_TITLE_ALIAS_GROUPS) {
      if ([...forms].some((form) => isAliasGroupForm(form, group))) {
        for (const alias of group) forms.add(alias);
      }
    }
  }
  return forms;
}

function isAliasGroupForm(form: string, group: readonly string[]): boolean {
  const tokens = new Set(form.split(' ').filter(Boolean));
  return tokens.size > 0
    && [...tokens].every((token) => group.includes(token))
    && group.some((alias) => tokens.has(alias));
}

function addNormalized(target: Set<string>, value: string): void {
  const normalized = normalizeText(value);
  if (normalized) target.add(normalized);
}

function comparePackSizes(
  expected: string | undefined,
  observed: string | undefined,
): ProviderIdentityComparisonEvidence {
  if (!expected || !observed) {
    return comparison('packSize', 'not_comparable', expected, observed, 'pack size is absent on one side');
  }
  const normalizedExpected = normalizePackSize(expected);
  const normalizedObserved = normalizePackSize(observed);
  const matches = normalizedExpected === normalizedObserved;
  return comparison(
    'packSize',
    matches ? 'match' : 'conflict',
    normalizedExpected,
    normalizedObserved,
    matches ? 'normalized pack sizes agree' : 'normalized pack sizes conflict',
  );
}

function comparePrices(
  expected: ProviderIdentityPrice | undefined,
  observed: ProviderIdentityPrice | undefined,
): ProviderIdentityComparisonEvidence {
  if (expected === undefined || observed === undefined) {
    return comparison(
      'price',
      'not_comparable',
      displayPrice(expected),
      displayPrice(observed),
      'price is absent on one side',
    );
  }
  const normalizedExpected = normalizePrice(expected);
  const normalizedObserved = normalizePrice(observed);
  if (!normalizedExpected || !normalizedObserved) {
    return comparison(
      'price',
      'not_comparable',
      displayPrice(expected),
      displayPrice(observed),
      'price could not be normalized on one side',
    );
  }
  const expectedValue = `${normalizedExpected.currency}:${normalizedExpected.minorAmount}`;
  const observedValue = `${normalizedObserved.currency}:${normalizedObserved.minorAmount}`;
  const matches = expectedValue === observedValue;
  return comparison(
    'price',
    matches ? 'match' : 'conflict',
    expectedValue,
    observedValue,
    matches ? 'currency and unit price agree' : 'currency or unit price conflicts',
  );
}

function compareOptionalText(
  field: 'provider' | 'offerId' | 'productId',
  expected: string | undefined,
  observed: string | undefined,
  normalize: (value: string) => string,
): ProviderIdentityComparisonEvidence {
  if (!expected || !observed) {
    return comparison(field, 'not_comparable', expected, observed, `${field} is absent on one side`);
  }
  const normalizedExpected = normalize(expected);
  const normalizedObserved = normalize(observed);
  const matches = normalizedExpected.length > 0
    && normalizedObserved.length > 0
    && normalizedExpected === normalizedObserved;
  return comparison(
    field,
    matches ? 'match' : 'conflict',
    normalizedExpected,
    normalizedObserved,
    matches ? `${field} agrees` : `${field} conflicts`,
  );
}

function comparison(
  field: ProviderIdentityField,
  outcome: ProviderIdentityComparisonOutcome,
  expected: string | undefined,
  observed: string | undefined,
  reason: string,
): ProviderIdentityComparisonEvidence {
  return {
    field,
    outcome,
    reason,
    ...(expected !== undefined ? { expected } : {}),
    ...(observed !== undefined ? { observed } : {}),
  };
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeStableId(value: string): string {
  return value.trim();
}

function normalizePackSize(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim()
    .replace(/\bkilograms?\b/g, 'kg')
    .replace(/\bkilogrammes?\b/g, 'kg')
    .replace(/\bgrams?\b/g, 'g')
    .replace(/\bgms?\b/g, 'g')
    .replace(/\blitres?\b/g, 'l')
    .replace(/\bliters?\b/g, 'l')
    .replace(/\bmillilitres?\b/g, 'ml')
    .replace(/\bmilliliters?\b/g, 'ml')
    .replace(/\bpieces?\b/g, 'pc')
    .replace(/\bpcs?\b/g, 'pc')
    .replace(/\bunits?\b/g, 'pc')
    .replace(/\s+/g, ' ')
    .trim();
  const simple = /^(\d+(?:\.\d+)?)\s*(mg|g|kg|ml|l|pc)$/.exec(normalized);
  if (!simple?.[1] || !simple[2]) return normalized;
  const amount = Number(simple[1]);
  if (!Number.isFinite(amount) || amount <= 0) return normalized;
  switch (simple[2]) {
    case 'mg':
      return `mass-mg:${normalizeNumber(amount)}`;
    case 'g':
      return `mass-mg:${normalizeNumber(amount * 1_000)}`;
    case 'kg':
      return `mass-mg:${normalizeNumber(amount * 1_000_000)}`;
    case 'ml':
      return `volume-ml:${normalizeNumber(amount)}`;
    case 'l':
      return `volume-ml:${normalizeNumber(amount * 1_000)}`;
    case 'pc':
      return `count:${normalizeNumber(amount)}`;
    default:
      return normalized;
  }
}

function normalizeNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function normalizePrice(value: ProviderIdentityPrice): NormalizedPrice | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0
      ? { currency: 'INR', minorAmount: Math.round(value * 100) }
      : undefined;
  }
  if (typeof value === 'object') {
    const currency = value.currency.trim().toUpperCase();
    return currency && Number.isFinite(value.amount) && value.amount >= 0
      ? { currency, minorAmount: Math.round(value.amount * 100) }
      : undefined;
  }
  const amountMatch = /-?\d[\d,]*(?:\.\d+)?/.exec(value);
  if (!amountMatch) return undefined;
  const amount = Number(amountMatch[0].replaceAll(',', ''));
  if (!Number.isFinite(amount) || amount < 0) return undefined;
  const currency = /\$|usd/i.test(value)
    ? 'USD'
    : /€|eur/i.test(value)
      ? 'EUR'
      : /₹|\brs\.?\b|\binr\b/i.test(value)
        ? 'INR'
        : 'INR';
  return { currency, minorAmount: Math.round(amount * 100) };
}

function displayPrice(value: ProviderIdentityPrice | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'object') return `${value.currency}:${value.amount}`;
  return String(value);
}
