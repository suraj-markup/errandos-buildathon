import { describe, expect, it, vi } from 'vitest';
import { DeterministicStageMetricsCollector } from './stage-metrics';

describe('deterministic stage metrics', () => {
  it('records only IDs, stage timing, outcome, and enumerated fallback', () => {
    const ticks = [100, 137];
    const onRecord = vi.fn();
    const metrics = new DeterministicStageMetricsCollector({
      now: () => ticks.shift()!,
      onRecord,
    });
    const timer = metrics.begin('grounding', {
      clarificationId: 'clarification_safe',
      eventId: 'event_safe',
      interactionId: 'interaction_safe',
      operationId: 'operation_safe',
      realtimeSessionId: 'realtime_safe',
      stepId: 'step_safe',
      taskId: 'task_safe',
    });

    expect(timer.finish({
      fallbackReason: 'model_timeout',
      outcome: 'timeout',
    })).toEqual({
      version: 1,
      durationMs: 37,
      clarificationId: 'clarification_safe',
      eventId: 'event_safe',
      fallbackReason: 'model_timeout',
      interactionId: 'interaction_safe',
      operationId: 'operation_safe',
      outcome: 'timeout',
      realtimeSessionId: 'realtime_safe',
      stage: 'grounding',
      stepId: 'step_safe',
      taskId: 'task_safe',
    });
    expect(JSON.stringify(onRecord.mock.calls)).not.toMatch(
      /transcript|audio|image|screenshot|address|payment|providerPayload/i,
    );
  });

  it('is bounded and produces deterministic percentile summaries', () => {
    const metrics = new DeterministicStageMetricsCollector({
      maxRecords: 3,
    });
    [10, 30, 20, 40].forEach((durationMs, index) => {
      metrics.record({
        durationMs,
        fallbackReason: index === 3 ? 'queue_timeout' : undefined,
        outcome: index === 3 ? 'timeout' : 'completed',
        stage: 'queue_wait',
      });
    });

    expect(metrics.snapshot().map(({ durationMs }) => durationMs))
      .toEqual([30, 20, 40]);
    expect(metrics.summarize()).toEqual([{
      version: 1,
      count: 3,
      fallbackCounts: { queue_timeout: 1 },
      p50DurationMs: 30,
      p95DurationMs: 40,
      stage: 'queue_wait',
    }]);
  });

  it('finishes a timer at most once', () => {
    const ticks = [5, 10, 100];
    const metrics = new DeterministicStageMetricsCollector({
      now: () => ticks.shift()!,
    });
    const timer = metrics.begin('device_session');
    const first = timer.finish({ outcome: 'completed' });
    const duplicate = timer.finish({
      fallbackReason: 'function_error',
      outcome: 'error',
    });
    expect(duplicate).toEqual(first);
    expect(metrics.snapshot()).toHaveLength(1);
  });
});
