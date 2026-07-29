import { describe, expect, it, vi } from 'vitest';
import {
  EphemeralObservationRegistry,
  type ObservationMetadata,
  type SafeObservation,
} from './observation-registry';
import type { SafeScreenObservationResult } from './observe-screen';
import type { SemanticCandidate } from './semantic-candidates';
import {
  groundScreenshotReadOnly,
  parseVisionGroundingResultV1,
  type VisionGroundingAdapter,
} from './structured-grounding';
import { ScreenshotTriggerPolicy } from './trigger-policy';

const metadata: ObservationMetadata = {
  capturedAt: 1_000,
  contentRect: { x: 0, y: 80, width: 1080, height: 2240 },
  fingerprint: 'screen-a',
  orientation: 'PORTRAIT',
  packageName: 'com.grofers.customerapp',
  viewport: { x: 0, y: 0, width: 1080, height: 2400 },
};
const candidates: SemanticCandidate[] = [
  {
    elementRef: 'element-milk-500',
    label: 'Amul Taaza Toned Milk · 500 ml · ₹29',
    role: 'button',
  },
  {
    elementRef: 'element-milk-1l',
    label: 'Amul Taaza Toned Milk · 1 L · ₹57',
    role: 'button',
  },
];

function fixture(options: {
  image?: Uint8Array;
  maxTtlMs?: number;
  now?: () => number;
} = {}): {
  observed: SafeScreenObservationResult & { status: 'observed' };
  registry: EphemeralObservationRegistry;
} {
  const registry = new EphemeralObservationRegistry({
    idFactory: () => 'observation-a',
    maxTtlMs: options.maxTtlMs,
    now: options.now ?? (() => 1_000),
  });
  const observation = registry.register({
    bindings: new Map([
      [
        'element-milk-500',
        {
          bounds: { x: 20, y: 200, width: 500, height: 120 },
          localNodeId: 'source-node-2',
        },
      ],
      [
        'element-milk-1l',
        {
          bounds: { x: 20, y: 340, width: 500, height: 120 },
          localNodeId: 'source-node-3',
        },
      ],
    ]),
    clientId: 'pixel-overlay',
    image: options.image ?? new Uint8Array([137, 80, 78, 71]),
    metadata,
    operationId: 'operation-a',
  });
  return {
    observed: {
      candidates,
      observation,
      status: 'observed',
    },
    registry,
  };
}

function adapter(
  result: unknown,
  kind: VisionGroundingAdapter['kind'] = 'responses_image',
): VisionGroundingAdapter {
  return {
    ground: vi.fn(async () => result),
    kind,
  };
}

function policy(overrides: ConstructorParameters<typeof ScreenshotTriggerPolicy>[0] = {}) {
  return new ScreenshotTriggerPolicy({
    minCaptureIntervalMs: 0,
    ...overrides,
  }, () => 1_000);
}

const input = {
  clientId: 'pixel-overlay',
  intent: 'choose_product' as const,
  operationId: 'operation-a',
  taskId: 'task-a',
  trigger: 'decision' as const,
};

describe('structured screenshot grounding', () => {
  it.each([
    'responses_image',
    'realtime_image',
  ] as const)('grounds a known reference through the %s adapter', async (kind) => {
    const { observed, registry } = fixture();
    const vision = adapter({
      confidence: 0.94,
      elementRef: 'element-milk-500',
      rationaleCode: 'semantic_visual_match',
      version: 1,
    }, kind);

    const result = await groundScreenshotReadOnly(input, {
      adapter: vision,
      observe: async () => observed,
      policy: policy(),
      registry,
    });

    expect(result.status).toBe('grounded');
    if (result.status !== 'grounded') return;
    expect(result.provider).toBe(kind);
    expect(result.localTarget.resolve()).toEqual({
      bounds: { x: 20, y: 200, width: 500, height: 120 },
      localNodeId: 'source-node-2',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /bounds|source-node|selector|coordinate|"x"|"y"/,
    );
    const request = vi.mocked(vision.ground).mock.calls[0]?.[0];
    expect(request).toEqual({
      candidates,
      image: expect.any(Uint8Array),
      intent: 'choose_product',
      version: 1,
    });
    expect(JSON.stringify(request?.candidates)).not.toMatch(
      /bounds|source-node|selector|coordinate|"x"|"y"/,
    );
  });

  it('falls back for an unknown or locally unresolved reference', async () => {
    const { observed, registry } = fixture();
    const result = await groundScreenshotReadOnly(input, {
      adapter: adapter({
        confidence: 0.99,
        elementRef: 'element-not-present',
        rationaleCode: 'visual_match',
        version: 1,
      }),
      observe: async () => observed,
      policy: policy(),
      registry,
    });

    expect(result).toMatchObject({
      reason: 'unknown_reference',
      status: 'semantic_fallback',
    });
  });

  it('falls back for ambiguous output and low confidence', async () => {
    const ambiguousFixture = fixture();
    await expect(groundScreenshotReadOnly(input, {
      adapter: adapter({
        confidence: 0.4,
        elementRef: null,
        rationaleCode: 'ambiguous',
        version: 1,
      }),
      observe: async () => ambiguousFixture.observed,
      policy: policy(),
      registry: ambiguousFixture.registry,
    })).resolves.toMatchObject({
      reason: 'ambiguous_model_output',
      status: 'semantic_fallback',
    });

    const lowFixture = fixture();
    await expect(groundScreenshotReadOnly(input, {
      adapter: adapter({
        confidence: 0.74,
        elementRef: 'element-milk-500',
        rationaleCode: 'visual_match',
        version: 1,
      }),
      observe: async () => lowFixture.observed,
      policy: policy(),
      registry: lowFixture.registry,
    })).resolves.toMatchObject({
      reason: 'low_confidence',
      status: 'semantic_fallback',
    });
  });

  it('rejects malformed output including any executable device internals', async () => {
    expect(parseVisionGroundingResultV1({
      confidence: 0.99,
      elementRef: 'element-milk-500',
      rationaleCode: 'visual_match',
      version: 1,
      x: 20,
      y: 200,
    })).toBeUndefined();
    expect(parseVisionGroundingResultV1({
      confidence: 0.99,
      elementRef: 'element-milk-500',
      rationaleCode: 'visual_match',
      selector: '//*[@text="Add"]',
      version: 1,
    })).toBeUndefined();

    const { observed, registry } = fixture();
    await expect(groundScreenshotReadOnly(input, {
      adapter: adapter({
        confidence: 'high',
        elementRef: 'element-milk-500',
        rationaleCode: 'visual_match',
        version: 1,
      }),
      observe: async () => observed,
      policy: policy(),
      registry,
    })).resolves.toMatchObject({
      reason: 'malformed_model_output',
      status: 'semantic_fallback',
    });
  });

  it('falls back when the observation expires before model resolution', async () => {
    let now = 1_000;
    const { observed, registry } = fixture({
      maxTtlMs: 10,
      now: () => now,
    });
    now = 1_011;

    await expect(groundScreenshotReadOnly(input, {
      adapter: adapter({
        confidence: 0.99,
        elementRef: 'element-milk-500',
        rationaleCode: 'visual_match',
        version: 1,
      }),
      observe: async () => observed,
      policy: policy(),
      registry,
    })).resolves.toMatchObject({
      reason: 'stale_observation',
      status: 'semantic_fallback',
    });
  });

  it('times out the adapter and supplies an abort signal', async () => {
    const { observed, registry } = fixture();
    let receivedSignal: AbortSignal | undefined;
    const vision: VisionGroundingAdapter = {
      ground: vi.fn(async (_request, options) => {
        receivedSignal = options.signal;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          confidence: 1,
          elementRef: 'element-milk-500',
          rationaleCode: 'visual_match',
          version: 1,
        };
      }),
      kind: 'realtime_image',
    };

    await expect(groundScreenshotReadOnly(input, {
      adapter: vision,
      observe: async () => observed,
      policy: policy({ groundingTimeoutMs: 250 }),
      registry,
    })).resolves.toMatchObject({
      reason: 'model_timeout',
      status: 'semantic_fallback',
    });
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('falls back when capture or the adapter fails', async () => {
    await expect(groundScreenshotReadOnly(input, {
      adapter: adapter({}),
      observe: async () => {
        throw new Error('private Appium details');
      },
      policy: policy(),
    })).resolves.toEqual({
      reason: 'capture_unavailable',
      semanticCandidates: [],
      status: 'semantic_fallback',
    });

    const { observed, registry } = fixture();
    const failing: VisionGroundingAdapter = {
      ground: () => {
        throw new Error('provider response with sensitive content');
      },
      kind: 'responses_image',
    };
    const result = await groundScreenshotReadOnly(input, {
      adapter: failing,
      observe: async () => observed,
      policy: policy(),
      registry,
    });
    expect(result).toMatchObject({
      reason: 'adapter_failed',
      status: 'semantic_fallback',
    });
    expect(JSON.stringify(result)).not.toContain('sensitive content');
  });

  it('never calls vision for a restricted screen', async () => {
    const vision = adapter({
      confidence: 1,
      elementRef: 'element-milk-500',
      rationaleCode: 'visual_match',
      version: 1,
    });
    const restricted: SafeScreenObservationResult = {
      privacy: {
        classes: ['otp'],
        restricted: true,
        safeFallback: {
          kind: 'restricted_screen',
          message: 'This screen contains private information, so visual context was not captured.',
        },
      },
      status: 'restricted',
    };

    await expect(groundScreenshotReadOnly(input, {
      adapter: vision,
      observe: async () => restricted,
      policy: policy(),
    })).resolves.toEqual({
      reason: 'restricted_screen',
      semanticCandidates: [],
      status: 'semantic_fallback',
    });
    expect(vision.ground).not.toHaveBeenCalled();
  });

  it('falls back before vision for an absent or oversized image', async () => {
    const vision = adapter({
      confidence: 1,
      elementRef: 'element-milk-500',
      rationaleCode: 'visual_match',
      version: 1,
    });
    const missing = fixture({ image: new Uint8Array() });
    await expect(groundScreenshotReadOnly(input, {
      adapter: vision,
      observe: async () => missing.observed,
      policy: policy(),
      registry: missing.registry,
    })).resolves.toMatchObject({
      reason: 'no_image',
      status: 'semantic_fallback',
    });

    const large = fixture({ image: new Uint8Array(32_001) });
    await expect(groundScreenshotReadOnly(input, {
      adapter: vision,
      observe: async () => large.observed,
      policy: policy({ maxImageBytes: 32_000 }),
      registry: large.registry,
    })).resolves.toMatchObject({
      reason: 'image_too_large',
      status: 'semantic_fallback',
    });
    expect(vision.ground).not.toHaveBeenCalled();
  });

  it('applies trigger and per-task budgets before capture', async () => {
    const observe = vi.fn(async () => fixture().observed);
    const registry = fixture().registry;
    const capturePolicy = policy({ maxCapturesPerTask: 1 });
    const dependencies = {
      adapter: adapter({
        confidence: 0.99,
        elementRef: 'element-milk-500',
        rationaleCode: 'visual_match',
        version: 1,
      }),
      observe,
      policy: capturePolicy,
      registry,
    };

    await expect(groundScreenshotReadOnly({
      ...input,
      trigger: 'background_refresh',
    }, dependencies)).resolves.toMatchObject({
      reason: 'trigger_not_allowed',
    });
    expect(observe).not.toHaveBeenCalled();

    await groundScreenshotReadOnly(input, dependencies);
    await expect(groundScreenshotReadOnly(input, dependencies)).resolves.toMatchObject({
      reason: 'capture_budget_exhausted',
    });
    expect(observe).toHaveBeenCalledOnce();
  });
});
