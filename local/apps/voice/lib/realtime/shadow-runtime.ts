import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
} from './shadow-corpus';
import {
  runControlShadowComparisonV1,
  type ControlShadowEvaluator,
  type SanitizedShadowTaskContextV1,
} from './shadow-coordinator';
import {
  createLocalQualityLatencyReportV1,
  serializeLocalQualityLatencyReportJsonV1,
  serializeLocalQualityLatencyReportMarkdownV1,
  type LocalQualityLatencyReportV1,
  type RedactedFallbackSampleV1,
  type RedactedStageLatencySampleV1,
} from './quality-report';

export type RealtimeShadowEvaluationArtifactsV1 = {
  json: string;
  markdown: string;
  report: LocalQualityLatencyReportV1;
  toolExecutionCount: 0;
  version: 1;
};

function defaultTaskForCase(
  testCase: ControlShadowCaseV1,
): SanitizedShadowTaskContextV1 {
  const awaitingClarification = testCase.expected.followUp;
  return {
    ...(awaitingClarification ? { activeItemPosition: 1 } : {}),
    awaitingClarification,
    hasPendingCheckout: testCase.expected.taskIntent === 'prepare_checkout',
    itemCount: awaitingClarification ? 1 : 0,
    phase: awaitingClarification ? 'awaiting_product_choice' : 'active',
    version: 1,
  };
}

/**
 * Runs identical sanitized Sarvam/task/observation inputs through both
 * control pipelines. Evaluators receive only a suppression callback and no
 * phone executor. Returned artifacts contain aggregate labels and metrics,
 * never raw transcript, image, coordinates, audio, or task prose.
 */
export async function runRealtimeShadowEvaluationV1(input: {
  corpus?: readonly ControlShadowCaseV1[];
  fallbackSamples?: readonly RedactedFallbackSampleV1[];
  realtime: {
    evaluator: ControlShadowEvaluator;
    model: string;
    runId: string;
  };
  responses: {
    evaluator: ControlShadowEvaluator;
    model: string;
    runId: string;
  };
  stageSamples?: readonly RedactedStageLatencySampleV1[];
  taskForCase?: (
    testCase: ControlShadowCaseV1,
  ) => SanitizedShadowTaskContextV1;
  timeoutMs?: number;
  version: 1;
}): Promise<RealtimeShadowEvaluationArtifactsV1> {
  if (input.version !== 1) {
    throw new Error('Unsupported Realtime shadow evaluation version.');
  }
  const corpus = input.corpus ?? CONTROL_SHADOW_CORPUS_V1;
  const taskForCase = input.taskForCase ?? defaultTaskForCase;
  const comparison = await runControlShadowComparisonV1({
    realtime: input.realtime,
    responses: input.responses,
    turns: corpus.map((testCase) => ({
      case: testCase,
      task: taskForCase(testCase),
      version: 1,
    })),
    version: 1,
  }, {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const report = createLocalQualityLatencyReportV1({
    corpus,
    ...(input.fallbackSamples
      ? { fallbacks: input.fallbackSamples }
      : {}),
    result: comparison,
    ...(input.stageSamples ? { stageSamples: input.stageSamples } : {}),
    version: 1,
  });
  return {
    json: serializeLocalQualityLatencyReportJsonV1(report),
    markdown: serializeLocalQualityLatencyReportMarkdownV1(report),
    report,
    toolExecutionCount: 0,
    version: 1,
  };
}
