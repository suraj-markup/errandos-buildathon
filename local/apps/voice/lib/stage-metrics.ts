const metricStages = [
  'device_automation',
  'device_session',
  'grounding',
  'grounding_model',
  'model',
  'provider_search',
  'queue_wait',
  'screenshot_capture',
  'screenshot_encoding',
  'screenshot_redaction',
  'synthesis',
  'transcript',
  'workflow',
] as const;

export type MetricStage = (typeof metricStages)[number];

const metricFallbackReasons = [
  'adapter_failed',
  'ambiguous_model_output',
  'appium_failure',
  'capture_budget_exhausted',
  'capture_rate_limited',
  'capture_unavailable',
  'capture_timeout',
  'cancelled',
  'device_unavailable',
  'function_error',
  'image_too_large',
  'low_confidence',
  'malformed_model_output',
  'model_timeout',
  'no_candidates',
  'no_image',
  'overlay_restoration_failed',
  'overlay_suppression_failed',
  'provider_error',
  'queue_timeout',
  'restricted_screen',
  'screen_changed',
  'session_recovery_failed',
  'stale_observation',
  'trigger_not_allowed',
  'unknown_reference',
] as const;

type MetricFallbackReason =
  (typeof metricFallbackReasons)[number];

type StageMetricOutcome =
  | 'cancelled'
  | 'completed'
  | 'error'
  | 'fallback'
  | 'timeout';

type StageMetricIds = {
  clarificationId?: string;
  clientId?: string;
  eventId?: string;
  interactionId?: string;
  itemId?: string;
  observationId?: string;
  operationId?: string;
  realtimeSessionId?: string;
  requestId?: string;
  selectionId?: string;
  stepId?: string;
  taskId?: string;
};

type StageMetricV1 = StageMetricIds & {
  durationMs: number;
  fallbackReason?: MetricFallbackReason;
  outcome: StageMetricOutcome;
  stage: MetricStage;
  version: 1;
};

type StageMetricSummaryV1 = {
  count: number;
  fallbackCounts: Partial<Record<MetricFallbackReason, number>>;
  p50DurationMs: number;
  p95DurationMs: number;
  stage: MetricStage;
  version: 1;
};

type FinishStageMetricInput = {
  fallbackReason?: MetricFallbackReason;
  outcome: StageMetricOutcome;
};

export type StageMetricTimer = {
  finish(input: FinishStageMetricInput): StageMetricV1;
};

type StageMetricsCollectorOptions = {
  maxRecords?: number;
  now?: () => number;
  onRecord?: (metric: StageMetricV1) => void;
};

function nonNegativeDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function percentile(sorted: readonly number[], proportion: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(
    0,
    Math.ceil(sorted.length * proportion) - 1,
  );
  return sorted[Math.min(index, sorted.length - 1)]!;
}

/**
 * Process-local, bounded metrics storage. The schema deliberately accepts
 * identifiers and enumerations only; there is no field for transcripts,
 * screenshots, provider payloads, addresses, or other user content.
 */
export class DeterministicStageMetricsCollector {
  readonly #maxRecords: number;
  readonly #now: () => number;
  readonly #onRecord?: (metric: StageMetricV1) => void;
  readonly #records: StageMetricV1[] = [];

  public constructor(options: StageMetricsCollectorOptions = {}) {
    this.#maxRecords = options.maxRecords ?? 2_000;
    if (!Number.isSafeInteger(this.#maxRecords) || this.#maxRecords < 1) {
      throw new Error('maxRecords must be a positive integer.');
    }
    this.#now = options.now ?? (() => performance.now());
    this.#onRecord = options.onRecord;
  }

  public begin(
    stage: MetricStage,
    ids: StageMetricIds = {},
  ): StageMetricTimer {
    const startedAt = this.#now();
    let completed: StageMetricV1 | undefined;
    return {
      finish: (input) => {
        if (completed) return { ...completed };
        completed = this.record({
          ...ids,
          durationMs: this.#now() - startedAt,
          ...input,
          stage,
        });
        return { ...completed };
      },
    };
  }

  public record(
    input: Omit<StageMetricV1, 'durationMs' | 'version'> & {
      durationMs: number;
    },
  ): StageMetricV1 {
    const metric: StageMetricV1 = {
      version: 1,
      stage: input.stage,
      outcome: input.outcome,
      durationMs: nonNegativeDuration(input.durationMs),
      ...(input.fallbackReason
        ? { fallbackReason: input.fallbackReason }
        : {}),
      ...(input.clarificationId
        ? { clarificationId: input.clarificationId }
        : {}),
      ...(input.clientId ? { clientId: input.clientId } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.interactionId
        ? { interactionId: input.interactionId }
        : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.observationId
        ? { observationId: input.observationId }
        : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.realtimeSessionId
        ? { realtimeSessionId: input.realtimeSessionId }
        : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.selectionId ? { selectionId: input.selectionId } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.#records.push(metric);
    if (this.#records.length > this.#maxRecords) {
      this.#records.splice(0, this.#records.length - this.#maxRecords);
    }
    this.#onRecord?.({ ...metric });
    return { ...metric };
  }

  public snapshot(): StageMetricV1[] {
    return this.#records.map((metric) => ({ ...metric }));
  }

  public summarize(): StageMetricSummaryV1[] {
    return metricStages.flatMap((stage) => {
      const records = this.#records.filter((metric) => metric.stage === stage);
      if (records.length === 0) return [];
      const durations = records
        .map((metric) => metric.durationMs)
        .sort((left, right) => left - right);
      const fallbackCounts: Partial<Record<MetricFallbackReason, number>> = {};
      records.forEach((metric) => {
        if (!metric.fallbackReason) return;
        fallbackCounts[metric.fallbackReason] =
          (fallbackCounts[metric.fallbackReason] ?? 0) + 1;
      });
      return [{
        version: 1 as const,
        count: records.length,
        fallbackCounts,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        stage,
      }];
    });
  }

  public reset(): void {
    this.#records.length = 0;
  }
}

const metricsGlobal = globalThis as typeof globalThis & {
  errandosStageMetrics?: DeterministicStageMetricsCollector;
};

export const stageMetrics =
  metricsGlobal.errandosStageMetrics
  ?? new DeterministicStageMetricsCollector();
metricsGlobal.errandosStageMetrics = stageMetrics;
