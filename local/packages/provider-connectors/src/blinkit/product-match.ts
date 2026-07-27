export interface BlinkitProductCandidate {
  productId: string;
  title: string;
  variant?: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function selectUniqueProductCandidate<T extends BlinkitProductCandidate>(query: string, candidates: readonly T[]): T {
  const wanted = normalize(query);
  const tokens = [...new Set(wanted.split(' ').filter(Boolean))];
  const scored = candidates.map((candidate) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate.productId)) throw new Error('Blinkit candidate lacks stable product identity');
    const text = normalize(`${candidate.title} ${candidate.variant ?? ''}`);
    const textTokens = new Set(text.split(' ').filter(Boolean));
    const overlap = tokens.filter((token) => textTokens.has(token)).length;
    const phrase = text.includes(wanted) ? 100 : 0;
    const compact = text.replaceAll(' ', '').includes(wanted.replaceAll(' ', '')) ? 50 : 0;
    return { candidate, score: phrase + compact + overlap * 10 };
  });
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  if (bestScore === 0) throw new Error(`no Blinkit result matches "${query}"`);
  const best = scored.filter(({ score }) => score === bestScore);
  if (best.length !== 1) throw new Error(`ambiguous Blinkit product match for "${query}"`);
  return best[0]!.candidate;
}
