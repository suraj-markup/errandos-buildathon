import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ResponsesProvider,
  SpeechProvider,
} from './provider-adapters';
import { coordinateVoiceTurn } from './coordinator';
import { LocalizedProgressSpeechCache } from './localized-progress-speech';
import {
  DeterministicUxTimingMetricsCollectorV1,
} from '../ux-timing-metrics';

function requestWithAudio(clientId: string): Request {
  const form = new FormData();
  form.set('audio', new File(['voice'], 'command.m4a', {
    type: 'audio/mp4',
  }));
  form.set('clientId', clientId);
  return new Request('http://localhost/api/voice/turn', {
    body: form,
    method: 'POST',
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function finishProvider(reply: string): ResponsesProvider {
  return {
    createResponse: vi.fn(async () => ({
      id: `response-${crypto.randomUUID()}`,
      output: [{
        type: 'function_call',
        name: 'submit_phone_plan_v2',
        call_id: `call-${crypto.randomUUID()}`,
        arguments: JSON.stringify({
          version: 2,
          intent: 'general',
          explicitProductChange: false,
          decision: 'finish',
          goal: {
            summary: 'Answer without phone execution',
            kind: 'conversation',
            terminalOutcome: 'ask_next',
            paymentPreference: null,
          },
          assistantMessage: reply,
          patchOperationsJson: '[]',
          actions: [],
        }),
      }],
    })),
  };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('UX077 non-blocking presentation acceptance', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns deterministic text and overlay before delayed Sarvam synthesis', async () => {
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'false');
    const synthesis = deferred<{
      audioBase64?: string;
      audioType?: string;
    }>();
    const synthesisStarted = deferred<void>();
    const speech: SpeechProvider = {
      synthesize: vi.fn(() => {
        synthesisStarted.resolve();
        return synthesis.promise;
      }),
      transcribe: vi.fn(async () => ({
        language_code: 'en-IN',
        transcript: 'Tell me the current status.',
      })),
    };

    let responseSettled = false;
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const acknowledgementTicks = [1_000, 1_750];
    const responsePromise = coordinateVoiceTurn(
      requestWithAudio(`ux077-text-first-${crypto.randomUUID()}`),
      `request-ux077-${crypto.randomUUID()}`,
      {
        metrics,
        now: (): number => acknowledgementTicks.shift()!,
        providers: {
          responses: finishProvider('The task is still running.'),
          speech,
        },
      },
    ).then((response) => {
      responseSettled = true;
      return response;
    });

    await synthesisStarted.promise;
    await nextEventLoopTurn();

    expect(responseSettled).toBe(true);
    const response = await responsePromise;
    const body = await response.json() as {
      audioBase64?: string;
      audioSynthesis?: {
        cacheStatus?: 'deduplicated' | 'hit' | 'miss';
        status?: 'pending' | 'ready';
        synthesisId?: string;
      };
      presentation?: {
        spoken?: { text?: string };
      };
      reply?: string;
    };
    expect(body).toMatchObject({
      audioSynthesis: {
        cacheStatus: 'miss',
        status: 'pending',
      },
      presentation: {
        spoken: {
          text: 'The task is still running.',
        },
      },
      reply: 'The task is still running.',
    });
    expect(body.audioSynthesis?.synthesisId).toEqual(expect.any(String));
    expect(body.audioBase64).toBeUndefined();
    expect(metrics.snapshot()).toEqual([
      expect.objectContaining({
        phase: 'initial_acknowledgement',
        outcome: 'completed',
        durationMs: 750,
        targetMs: 1_000,
        targetMet: true,
      }),
    ]);

    synthesis.resolve({
      audioBase64: 'AQID',
      audioType: 'audio/mpeg',
    });
  });

  it('reports localized phrase miss, deduplication, hit, and synthesis latency', async () => {
    let now = 1_000;
    let nextId = 0;
    const synthesis = deferred<{
      audioBase64?: string;
      audioType?: string;
    }>();
    const synthesize = vi.fn(() => synthesis.promise);
    const cache = new LocalizedProgressSpeechCache({
      clock: () => now,
      idFactory: () => `synthesis-${++nextId}`,
      synthesize,
    });

    const miss = cache.request({
      clientId: 'pixel-one',
      generation: 'phase-searching',
      languageCode: 'hi-IN',
      text: 'दूध खोज रहा हूँ',
    });
    const deduplicated = cache.request({
      clientId: 'pixel-two',
      generation: 'phase-searching',
      languageCode: 'hi-IN',
      text: 'दूध खोज रहा हूँ',
    });

    expect(miss).toMatchObject({
      metadata: {
        cacheStatus: 'miss',
        requestLatencyMs: 0,
      },
      status: 'pending',
    });
    expect(deduplicated).toMatchObject({
      metadata: {
        cacheStatus: 'deduplicated',
        requestLatencyMs: 0,
      },
      status: 'pending',
    });
    await Promise.resolve();
    expect(synthesize).toHaveBeenCalledOnce();

    now = 1_125;
    synthesis.resolve({
      audioBase64: 'localized-audio',
      audioType: 'audio/mpeg',
    });
    const ready = await cache.waitFor(miss.synthesisId);
    expect(ready).toMatchObject({
      metadata: {
        cacheStatus: 'miss',
        synthesisLatencyMs: 125,
      },
      status: 'ready',
    });

    const hit = cache.request({
      clientId: 'pixel-three',
      generation: 'phase-searching',
      languageCode: 'hi-IN',
      text: 'दूध खोज रहा हूँ',
    });
    expect(hit).toMatchObject({
      metadata: {
        cacheStatus: 'hit',
        requestLatencyMs: 0,
        synthesisLatencyMs: 125,
      },
      status: 'ready',
    });
    expect(cache.metrics()).toMatchObject({
      cacheEntries: 1,
      cacheHits: 1,
      cacheMisses: 1,
      deduplicatedRequests: 1,
      inFlightSyntheses: 0,
      synthesisCompleted: 1,
      totalSynthesisLatencyMs: 125,
    });
  });

  it('still returns deterministic text when the audio queue is saturated', async () => {
    vi.stubEnv('JALDI_PHONE_TASK_V2', 'false');
    const synthesis = deferred<{
      audioBase64?: string;
      audioType?: string;
    }>();
    const cache = new LocalizedProgressSpeechCache({
      maxRequests: 1,
      synthesize: () => synthesis.promise,
    });
    cache.request({
      clientId: 'existing-client',
      languageCode: 'en-IN',
      text: 'Existing synthesis',
    });
    const speech: SpeechProvider = {
      synthesize: vi.fn(async () => ({ audioBase64: 'unused' })),
      transcribe: vi.fn(async () => ({
        language_code: 'en-IN',
        transcript: 'Tell me the current status.',
      })),
    };

    const response = await coordinateVoiceTurn(
      requestWithAudio(`ux077-saturated-${crypto.randomUUID()}`),
      `request-ux077-saturated-${crypto.randomUUID()}`,
      {
        localizedProgressSpeech: cache,
        providers: {
          responses: finishProvider('The task is still running.'),
          speech,
        },
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      audioSynthesis: {
        status: 'unavailable',
      },
      presentation: {
        spoken: {
          text: 'The task is still running.',
        },
      },
      reply: 'The task is still running.',
    });
    expect(speech.synthesize).not.toHaveBeenCalled();
    synthesis.resolve({ audioBase64: 'existing-audio' });
  });
});
