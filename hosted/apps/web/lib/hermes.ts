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

const voiceTurnInstructions = (languageCode: SupportedLanguageCode): string => `
This request came from the JaldiAI voice interface. Sarvam translated the user's ${LANGUAGE_NAMES[languageCode]} speech into English.
Use the JaldiAI skill and typed JaldiAI MCP tools for provider operations. Never guess a product, quantity, price, address, or approval.
Ask a short clarification question when the translated request is ambiguous.
Reply in concise English; the interface will localize the prose back to ${LANGUAGE_NAMES[languageCode]}.
Wrap every provider-sourced fact that must remain exact in [[fact:...]] markers. This includes product titles, pack sizes, quantities, prices, fees, total, ETA, address, payment mode, expiry, proposal IDs, status, and provider references.
Never put phone numbers, OTPs, secrets, or hidden provider state in the response.
For a prepared proposal, explicitly say that nothing has been ordered yet. Do not place an order unless the owner explicitly confirms the exact proposal rendered in the immediately preceding conversation.
`.trim();

export class HermesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HermesClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_URL).replace(/\/$/, '');
    this.model = options.model ?? 'hermes-agent';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
          { role: 'system', content: voiceTurnInstructions(languageCode) },
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
  });
};
