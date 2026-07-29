import { describe, expect, it, vi } from 'vitest';
import { activeRealtimeResponseRegistry } from '../../../../lib/realtime/active-response-registry';
import {
  getOrCreateLocalizedProgressSpeechCache,
} from '../../../../lib/voice-turn/localized-progress-speech';
import { POST } from './route';

describe('POST /api/voice/cancel-response', () => {
  it('cancels model output without exposing phone cancellation', async () => {
    const cancelResponse = vi.fn(async () => true);
    const unregister = activeRealtimeResponseRegistry.register({
      clientId: 'pixel-overlay-test',
      response: { cancelResponse },
      taskId: 'task_test',
    });
    try {
      const response = await POST(new Request(
        'http://localhost/api/voice/cancel-response',
        {
          body: JSON.stringify({ clientId: 'pixel-overlay-test' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
      ));
      await expect(response.json()).resolves.toMatchObject({
        modelResponse: 'cancelled',
        ok: true,
        phoneOperation: 'unchanged',
      });
      expect(cancelResponse).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });

  it('invalidates obsolete audio delivery without cancelling shared synthesis', async () => {
    let finishSynthesis!: (audio: { audioBase64: string }) => void;
    const synthesis = new Promise<{ audioBase64: string }>((resolve) => {
      finishSynthesis = resolve;
    });
    const cache = getOrCreateLocalizedProgressSpeechCache({
      synthesize: () => synthesis,
    });
    const clientId = `cancel-audio-${crypto.randomUUID()}`;
    const pending = cache.request({
      clientId,
      languageCode: 'en-IN',
      text: `Searching ${crypto.randomUUID()}`,
    });
    await Promise.resolve();

    const response = await POST(new Request(
      'http://localhost/api/voice/cancel-response',
      {
        body: JSON.stringify({ clientId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    ));
    await expect(response.json()).resolves.toMatchObject({
      obsoleteAudioDeliveries: 1,
      ok: true,
      phoneOperation: 'unchanged',
    });
    expect(cache.status(pending.synthesisId)?.status).toBe('obsolete');

    finishSynthesis({ audioBase64: 'cacheable-shared-audio' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(cache.metrics()).toMatchObject({
      inFlightSyntheses: 0,
      synthesisCompleted: 1,
    });
  });
});
