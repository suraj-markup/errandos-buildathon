import {
  type EphemeralObservationRegistry,
  type LocalElementBinding,
  type ObservationContext,
  type SafeObservation,
} from './observation-registry';
import {
  observeScreenReadOnly,
  observationRegistry,
  type ObserveScreenDependencies,
  type SafeScreenObservationResult,
} from './observe-screen';
import type { SemanticCandidate } from './semantic-candidates';
import {
  ScreenshotTriggerPolicy,
  type ScreenshotTrigger,
} from './trigger-policy';
import {
  stageMetrics,
  type DeterministicStageMetricsCollector,
} from '../stage-metrics';
import { logEvent } from '../structured-logger';
import {
  runWithStageDeadline,
  StageDeadlineExceededError,
} from '../stage-deadlines';

type VisionGroundingIntentV1 =
  | 'choose_product'
  | 'disambiguate_screen'
  | 'draw_attention'
  | 'verify_result';

type VisionGroundingRationaleCodeV1 =
  | 'ambiguous'
  | 'no_match'
  | 'ordinal_match'
  | 'selected_state'
  | 'semantic_visual_match'
  | 'visual_match';

type VisionGroundingResultV1 = {
  confidence: number;
  elementRef: string | null;
  rationaleCode: VisionGroundingRationaleCodeV1;
  version: 1;
};

type VisionGroundingRequestV1 = {
  candidates: readonly SemanticCandidate[];
  image: Uint8Array;
  intent: VisionGroundingIntentV1;
  version: 1;
};

export type VisionGroundingAdapter = {
  ground(
    request: VisionGroundingRequestV1,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
  kind: 'realtime_image' | 'responses_image';
};

export class LocalGroundedTarget {
  readonly #binding: LocalElementBinding;

  public constructor(binding: LocalElementBinding) {
    this.#binding = {
      bounds: { ...binding.bounds },
      localNodeId: binding.localNodeId,
    };
  }

  /** Trusted local coordinators only. Never include this return value in logs. */
  public resolve(): LocalElementBinding {
    return {
      bounds: { ...this.#binding.bounds },
      localNodeId: this.#binding.localNodeId,
    };
  }
}

export type GroundingFallbackReason =
  | 'adapter_failed'
  | 'ambiguous_model_output'
  | 'capture_budget_exhausted'
  | 'capture_rate_limited'
  | 'capture_unavailable'
  | 'image_too_large'
  | 'low_confidence'
  | 'malformed_model_output'
  | 'model_timeout'
  | 'no_candidates'
  | 'no_image'
  | 'restricted_screen'
  | 'stale_observation'
  | 'trigger_not_allowed'
  | 'unknown_reference';

export type StructuredGroundingOutcome =
  | {
      decision: VisionGroundingResultV1;
      localTarget: LocalGroundedTarget;
      observation: SafeObservation;
      operationId: string;
      provider: VisionGroundingAdapter['kind'];
      status: 'grounded';
    }
  | {
      observation?: SafeObservation;
      reason: GroundingFallbackReason;
      semanticCandidates: readonly SemanticCandidate[];
      status: 'semantic_fallback';
    };

type StructuredGroundingInput = {
  clientId: string;
  intent: VisionGroundingIntentV1;
  operationId: string;
  taskId: string;
  trigger: ScreenshotTrigger | string;
};

type StructuredGroundingDependencies = {
  adapter: VisionGroundingAdapter;
  confidenceThreshold?: number;
  observe?: (
    input: { clientId: string; operationId: string },
    dependencies?: ObserveScreenDependencies,
  ) => Promise<SafeScreenObservationResult>;
  observeDependencies?: ObserveScreenDependencies;
  policy?: ScreenshotTriggerPolicy;
  registry?: EphemeralObservationRegistry;
  metrics?: DeterministicStageMetricsCollector;
};

const rationaleCodes = new Set<VisionGroundingRationaleCodeV1>([
  'ambiguous',
  'no_match',
  'ordinal_match',
  'selected_state',
  'semantic_visual_match',
  'visual_match',
]);
const noSelectionCodes = new Set<VisionGroundingRationaleCodeV1>([
  'ambiguous',
  'no_match',
]);
const exactResultKeys = new Set([
  'confidence',
  'elementRef',
  'rationaleCode',
  'version',
]);

const groundingGlobal = globalThis as typeof globalThis & {
  errandosScreenshotTriggerPolicy?: ScreenshotTriggerPolicy;
};
const screenshotTriggerPolicy =
  groundingGlobal.errandosScreenshotTriggerPolicy
    ?? new ScreenshotTriggerPolicy();
groundingGlobal.errandosScreenshotTriggerPolicy = screenshotTriggerPolicy;

export function parseVisionGroundingResultV1(
  value: unknown,
): VisionGroundingResultV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !exactResultKeys.has(key))
    || record['version'] !== 1
    || typeof record['confidence'] !== 'number'
    || !Number.isFinite(record['confidence'])
    || record['confidence'] < 0
    || record['confidence'] > 1
    || typeof record['rationaleCode'] !== 'string'
    || !rationaleCodes.has(
      record['rationaleCode'] as VisionGroundingRationaleCodeV1,
    )
    || (
      record['elementRef'] !== null
      && (
        typeof record['elementRef'] !== 'string'
        || record['elementRef'].length < 1
        || record['elementRef'].length > 200
      )
    )
  ) {
    return undefined;
  }
  const rationaleCode =
    record['rationaleCode'] as VisionGroundingRationaleCodeV1;
  if (
    noSelectionCodes.has(rationaleCode)
      !== (record['elementRef'] === null)
  ) {
    return undefined;
  }
  return {
    confidence: record['confidence'],
    elementRef: record['elementRef'] as string | null,
    rationaleCode,
    version: 1,
  };
}

function semanticFallback(
  reason: GroundingFallbackReason,
  candidates: readonly SemanticCandidate[] = [],
  observation?: SafeObservation,
): StructuredGroundingOutcome {
  return {
    ...(observation ? { observation } : {}),
    reason,
    semanticCandidates: candidates,
    status: 'semantic_fallback',
  };
}

async function withTimeout(
  adapter: VisionGroundingAdapter,
  request: VisionGroundingRequestV1,
  timeoutMs: number,
): Promise<
  | { status: 'completed'; value: unknown }
  | { status: 'failed' }
  | { status: 'timed_out' }
> {
  try {
    const value = await runWithStageDeadline({
      run: (signal) => Promise.resolve(adapter.ground(request, { signal })),
      stage: 'grounding',
      timeoutMs,
    });
    return { status: 'completed', value };
  } catch (error) {
    return error instanceof StageDeadlineExceededError
      ? { status: 'timed_out' }
      : { status: 'failed' };
  }
}

export async function groundScreenshotReadOnly(
  input: StructuredGroundingInput,
  dependencies: StructuredGroundingDependencies,
): Promise<StructuredGroundingOutcome> {
  const metrics = dependencies.metrics ?? stageMetrics;
  const metricIds = {
    clientId: input.clientId,
    operationId: input.operationId,
    taskId: input.taskId,
  };
  const groundingTimer = metrics.begin('grounding', metricIds);
  const fallback = (
    reason: GroundingFallbackReason,
    candidates: readonly SemanticCandidate[] = [],
    observation?: SafeObservation,
  ): StructuredGroundingOutcome => {
    logEvent('info', 'metric.stage', groundingTimer.finish({
      fallbackReason: reason,
      outcome: reason === 'model_timeout' ? 'timeout' : 'fallback',
    }));
    return semanticFallback(reason, candidates, observation);
  };
  const policy = dependencies.policy ?? screenshotTriggerPolicy;
  const permit = policy.authorize({
    taskId: input.taskId,
    trigger: input.trigger,
  });
  if (!permit.allowed) return fallback(permit.reason);

  let observed: SafeScreenObservationResult;
  try {
    observed = await (dependencies.observe ?? observeScreenReadOnly)(
      {
        clientId: input.clientId,
        operationId: input.operationId,
      },
      dependencies.observeDependencies,
    );
  } catch {
    return fallback('capture_unavailable');
  }
  if (observed.status === 'restricted') {
    return fallback('restricted_screen');
  }
  if (observed.status === 'unavailable') {
    return fallback('capture_unavailable');
  }
  if (observed.candidates.length === 0) {
    return fallback(
      'no_candidates',
      observed.candidates,
      observed.observation,
    );
  }

  const registry = dependencies.registry
    ?? dependencies.observeDependencies?.registry
    ?? observationRegistry;
  const context: ObservationContext = {
    clientId: input.clientId,
    fingerprint: observed.observation.fingerprint,
    operationId: input.operationId,
    orientation: observed.observation.orientation,
    packageName: observed.observation.packageName,
  };
  if (!registry.get(observed.observation.observationId, context)) {
    return fallback(
      'stale_observation',
      observed.candidates,
      observed.observation,
    );
  }
  const image = registry.image(observed.observation.observationId, context);
  if (!image?.byteLength) {
    return fallback(
      'no_image',
      observed.candidates,
      observed.observation,
    );
  }
  if (image.byteLength > permit.maxImageBytes) {
    image.fill(0);
    return fallback(
      'image_too_large',
      observed.candidates,
      observed.observation,
    );
  }

  let adapterResult: Awaited<ReturnType<typeof withTimeout>>;
  const modelTimer = metrics.begin('grounding_model', {
    ...metricIds,
    observationId: observed.observation.observationId,
  });
  try {
    adapterResult = await withTimeout(
      dependencies.adapter,
      {
        candidates: observed.candidates,
        image,
        intent: input.intent,
        version: 1,
      },
      permit.groundingTimeoutMs,
    );
  } finally {
    image.fill(0);
  }
  if (adapterResult.status === 'timed_out') {
    logEvent('warn', 'metric.stage', modelTimer.finish({
      fallbackReason: 'model_timeout',
      outcome: 'timeout',
    }));
    return fallback(
      'model_timeout',
      observed.candidates,
      observed.observation,
    );
  }
  if (adapterResult.status === 'failed') {
    logEvent('warn', 'metric.stage', modelTimer.finish({
      fallbackReason: 'adapter_failed',
      outcome: 'error',
    }));
    return fallback(
      'adapter_failed',
      observed.candidates,
      observed.observation,
    );
  }
  logEvent('info', 'metric.stage', modelTimer.finish({
    outcome: 'completed',
  }));
  const decision = parseVisionGroundingResultV1(adapterResult.value);
  if (!decision) {
    return fallback(
      'malformed_model_output',
      observed.candidates,
      observed.observation,
    );
  }
  if (decision.rationaleCode === 'ambiguous' || decision.rationaleCode === 'no_match') {
    return fallback(
      'ambiguous_model_output',
      observed.candidates,
      observed.observation,
    );
  }
  const threshold = Math.min(
    Math.max(dependencies.confidenceThreshold ?? 0.75, 0),
    1,
  );
  if (decision.confidence < threshold) {
    return fallback(
      'low_confidence',
      observed.candidates,
      observed.observation,
    );
  }
  if (
    !observed.candidates.some(
      (candidate) => candidate.elementRef === decision.elementRef,
    )
  ) {
    return fallback(
      'unknown_reference',
      observed.candidates,
      observed.observation,
    );
  }
  const binding = registry.resolve(
    observed.observation.observationId,
    decision.elementRef!,
    context,
  );
  if (!binding) {
    return fallback(
      'stale_observation',
      observed.candidates,
      observed.observation,
    );
  }
  logEvent('info', 'metric.stage', groundingTimer.finish({
    outcome: 'completed',
  }));
  return {
    decision,
    localTarget: new LocalGroundedTarget(binding),
    observation: observed.observation,
    operationId: input.operationId,
    provider: dependencies.adapter.kind,
    status: 'grounded',
  };
}
