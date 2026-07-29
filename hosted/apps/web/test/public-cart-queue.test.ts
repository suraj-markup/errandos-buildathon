import { describe, expect, it } from 'vitest';
import { runPublicCartTurn } from '../lib/public-cart-queue';

describe('public cart queue', () => {
  it('runs shared-emulator turns one at a time and continues after failure', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runPublicCartTurn(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      throw new Error('expected failure');
    });
    const second = runPublicCartTurn(async () => {
      events.push('second:start');
      events.push('second:end');
      return 'done';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst?.();
    await expect(first).rejects.toThrow('expected failure');
    await expect(second).resolves.toBe('done');
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
