import { describe, expect, it, vi } from 'vitest';
import { SarvamClient } from '../lib/sarvam';

describe('SarvamClient', () => {
  it('transcribes speech to English and keeps the detected language', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      transcript: 'Find two packets of milk',
      language_code: 'ta-IN',
      language_probability: 0.97,
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const client = new SarvamClient({ apiKey: 'sarvam-secret', fetchImpl });

    const result = await client.transcribe(new File(['voice'], 'voice.webm', { type: 'audio/webm' }));

    expect(result).toEqual({
      transcript: 'Find two packets of milk',
      languageCode: 'ta-IN',
      languageProbability: 0.97,
    });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('api-subscription-key')).toBe('sarvam-secret');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('never sends marked facts to translation', async () => {
    const translatedInputs: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { input: string };
      translatedInputs.push(request.input);
      return new Response(JSON.stringify({ translated_text: `ಕನ್ನಡ:${request.input}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new SarvamClient({ apiKey: 'sarvam-secret', fetchImpl });

    const result = await client.translate(
      'Total [[fact:₹148]] for [[fact:Amul Taaza 1 L]].',
      'kn-IN',
    );

    expect(result).toContain('₹148');
    expect(result).toContain('Amul Taaza 1 L');
    expect(translatedInputs.join('')).not.toContain('₹148');
    expect(translatedInputs.join('')).not.toContain('Amul Taaza');
  });

  it('returns a browser-playable WAV data URL', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ audios: ['UklGRg=='] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const client = new SarvamClient({ apiKey: 'sarvam-secret', fetchImpl });

    await expect(client.speak('Namaskara', 'kn-IN'))
      .resolves.toBe('data:audio/wav;base64,UklGRg==');
  });
});
