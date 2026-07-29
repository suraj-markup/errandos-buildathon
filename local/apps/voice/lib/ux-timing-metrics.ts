import { logEvent } from './structured-logger';

const uxTimingPhasesV1 = [
  'initial_acknowledgement',
  'choice_wait',
  'choice_acknowledgement',
  'accepted_to_first_event',
  'accepted_to_worker_start',
  'accepted_to_mutation_start',
  'mutation',
  'verification',
  'verified_to_next_step',
  'task_completion',
  'event_delivery',
] as const;

type UxTimingPhaseV1 = (typeof uxTimingPhasesV1)[number];

const uxTimingOutcomesV1 = [
  'cancelled',
  'completed',
  'duplicate',
  'error',
  'rejected',
  'timeout',
] as const;

type UxTimingOutcomeV1 = (typeof uxTimingOutcomesV1)[number];

type UxTimingCorrelationV1 = {
  clientId?: string;
  eventId?: string;
  interactionId?: string;
  itemId?: string;
  operationId?: string;
  requestId?: string;
  selectionId?: string;
  stepId?: string;
  taskId?: string;
};

export type UxTimingMetricV1 = UxTimingCorrelationV1 & {
  durationMs: number;
  outcome: UxTimingOutcomeV1;
  phase: UxTimingPhaseV1;
  targetMet?: boolean;
  targetMs?: number;
  version: 1;
};

type UxTimingSummaryV1 = {
  count: number;
  outcome: UxTimingOutcomeV1;
  p50DurationMs: number;
  p95DurationMs: number;
  phase: UxTimingPhaseV1;
  targetMetCount?: number;
  targetMs?: number;
  version: 1;
};

type UxTimingFinishInputV1 = {
  outcome: UxTimingOutcomeV1;
};

type UxTimingIntervalV1 = {
  finish(input: UxTimingFinishInputV1): UxTimingMetricV1;
};

type UxTimingMetricsCollectorOptionsV1 = {
  maxRecords?: number;
  now?: () => number;
  onRecord?: (metric: UxTimingMetricV1) => void;
};

type RecordUxTimingIntervalInputV1 = UxTimingCorrelationV1 & {
  endedAt: number;
  outcome: UxTimingOutcomeV1;
  phase: UxTimingPhaseV1;
  startedAt: number;
  targetMs?: number;
};

const correlationKeys = [
  'clientId',
  'eventId',
  'interactionId',
  'itemId',
  'operationId',
  'requestId',
  'selectionId',
  'stepId',
  'taskId',
] as const satisfies readonly (keyof UxTimingCorrelationV1)[];

const maximumRecordCount = 10_000;
const identifierPatterns = {
  clientId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/,
  eventId: /^event[_:-][A-Za-z0-9][A-Za-z0-9._:-]{3,119}$/,
  interactionId:
    /^interaction[_:-][A-Za-z0-9][A-Za-z0-9._:-]{3,119}$/,
  itemId: /^task_item_[A-Za-z0-9][A-Za-z0-9-]{3,79}$/,
  operationId: /^operation_[A-Za-z0-9][A-Za-z0-9-]{3,79}$/,
  requestId: /^request[_:-][A-Za-z0-9][A-Za-z0-9._:-]{3,119}$/,
  selectionId: /^selection_[A-Za-z0-9][A-Za-z0-9-]{3,79}$/,
  stepId: /^step[_:-][A-Za-z0-9][A-Za-z0-9._:-]{3,119}$/,
  taskId: /^task_[A-Za-z0-9][A-Za-z0-9-]{3,79}$/,
} as const satisfies Record<
  keyof UxTimingCorrelationV1,
  RegExp
>;

function finiteTimestamp(value: number, field: string): number {
  if (
    !Number.isFinite(value)
    || value < 0
    || value > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `${field} must be a finite non-negative safe-range number.`,
    );
  }
  return value;
}

function target(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('targetMs must be a positive safe integer.');
  }
  return value;
}

function correlation(
  input: UxTimingCorrelationV1,
): UxTimingCorrelationV1 {
  const result: UxTimingCorrelationV1 = {};
  for (const key of correlationKeys) {
    const value = input[key];
    if (value === undefined) continue;
    if (!identifierPatterns[key].test(value)) {
      throw new Error(`${key} must be a bounded identifier.`);
    }
    result[key] = value;
  }
  return result;
}

function phase(value: UxTimingPhaseV1): UxTimingPhaseV1 {
  if (!uxTimingPhasesV1.includes(value)) {
    throw new Error('Unsupported UX timing phase.');
  }
  return value;
}

function outcome(value: UxTimingOutcomeV1): UxTimingOutcomeV1 {
  if (!uxTimingOutcomesV1.includes(value)) {
    throw new Error('Unsupported UX timing outcome.');
  }
  return value;
}

function percentile(
  sorted: readonly number[],
  proportion: number,
): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * proportion) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function groupKey(metric: UxTimingMetricV1): string {
  return `${metric.phase}\u0000${metric.outcome}\u0000${
    metric.targetMs ?? 'none'
  }`;
}

/**
 * Process-local UX timing recorder. The public record contains only
 * enumerated lifecycle data, bounded correlation identifiers, and durations.
 * It cannot carry transcripts, product labels, screenshots, addresses,
 * provider payloads, or payment data.
 */
export class DeterministicUxTimingMetricsCollectorV1 {
  readonly #maxRecords: number;
  readonly #now: () => number;
  readonly #onRecord?: (metric: UxTimingMetricV1) => void;
  readonly #records: UxTimingMetricV1[] = [];

  public constructor(options: UxTimingMetricsCollectorOptionsV1 = {}) {
    this.#maxRecords = options.maxRecords ?? 2_000;
    if (
      !Number.isSafeInteger(this.#maxRecords)
      || this.#maxRecords < 1
      || this.#maxRecords > maximumRecordCount
    ) {
      throw new Error(
        `maxRecords must be an integer between 1 and ${maximumRecordCount}.`,
      );
    }
    this.#now = options.now ?? ((): number => performance.now());
    this.#onRecord = options.onRecord;
  }

  public begin(
    phase: UxTimingPhaseV1,
    ids: UxTimingCorrelationV1 = {},
    targetMs?: number,
  ): UxTimingIntervalV1 {
    const startedAt = finiteTimestamp(this.#now(), 'startedAt');
    const safeIds = correlation(ids);
    const safeTarget = target(targetMs);
    let completed: UxTimingMetricV1 | undefined;
    return {
      finish: (input): UxTimingMetricV1 => {
        if (completed) return structuredClone(completed);
        completed = this.recordInterval({
          ...safeIds,
          endedAt: this.#now(),
          outcome: input.outcome,
          phase,
          startedAt,
          ...(safeTarget === undefined ? {} : { targetMs: safeTarget }),
        });
        return structuredClone(completed);
      },
    };
  }

  public recordInterval(
    input: RecordUxTimingIntervalInputV1,
  ): UxTimingMetricV1 {
    const startedAt = finiteTimestamp(input.startedAt, 'startedAt');
    const endedAt = finiteTimestamp(input.endedAt, 'endedAt');
    if (endedAt < startedAt) {
      throw new Error('endedAt must not precede startedAt.');
    }
    const safeTarget = target(input.targetMs);
    const durationMs = Math.max(0, Math.round(endedAt - startedAt));
    if (!Number.isSafeInteger(durationMs)) {
      throw new Error('durationMs must be a non-negative safe integer.');
    }
    const metric: UxTimingMetricV1 = {
      version: 1,
      phase: phase(input.phase),
      outcome: outcome(input.outcome),
      durationMs,
      ...correlation(input),
      ...(safeTarget === undefined
        ? {}
        : {
            targetMs: safeTarget,
            targetMet: durationMs <= safeTarget,
          }),
    };
    this.#records.push(metric);
    if (this.#records.length > this.#maxRecords) {
      this.#records.splice(0, this.#records.length - this.#maxRecords);
    }
    this.#onRecord?.(structuredClone(metric));
    return structuredClone(metric);
  }

  public snapshot(): UxTimingMetricV1[] {
    return structuredClone(this.#records);
  }

  public summarize(): UxTimingSummaryV1[] {
    const groups = new Map<string, UxTimingMetricV1[]>();
    for (const metric of this.#records) {
      const key = groupKey(metric);
      const records = groups.get(key) ?? [];
      records.push(metric);
      groups.set(key, records);
    }
    return [...groups.values()]
      .map((records): UxTimingSummaryV1 => {
        const sample = records[0]!;
        const durations = records
          .map(({ durationMs }) => durationMs)
          .sort((left, right) => left - right);
        return {
          version: 1,
          phase: sample.phase,
          outcome: sample.outcome,
          count: records.length,
          p50DurationMs: percentile(durations, 0.5),
          p95DurationMs: percentile(durations, 0.95),
          ...(sample.targetMs === undefined
            ? {}
            : {
                targetMs: sample.targetMs,
                targetMetCount: records.filter(
                  ({ targetMet }) => targetMet,
                ).length,
              }),
        };
      })
      .sort((left, right) => {
        const phaseDifference =
          uxTimingPhasesV1.indexOf(left.phase)
          - uxTimingPhasesV1.indexOf(right.phase);
        if (phaseDifference !== 0) return phaseDifference;
        const outcomeDifference = left.outcome.localeCompare(right.outcome);
        if (outcomeDifference !== 0) return outcomeDifference;
        return (left.targetMs ?? -1) - (right.targetMs ?? -1);
      });
  }

  public reset(): void {
    this.#records.length = 0;
  }
}

/**
 * Records an optional UX observation without allowing malformed telemetry,
 * an unavailable sink, or a test clock to change response or task truth.
 */
export function recordUxTimingIntervalSafelyV1(
  metrics: Pick<
    DeterministicUxTimingMetricsCollectorV1,
    'recordInterval'
  >,
  input: RecordUxTimingIntervalInputV1,
): UxTimingMetricV1 | undefined {
  try {
    return metrics.recordInterval(input);
  } catch {
    logEvent('warn', 'metric.ux_timing_dropped', {
      phase: input.phase,
      reason: 'invalid_lifecycle_boundary',
    });
    return undefined;
  }
}

const uxTimingMetricsGlobal = globalThis as typeof globalThis & {
  errandosUxTimingMetricsV1?: DeterministicUxTimingMetricsCollectorV1;
};

/**
 * Process-wide production collector. `logEvent` writes one sanitized JSON
 * object per line, so the sink can be consumed directly by a JSONL drain.
 * UxTimingMetricV1 itself only permits bounded correlation identifiers,
 * enumerated outcomes, and numeric durations.
 */
export const uxTimingMetricsV1 =
  uxTimingMetricsGlobal.errandosUxTimingMetricsV1
  ?? new DeterministicUxTimingMetricsCollectorV1({
    onRecord: (metric): void => {
      if (process.env.NODE_ENV !== 'test') {
        logEvent('info', 'metric.ux_timing', metric);
      }
    },
  });
uxTimingMetricsGlobal.errandosUxTimingMetricsV1 = uxTimingMetricsV1;
