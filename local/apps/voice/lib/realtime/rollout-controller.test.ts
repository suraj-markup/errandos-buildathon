import { describe, expect, it, vi } from 'vitest';
import type { VoiceFeatureFlags } from '../feature-flags';
import {
  evaluateRealtimeRolloutGate,
  requestedRealtimeRolloutStage,
  resolveRealtimeRolloutPolicy,
  runGuardedRealtimeControl,
} from './rollout-controller';
import type { LocalQualityLatencyReportV1 } from './quality-report';

function flags(
  overrides: Partial<VoiceFeatureFlags> = {},
): VoiceFeatureFlags {
  return {
    authoritativeTaskStateV1: true,
    phoneTaskV2: false,
    realtimeControlV1: true,
    realtimePhoneToolsV1: true,
    realtimeShadowV1: true,
    screenshotObservationV1: true,
    visionGroundingV1: true,
    ...overrides,
  };
}

describe('guarded Realtime rollout', () => {
  it('defaults to shadow and accepts only declared rollout stages', () => {
    expect(requestedRealtimeRolloutStage({})).toBe('shadow');
    expect(requestedRealtimeRolloutStage({
      JALDI_REALTIME_ROLLOUT_STAGE: 'read_only_tools',
    })).toBe('read_only_tools');
    expect(requestedRealtimeRolloutStage({
      JALDI_REALTIME_ROLLOUT_STAGE: 'unsafe_everything',
    })).toBe('shadow');
  });

  it('fails closed through independent control, vision, and tool switches', () => {
    expect(resolveRealtimeRolloutPolicy({
      broadTaskCohort: true,
      developerClient: true,
      flags: flags({ realtimeControlV1: false }),
      requestedStage: 'broader_task_cohort',
    }).effectiveStage).toBe('shadow');
    expect(resolveRealtimeRolloutPolicy({
      broadTaskCohort: true,
      developerClient: true,
      flags: flags({ visionGroundingV1: false }),
      requestedStage: 'broader_task_cohort',
    }).effectiveStage).toBe('developer_control');
    expect(resolveRealtimeRolloutPolicy({
      broadTaskCohort: true,
      developerClient: true,
      flags: flags({ realtimePhoneToolsV1: false }),
      requestedStage: 'broader_task_cohort',
    }).effectiveStage).toBe('screenshot_grounding');
  });

  it('requires an explicit developer/cohort gate and always keeps Sarvam', () => {
    const developerBlocked = resolveRealtimeRolloutPolicy({
      broadTaskCohort: true,
      developerClient: false,
      flags: flags(),
      requestedStage: 'read_only_tools',
    });
    expect(developerBlocked).toMatchObject({
      effectiveStage: 'shadow',
      phoneToolCapability: 'none',
      speechProvider: 'sarvam',
    });
    const cohortBlocked = resolveRealtimeRolloutPolicy({
      broadTaskCohort: false,
      developerClient: true,
      flags: flags(),
      requestedStage: 'broader_task_cohort',
    });
    expect(cohortBlocked).toMatchObject({
      effectiveStage: 'reversible_cart_tools',
      phoneToolCapability: 'reversible_cart',
      speechProvider: 'sarvam',
    });
  });

  it('uses Responses as authority without waiting for shadow completion', async () => {
    const policy = resolveRealtimeRolloutPolicy({
      broadTaskCohort: false,
      developerClient: true,
      flags: flags(),
      requestedStage: 'shadow',
    });
    const responses = vi.fn(async () => 'responses-decision');
    let rejectRealtime!: (error: Error) => void;
    const realtime = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectRealtime = reject;
    }));
    const onShadowSettled = vi.fn();

    await expect(runGuardedRealtimeControl({
      onShadowSettled,
      policy,
      realtime,
      responses,
      timeoutMs: 100,
    })).resolves.toMatchObject({
      pipeline: 'responses',
      shadow: { status: 'started' },
      value: 'responses-decision',
    });
    expect(onShadowSettled).not.toHaveBeenCalled();
    rejectRealtime(new Error('provider down'));
    await vi.waitFor(() => expect(onShadowSettled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    ));
  });

  it('falls back once on Realtime failure and timeout', async () => {
    const policy = resolveRealtimeRolloutPolicy({
      broadTaskCohort: false,
      developerClient: true,
      flags: flags(),
      requestedStage: 'developer_control',
    });
    const responses = vi.fn(async () => 'fallback');
    await expect(runGuardedRealtimeControl({
      policy,
      realtime: async () => {
        throw new Error('failed');
      },
      responses,
      timeoutMs: 100,
    })).resolves.toMatchObject({
      fallbackReason: 'realtime_failure',
      pipeline: 'responses',
      value: 'fallback',
    });
    await expect(runGuardedRealtimeControl({
      policy,
      realtime: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      responses,
      timeoutMs: 5,
    })).resolves.toMatchObject({
      fallbackReason: 'realtime_timeout',
      pipeline: 'responses',
      value: 'fallback',
    });
    expect(responses).toHaveBeenCalledTimes(2);
  });

  it('blocks promotion when measured quality, latency, or safety misses', () => {
    const group = (qualityScore: number, p95Ms: number) => ({
      accuracy: {
        clarification: qualityScore,
        entities: qualityScore,
        followUp: qualityScore,
        grounding: qualityScore,
        negation: qualityScore,
        ordinal: qualityScore,
        quantityAndPack: qualityScore,
        taskIntent: qualityScore,
        toolIntent: qualityScore,
      },
      caseCount: 20,
      evaluatedCases: 20,
      key: 'all',
      latency: { count: 20, meanMs: p95Ms, p50Ms: p95Ms, p95Ms },
      missingCases: 0,
      qualityScore,
      success: { failed: 0, missing: 0, partial: 0, perfect: 20 },
    });
    const report = {
      counts: {
        disagreements: 1,
        failures: {
          byPipeline: [{ count: 3, pipeline: 'realtime_control' }],
          byReason: [{ count: 3, reason: 'provider_failure' }],
          total: 3,
        },
        fallbacks: { byPipeline: [], byReason: [], total: 0 },
        suppressedToolCalls: 0,
        toolExecutions: 0,
      },
      pipelines: [
        {
          model: 'gpt-4.1-mini',
          overall: group(0.95, 500),
          perIntent: [],
          perLanguage: [],
          perScreen: [],
          pipeline: 'responses_control',
          runId: 'responses-run',
        },
        {
          model: 'gpt-realtime-2.1',
          overall: group(0.8, 1_500),
          perIntent: [],
          perLanguage: [],
          perScreen: [],
          pipeline: 'realtime_control',
          runId: 'realtime-run',
        },
      ],
      corpus: { caseCount: 20, fingerprint: 'abc', languageCount: 6 },
      stageLatency: [],
      version: 1,
    } satisfies LocalQualityLatencyReportV1;

    expect(evaluateRealtimeRolloutGate(report, {
      maxFailureRate: 0.1,
      maxP95LatencyMs: 1_000,
      maxQualityRegression: 0.05,
      minCases: 20,
      minRealtimeQuality: 0.9,
      version: 1,
    })).toEqual({
      passed: false,
      reasons: [
        'realtime_quality_below_threshold',
        'quality_regression',
        'latency_above_threshold',
        'failure_rate_above_threshold',
      ],
      version: 1,
    });
  });
});
