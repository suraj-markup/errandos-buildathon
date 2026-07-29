import { describe, expect, it, vi } from 'vitest';
import { sanitizeLogData } from '../structured-logger';
import {
  LocalGroundedTarget,
  type StructuredGroundingOutcome,
} from './structured-grounding';
import {
  broadFallback,
  createSpatialAttentionDecision,
  deliverSpatialAttention,
  transformNormalizedRect,
  type DisplayTransformMetadata,
} from './spatial-attention';

const pixelPortrait: DisplayTransformMetadata = {
  overlayDensityDpi: 420,
  overlayHeightPx: 2424,
  overlayInsetsPx: { left: 0, top: 96, right: 0, bottom: 128 },
  overlayRotationDegrees: 0,
  overlayWidthPx: 1080,
  sourceContentRectPx: { x: 0, y: 96, width: 1080, height: 2200 },
  sourceDensityDpi: 420,
  sourceHeightPx: 2424,
  sourceRotationDegrees: 0,
  sourceWidthPx: 1080,
};

function grounded(
  bounds = { x: 108, y: 536, width: 432, height: 220 },
): StructuredGroundingOutcome & { status: 'grounded' } {
  return {
    decision: {
      confidence: 0.95,
      elementRef: 'element-milk',
      rationaleCode: 'semantic_visual_match',
      version: 1,
    },
    localTarget: new LocalGroundedTarget({
      bounds,
      localNodeId: 'source-node-4',
    }),
    observation: {
      candidateCount: 1,
      capturedAt: 1_000,
      expiresAt: 10_000,
      fingerprint: 'screen-a',
      observationId: 'observation-a',
      orientation: 'PORTRAIT',
      packageName: 'com.grofers.customerapp',
    },
    operationId: 'operation-a',
    provider: 'realtime_image',
    status: 'grounded',
  };
}

describe('spatial attention coordinate transformation', () => {
  it('matches the Pixel portrait crop and inset golden fixture', () => {
    expect(transformNormalizedRect({
      left: 0.1,
      top: 0.2,
      right: 0.5,
      bottom: 0.3,
    }, pixelPortrait)).toEqual({
      left: 108,
      top: 536,
      right: 540,
      bottom: 756,
    });
  });

  it('applies density changes', () => {
    expect(transformNormalizedRect({
      left: 0.1,
      top: 0.1,
      right: 0.2,
      bottom: 0.2,
    }, {
      ...pixelPortrait,
      overlayDensityDpi: 560,
      overlayHeightPx: 3232,
      overlayInsetsPx: { left: 0, top: 0, right: 0, bottom: 0 },
      overlayWidthPx: 1440,
      sourceContentRectPx: { x: 0, y: 0, width: 1080, height: 2424 },
    })).toEqual({
      left: 144,
      top: 323.2,
      right: 288,
      bottom: 646.4,
    });
  });

  it('rotates portrait source coordinates into a landscape overlay', () => {
    expect(transformNormalizedRect({
      left: 100 / 1080,
      top: 200 / 2424,
      right: 300 / 1080,
      bottom: 400 / 2424,
    }, {
      ...pixelPortrait,
      overlayHeightPx: 1080,
      overlayInsetsPx: { left: 0, top: 0, right: 0, bottom: 0 },
      overlayRotationDegrees: 90,
      overlayWidthPx: 2424,
      sourceContentRectPx: { x: 0, y: 0, width: 1080, height: 2424 },
    })).toEqual({
      left: 2024,
      top: 100,
      right: 2224,
      bottom: 300,
    });
  });

  it('clamps to status, navigation, and side insets', () => {
    expect(transformNormalizedRect({
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    }, {
      ...pixelPortrait,
      overlayInsetsPx: { left: 20, top: 100, right: 30, bottom: 120 },
      sourceContentRectPx: { x: 0, y: 0, width: 1080, height: 2424 },
    })).toEqual({
      left: 20,
      top: 100,
      right: 1050,
      bottom: 2304,
    });
  });

  it('rejects malformed rectangles and invalid display metadata', () => {
    expect(transformNormalizedRect({
      left: 0.5,
      top: 0.2,
      right: 0.4,
      bottom: 0.3,
    }, pixelPortrait)).toBeUndefined();
    expect(transformNormalizedRect({
      left: 0.1,
      top: 0.2,
      right: 0.4,
      bottom: 0.3,
    }, {
      ...pixelPortrait,
      overlayDensityDpi: 0,
    })).toBeUndefined();
  });
});

describe('private spatial attention command', () => {
  it('binds version, operation, observation, fingerprint, display, and expiry only at delivery', async () => {
    const decision = createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: grounded(),
      now: 2_000,
      operationId: 'operation-a',
      ttlMs: 4_000,
    });
    expect(decision.mode).toBe('exact');
    expect(JSON.stringify(decision)).not.toMatch(
      /normalizedRect|overlayRect|screen-a|observation-a|operation-a|source-node|bounds/,
    );
    expect(sanitizeLogData({ decision })).toEqual({
      decision: {
        command: {},
        mode: 'exact',
      },
    });

    let payload: Record<string, unknown> | undefined;
    const delivered = await deliverSpatialAttention(decision, {
      exactSink: async (serialized) => {
        payload = JSON.parse(serialized) as Record<string, unknown>;
        return true;
      },
      now: 2_001,
    });
    expect(delivered).toBe(true);
    expect(payload).toMatchObject({
      expiresAtEpochMs: 6_000,
      observationId: 'observation-a',
      operationId: 'operation-a',
      overlayRectPx: {
        left: 108,
        top: 536,
        right: 540,
        bottom: 756,
      },
      screenFingerprint: 'screen-a',
      version: 1,
    });
  });

  it('clears instead of delivering an expired command', async () => {
    const decision = createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: grounded(),
      now: 2_000,
      operationId: 'operation-a',
      ttlMs: 250,
    });
    const exactSink = vi.fn(async () => true);
    const clearSink = vi.fn(async () => true);

    await expect(deliverSpatialAttention(decision, {
      clearSink,
      exactSink,
      now: 2_251,
    })).resolves.toBe(true);
    expect(exactSink).not.toHaveBeenCalled();
    expect(clearSink).toHaveBeenCalledOnce();
  });

  it('falls back safely for missing private binding or out-of-content geometry', () => {
    const missingBinding = {
      ...grounded(),
      localTarget: {
        resolve: () => {
          throw new Error('missing binding');
        },
      },
    } as unknown as StructuredGroundingOutcome;
    expect(createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: missingBinding,
      operationId: 'operation-a',
      subject: 'options',
    })).toEqual({ mode: 'broad', subject: 'options' });

    expect(createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: grounded({ x: 20, y: 2_400, width: 100, height: 20 }),
      operationId: 'operation-a',
    })).toEqual({ mode: 'none' });
  });

  it('rejects a mismatched operation binding', () => {
    expect(createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: grounded(),
      operationId: 'operation-b',
      subject: 'product',
    })).toEqual({ mode: 'broad', subject: 'product' });
  });

  it('uses broad semantic regions except on restricted screens', async () => {
    expect(broadFallback('unknown_reference', 'product')).toEqual({
      mode: 'broad',
      subject: 'product',
    });
    expect(broadFallback('restricted_screen', 'payment')).toEqual({
      mode: 'none',
    });
    expect(broadFallback('stale_observation')).toEqual({ mode: 'none' });

    const broadSink = vi.fn(async () => true);
    await deliverSpatialAttention({ mode: 'broad', subject: 'cart' }, {
      broadSink,
    });
    expect(broadSink).toHaveBeenCalledWith('cart');
  });

  it('uses broad or no attention when exact grounding is unavailable', () => {
    const fallback: StructuredGroundingOutcome = {
      reason: 'stale_observation',
      semanticCandidates: [],
      status: 'semantic_fallback',
    };
    expect(createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: fallback,
      operationId: 'operation-a',
      subject: 'checkout',
    })).toEqual({ mode: 'broad', subject: 'checkout' });
    expect(createSpatialAttentionDecision({
      display: pixelPortrait,
      grounding: fallback,
      operationId: 'operation-a',
    })).toEqual({ mode: 'none' });
  });
});
