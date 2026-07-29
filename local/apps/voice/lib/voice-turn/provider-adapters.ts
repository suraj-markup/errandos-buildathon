import {
  errorDetails,
  logEvent,
  traceFunction,
} from '../structured-logger';
import {
  OpenAIRealtimeControlAdapter,
  type RealtimeControlProvider,
} from '../realtime/provider-adapter';

export type OpenAIOutputItem = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

export type OpenAIResponse = {
  id?: string;
  output?: OpenAIOutputItem[];
  output_text?: string;
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

export type OpenAIResponseRequest = Record<string, unknown>;

type SarvamTranscript = {
  transcript?: string;
  language_code?: string | null;
  error?: {
    message?: string;
  };
};

type SynthesizedSpeech = {
  audioBase64?: string;
  audioType?: string;
};

export interface ResponsesProvider {
  createResponse(body: OpenAIResponseRequest): Promise<OpenAIResponse>;
}

export interface SpeechProvider {
  synthesize(text: string, languageCode: string): Promise<SynthesizedSpeech>;
  transcribe(audio: File): Promise<SarvamTranscript>;
}

const TRANSIENT_NETWORK_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function transientNetworkCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    cause?: unknown;
    code?: unknown;
  };
  if (typeof candidate.code === 'string') return candidate.code;
  return transientNetworkCode(candidate.cause);
}

async function withSingleTransientRetry<T>(
  operation: () => Promise<T>,
  stage: 'synthesize' | 'transcribe',
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const code = transientNetworkCode(error);
    if (!code || !TRANSIENT_NETWORK_CODES.has(code)) throw error;
    logEvent('warn', 'provider.sarvam.retry', {
      attempt: 2,
      reason: code,
      stage,
    });
    return operation();
  }
}

export type VoiceProviderAdapters = {
  realtime?: RealtimeControlProvider;
  responses: ResponsesProvider;
  speech: SpeechProvider;
};

export function extractResponseText(response: OpenAIResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();

  return response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && content.text)
    .map((content) => content.text)
    .join('')
    .trim() ?? '';
}

export class OpenAIResponsesAdapter implements ResponsesProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async createResponse(body: OpenAIResponseRequest): Promise<OpenAIResponse> {
    return traceFunction(
      'provider.openai.responses',
      {
        hasPreviousResponse: Boolean(body['previous_response_id']),
        inputKind: Array.isArray(body['input']) ? 'array' : typeof body['input'],
        model: body['model'],
        toolCount: Array.isArray(body['tools']) ? body['tools'].length : 0,
      },
      async () => {
        const response = await this.fetchImplementation(
          'https://api.openai.com/v1/responses',
          {
            body: JSON.stringify(body),
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              'content-type': 'application/json',
            },
            method: 'POST',
          },
        );
        const payload = await response.json() as OpenAIResponse;

        if (!response.ok) {
          throw new Error(
            payload.error?.message ?? `OpenAI returned ${response.status}.`,
          );
        }

        return payload;
      },
      (payload) => ({
        responseId: payload.id,
        responseOutputTypes: payload.output?.map((item) => item.type),
      }),
    );
  }
}

export class SarvamSpeechAdapter implements SpeechProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async transcribe(audio: File): Promise<SarvamTranscript> {
    return traceFunction(
      'provider.sarvam.transcribe',
      {
        audioBytes: audio.size,
        audioContentType: audio.type,
        audioFilename: audio.name,
      },
      async () => {
        const contentType =
          audio.type.split(';', 1)[0] || 'application/octet-stream';
        const normalizedAudio = new Blob(
          [await audio.arrayBuffer()],
          { type: contentType },
        );
        const response = await withSingleTransientRetry(
          async () => {
            const body = new FormData();
            body.set('file', normalizedAudio, audio.name || 'command.webm');
            body.set('model', 'saaras:v3');
            body.set('mode', 'translate');
            body.set('language_code', 'unknown');
            return this.fetchImplementation(
              'https://api.sarvam.ai/speech-to-text',
              {
                body,
                headers: { 'api-subscription-key': this.apiKey },
                method: 'POST',
              },
            );
          },
          'transcribe',
        );
        const payload = await response.json() as SarvamTranscript;

        if (!response.ok) {
          throw new Error(
            payload.error?.message
              ?? `Sarvam transcription returned ${response.status}.`,
          );
        }

        return payload;
      },
      (payload) => ({
        languageCode: payload.language_code,
        transcript: payload.transcript,
        transcriptCharacters: payload.transcript?.length ?? 0,
      }),
    );
  }

  async synthesize(
    text: string,
    languageCode: string,
  ): Promise<SynthesizedSpeech> {
    return traceFunction(
      'provider.sarvam.synthesize',
      {
        languageCode,
        text,
        textCharacters: text.length,
      },
      async () => {
        const response = await withSingleTransientRetry(
          () => this.fetchImplementation(
            'https://api.sarvam.ai/text-to-speech/stream',
            {
              body: JSON.stringify({
                text,
                target_language_code: languageCode,
                speaker: 'shubh',
                model: 'bulbul:v3',
                output_audio_codec: 'mp3',
                pace: 1.05,
              }),
              headers: {
                'api-subscription-key': this.apiKey,
                'content-type': 'application/json',
              },
              method: 'POST',
            },
          ),
          'synthesize',
        );

        if (!response.ok) {
          logEvent('warn', 'provider.sarvam.synthesize.unavailable', {
            httpStatus: response.status,
          });
          return {};
        }

        const audio = Buffer.from(
          await response.arrayBuffer(),
        ).toString('base64');
        return {
          audioBase64: audio,
          audioType: response.headers.get('content-type') ?? 'audio/mpeg',
        };
      },
      (voice) => ({
        audioGenerated: Boolean(voice.audioBase64),
        audioType: voice.audioType,
        audioBase64Characters: voice.audioBase64?.length ?? 0,
      }),
    );
  }
}

export function createVoiceProviderAdapters(input: {
  fetchImplementation?: typeof fetch;
  openAIApiKey: string;
  sarvamApiKey: string;
}): VoiceProviderAdapters {
  return {
    realtime: new OpenAIRealtimeControlAdapter({
      apiKey: input.openAIApiKey,
      ...(process.env.OPENAI_ORGANIZATION
        ? { organization: process.env.OPENAI_ORGANIZATION }
        : {}),
      ...(process.env.OPENAI_PROJECT
        ? { project: process.env.OPENAI_PROJECT }
        : {}),
    }),
    responses: new OpenAIResponsesAdapter(
      input.openAIApiKey,
      input.fetchImplementation,
    ),
    speech: new SarvamSpeechAdapter(
      input.sarvamApiKey,
      input.fetchImplementation,
    ),
  };
}

export async function synthesizeWithFallback(
  speech: SpeechProvider,
  text: string,
  languageCode: string,
): Promise<SynthesizedSpeech> {
  return speech.synthesize(text, languageCode).catch((error) => {
    logEvent('warn', 'provider.sarvam.synthesize.fallback', {
      ...errorDetails(error),
    });
    return {};
  });
}
