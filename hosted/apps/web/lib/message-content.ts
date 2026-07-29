const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const RAW_DATA_URL_PATTERN = /data:(?:image|audio)\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi;
const RAW_WEB_URL_PATTERN = /https?:\/\/\S+/gi;
const TABLE_DIVIDER_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const RICH_MARKDOWN_PATTERN = /(?:!\[[^\]]*]\([^)]+\)|\[[^\]]+]\(data:audio\/[^)]+\)|^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}|^#{1,6}\s|^```|^\s*[-*+]\s|^\s*\d+\.\s)/im;

const MAX_SPEAKABLE_CHARACTERS = 6_000;

const mediaDescription = (alt: string): string => {
  const normalized = alt.trim();
  if (!normalized || /^(?:image|photo|screenshot|screen)$/i.test(normalized)) {
    return 'Image attached.';
  }
  if (/^(?:audio|voice|recording)$/i.test(normalized)) return 'Audio attached.';
  return `${normalized}.`;
};

const readableTableRow = (line: string): string => {
  const cells = line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  return cells.length > 0 ? `${cells.join(', ')}.` : '';
};

export const hasRichMessageContent = (input: string): boolean => RICH_MARKDOWN_PATTERN.test(input);

export const extractSpeakableText = (input: string): string => {
  const withoutFences = input.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  const withoutMedia = withoutFences.replace(
    MARKDOWN_IMAGE_PATTERN,
    (_match, alt: string, source: string) => (
      source.toLowerCase().startsWith('data:audio/')
        ? 'Audio attached.'
        : mediaDescription(alt)
    ),
  );
  const withoutLinkedMedia = withoutMedia.replace(
    MARKDOWN_LINK_PATTERN,
    (_match, label: string, source: string) => (
      source.toLowerCase().startsWith('data:audio/') ? 'Audio attached.' : label
    ),
  );

  const readableLines = withoutLinkedMedia
    .replace(RAW_DATA_URL_PATTERN, '')
    .replace(RAW_WEB_URL_PATTERN, 'link')
    .split(/\r?\n/)
    .map((line) => {
      if (TABLE_DIVIDER_PATTERN.test(line)) return '';
      if (line.includes('|')) return readableTableRow(line);
      return line
        .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/, '')
        .replace(/[*_~`]/g, '');
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return readableLines.slice(0, MAX_SPEAKABLE_CHARACTERS).trim();
};
