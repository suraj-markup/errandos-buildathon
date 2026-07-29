import { describe, expect, it, vi } from 'vitest';
import {
  DeterministicUxTimingMetricsCollectorV1,
  recordUxTimingIntervalSafelyV1,
} from './ux-timing-metrics';
import { logEvent } from './structured-logger';

describe('UX timing metrics V1', () => {
  it('records a privacy-safe correlated interval and target result', () => {
    const ticks = [100, 337];
    const onRecord = vi.fn();
    const metrics = new DeterministicUxTimingMetricsCollectorV1({
      now: (): number => ticks.shift()!,
      onRecord,
    });
    const interval = metrics.begin('choice_acknowledgement', {
      clientId: 'pixel-overlay',
      eventId: 'event_safe',
      interactionId: 'interaction_safe',
      itemId: 'task_item_safe',
      operationId: 'operation_safe',
      requestId: 'request_safe',
      selectionId: 'selection_safe',
      stepId: 'step:safe',
      taskId: 'task_safe',
    }, 250);

    expect(interval.finish({ outcome: 'completed' })).toEqual({
      version: 1,
      phase: 'choice_acknowledgement',
      outcome: 'completed',
      durationMs: 237,
      targetMs: 250,
      targetMet: true,
      clientId: 'pixel-overlay',
      eventId: 'event_safe',
      interactionId: 'interaction_safe',
      itemId: 'task_item_safe',
      operationId: 'operation_safe',
      requestId: 'request_safe',
      selectionId: 'selection_safe',
      stepId: 'step:safe',
      taskId: 'task_safe',
    });
    expect(onRecord).toHaveBeenCalledOnce();
    expect(JSON.stringify(onRecord.mock.calls)).not.toMatch(
      /transcript|product|screenshot|address|providerPayload|payment/i,
    );
  });

  it('whitelists correlation fields from runtime input', () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    const input = {
      startedAt: 10,
      endedAt: 20,
      outcome: 'completed' as const,
      phase: 'event_delivery' as const,
      taskId: 'task_safe',
      transcript: 'private words',
      address: 'private address',
    };

    const recorded = metrics.recordInterval(input);
    expect(recorded).toEqual({
      version: 1,
      phase: 'event_delivery',
      outcome: 'completed',
      durationMs: 10,
      taskId: 'task_safe',
    });
    expect(recorded).not.toHaveProperty('transcript');
    expect(recorded).not.toHaveProperty('address');
  });

  it('finishes a begun interval exactly once', () => {
    const ticks = [5, 10, 500];
    const metrics = new DeterministicUxTimingMetricsCollectorV1({
      now: (): number => ticks.shift()!,
    });
    const interval = metrics.begin('initial_acknowledgement');
    const first = interval.finish({ outcome: 'completed' });

    expect(interval.finish({ outcome: 'error' })).toEqual(first);
    expect(metrics.snapshot()).toEqual([first]);
  });

  it('drops an invalid best-effort metric without throwing', () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1();

    expect(recordUxTimingIntervalSafelyV1(metrics, {
      endedAt: 10,
      outcome: 'completed',
      phase: 'accepted_to_first_event',
      startedAt: 0,
      targetMs: 500,
      taskId: 'contains private words',
    })).toBeUndefined();
    expect(metrics.snapshot()).toEqual([]);
  });

  it('is bounded and summarizes p50 and p95 by phase, outcome, and target', () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1({
      maxRecords: 5,
    });
    [10, 20, 30, 40].forEach((durationMs) => {
      metrics.recordInterval({
        startedAt: 0,
        endedAt: durationMs,
        outcome: 'completed',
        phase: 'verified_to_next_step',
        targetMs: 25,
      });
    });
    metrics.recordInterval({
      startedAt: 0,
      endedAt: 50,
      outcome: 'timeout',
      phase: 'verified_to_next_step',
      targetMs: 25,
    });
    metrics.recordInterval({
      startedAt: 0,
      endedAt: 60,
      outcome: 'completed',
      phase: 'task_completion',
    });

    expect(metrics.snapshot()).toHaveLength(5);
    expect(metrics.summarize()).toEqual([
      {
        version: 1,
        phase: 'verified_to_next_step',
        outcome: 'completed',
        count: 3,
        p50DurationMs: 30,
        p95DurationMs: 40,
        targetMs: 25,
        targetMetCount: 1,
      },
      {
        version: 1,
        phase: 'verified_to_next_step',
        outcome: 'timeout',
        count: 1,
        p50DurationMs: 50,
        p95DurationMs: 50,
        targetMs: 25,
        targetMetCount: 0,
      },
      {
        version: 1,
        phase: 'task_completion',
        outcome: 'completed',
        count: 1,
        p50DurationMs: 60,
        p95DurationMs: 60,
      },
    ]);
  });

  it('rejects invalid clocks, targets, and identifiers', () => {
    const metrics = new DeterministicUxTimingMetricsCollectorV1();
    expect(() => metrics.recordInterval({
      startedAt: 20,
      endedAt: 10,
      outcome: 'completed',
      phase: 'mutation',
    })).toThrow(/must not precede/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: 10,
      outcome: 'completed',
      phase: 'mutation',
      targetMs: 0,
    })).toThrow(/targetMs/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: 10,
      outcome: 'completed',
      phase: 'mutation',
      taskId: 'contains private words',
    })).toThrow(/taskId/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: 10,
      outcome: 'completed',
      phase: 'mutation',
      taskId: 'dHJhbnNjcmlwdF9waWlfZGF0YQ',
    })).toThrow(/taskId/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: Number.MAX_VALUE,
      outcome: 'completed',
      phase: 'mutation',
    })).toThrow(/endedAt/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: 10,
      outcome: 'completed',
      phase: 'not_a_phase',
    } as never)).toThrow(/phase/);
    expect(() => metrics.recordInterval({
      startedAt: 0,
      endedAt: 10,
      outcome: 'not_an_outcome',
      phase: 'mutation',
    } as never)).toThrow(/outcome/);
  });

  it('rejects record capacities that could make process memory unbounded', () => {
    expect(() => new DeterministicUxTimingMetricsCollectorV1({
      maxRecords: 10_001,
    })).toThrow(/between 1 and 10000/);
    expect(() => new DeterministicUxTimingMetricsCollectorV1({
      maxRecords: Number.MAX_SAFE_INTEGER,
    })).toThrow(/between 1 and 10000/);
  });

  it('writes the production metric schema as one privacy-safe JSONL record', () => {
    const lines: string[] = [];
    const metrics = new DeterministicUxTimingMetricsCollectorV1({
      onRecord: (metric): void => {
        logEvent(
          'info',
          'metric.ux_timing',
          metric,
          (line): void => {
            lines.push(line);
          },
        );
      },
    });

    metrics.recordInterval({
      endedAt: 25,
      operationId: 'operation_safe',
      outcome: 'completed',
      phase: 'verification',
      startedAt: 10,
      taskId: 'task_safe',
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'metric.ux_timing',
      level: 'info',
      version: 1,
      phase: 'verification',
      outcome: 'completed',
      durationMs: 15,
      operationId: 'operation_safe',
      taskId: 'task_safe',
    });
    expect(lines[0]).not.toMatch(
      /transcript|product|screenshot|address|payment|providerPayload/i,
    );
  });
});
