type PendingProductOption = {
  offerId?: string;
  priceAmount?: number;
  priceCurrency?: 'INR';
  price?: string;
  product?: string;
  size?: string;
  spokenLabel?: string;
};

type ProductChoiceResolution =
  | { kind: 'ambiguous' | 'cancel' | 'no_match' | 'retry' | 'skip' }
  | {
      index: number;
      kind: 'selected';
      option: PendingProductOption & { offerId: string };
    };

const ignoredChoiceWords = new Set([
  'add',
  'buy',
  'choose',
  'get',
  'give',
  'item',
  'kar',
  'kardo',
  'ko',
  'le',
  'lo',
  'me',
  'mein',
  'one',
  'option',
  'please',
  'select',
  'the',
  'this',
  'to',
  'wala',
  'wali',
]);

const ordinalPatterns: Array<RegExp> = [
  /\b(?:1|1st|first|pehla|pahla)\b|पहल[ाी]/iu,
  /\b(?:2|2nd|second|dusra|doosra)\b|दूसर[ाी]/iu,
  /\b(?:3|3rd|third|teesra|tisra)\b|तीसर[ाी]/iu,
  /\b(?:4|4th|fourth|chautha)\b|चौथ[ाी]/iu,
  /\b(?:5|5th|fifth|paanchva|panchva)\b|पाँचवाँ|पांचवां/iu,
];

function normalizedWords(value: string): string[] {
  return value
    .toLocaleLowerCase('en-IN')
    .replace(/\blay['’]?s\b|\blayers\b/g, 'lays')
    .replace(/\bgrams?\b/g, 'g')
    .replace(/\bkilograms?\b|\bkgs?\b/g, 'kg')
    .replace(/\bmillilit(?:er|re)s?\b|\bmls?\b/g, 'ml')
    .replace(/\blitres?\b|\bliters?\b/g, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !ignoredChoiceWords.has(word));
}

function ordinalIndex(transcript: string, optionCount: number): number | undefined {
  if (/\b(?:last|final|aakhri|akhri)\b|आखिरी|अंतिम/iu.test(transcript)) {
    return optionCount > 0 ? optionCount - 1 : undefined;
  }
  const matches = ordinalPatterns
    .map((pattern, index) => pattern.test(transcript) ? index : undefined)
    .filter((index): index is number => index !== undefined);
  return matches.length === 1 ? matches[0] : undefined;
}

export function isProductWorkflowCancellation(transcript: string): boolean {
  const normalized = transcript.toLocaleLowerCase('en-IN').trim();
  if (/\b(?:isko chhodo|skip this|next product)\b/i.test(normalized)) return false;
  if (normalized.includes('इसे छोड़ो')) return false;
  return /\b(cancel|never mind|nevermind|stop|forget it|cancel list|rehne do|chhodo)\b/i
    .test(normalized)
    || ['छोड़ो', 'रहने दो'].some((phrase) => normalized.includes(phrase));
}

export function resolvePendingProductChoice(
  transcript: string,
  options: readonly PendingProductOption[],
): ProductChoiceResolution {
  const normalized = transcript.toLocaleLowerCase('en-IN').trim();
  if (
    /\b(skip|skip this|next product|leave this|not this one|isko chhodo)\b/i
      .test(normalized)
    || normalized.includes('इसे छोड़ो')
  ) {
    return { kind: 'skip' };
  }
  if (
    /\b(retry|try again|search again|again|dobara|phir se)\b/i.test(normalized)
    || ['दोबारा', 'फिर से'].some((phrase) => normalized.includes(phrase))
  ) {
    return { kind: 'retry' };
  }
  if (isProductWorkflowCancellation(normalized)) return { kind: 'cancel' };

  const ordinal = ordinalIndex(normalized, options.length);
  if (ordinal !== undefined) {
    const option = options[ordinal];
    return option?.offerId
      ? { index: ordinal, kind: 'selected', option: { ...option, offerId: option.offerId } }
      : { kind: 'no_match' };
  }

  const wanted = normalizedWords(normalized);
  if (wanted.length === 0) return { kind: 'no_match' };
  const matches = options
    .map((option, index) => ({
      index,
      option,
      words: new Set(normalizedWords([
        option.product,
        option.spokenLabel,
        option.size,
        option.price,
      ].filter(Boolean).join(' '))),
    }))
    .filter(({ option, words }) =>
      Boolean(option.offerId) && wanted.every((word) => words.has(word)));

  if (matches.length !== 1) {
    if (matches.length > 1) return { kind: 'ambiguous' };

    // Natural voice answers often include filler in another script, for
    // example "Vanilla Magic वाला add करो". Do not require those filler
    // words to be part of the product title. A single distinctive word is
    // safe only when it occurs in exactly one visible option; otherwise keep
    // asking rather than guessing.
    const wantedSet = new Set(wanted);
    const relaxedMatches = options
      .map((option, index) => {
        const optionWords = normalizedWords([
          option.product,
          option.spokenLabel,
          option.size,
          option.price,
        ].filter(Boolean).join(' '));
        const matchedWords = optionWords.filter((word) => wantedSet.has(word));
        return { index, matchedWords, option };
      })
      .filter(({ matchedWords, option }) =>
        Boolean(option.offerId)
        && matchedWords.some((word) => word.length >= 4));
    if (relaxedMatches.length !== 1) {
      return {
        kind: relaxedMatches.length > 1 ? 'ambiguous' : 'no_match',
      };
    }
    const relaxed = relaxedMatches[0]!;
    return {
      index: relaxed.index,
      kind: 'selected',
      option: {
        ...relaxed.option,
        offerId: relaxed.option.offerId!,
      },
    };
  }
  const match = matches[0]!;
  return {
    index: match.index,
    kind: 'selected',
    option: {
      ...match.option,
      offerId: match.option.offerId!,
    },
  };
}
