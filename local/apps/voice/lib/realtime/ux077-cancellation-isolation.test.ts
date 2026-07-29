import { describe, expect, it, vi } from 'vitest';
import { LocalizedProgressSpeechCache } from '../voice-turn/localized-progress-speech';
import { RealtimeCancellationDomains } from './cancellation-domains';

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

describe('UX077 obsolete playback cancellation isolation', () => {
  it('marks an obsolete phrase delivery without aborting shared synthesis or phone work', async () => {
    const synthesis = deferred<{
      audioBase64?: string;
      audioType?: string;
    }>();
    const phoneCompletion = deferred<{ status: 'verified' }>();
    const synthesize = vi.fn(() => synthesis.promise);
    const executePhoneWork = vi.fn(() => phoneCompletion.promise);
    const cancelPhoneWork = vi.fn();
    const cache = new LocalizedProgressSpeechCache({
      idFactory: () => 'synthesis-obsolete',
      synthesize,
    });
    const phoneWork = executePhoneWork();

    const pending = cache.request({
      clientId: 'pixel-overlay',
      generation: 'phase-searching',
      languageCode: 'en-IN',
      text: 'Searching for milk',
    });
    await Promise.resolve();
    expect(pending.status).toBe('pending');
    expect(synthesize).toHaveBeenCalledOnce();

    expect(cache.markGenerationObsolete({
      clientId: 'pixel-overlay',
      generation: 'phase-searching',
    })).toBe(1);
    expect(cache.status(pending.synthesisId)).toMatchObject({
      status: 'obsolete',
      synthesisId: pending.synthesisId,
    });
    expect(cancelPhoneWork).not.toHaveBeenCalled();

    synthesis.resolve({
      audioBase64: 'audio-completed-for-cache',
      audioType: 'audio/mpeg',
    });
    phoneCompletion.resolve({ status: 'verified' });

    await expect(phoneWork).resolves.toEqual({ status: 'verified' });
    expect(executePhoneWork).toHaveBeenCalledOnce();
    expect(cancelPhoneWork).not.toHaveBeenCalled();
  });

  it('stops obsolete playback while in-flight phone work remains authoritative', async () => {
    const phoneCompletion = deferred<{ status: 'verified' }>();
    const executePhoneWork = vi.fn(() => phoneCompletion.promise);
    const cancelPhoneWork = vi.fn();
    const stopPlayback = vi.fn();
    const cancelResponse = vi.fn(async () => true);
    const phoneWork = executePhoneWork();
    let phoneWorkSettled = false;
    void phoneWork.then(() => {
      phoneWorkSettled = true;
    });
    const cancellation = new RealtimeCancellationDomains({
      playback: { stopPlayback },
      response: { cancelResponse },
    });

    await expect(cancellation.interruptForPushToTalk()).resolves.toEqual({
      modelResponse: 'cancelled',
      phoneOperation: 'unchanged',
      sarvamPlayback: 'stopped',
      version: 1,
    });

    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(cancelPhoneWork).not.toHaveBeenCalled();
    expect(phoneWorkSettled).toBe(false);

    phoneCompletion.resolve({ status: 'verified' });
    await expect(phoneWork).resolves.toEqual({ status: 'verified' });
    expect(executePhoneWork).toHaveBeenCalledOnce();
    expect(cancelPhoneWork).not.toHaveBeenCalled();
  });
});
