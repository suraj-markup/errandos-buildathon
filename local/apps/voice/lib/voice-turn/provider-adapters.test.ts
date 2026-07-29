import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesAdapter,
  SarvamSpeechAdapter,
  createVoiceProviderAdapters,
  extractResponseText,
} from './provider-adapters';

describe('voice provider adapters', () => {
  it('keeps the Responses provider behind a typed request/response boundary', async () => {
    const fetchImplementation = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => Response.json({
      id: 'response-1',
      output_text: 'Done.',
    }));
    const adapter = new OpenAIResponsesAdapter(
      'openai-test-key',
      fetchImplementation,
    );

    const response = await adapter.createResponse({
      input: 'hello',
      model: 'gpt-4.1-mini',
    });

    expect(extractResponseText(response)).toBe('Done.');
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [, init] = fetchImplementation.mock.calls[0]!;
    expect(init?.headers).toEqual({
      authorization: 'Bearer openai-test-key',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      input: 'hello',
      model: 'gpt-4.1-mini',
    });
  });

  it('normalizes speech input and returns synthesis without leaking HTTP details', async () => {
    const fetchImplementation = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/speech-to-text')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const body = init?.body as FormData;
        expect(body.get('model')).toBe('saaras:v3');
        expect(body.get('mode')).toBe('translate');
        expect(body.get('language_code')).toBe('unknown');
        return Response.json({
          language_code: 'hi-IN',
          transcript: 'Add milk',
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    const adapter = new SarvamSpeechAdapter(
      'sarvam-test-key',
      fetchImplementation,
    );

    const transcript = await adapter.transcribe(
      new File(['audio'], 'command.m4a', { type: 'audio/mp4; codecs=aac' }),
    );
    const voice = await adapter.synthesize('हो गया।', 'hi-IN');

    expect(transcript).toEqual({
      language_code: 'hi-IN',
      transcript: 'Add milk',
    });
    expect(voice).toEqual({
      audioBase64: 'AQID',
      audioType: 'audio/mpeg',
    });
  });

  it('retries one transient Sarvam connection reset before returning the transcript', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET' },
    });
    const fetchImplementation = vi.fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(Response.json({
        language_code: 'en-IN',
        transcript: 'check the cart',
      }));
    const adapter = new SarvamSpeechAdapter(
      'sarvam-test-key',
      fetchImplementation,
    );

    await expect(adapter.transcribe(
      new File(['audio'], 'command.m4a', { type: 'audio/mp4' }),
    )).resolves.toMatchObject({
      language_code: 'en-IN',
      transcript: 'check the cart',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(fetchImplementation.mock.calls[0]![1]?.body)
      .toBeInstanceOf(FormData);
    expect(fetchImplementation.mock.calls[1]![1]?.body)
      .toBeInstanceOf(FormData);
  });

  it('does not retry a non-transient Sarvam failure', async () => {
    const fetchImplementation = vi.fn()
      .mockRejectedValue(new TypeError('invalid request'));
    const adapter = new SarvamSpeechAdapter(
      'sarvam-test-key',
      fetchImplementation,
    );

    await expect(adapter.transcribe(
      new File(['audio'], 'command.m4a', { type: 'audio/mp4' }),
    )).rejects.toThrow('invalid request');
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('constructs independently replaceable speech and response adapters', () => {
    const adapters = createVoiceProviderAdapters({
      fetchImplementation: vi.fn(),
      openAIApiKey: 'openai-test-key',
      sarvamApiKey: 'sarvam-test-key',
    });

    expect(adapters.responses).toBeInstanceOf(OpenAIResponsesAdapter);
    expect(adapters.speech).toBeInstanceOf(SarvamSpeechAdapter);
  });
});
