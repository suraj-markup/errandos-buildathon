import {
  clearOverlaySpatialAttention,
  publishBroadOverlayAttention,
  publishPrivateOverlayAttention,
} from '../overlay';
import type { LocalBounds } from './observation-registry';
import type {
  GroundingFallbackReason,
  StructuredGroundingOutcome,
} from './structured-grounding';

type RotationDegrees = 0 | 90 | 180 | 270;

type NormalizedRect = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

export type DisplayTransformMetadata = {
  overlayDensityDpi: number;
  overlayHeightPx: number;
  overlayInsetsPx: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  overlayRotationDegrees: RotationDegrees;
  overlayWidthPx: number;
  sourceContentRectPx: LocalBounds;
  sourceDensityDpi: number;
  sourceHeightPx: number;
  sourceRotationDegrees: RotationDegrees;
  sourceWidthPx: number;
};

type OverlayPixelRect = {
  bottom: number;
  left: number;
  right: number;
  top: number;
};

type BroadAttentionSubject =
  | 'address'
  | 'cart'
  | 'checkout'
  | 'confirmation'
  | 'options'
  | 'payment'
  | 'product'
  | 'recent_orders';

declare const privateAttentionBrand: unique symbol;

type PrivateSpatialAttentionCommand = {
  readonly [privateAttentionBrand]: true;
};

type SpatialAttentionDecision =
  | {
      command: PrivateSpatialAttentionCommand;
      mode: 'exact';
    }
  | {
      mode: 'broad';
      subject: BroadAttentionSubject;
    }
  | {
      mode: 'none';
    };

type PrivateSpatialAttentionPayloadV1 = {
  display: DisplayTransformMetadata;
  expiresAtEpochMs: number;
  normalizedRect: NormalizedRect;
  observationId: string;
  operationId: string;
  overlayRectPx: OverlayPixelRect;
  screenFingerprint: string;
  version: 1;
};

type AttentionSink = (serializedPayload: string) => Promise<boolean>;
type BroadAttentionSink = (subject: BroadAttentionSubject) => Promise<boolean>;
type ClearAttentionSink = () => Promise<boolean>;

const privatePayloads = new WeakMap<
  PrivateSpatialAttentionCommand,
  PrivateSpatialAttentionPayloadV1
>();

const broadSubjects = new Set<BroadAttentionSubject>([
  'address',
  'cart',
  'checkout',
  'confirmation',
  'options',
  'payment',
  'product',
  'recent_orders',
]);

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validDisplay(display: DisplayTransformMetadata): boolean {
  const insets = display.overlayInsetsPx;
  return finitePositive(display.sourceWidthPx)
    && finitePositive(display.sourceHeightPx)
    && finitePositive(display.overlayWidthPx)
    && finitePositive(display.overlayHeightPx)
    && finitePositive(display.sourceDensityDpi)
    && finitePositive(display.overlayDensityDpi)
    && finitePositive(display.sourceContentRectPx.width)
    && finitePositive(display.sourceContentRectPx.height)
    && [0, 90, 180, 270].includes(display.sourceRotationDegrees)
    && [0, 90, 180, 270].includes(display.overlayRotationDegrees)
    && Object.values(insets).every(
      (value) => Number.isFinite(value) && value >= 0,
    )
    && insets.left + insets.right < display.overlayWidthPx
    && insets.top + insets.bottom < display.overlayHeightPx;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function validNormalizedRect(rect: NormalizedRect): boolean {
  return Object.values(rect).every(Number.isFinite)
    && rect.left >= 0
    && rect.top >= 0
    && rect.right <= 1
    && rect.bottom <= 1
    && rect.left < rect.right
    && rect.top < rect.bottom;
}

function rotateRect(
  rect: OverlayPixelRect,
  width: number,
  height: number,
  delta: RotationDegrees,
): OverlayPixelRect {
  switch (delta) {
    case 90:
      return {
        left: height - rect.bottom,
        top: rect.left,
        right: height - rect.top,
        bottom: rect.right,
      };
    case 180:
      return {
        left: width - rect.right,
        top: height - rect.bottom,
        right: width - rect.left,
        bottom: height - rect.top,
      };
    case 270:
      return {
        left: rect.top,
        top: width - rect.right,
        right: rect.bottom,
        bottom: width - rect.left,
      };
    default:
      return { ...rect };
  }
}

export function transformNormalizedRect(
  normalizedRect: NormalizedRect,
  display: DisplayTransformMetadata,
): OverlayPixelRect | undefined {
  if (!validNormalizedRect(normalizedRect) || !validDisplay(display)) {
    return undefined;
  }
  const crop = display.sourceContentRectPx;
  const sourceRect: OverlayPixelRect = {
    left: crop.x + normalizedRect.left * crop.width,
    top: crop.y + normalizedRect.top * crop.height,
    right: crop.x + normalizedRect.right * crop.width,
    bottom: crop.y + normalizedRect.bottom * crop.height,
  };
  const delta = (
    (
      display.overlayRotationDegrees
        - display.sourceRotationDegrees
        + 360
    ) % 360
  ) as RotationDegrees;
  const rotated = rotateRect(
    sourceRect,
    display.sourceWidthPx,
    display.sourceHeightPx,
    delta,
  );
  const densityScale =
    display.overlayDensityDpi / display.sourceDensityDpi;
  const insets = display.overlayInsetsPx;
  const minimumX = insets.left;
  const minimumY = insets.top;
  const maximumX = display.overlayWidthPx - insets.right;
  const maximumY = display.overlayHeightPx - insets.bottom;
  const transformed = {
    left: clamp(rotated.left * densityScale, minimumX, maximumX),
    top: clamp(rotated.top * densityScale, minimumY, maximumY),
    right: clamp(rotated.right * densityScale, minimumX, maximumX),
    bottom: clamp(rotated.bottom * densityScale, minimumY, maximumY),
  };
  if (
    transformed.right - transformed.left < 1
    || transformed.bottom - transformed.top < 1
  ) {
    return undefined;
  }
  return transformed;
}

function normalizedTarget(
  bounds: LocalBounds,
  content: LocalBounds,
): NormalizedRect | undefined {
  const left = clamp(bounds.x, content.x, content.x + content.width);
  const top = clamp(bounds.y, content.y, content.y + content.height);
  const right = clamp(
    bounds.x + bounds.width,
    content.x,
    content.x + content.width,
  );
  const bottom = clamp(
    bounds.y + bounds.height,
    content.y,
    content.y + content.height,
  );
  if (right - left < 1 || bottom - top < 1) return undefined;
  return {
    left: (left - content.x) / content.width,
    top: (top - content.y) / content.height,
    right: (right - content.x) / content.width,
    bottom: (bottom - content.y) / content.height,
  };
}

export function createSpatialAttentionDecision(input: {
  display: DisplayTransformMetadata;
  grounding: StructuredGroundingOutcome;
  now?: number;
  operationId: string;
  subject?: BroadAttentionSubject;
  ttlMs?: number;
}): SpatialAttentionDecision {
  if (input.grounding.status !== 'grounded') {
    return broadFallback(input.grounding.reason, input.subject);
  }
  const now = input.now ?? Date.now();
  const expiresAtEpochMs = Math.min(
    input.grounding.observation.expiresAt,
    now + Math.min(Math.max(input.ttlMs ?? 4_000, 250), 10_000),
  );
  if (
    !input.operationId.trim()
    || input.operationId !== input.grounding.operationId
    || expiresAtEpochMs <= now
    || !validDisplay(input.display)
  ) {
    return input.subject ? { mode: 'broad', subject: input.subject } : { mode: 'none' };
  }
  let binding;
  try {
    binding = input.grounding.localTarget.resolve();
  } catch {
    return input.subject ? { mode: 'broad', subject: input.subject } : { mode: 'none' };
  }
  const normalizedRect = normalizedTarget(
    binding.bounds,
    input.display.sourceContentRectPx,
  );
  const overlayRectPx = normalizedRect
    ? transformNormalizedRect(normalizedRect, input.display)
    : undefined;
  if (!normalizedRect || !overlayRectPx) {
    return input.subject ? { mode: 'broad', subject: input.subject } : { mode: 'none' };
  }

  const command = Object.freeze({}) as PrivateSpatialAttentionCommand;
  privatePayloads.set(command, {
    display: structuredClone(input.display),
    expiresAtEpochMs,
    normalizedRect: { ...normalizedRect },
    observationId: input.grounding.observation.observationId,
    operationId: input.operationId,
    overlayRectPx,
    screenFingerprint: input.grounding.observation.fingerprint,
    version: 1,
  });
  return { command, mode: 'exact' };
}

export function broadFallback(
  reason: GroundingFallbackReason,
  subject?: BroadAttentionSubject,
): SpatialAttentionDecision {
  if (
    reason === 'restricted_screen'
    || !subject
    || !broadSubjects.has(subject)
  ) {
    return { mode: 'none' };
  }
  return { mode: 'broad', subject };
}

export async function deliverSpatialAttention(
  decision: SpatialAttentionDecision,
  options: {
    clearSink?: ClearAttentionSink;
    broadSink?: BroadAttentionSink;
    exactSink?: AttentionSink;
    now?: number;
  } = {},
): Promise<boolean> {
  if (decision.mode === 'none') {
    return (options.clearSink ?? clearOverlaySpatialAttention)();
  }
  if (decision.mode === 'broad') {
    return (options.broadSink ?? publishBroadOverlayAttention)(
      decision.subject,
    );
  }
  const payload = privatePayloads.get(decision.command);
  if (!payload || payload.expiresAtEpochMs <= (options.now ?? Date.now())) {
    return (options.clearSink ?? clearOverlaySpatialAttention)();
  }
  return (options.exactSink ?? publishPrivateOverlayAttention)(
    JSON.stringify(payload),
  );
}
