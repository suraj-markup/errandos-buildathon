import type { VoiceFeatureFlags } from '../feature-flags';
import type { LocalQualityLatencyReportV1 } from './quality-report';
import type { RealtimePhoneToolCapability } from './safe-phone-tools';

export const realtimeRolloutStages = [
  'responses_only',
  'shadow',
  'developer_control',
  'screenshot_grounding',
  'read_only_tools',
  'reversible_cart_tools',
  'broader_task_cohort',
] as const;

export type RealtimeRolloutStage = (typeof realtimeRolloutStages)[number];

export type RealtimeRolloutPolicyV1 = {
  controlPipeline: 'realtime' | 'responses';
  effectiveStage: RealtimeRolloutStage;
  fallbackPipeline: 'responses';
  phoneToolCapability: RealtimePhoneToolCapability;
  requestedStage: RealtimeRolloutStage;
  screenshotGrounding: boolean;
  shadowRealtime: boolean;
  speechProvider: 'sarvam';
  version: 1;
};

export type RealtimeRolloutPolicyInput = {
  broadTaskCohort: boolean;
  developerClient: boolean;
  flags: Pick<
    VoiceFeatureFlags,
    | 'realtimeControlV1'
    | 'realtimePhoneToolsV1'
    | 'realtimeShadowV1'
    | 'screenshotObservationV1'
    | 'visionGroundingV1'
  >;
  requestedStage: RealtimeRolloutStage;
};

export function requestedRealtimeRolloutStage(
  environment: Record<string, string | undefined> = process.env,
): RealtimeRolloutStage {
  const requested = environment['JALDI_REALTIME_ROLLOUT_STAGE']?.trim();
  return realtimeRolloutStages.includes(requested as RealtimeRolloutStage)
    ? requested as RealtimeRolloutStage
    : 'shadow';
}

const stageIndex = new Map(
  realtimeRolloutStages.map((stage, index) => [stage, index]),
);

function atLeast(
  stage: RealtimeRolloutStage,
  minimum: RealtimeRolloutStage,
): boolean {
  return stageIndex.get(stage)! >= stageIndex.get(minimum)!;
}

function lowerStage(
  stage: RealtimeRolloutStage,
  ceiling: RealtimeRolloutStage,
): RealtimeRolloutStage {
  return atLeast(stage, ceiling) && stage !== ceiling ? ceiling : stage;
}

/**
 * Resolves independent feature flags into one fail-closed rollout stage.
 * Sarvam remains the speech provider at every stage.
 */
export function resolveRealtimeRolloutPolicy(
  input: RealtimeRolloutPolicyInput,
): RealtimeRolloutPolicyV1 {
  let effectiveStage = input.requestedStage;
  if (!input.flags.realtimeShadowV1) {
    effectiveStage = 'responses_only';
  }
  if (
    atLeast(effectiveStage, 'developer_control')
    && (!input.flags.realtimeControlV1 || !input.developerClient)
  ) {
    effectiveStage = input.flags.realtimeShadowV1
      ? 'shadow'
      : 'responses_only';
  }
  if (
    atLeast(effectiveStage, 'screenshot_grounding')
    && (
      !input.flags.screenshotObservationV1
      || !input.flags.visionGroundingV1
    )
  ) {
    effectiveStage = lowerStage(effectiveStage, 'developer_control');
  }
  if (
    atLeast(effectiveStage, 'read_only_tools')
    && !input.flags.realtimePhoneToolsV1
  ) {
    effectiveStage = lowerStage(effectiveStage, 'screenshot_grounding');
  }
  if (
    effectiveStage === 'broader_task_cohort'
    && !input.broadTaskCohort
  ) {
    effectiveStage = 'reversible_cart_tools';
  }

  const phoneToolCapability: RealtimePhoneToolCapability =
    effectiveStage === 'read_only_tools'
      ? 'read_only'
      : effectiveStage === 'reversible_cart_tools'
        ? 'reversible_cart'
        : effectiveStage === 'broader_task_cohort'
          ? 'broader'
          : 'none';

  return {
    controlPipeline: atLeast(effectiveStage, 'developer_control')
      ? 'realtime'
      : 'responses',
    effectiveStage,
    fallbackPipeline: 'responses',
    phoneToolCapability,
    requestedStage: input.requestedStage,
    screenshotGrounding: atLeast(effectiveStage, 'screenshot_grounding'),
    shadowRealtime: effectiveStage === 'shadow',
    speechProvider: 'sarvam',
    version: 1,
  };
}

export type GuardedControlFallbackReason =
  | 'realtime_failure'
  | 'realtime_timeout';

export type GuardedControlResultV1<T> = {
  fallbackReason?: GuardedControlFallbackReason;
  pipeline: 'realtime' | 'responses';
  shadow?: {
    latencyMs: number;
    status: 'completed' | 'failed' | 'started' | 'timeout';
  };
  value: T;
  version: 1;
};

function timed<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<
  | { latencyMs: number; status: 'completed'; value: T }
  | { latencyMs: number; status: 'failed' | 'timeout' }
> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const attempt = Promise.resolve()
    .then(() => run(controller.signal))
    .then(
      (value) => ({ status: 'completed' as const, value }),
      () => ({ status: 'failed' as const }),
    );
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ status: 'timeout' }),
      timeoutMs,
    );
  });
  return Promise.race([attempt, timeout]).then((outcome) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const latencyMs = Math.max(0, performance.now() - startedAt);
    if (outcome.status === 'timeout') controller.abort();
    return { ...outcome, latencyMs };
  });
}

/**
 * Runs one control authority and at most one bounded Responses fallback.
 * Tool execution is intentionally outside this runner so a fallback cannot
 * duplicate a mutation that has crossed the local operation boundary.
 */
export async function runGuardedRealtimeControl<T>(input: {
  onShadowSettled?: (result: {
    latencyMs: number;
    status: 'completed' | 'failed' | 'timeout';
  }) => void;
  policy: RealtimeRolloutPolicyV1;
  realtime: (signal: AbortSignal) => Promise<T>;
  responses: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
}): Promise<GuardedControlResultV1<T>> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error('Realtime control timeout must be positive.');
  }

  if (input.policy.shadowRealtime) {
    let settledShadow:
      | { latencyMs: number; status: 'completed' | 'failed' | 'timeout' }
      | undefined;
    const shadow = timed(input.realtime, input.timeoutMs).then((outcome) => {
      settledShadow = {
        latencyMs: outcome.latencyMs,
        status: outcome.status,
      };
      input.onShadowSettled?.(settledShadow);
    });
    const authority = await input.responses(new AbortController().signal);
    // Shadow mode must never extend user-visible control latency. The
    // tool-suppressed evaluation is allowed to finish in the server process
    // and reports its own terminal telemetry through onShadowSettled.
    void shadow;
    return {
      pipeline: 'responses',
      shadow: settledShadow ?? { latencyMs: 0, status: 'started' },
      value: authority,
      version: 1,
    };
  }

  if (input.policy.controlPipeline === 'responses') {
    return {
      pipeline: 'responses',
      value: await input.responses(new AbortController().signal),
      version: 1,
    };
  }

  const realtime = await timed(input.realtime, input.timeoutMs);
  if (realtime.status === 'completed') {
    return {
      pipeline: 'realtime',
      value: realtime.value,
      version: 1,
    };
  }
  return {
    fallbackReason: realtime.status === 'timeout'
      ? 'realtime_timeout'
      : 'realtime_failure',
    pipeline: 'responses',
    value: await input.responses(new AbortController().signal),
    version: 1,
  };
}

export type RealtimeRolloutGateThresholdsV1 = {
  maxFailureRate: number;
  maxP95LatencyMs: number;
  maxQualityRegression: number;
  minCases: number;
  minRealtimeQuality: number;
  version: 1;
};

export type RealtimeRolloutGateResultV1 = {
  passed: boolean;
  reasons: string[];
  version: 1;
};

export function evaluateRealtimeRolloutGate(
  report: LocalQualityLatencyReportV1,
  thresholds: RealtimeRolloutGateThresholdsV1,
): RealtimeRolloutGateResultV1 {
  if (
    thresholds.version !== 1
    || thresholds.minCases < 1
    || thresholds.maxP95LatencyMs <= 0
    || [
      thresholds.maxFailureRate,
      thresholds.maxQualityRegression,
      thresholds.minRealtimeQuality,
    ].some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error('Invalid Realtime rollout gate thresholds.');
  }
  const responses = report.pipelines.find(
    ({ pipeline }) => pipeline === 'responses_control',
  )!;
  const realtime = report.pipelines.find(
    ({ pipeline }) => pipeline === 'realtime_control',
  )!;
  const reasons: string[] = [];
  if (realtime.overall.evaluatedCases < thresholds.minCases) {
    reasons.push('insufficient_cases');
  }
  if (realtime.overall.qualityScore < thresholds.minRealtimeQuality) {
    reasons.push('realtime_quality_below_threshold');
  }
  if (
    responses.overall.qualityScore - realtime.overall.qualityScore
    > thresholds.maxQualityRegression
  ) {
    reasons.push('quality_regression');
  }
  if (
    (realtime.overall.latency.p95Ms ?? Number.POSITIVE_INFINITY)
    > thresholds.maxP95LatencyMs
  ) {
    reasons.push('latency_above_threshold');
  }
  const realtimeFailures = report.counts.failures.byPipeline
    .find(({ pipeline }) => pipeline === 'realtime_control')?.count ?? 0;
  const denominator = realtime.overall.caseCount || 1;
  if (realtimeFailures / denominator > thresholds.maxFailureRate) {
    reasons.push('failure_rate_above_threshold');
  }
  if (report.counts.toolExecutions !== 0) {
    reasons.push('shadow_tool_execution_detected');
  }
  return {
    passed: reasons.length === 0,
    reasons,
    version: 1,
  };
}
