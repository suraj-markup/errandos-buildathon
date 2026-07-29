import { describe, expect, it } from 'vitest';
import {
  EphemeralObservationRegistry,
  type ObservationContext,
  type ObservationMetadata,
} from './observation-registry';

const metadata: ObservationMetadata = {
  capturedAt: 1_000,
  contentRect: { x: 0, y: 80, width: 1080, height: 2240 },
  fingerprint: 'screen-a',
  orientation: 'PORTRAIT',
  packageName: 'com.grofers.customerapp',
  viewport: { x: 0, y: 0, width: 1080, height: 2400 },
};

function context(overrides: Partial<ObservationContext> = {}): ObservationContext {
  return {
    clientId: 'pixel-overlay',
    fingerprint: 'screen-a',
    operationId: 'operation-a',
    orientation: 'PORTRAIT',
    packageName: 'com.grofers.customerapp',
    ...overrides,
  };
}

describe('ephemeral observation registry', () => {
  it('keeps image bytes and geometry private while resolving a fresh local binding', () => {
    const registry = new EphemeralObservationRegistry({
      idFactory: () => 'observation-a',
      now: () => 1_000,
    });
    const safe = registry.register({
      bindings: new Map([[
        'element-a',
        {
          bounds: { x: 20, y: 200, width: 500, height: 90 },
          localNodeId: 'node-2',
        },
      ]]),
      clientId: 'pixel-overlay',
      image: new Uint8Array([1, 2, 3]),
      metadata,
      operationId: 'operation-a',
    });

    expect(safe).toEqual({
      candidateCount: 1,
      capturedAt: 1_000,
      expiresAt: 31_000,
      fingerprint: 'screen-a',
      observationId: 'observation-a',
      orientation: 'PORTRAIT',
      packageName: 'com.grofers.customerapp',
    });
    expect(JSON.stringify(safe)).not.toMatch(/bounds|localNodeId|image|1,2,3/);
    expect(registry.resolve('observation-a', 'element-a', context())).toEqual({
      bounds: { x: 20, y: 200, width: 500, height: 90 },
      localNodeId: 'node-2',
    });
    expect(registry.image('observation-a', context())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('expires observations and cleans them up', () => {
    let now = 1_000;
    const registry = new EphemeralObservationRegistry({
      idFactory: () => 'observation-a',
      now: () => now,
    });
    registry.register({
      bindings: new Map(),
      clientId: 'pixel-overlay',
      image: new Uint8Array([1]),
      metadata,
      operationId: 'operation-a',
      ttlMs: 100,
    });

    now = 1_100;
    expect(registry.get('observation-a', context())).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it.each([
    ['wrong package', { packageName: 'com.android.settings' }],
    ['wrong fingerprint', { fingerprint: 'screen-b' }],
    ['rotation', { orientation: 'LANDSCAPE' as const }],
  ])('invalidates on %s', (_name, overrides) => {
    const registry = new EphemeralObservationRegistry({
      idFactory: () => 'observation-a',
      now: () => 1_000,
    });
    registry.register({
      bindings: new Map(),
      clientId: 'pixel-overlay',
      image: new Uint8Array([1]),
      metadata,
      operationId: 'operation-a',
    });

    expect(registry.get('observation-a', context(overrides))).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('replaces only the same client observation and isolates other clients', () => {
    let id = 0;
    const registry = new EphemeralObservationRegistry({
      idFactory: () => `observation-${++id}`,
      now: () => 1_000,
    });
    const first = registry.register({
      bindings: new Map(),
      clientId: 'client-a',
      image: new Uint8Array([1]),
      metadata,
      operationId: 'operation-a',
    });
    const other = registry.register({
      bindings: new Map(),
      clientId: 'client-b',
      image: new Uint8Array([2]),
      metadata,
      operationId: 'operation-b',
    });
    const replacement = registry.register({
      bindings: new Map(),
      clientId: 'client-a',
      image: new Uint8Array([3]),
      metadata,
      operationId: 'operation-c',
    });

    expect(registry.get(first.observationId, context({
      clientId: 'client-a',
    }))).toBeUndefined();
    expect(registry.get(other.observationId, context({
      clientId: 'client-b',
      operationId: 'operation-b',
    }))).toBeDefined();
    expect(registry.get(replacement.observationId, context({
      clientId: 'client-a',
      operationId: 'operation-c',
    }))).toBeDefined();
    expect(registry.get(other.observationId, context({
      clientId: 'client-a',
      operationId: 'operation-b',
    }))).toBeUndefined();
    expect(registry.get(other.observationId, context({
      clientId: 'client-b',
      operationId: 'operation-b',
    }))).toBeDefined();
  });

  it('invalidates a prior observation when a new operation begins', () => {
    const registry = new EphemeralObservationRegistry({
      idFactory: () => 'observation-a',
      now: () => 1_000,
    });
    registry.register({
      bindings: new Map(),
      clientId: 'pixel-overlay',
      image: new Uint8Array([1]),
      metadata,
      operationId: 'operation-a',
    });

    registry.beginOperation('pixel-overlay', 'operation-b');
    expect(registry.size()).toBe(0);
  });
});
