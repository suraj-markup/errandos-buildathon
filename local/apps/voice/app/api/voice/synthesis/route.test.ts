import { describe, expect, it } from 'vitest';
import {
  getOrCreateLocalizedProgressSpeechCache,
} from '../../../../lib/voice-turn/localized-progress-speech';
import { GET } from './route';

describe('GET /api/voice/synthesis', () => {
  it('returns only the owning client delivery and exposes latency metadata', async () => {
    const clientId = `synthesis-owner-${crypto.randomUUID()}`;
    const cache = getOrCreateLocalizedProgressSpeechCache({
      synthesize: async () => ({
        audioBase64: 'ready-audio',
        audioType: 'audio/mpeg',
      }),
    });
    const pending = cache.request({
      clientId,
      languageCode: 'en-IN',
      text: `Ready ${crypto.randomUUID()}`,
    });
    await cache.waitFor(pending.synthesisId);

    const response = await GET(new Request(
      `http://localhost/api/voice/synthesis?clientId=${clientId}`
      + `&synthesisId=${encodeURIComponent(pending.synthesisId)}`,
    ));
    await expect(response.json()).resolves.toMatchObject({
      audioBase64: 'ready-audio',
      audioSynthesis: {
        cacheStatus: 'miss',
        requestLatencyMs: expect.any(Number),
        status: 'ready',
        synthesisId: pending.synthesisId,
      },
      ok: true,
    });

    const wrongOwner = await GET(new Request(
      'http://localhost/api/voice/synthesis?clientId=another-client'
      + `&synthesisId=${encodeURIComponent(pending.synthesisId)}`,
    ));
    expect(wrongOwner.status).toBe(404);
  });
});
