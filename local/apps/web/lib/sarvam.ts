import type { SupportedLanguageCode, TranscriptionResponse } from './api-contracts';
import { readErrorMessage, UpstreamError } from './http';
import { localizePreservingFacts, stripFactMarkers } from './safe-localization';

const DEFAULT_BASE_URL = 'https://api.sarvam.ai';
const DEFAULT_TIMEOUT_MS = 45_000;

interface SarvamClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface SarvamSttResponse {
  transcript?: unknown;
  language_code?: unknown;
  language_probability?: unknown;
}

interface SarvamTranslationResponse {
  translated_text?: unknown;
}

interface SarvamSpeechResponse {
  audios?: unknown;
}

const languageCodeOrEnglish = (value: unknown): SupportedLanguageCode => {
  const supported = new Set<string>([
    'as-IN', 'bn-IN', 'brx-IN', 'doi-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN',
    'kok-IN', 'ks-IN', 'mai-IN', 'ml-IN', 'mni-IN', 'mr-IN', 'ne-IN', 'od-IN',
    'pa-IN', 'sa-IN', 'sat-IN', 'sd-IN', 'ta-IN', 'te-IN', 'ur-IN',
  ]);
  return typeof value === 'string' && supported.has(value)
    ? value as SupportedLanguageCode
    : 'en-IN';
};

export class SarvamClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SarvamClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async transcribe(audio: File): Promise<TranscriptionResponse> {
    const form = new FormData();
    form.set('file', audio, audio.name || 'voice.webm');
    form.set('model', 'saaras:v3');
    form.set('mode', 'translate');
    form.set('language_code', 'unknown');

    const response = await this.fetchImpl(`${this.baseUrl}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new UpstreamError('sarvam', response.status, await readErrorMessage(response));
    }

    const body = await response.json() as SarvamSttResponse;
    if (typeof body.transcript !== 'string' || body.transcript.trim().length === 0) {
      throw new UpstreamError('sarvam', response.status, 'Sarvam returned an empty transcript.');
    }

    const probability = typeof body.language_probability === 'number'
      ? body.language_probability
      : undefined;

    return {
      transcript: body.transcript.trim(),
      languageCode: languageCodeOrEnglish(body.language_code),
      ...(probability === undefined ? {} : { languageProbability: probability }),
    };
  }

  async translate(text: string, targetLanguageCode: SupportedLanguageCode): Promise<string> {
    if (targetLanguageCode === 'en-IN') return stripFactMarkers(text);

    return localizePreservingFacts(text, async (prose) => {
      const response = await this.fetchImpl(`${this.baseUrl}/translate`, {
        method: 'POST',
        headers: {
          'api-subscription-key': this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: prose,
          source_language_code: 'en-IN',
          target_language_code: targetLanguageCode,
          model: 'sarvam-translate:v1',
          mode: 'formal',
          numerals_format: 'international',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new UpstreamError('sarvam', response.status, await readErrorMessage(response));
      }
      const body = await response.json() as SarvamTranslationResponse;
      if (typeof body.translated_text !== 'string') {
        throw new UpstreamError('sarvam', response.status, 'Sarvam returned invalid translated text.');
      }
      return body.translated_text;
    });
  }

  async speak(text: string, languageCode: SupportedLanguageCode): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/text-to-speech`, {
      method: 'POST',
      headers: {
        'api-subscription-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        target_language_code: languageCode,
        model: 'bulbul:v3',
        speaker: 'shubh',
        pace: 0.95,
        speech_sample_rate: 24_000,
        output_audio_codec: 'wav',
        temperature: 0.45,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      throw new UpstreamError('sarvam', response.status, await readErrorMessage(response));
    }
    const body = await response.json() as SarvamSpeechResponse;
    const audio = Array.isArray(body.audios) ? body.audios[0] : undefined;
    if (typeof audio !== 'string' || audio.length === 0) {
      throw new UpstreamError('sarvam', response.status, 'Sarvam returned invalid audio.');
    }
    return `data:audio/wav;base64,${audio}`;
  }
}

export const createSarvamClientFromEnv = (): SarvamClient => {
  const apiKey = process.env['SARVAM_API_KEY'];
  if (!apiKey) throw new Error('SARVAM_API_KEY is not configured.');
  const baseUrl = process.env['SARVAM_API_BASE_URL'];
  return new SarvamClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
};
