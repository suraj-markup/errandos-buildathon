import { describe, expect, it, vi } from 'vitest';
import {
  LocalizedProgressSpeechCache,
  LocalizedProgressSpeechWaitAbortedError,
  type LocalizedProgressAudio,
} from './localized-progress-speech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function ids(): () => string {
  let next = 0;
  return () => `synthesis-${++next}`;
}

describe('LocalizedProgressSpeechCache', () => {
  it('returns immediately, deduplicates concurrent synthesis, then serves a cache hit', async () => {
    let now = 1_000;
    const synthesis = deferred<LocalizedProgressAudio>();
    const synthesize = vi.fn(() => synthesis.promise);
    const cache = new LocalizedProgressSpeechCache({
      clock: () => now,
      idFactory: ids(),
      synthesize,
    });

    const first = cache.request({
      clientId: 'pixel',
      generation: 'searching',
      languageCode: 'hi-IN',
      text: '  दूध   खोज रहा हूँ  ',
    });
    const second = cache.request({
      clientId: 'tablet',
      languageCode: 'hi-IN',
      text: 'दूध खोज रहा हूँ',
    });

    expect(first).toMatchObject({
      metadata: { cacheStatus: 'miss', requestLatencyMs: 0 },
      status: 'pending',
    });
    expect(second).toMatchObject({
      metadata: { cacheStatus: 'deduplicated', requestLatencyMs: 0 },
      status: 'pending',
    });
    expect(synthesize).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(synthesize).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledWith('दूध खोज रहा हूँ', 'hi-IN');

    now = 1_025;
    synthesis.resolve({
      audioBase64: 'localized-audio',
      audioType: 'audio/mpeg',
    });
    await expect(cache.waitFor(first.synthesisId)).resolves.toMatchObject({
      audio: { audioBase64: 'localized-audio' },
      metadata: {
        cacheStatus: 'miss',
        requestLatencyMs: 25,
        synthesisLatencyMs: 25,
      },
      status: 'ready',
    });
    await expect(cache.waitFor(second.synthesisId)).resolves.toMatchObject({
      metadata: {
        cacheStatus: 'deduplicated',
        synthesisLatencyMs: 25,
      },
      status: 'ready',
    });

    const cached = cache.request({
      clientId: 'pixel',
      languageCode: 'hi-IN',
      text: 'दूध खोज रहा हूँ',
    });
    expect(cached).toMatchObject({
      audio: { audioBase64: 'localized-audio' },
      metadata: {
        cacheStatus: 'hit',
        requestLatencyMs: 0,
        synthesisLatencyMs: 25,
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
      totalSynthesisLatencyMs: 25,
    });
  });

  it('expires entries and enforces an LRU cache bound', async () => {
    let now = 0;
    const synthesize = vi.fn(async (text: string) => ({
      audioBase64: `audio:${text}`,
      audioType: 'audio/mpeg',
    }));
    const cache = new LocalizedProgressSpeechCache({
      clock: () => now,
      idFactory: ids(),
      maxEntries: 2,
      synthesize,
      ttlMs: 10,
    });
    const request = async (text: string) => {
      const result = cache.request({
        clientId: 'pixel',
        languageCode: 'en-IN',
        text,
      });
      return result.status === 'pending'
        ? await cache.waitFor(result.synthesisId)
        : result;
    };

    await request('Searching for milk');
    await request('Milk added');
    expect((await request('Searching for milk'))?.metadata.cacheStatus)
      .toBe('hit');
    await request('I need your choice');
    expect(cache.metrics()).toMatchObject({
      cacheEntries: 2,
      evictions: 1,
    });

    expect((await request('Milk added'))?.metadata.cacheStatus).toBe('miss');
    now = 11;
    expect((await request('Searching for milk'))?.metadata.cacheStatus)
      .toBe('miss');
    expect(cache.metrics().expirations).toBeGreaterThanOrEqual(1);
    expect(cache.metrics().cacheEntries).toBeLessThanOrEqual(2);
  });

  it('aborts only one waiter while shared synthesis finishes and remains cacheable', async () => {
    const synthesis = deferred<LocalizedProgressAudio>();
    const synthesize = vi.fn(() => synthesis.promise);
    const cache = new LocalizedProgressSpeechCache({
      idFactory: ids(),
      synthesize,
    });
    const pending = cache.request({
      clientId: 'pixel',
      languageCode: 'en-IN',
      text: 'Searching for milk',
    });
    expect(pending.status).toBe('pending');

    const abort = new AbortController();
    const waiting = cache.waitFor(pending.synthesisId, {
      signal: abort.signal,
    });
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(
      LocalizedProgressSpeechWaitAbortedError,
    );
    expect(cache.metrics().inFlightSyntheses).toBe(1);

    synthesis.resolve({ audioBase64: 'finished-after-abort' });
    await expect(cache.waitFor(pending.synthesisId)).resolves.toMatchObject({
      audio: { audioBase64: 'finished-after-abort' },
      status: 'ready',
    });
    expect(cache.request({
      clientId: 'pixel',
      languageCode: 'en-IN',
      text: 'Searching for milk',
    })).toMatchObject({
      metadata: { cacheStatus: 'hit' },
      status: 'ready',
    });
    expect(synthesize).toHaveBeenCalledOnce();
  });

  it('marks only the obsolete client generation and never cancels shared work', async () => {
    const synthesis = deferred<LocalizedProgressAudio>();
    const synthesize = vi.fn(() => synthesis.promise);
    const phoneOperation = vi.fn();
    const cache = new LocalizedProgressSpeechCache({
      idFactory: ids(),
      synthesize,
    });
    const stale = cache.request({
      clientId: 'pixel',
      generation: 'searching',
      languageCode: 'en-IN',
      text: 'Searching for milk',
    });
    const current = cache.request({
      clientId: 'pixel',
      generation: 'adding',
      languageCode: 'en-IN',
      text: 'Searching for milk',
    });

    expect(cache.markGenerationObsolete({
      clientId: 'pixel',
      generation: 'searching',
    })).toBe(1);
    expect(cache.status(stale.synthesisId)?.status).toBe('obsolete');
    expect(cache.status(current.synthesisId)?.status).toBe('pending');
    expect(phoneOperation).not.toHaveBeenCalled();

    synthesis.resolve({ audioBase64: 'shared-audio' });
    await expect(cache.waitFor(current.synthesisId)).resolves.toMatchObject({
      audio: { audioBase64: 'shared-audio' },
      status: 'ready',
    });
    expect(cache.status(stale.synthesisId)?.status).toBe('obsolete');
    expect(synthesize).toHaveBeenCalledOnce();
    expect(phoneOperation).not.toHaveBeenCalled();
    expect(cache.metrics().obsoleteDeliveries).toBe(1);
  });

  it('accepts only bounded, non-empty progress phrases', () => {
    const cache = new LocalizedProgressSpeechCache({
      maxTextCharacters: 8,
      synthesize: vi.fn(async () => ({ audioBase64: 'audio' })),
    });

    expect(() => cache.request({
      clientId: 'pixel',
      languageCode: 'en-IN',
      text: '123456789',
    })).toThrow(/limited to 8 characters/);
    expect(() => cache.request({
      clientId: 'pixel',
      languageCode: 'en-IN',
      text: '   ',
    })).toThrow(/text is required/);
  });
});
