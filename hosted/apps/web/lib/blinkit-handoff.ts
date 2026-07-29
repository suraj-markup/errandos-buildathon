const BLINKIT_URL_PATTERN = /https:\/\/(?:[a-z0-9-]+\.)*blinkit\.com\/[^\s\]]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?'"`)]+$/u;

export interface BlinkitHandoff {
  reply: string;
  shareUrl?: string;
}

const isBlinkitHostname = (hostname: string): boolean => (
  hostname === 'blinkit.com' || hostname.endsWith('.blinkit.com')
);

export const extractBlinkitHandoff = (rawReply: string): BlinkitHandoff => {
  const candidate = rawReply.match(BLINKIT_URL_PATTERN)?.[0]?.replace(TRAILING_PUNCTUATION, '');
  if (!candidate) return { reply: rawReply };

  let shareUrl: string;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || !isBlinkitHostname(parsed.hostname.toLowerCase())) {
      return { reply: rawReply };
    }
    shareUrl = parsed.toString();
  } catch {
    return { reply: rawReply };
  }

  const withoutLink = rawReply
    .replace(`[[fact:${candidate}]]`, '')
    .replace(candidate, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .trim();

  return {
    reply: withoutLink || 'Your cart link is ready. Review current availability, prices, delivery terms, and checkout inside Blinkit.',
    shareUrl,
  };
};
