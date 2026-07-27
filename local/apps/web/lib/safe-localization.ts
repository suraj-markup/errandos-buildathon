const FACT_PATTERN = /\[\[fact:([\s\S]*?)\]\]/g;

export type LocalizedSegment =
  | { kind: 'fact'; text: string }
  | { kind: 'prose'; text: string };

export const splitProtectedFacts = (input: string): LocalizedSegment[] => {
  const segments: LocalizedSegment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(FACT_PATTERN)) {
    const index = match.index;
    const fact = match[1];
    if (index === undefined || fact === undefined) continue;
    if (index > cursor) segments.push({ kind: 'prose', text: input.slice(cursor, index) });
    segments.push({ kind: 'fact', text: fact });
    cursor = index + match[0].length;
  }

  if (cursor < input.length) segments.push({ kind: 'prose', text: input.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: 'prose', text: input }];
};

export const stripFactMarkers = (input: string): string =>
  splitProtectedFacts(input).map((segment) => segment.text).join('');

export const localizePreservingFacts = async (
  input: string,
  translate: (text: string) => Promise<string>,
): Promise<string> => {
  const segments = splitProtectedFacts(input);
  const localized = await Promise.all(
    segments.map(async (segment) => {
      if (segment.kind === 'fact' || segment.text.trim().length === 0) return segment.text;
      const leadingWhitespace = segment.text.match(/^\s*/)?.[0] ?? '';
      const trailingWhitespace = segment.text.match(/\s*$/)?.[0] ?? '';
      const prose = segment.text.slice(
        leadingWhitespace.length,
        segment.text.length - trailingWhitespace.length,
      );
      return `${leadingWhitespace}${await translate(prose)}${trailingWhitespace}`;
    }),
  );
  return localized.join('').replace(/\n{3,}/g, '\n\n').trim();
};
