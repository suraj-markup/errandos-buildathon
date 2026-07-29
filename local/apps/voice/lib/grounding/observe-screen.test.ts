import { afterEach, describe, expect, it, vi } from 'vitest';
import { EphemeralObservationRegistry } from './observation-registry';
import { observeScreenReadOnly } from './observe-screen';

describe('read-only screen observation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a typed safe fallback when screenshot capture exceeds its deadline', async () => {
    vi.useFakeTimers();
    const result = observeScreenReadOnly({
      clientId: 'pixel-overlay',
      operationId: 'operation-timeout',
    }, {
      capture: async () => new Promise(() => undefined),
      captureTimeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toEqual({
      reason: 'capture_timeout',
      status: 'unavailable',
    });
  });

  it('returns safe candidates while retaining private material only in memory', async () => {
    const registry = new EphemeralObservationRegistry({
      idFactory: () => 'observation-a',
      now: () => 1_000,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await observeScreenReadOnly({
      clientId: 'pixel-overlay',
      operationId: 'operation-a',
    }, {
      capture: async () => ({
        image: bytes,
        metadata: {
          capturedAt: 1_000,
          contentRect: { x: 0, y: 100, width: 1080, height: 2200 },
          fingerprint: 'screen-a',
          orientation: 'PORTRAIT',
          packageName: 'com.grofers.customerapp',
          viewport: { x: 0, y: 0, width: 1080, height: 2400 },
        },
        source: '<hierarchy><node bounds="[20,200][900,320]" class="android.widget.Button" clickable="true" displayed="true" enabled="true" text="Add Amul Taaza 500 ml" /></hierarchy>',
        status: 'captured',
      }),
      registry,
    });

    expect(result).toEqual({
      candidates: [{
        elementRef: expect.stringMatching(/^element_/),
        label: 'Add Amul Taaza 500 ml',
        role: 'button',
      }],
      observation: {
        candidateCount: 1,
        capturedAt: 1_000,
        expiresAt: 31_000,
        fingerprint: 'screen-a',
        observationId: 'observation-a',
        orientation: 'PORTRAIT',
        packageName: 'com.grofers.customerapp',
      },
      status: 'observed',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /bounds|source-node|screenshot|image|android\.widget|clickable|1,2,3/,
    );
    expect(bytes).toEqual(new Uint8Array([0, 0, 0]));
  });

  it('does not create an observation for restricted or failed capture', async () => {
    const registry = new EphemeralObservationRegistry();
    const restricted = await observeScreenReadOnly({
      clientId: 'pixel-overlay',
      operationId: 'operation-a',
    }, {
      capture: async () => ({
        privacy: {
          classes: ['otp'],
          restricted: true,
          safeFallback: {
            kind: 'restricted_screen',
            message: 'This screen contains private information, so visual context was not captured.',
          },
        },
        status: 'restricted',
      }),
      registry,
    });

    expect(restricted.status).toBe('restricted');
    expect(registry.size()).toBe(0);
  });
});
