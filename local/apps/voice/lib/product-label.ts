type ProductLabelSource = {
  offerId: string;
  packSize?: string;
  title: string;
};

const categoryWords = new Set([
  'beverage',
  'beverages',
  'biscuit',
  'biscuits',
  'chips',
  'drink',
  'drinks',
  'milk',
  'packet',
  'packets',
  'potato',
  'snack',
  'snacks',
]);

const normalizedToken = (value: string): string => value
  .toLocaleLowerCase('en-IN')
  .normalize('NFKD')
  .replace(/\p{M}+/gu, '')
  .replace(/[’']/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, '');

function displayTokens(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’.-]+$/gu, ''))
    .filter(Boolean);
}

function compactLabel(tokens: readonly string[]): string {
  if (tokens.length <= 3) return tokens.join(' ');
  return tokens.slice(-3).join(' ');
}

function baseLabel(
  source: ProductLabelSource,
  commonTokens: ReadonlySet<string>,
): string {
  const tokens = displayTokens(source.title);
  const distinguishing = tokens.filter((token) => {
    const normalized = normalizedToken(token);
    return normalized && !commonTokens.has(normalized);
  });
  const withoutCategory = distinguishing.filter(
    (token) => !categoryWords.has(normalizedToken(token)),
  );
  const useful = withoutCategory.length >= 2
    ? withoutCategory
    : distinguishing.length > 0
      ? distinguishing
      : tokens;

  return compactLabel(useful) || source.title.trim();
}

function commonTitleTokens(sources: readonly ProductLabelSource[]): Set<string> {
  if (sources.length < 2) return new Set();
  const [first, ...rest] = sources;
  const common = new Set(displayTokens(first?.title ?? '').map(normalizedToken).filter(Boolean));
  for (const source of rest) {
    const tokens = new Set(displayTokens(source.title).map(normalizedToken).filter(Boolean));
    for (const token of common) {
      if (!tokens.has(token)) common.delete(token);
    }
  }
  return common;
}

/**
 * Produces short labels for speech while retaining a deterministic fallback to
 * the exact provider title whenever shortening would make options ambiguous.
 */
export function buildProductSpokenLabels(
  sources: readonly ProductLabelSource[],
): Map<string, string> {
  const common = commonTitleTokens(sources);
  const labels = new Map<string, string>();
  for (const source of sources) labels.set(source.offerId, baseLabel(source, common));

  const duplicateGroups = new Map<string, ProductLabelSource[]>();
  for (const source of sources) {
    const label = labels.get(source.offerId) ?? source.title;
    const key = normalizedToken(label);
    duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), source]);
  }

  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    for (const source of group) {
      const current = labels.get(source.offerId) ?? source.title;
      labels.set(
        source.offerId,
        source.packSize ? `${current}, ${source.packSize}` : source.title.trim(),
      );
    }
  }

  const finalSeen = new Set<string>();
  for (const source of sources) {
    const label = labels.get(source.offerId) ?? source.title;
    const key = normalizedToken(label);
    if (finalSeen.has(key)) labels.set(source.offerId, source.title.trim());
    finalSeen.add(normalizedToken(labels.get(source.offerId) ?? source.title));
  }

  return labels;
}
