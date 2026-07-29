import type { SupportedLanguageCode } from './api-contracts';
import { readErrorMessage, UpstreamError } from './http';

const DEFAULT_URL = 'http://127.0.0.1:8642';
const DEFAULT_TIMEOUT_MS = 90_000;

interface HermesClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  publicCartHandoff?: boolean;
}

interface HermesResponse {
  choices?: Array<{
    message?: { content?: unknown };
  }>;
}

const LANGUAGE_NAMES: Record<SupportedLanguageCode, string> = {
  'as-IN': 'Assamese', 'bn-IN': 'Bengali', 'brx-IN': 'Bodo', 'doi-IN': 'Dogri',
  'en-IN': 'English', 'gu-IN': 'Gujarati', 'hi-IN': 'Hindi', 'kn-IN': 'Kannada',
  'kok-IN': 'Konkani', 'ks-IN': 'Kashmiri', 'mai-IN': 'Maithili', 'ml-IN': 'Malayalam',
  'mni-IN': 'Manipuri', 'mr-IN': 'Marathi', 'ne-IN': 'Nepali', 'od-IN': 'Odia',
  'pa-IN': 'Punjabi', 'sa-IN': 'Sanskrit', 'sat-IN': 'Santali', 'sd-IN': 'Sindhi',
  'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'ur-IN': 'Urdu',
};

const voiceTurnInstructions = (
  languageCode: SupportedLanguageCode,
  publicCartHandoff: boolean,
): string => `
This request came from the JaldiAI web interface, backed by ErrandOS. Sarvam translated the user's ${LANGUAGE_NAMES[languageCode]} speech into English.
${publicCartHandoff
    ? 'Use only the cart-handoff workflow and the narrow ErrandOS MCP tools currently exposed.'
    : 'Use the ErrandOS skill and typed ErrandOS MCP tools for provider operations.'}
Never guess a product, quantity, price, address, or approval.
${publicCartHandoff
    ? 'For ambiguous grocery wording, use read-only product search first and base any follow-up on the live choices returned.'
    : 'Ask a short clarification question when the translated request is ambiguous.'}
Reply in concise English; the interface will localize the prose back to ${LANGUAGE_NAMES[languageCode]}.
Wrap every provider-sourced fact that must remain exact in [[fact:...]] markers. This includes product titles, pack sizes, quantities, prices, fees, total, ETA, address, payment mode, expiry, proposal IDs, status, and provider references.
Never put phone numbers, OTPs, secrets, or hidden provider state in the response.
${publicCartHandoff
    ? 'Nothing in this interface authorizes checkout or ordering.'
    : 'For a prepared proposal, explicitly say that nothing has been ordered yet. Do not place an order unless the owner explicitly confirms the exact proposal rendered in the immediately preceding conversation.'}
`.trim();

const publicCartHandoffInstructions = `
This is the public JaldiAI cart-handoff interface, backed by ErrandOS. The Blinkit cart is a shared, temporary working buffer used only to create an official share link.
The user is using Suraj's shared provider account. Their maximum allowed action is receiving an official cart share link.
If they ask for COD, checkout, order placement, saved-account access, or their own MCP server/setup, call no tools. Say explicitly: "On Suraj's shared account, I can only search, build, and share a cart link; I cannot place an order or use COD." Then direct them to Suraj at https://sk9261712674.com for COD access or their own MCP server/setup.
Never inspect, describe, or reveal the pre-existing cart. Never access or discuss login, phone, OTP, saved addresses, checkout, order history, proposals, receipts, or order status.
Use a search-first clarification flow:
1. Understand the user's natural grocery phrases without requiring a catalog-ready product list. Split multi-item requests into the distinct products they asked for and remember unresolved items across follow-up turns.
2. When a product, brand, flavour, pack, or quantity is ambiguous, call blinkit_search_products for each unresolved product phrase before asking a question. Search the user's words as given; for example, search "Hocco ice cream" instead of asking which Hocco flavour or pack exists.
3. Do not clear or modify the cart during this discovery step. Read-only search is the only product operation allowed until the choices are exact.
4. Use the returned catalog results to ask one compact, choice-based follow-up. Show at most four relevant live options per unresolved item with exact title, pack size, and price when returned, then ask the user to choose and provide only any still-missing quantity. Never invent an example product or ask them to rewrite the whole request in a detailed format.
5. If search returns one exact viable match but quantity is missing, show that match and ask only for quantity. If there are no relevant results, say so and ask for a nearby alternative term.
6. A follow-up such as "Hocco ice cream" refines the earlier ice-cream request. Search it immediately, retain the other unresolved items such as milk, and respond with live choices rather than another generic pack/flavour question.
Once the request is exact, complete the handoff in this same turn: clear the cart first, search for each exact item, add the requested quantities, verify each returned complete cart, and create the official Blinkit share link.
Use only the public cart tools exposed by the server. Never prepare checkout, select payment, or place an order. Treat unavailable tools as intentionally forbidden.
Return the verified cart facts and the official share URL exactly. Wrap the URL in [[fact:...]] markers.
Explain briefly that the user's Blinkit app will recheck location-specific availability, prices, delivery terms, and checkout after they open the link.
Never invent a URL or claim that a cart is ready unless blinkit_share_cart returned completed.
`.trim();

export class HermesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly publicCartHandoff: boolean;

  constructor(options: HermesClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_URL).replace(/\/$/, '');
    this.model = options.model ?? 'hermes-agent';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.publicCartHandoff = options.publicCartHandoff ?? false;
  }

  async chat(message: string, languageCode: SupportedLanguageCode, sessionId: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        'x-hermes-session-id': sessionId,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: [
              voiceTurnInstructions(languageCode, this.publicCartHandoff),
              ...(this.publicCartHandoff ? [publicCartHandoffInstructions] : []),
            ].join('\n\n'),
          },
          { role: 'user', content: message },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new UpstreamError('hermes', response.status, await readErrorMessage(response));
    }
    const body = await response.json() as HermesResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new UpstreamError('hermes', response.status, 'Hermes returned an empty response.');
    }
    return content.trim();
  }
}

export const createHermesClientFromEnv = (): HermesClient => {
  const apiKey = process.env['HERMES_API_KEY'];
  if (!apiKey) throw new Error('HERMES_API_KEY is not configured.');
  const baseUrl = process.env['HERMES_API_URL'];
  const model = process.env['HERMES_MODEL'];
  return new HermesClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    publicCartHandoff: isPublicCartHandoffEnabled(),
  });
};

export const isPublicCartHandoffEnabled = (): boolean => (
  process.env['ERRANDOS_PUBLIC_CART_HANDOFF'] === 'true'
);
