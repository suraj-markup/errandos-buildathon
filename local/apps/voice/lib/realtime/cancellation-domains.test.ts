import { describe, expect, it, vi } from 'vitest';
import { parseLocalIdentifier } from '../workflow/identifiers';
import { RealtimeCancellationDomains } from './cancellation-domains';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);

describe('Realtime cancellation domains', () => {
  it.each([
    'speaking',
    'searching',
    'adding',
    'verifying',
    'awaiting_clarification',
  ])('stops playback and obsolete model output during %s without cancelling the phone', async () => {
    const stopPlayback = vi.fn();
    const cancelResponse = vi.fn(async () => true);
    const cancelTask = vi.fn();
    const domains = new RealtimeCancellationDomains({
      playback: { stopPlayback },
      response: { cancelResponse },
    });

    await expect(domains.interruptForPushToTalk()).resolves.toEqual({
      modelResponse: 'cancelled',
      phoneOperation: 'unchanged',
      sarvamPlayback: 'stopped',
      version: 1,
    });
    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('reports an idle model response while still stopping Sarvam playback', async () => {
    const stopPlayback = vi.fn();
    const domains = new RealtimeCancellationDomains({
      playback: { stopPlayback },
      response: { cancelResponse: vi.fn(async () => false) },
    });

    await expect(domains.interruptForPushToTalk()).resolves.toMatchObject({
      modelResponse: 'idle',
      phoneOperation: 'unchanged',
      sarvamPlayback: 'stopped',
    });
  });

  it('cancels obsolete playback and response without access to phone work', async () => {
    const stopPlayback = vi.fn();
    const cancelResponse = vi.fn(async () => true);
    const cancelTask = vi.fn();
    const domains = new RealtimeCancellationDomains({
      playback: { stopPlayback },
      response: { cancelResponse },
    });

    await expect(domains.interruptObsoleteOutput()).resolves.toEqual({
      modelResponse: 'cancelled',
      phoneOperation: 'unchanged',
      sarvamPlayback: 'stopped',
      version: 1,
    });
    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(cancelResponse).toHaveBeenCalledOnce();
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('exposes phone cancellation only through an explicit task action', async () => {
    const cancelTask = vi.fn(() => ({ status: 'cancelled' }));
    const domains = new RealtimeCancellationDomains({
      playback: { stopPlayback: vi.fn() },
      response: { cancelResponse: vi.fn(async () => false) },
    });

    await expect(domains.cancelTaskExplicitly({
      controller: { cancelTask },
      taskId,
    })).resolves.toEqual({ status: 'cancelled' });
    expect(cancelTask).toHaveBeenCalledWith(taskId);
  });
});
