import {
  EphemeralObservationRegistry,
  type SafeObservation,
} from './observation-registry';
import {
  buildSanitizedSemanticCandidates,
  type SemanticCandidate,
} from './semantic-candidates';
import {
  captureSanitizedScreenshot,
  type SanitizedScreenshotCapture,
  type ScreenshotCaptureDependencies,
} from './screenshot-capture';
import {
  stageMetrics,
  type DeterministicStageMetricsCollector,
} from '../stage-metrics';
import { logEvent, updateLogContext } from '../structured-logger';
import {
  runWithStageDeadline,
  stageDeadlinePolicy,
  StageDeadlineExceededError,
  type StageDeadlinePolicy,
} from '../stage-deadlines';

export type SafeScreenObservationResult =
  | {
      candidates: SemanticCandidate[];
      observation: SafeObservation;
      status: 'observed';
    }
  | Extract<SanitizedScreenshotCapture, { status: 'restricted' | 'unavailable' }>;

export type ObserveScreenDependencies = {
  capture?: (
    dependencies?: ScreenshotCaptureDependencies,
  ) => Promise<SanitizedScreenshotCapture>;
  captureDependencies?: ScreenshotCaptureDependencies;
  registry?: EphemeralObservationRegistry;
  metrics?: DeterministicStageMetricsCollector;
  deadlinePolicy?: StageDeadlinePolicy;
  captureTimeoutMs?: number;
};

const observationGlobal = globalThis as typeof globalThis & {
  errandosObservationRegistry?: EphemeralObservationRegistry;
};

export const observationRegistry =
  observationGlobal.errandosObservationRegistry
    ?? new EphemeralObservationRegistry();
observationGlobal.errandosObservationRegistry = observationRegistry;

/**
 * Produces model-safe screen context without invoking a model or mutating UI.
 * Image bytes and executable geometry remain only in the ephemeral registry.
 */
export async function observeScreenReadOnly(
  input: {
    clientId: string;
    operationId: string;
  },
  dependencies: ObserveScreenDependencies = {},
): Promise<SafeScreenObservationResult> {
  const metrics = dependencies.metrics ?? stageMetrics;
  const deadlinePolicy = dependencies.deadlinePolicy ?? stageDeadlinePolicy;
  const captureTimer = metrics.begin('screenshot_capture', {
    clientId: input.clientId,
    operationId: input.operationId,
  });
  let capture: SanitizedScreenshotCapture;
  try {
    capture = await runWithStageDeadline({
      run: async () =>
        (dependencies.capture ?? captureSanitizedScreenshot)(
          dependencies.captureDependencies,
        ),
      stage: 'screenshot_capture',
      timeoutMs: dependencies.captureTimeoutMs
        ?? deadlinePolicy.timeoutFor('screenshot_capture'),
    });
  } catch (error) {
    if (error instanceof StageDeadlineExceededError) {
      capture = {
        reason: 'capture_timeout',
        status: 'unavailable',
      };
    } else {
    logEvent('warn', 'metric.stage', captureTimer.finish({
      fallbackReason: 'capture_unavailable',
      outcome: 'error',
    }));
    throw error;
    }
  }
  if (capture.status !== 'captured') {
    logEvent('info', 'metric.stage', captureTimer.finish({
      fallbackReason: capture.status === 'restricted'
        ? 'restricted_screen'
        : capture.reason,
      outcome: 'fallback',
    }));
    return capture;
  }
  logEvent('info', 'metric.stage', captureTimer.finish({
    outcome: 'completed',
  }));

  const semantic = buildSanitizedSemanticCandidates(capture.source, {
    contentRect: capture.metadata.contentRect,
  });
  const registry = dependencies.registry ?? observationRegistry;
  registry.beginOperation(input.clientId, input.operationId);
  const observation = registry.register({
    bindings: semantic.bindings,
    clientId: input.clientId,
    image: capture.image,
    metadata: capture.metadata,
    operationId: input.operationId,
  });
  updateLogContext({
    clientId: input.clientId,
    observationId: observation.observationId,
    operationId: input.operationId,
  });
  capture.image.fill(0);

  return {
    candidates: semantic.candidates,
    observation,
    status: 'observed',
  };
}
