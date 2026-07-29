import {
  type ControlShadowCaseV1,
  type ControlShadowLanguageCode,
  type ControlShadowTaskIntent,
} from './shadow-corpus';
import {
  fingerprintControlShadowCorpusV1,
  type ControlShadowAccuracyV1,
  type ControlShadowCaseScoreV1,
  type ControlShadowLatencyV1,
  type ControlShadowPipeline,
  type ControlShadowRunScoreV1,
} from './shadow-scorer';
import {
  type ControlShadowCoordinatorResultV1,
  type ControlShadowFailureCategory,
} from './shadow-coordinator';

export type RedactedFallbackReasonV1 =
  | 'feature_disabled'
  | 'provider_failure'
  | 'quality_guard'
  | 'timeout'
  | 'transport_unavailable';

export type RedactedFallbackSampleV1 = {
  caseId: string;
  pipeline: ControlShadowPipeline;
  reason: RedactedFallbackReasonV1;
  version: 1;
};

export type RedactedDeviceStageV1 =
  | 'control_model'
  | 'device_action'
  | 'queue_wait'
  | 'speech_synthesis'
  | 'transcription'
  | 'verification';

export type RedactedStageLatencySampleV1 = {
  latencyMs: number;
  pipeline: ControlShadowPipeline;
  stage: RedactedDeviceStageV1;
  success: boolean;
  version: 1;
};

export type LocalQualityGroupV1 = {
  accuracy: ControlShadowAccuracyV1;
  caseCount: number;
  evaluatedCases: number;
  key: string;
  latency: ControlShadowLatencyV1;
  missingCases: number;
  qualityScore: number;
  success: {
    failed: number;
    missing: number;
    partial: number;
    perfect: number;
  };
};

export type LocalQualityPipelineReportV1 = {
  model: string;
  overall: LocalQualityGroupV1;
  perIntent: LocalQualityGroupV1[];
  perLanguage: LocalQualityGroupV1[];
  perScreen: LocalQualityGroupV1[];
  pipeline: ControlShadowPipeline;
  runId: string;
};

export type LocalQualityLatencyReportV1 = {
  corpus: {
    caseCount: number;
    fingerprint: string;
    languageCount: number;
  };
  counts: {
    disagreements: number;
    failures: {
      byPipeline: Array<{
        count: number;
        pipeline: ControlShadowPipeline;
      }>;
      byReason: Array<{
        count: number;
        reason: ControlShadowFailureCategory;
      }>;
      total: number;
    };
    fallbacks: {
      byPipeline: Array<{
        count: number;
        pipeline: ControlShadowPipeline;
      }>;
      byReason: Array<{
        count: number;
        reason: RedactedFallbackReasonV1;
      }>;
      total: number;
    };
    suppressedToolCalls: number;
    toolExecutions: 0;
  };
  pipelines: [
    LocalQualityPipelineReportV1,
    LocalQualityPipelineReportV1,
  ];
  stageLatency: Array<{
    failures: number;
    latency: ControlShadowLatencyV1;
    pipeline: ControlShadowPipeline;
    stage: RedactedDeviceStageV1;
    successes: number;
  }>;
  version: 1;
};

const accuracyNames: ReadonlyArray<keyof ControlShadowAccuracyV1> = [
  'taskIntent',
  'toolIntent',
  'entities',
  'quantityAndPack',
  'ordinal',
  'negation',
  'followUp',
  'clarification',
  'grounding',
];

const pipelines: readonly ControlShadowPipeline[] = [
  'responses_control',
  'realtime_control',
];

const fallbackReasons = new Set<RedactedFallbackReasonV1>([
  'feature_disabled',
  'provider_failure',
  'quality_guard',
  'timeout',
  'transport_unavailable',
]);

const deviceStages = new Set<RedactedDeviceStageV1>([
  'control_model',
  'device_action',
  'queue_wait',
  'speech_synthesis',
  'transcription',
  'verification',
]);

function round(value: number, places: number = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function safeMetricLabel(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value)) {
    throw new Error(`${field} must be a sanitized metric label.`);
  }
  return value;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(
    values.reduce((total, value) => total + value, 0) / values.length,
    2,
  );
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[
    Math.max(0, Math.ceil(percentile * sortedValues.length) - 1)
  ] ?? null;
}

function latencySummary(values: readonly number[]): ControlShadowLatencyV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    meanMs: mean(sorted),
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
  };
}

function aggregateAccuracy(
  cases: readonly ControlShadowCaseScoreV1[],
): ControlShadowAccuracyV1 {
  return Object.fromEntries(accuracyNames.map((name) => {
    const values = cases
      .map((testCase) => testCase.accuracy[name])
      .filter((value): value is number => value !== null);
    return [
      name,
      values.length === 0
        ? null
        : round(values.reduce((total, value) => total + value, 0) / values.length),
    ];
  })) as ControlShadowAccuracyV1;
}

function aggregateQuality(accuracy: ControlShadowAccuracyV1): number {
  const values = Object.values(accuracy).filter(
    (value): value is number => value !== null,
  );
  return values.length === 0
    ? 0
    : round(values.reduce((total, value) => total + value, 0) / values.length);
}

function groupMetric(
  key: string,
  cases: readonly ControlShadowCaseScoreV1[],
): LocalQualityGroupV1 {
  const accuracy = aggregateAccuracy(cases);
  return {
    accuracy,
    caseCount: cases.length,
    evaluatedCases: cases.filter((testCase) => !testCase.missing).length,
    key,
    latency: latencySummary(cases.flatMap(
      (testCase) => testCase.latencyMs === null ? [] : [testCase.latencyMs],
    )),
    missingCases: cases.filter((testCase) => testCase.missing).length,
    qualityScore: aggregateQuality(accuracy),
    success: {
      failed: cases.filter(
        (testCase) => !testCase.missing && testCase.qualityScore === 0,
      ).length,
      missing: cases.filter((testCase) => testCase.missing).length,
      partial: cases.filter(
        (testCase) => testCase.qualityScore > 0
          && testCase.qualityScore < 1,
      ).length,
      perfect: cases.filter(
        (testCase) => testCase.qualityScore === 1,
      ).length,
    },
  };
}

function groupedMetrics(
  run: ControlShadowRunScoreV1,
  corpus: readonly ControlShadowCaseV1[],
  keyForCase: (testCase: ControlShadowCaseV1) => string,
): LocalQualityGroupV1[] {
  const caseScoreById = new Map(
    run.perCase.map((testCase) => [testCase.caseId, testCase]),
  );
  const grouped = new Map<string, ControlShadowCaseScoreV1[]>();
  for (const testCase of corpus) {
    const score = caseScoreById.get(testCase.caseId);
    if (!score) throw new Error(`Missing scored case ${testCase.caseId}.`);
    const key = keyForCase(testCase);
    const values = grouped.get(key) ?? [];
    values.push(score);
    grouped.set(key, values);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([key, cases]) => groupMetric(key, cases));
}

function pipelineReport(
  run: ControlShadowRunScoreV1,
  corpus: readonly ControlShadowCaseV1[],
): LocalQualityPipelineReportV1 {
  safeMetricLabel(run.model, `${run.pipeline}.model`);
  safeMetricLabel(run.runId, `${run.pipeline}.runId`);
  return {
    model: run.model,
    overall: groupMetric('all', run.perCase),
    perIntent: groupedMetrics(
      run,
      corpus,
      (testCase) => testCase.expected.taskIntent,
    ),
    perLanguage: groupedMetrics(
      run,
      corpus,
      (testCase) => testCase.languageCode,
    ),
    perScreen: groupedMetrics(
      run,
      corpus,
      (testCase) => testCase.observation?.screenKind ?? 'no_observation',
    ),
    pipeline: run.pipeline,
    runId: run.runId,
  };
}

function countedBy<T extends string>(
  values: readonly T[],
): Array<{ count: number; value: T }> {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
    .map(([value, count]) => ({ count, value }));
}

function validateCorpus(
  result: ControlShadowCoordinatorResultV1,
  corpus: readonly ControlShadowCaseV1[],
): void {
  const expectedIds = result.report.corpus.caseIds;
  if (
    expectedIds.length !== corpus.length
    || expectedIds.some((caseId, index) => caseId !== corpus[index]?.caseId)
  ) {
    throw new Error('Quality report corpus case order does not match scoring.');
  }
  for (const testCase of corpus) safeMetricLabel(testCase.caseId, 'caseId');
  if (
    result.report.corpus.fingerprint
    !== fingerprintControlShadowCorpusV1(corpus)
  ) {
    throw new Error('Quality report corpus fingerprint does not match scoring.');
  }
}

function validateRedactedInputs(input: {
  result: ControlShadowCoordinatorResultV1;
  fallbacks: readonly RedactedFallbackSampleV1[];
  stageSamples: readonly RedactedStageLatencySampleV1[];
}): void {
  const caseIds = new Set(input.result.report.corpus.caseIds);
  for (const fallback of input.fallbacks) {
    if (
      fallback.version !== 1
      || !caseIds.has(fallback.caseId)
      || !pipelines.includes(fallback.pipeline)
      || !fallbackReasons.has(fallback.reason)
    ) {
      throw new Error('Invalid redacted fallback sample.');
    }
  }
  for (const sample of input.stageSamples) {
    if (
      sample.version !== 1
      || !pipelines.includes(sample.pipeline)
      || !deviceStages.has(sample.stage)
      || typeof sample.success !== 'boolean'
      || !Number.isFinite(sample.latencyMs)
      || sample.latencyMs < 0
    ) {
      throw new Error('Invalid redacted stage latency sample.');
    }
  }
}

function scoreDisagreements(
  responses: ControlShadowRunScoreV1,
  realtime: ControlShadowRunScoreV1,
): number {
  const realtimeById = new Map(
    realtime.perCase.map((testCase) => [testCase.caseId, testCase]),
  );
  return responses.perCase.filter((responseCase) => {
    const realtimeCase = realtimeById.get(responseCase.caseId);
    if (!realtimeCase) return true;
    return responseCase.missing !== realtimeCase.missing
      || accuracyNames.some(
        (name) => responseCase.accuracy[name] !== realtimeCase.accuracy[name],
      );
  }).length;
}

export function createLocalQualityLatencyReportV1(input: {
  corpus: readonly ControlShadowCaseV1[];
  fallbacks?: readonly RedactedFallbackSampleV1[];
  result: ControlShadowCoordinatorResultV1;
  stageSamples?: readonly RedactedStageLatencySampleV1[];
  version: 1;
}): LocalQualityLatencyReportV1 {
  if (input.version !== 1 || input.result.schemaVersion !== 1) {
    throw new Error('Unsupported local quality report version.');
  }
  const fallbacks = input.fallbacks ?? [];
  const stageSamples = input.stageSamples ?? [];
  validateCorpus(input.result, input.corpus);
  validateRedactedInputs({
    fallbacks,
    result: input.result,
    stageSamples,
  });

  const failurePipelines = countedBy(
    input.result.diagnostics.failures.map((failure) => failure.pipeline),
  );
  const failureReasons = countedBy(
    input.result.diagnostics.failures.map((failure) => failure.reason),
  );
  const fallbackPipelines = countedBy(
    fallbacks.map((fallback) => fallback.pipeline),
  );
  const fallbackReasonCounts = countedBy(
    fallbacks.map((fallback) => fallback.reason),
  );
  const stageKeys = [...new Set(stageSamples.map(
    (sample) => `${sample.pipeline}:${sample.stage}`,
  ))].sort((left, right) => left.localeCompare(right, 'en-US'));
  const stageLatency = stageKeys.map((key) => {
    const [pipeline, stage] = key.split(':') as [
      ControlShadowPipeline,
      RedactedDeviceStageV1,
    ];
    const samples = stageSamples.filter(
      (sample) => sample.pipeline === pipeline && sample.stage === stage,
    );
    return {
      failures: samples.filter((sample) => !sample.success).length,
      latency: latencySummary(samples.map((sample) => sample.latencyMs)),
      pipeline,
      stage,
      successes: samples.filter((sample) => sample.success).length,
    };
  });
  const languageCodes = new Set<ControlShadowLanguageCode>(
    input.corpus.map((testCase) => testCase.languageCode),
  );

  return {
    corpus: {
      caseCount: input.corpus.length,
      fingerprint: input.result.report.corpus.fingerprint,
      languageCount: languageCodes.size,
    },
    counts: {
      disagreements: scoreDisagreements(
        input.result.report.responses,
        input.result.report.realtime,
      ),
      failures: {
        byPipeline: failurePipelines.map(({ count, value }) => ({
          count,
          pipeline: value,
        })),
        byReason: failureReasons.map(({ count, value }) => ({
          count,
          reason: value,
        })),
        total: input.result.diagnostics.failures.length,
      },
      fallbacks: {
        byPipeline: fallbackPipelines.map(({ count, value }) => ({
          count,
          pipeline: value,
        })),
        byReason: fallbackReasonCounts.map(({ count, value }) => ({
          count,
          reason: value,
        })),
        total: fallbacks.length,
      },
      suppressedToolCalls:
        input.result.diagnostics.suppressedToolCallCount,
      toolExecutions: 0,
    },
    pipelines: [
      pipelineReport(input.result.report.responses, input.corpus),
      pipelineReport(input.result.report.realtime, input.corpus),
    ],
    stageLatency,
    version: 1,
  };
}

export function serializeLocalQualityLatencyReportJsonV1(
  report: LocalQualityLatencyReportV1,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function percentage(value: number | null): string {
  return value === null ? '—' : `${round(value * 100, 2).toFixed(2)}%`;
}

function milliseconds(value: number | null): string {
  return value === null ? '—' : `${round(value, 2).toFixed(2)} ms`;
}

function groupRows(
  groups: readonly LocalQualityGroupV1[],
): string[] {
  return groups.map((group) => [
    `| ${group.key}`,
    group.caseCount,
    percentage(group.qualityScore),
    percentage(group.accuracy.toolIntent),
    percentage(group.accuracy.grounding),
    milliseconds(group.latency.p50Ms),
    milliseconds(group.latency.p95Ms),
    `${group.missingCases} |`,
  ].join(' | '));
}

export function serializeLocalQualityLatencyReportMarkdownV1(
  report: LocalQualityLatencyReportV1,
): string {
  const lines = [
    '# Local Control Quality and Latency Report',
    '',
    `Corpus: \`${report.corpus.fingerprint}\` · ${report.corpus.caseCount} cases · ${report.corpus.languageCount} languages`,
    '',
    '## Summary',
    '',
    '| Pipeline | Model | Quality | Tool intent | Grounding | p50 | p95 | Missing |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.pipelines.map((pipeline) => [
      `| ${pipeline.pipeline}`,
      pipeline.model,
      percentage(pipeline.overall.qualityScore),
      percentage(pipeline.overall.accuracy.toolIntent),
      percentage(pipeline.overall.accuracy.grounding),
      milliseconds(pipeline.overall.latency.p50Ms),
      milliseconds(pipeline.overall.latency.p95Ms),
      `${pipeline.overall.missingCases} |`,
    ].join(' | ')),
    '',
    `Disagreements: ${report.counts.disagreements} · Failures: ${report.counts.failures.total} · Fallbacks: ${report.counts.fallbacks.total} · Suppressed tool calls: ${report.counts.suppressedToolCalls} · Tool executions: ${report.counts.toolExecutions}`,
  ];

  for (const pipeline of report.pipelines) {
    for (const [title, groups] of [
      ['Language', pipeline.perLanguage],
      ['Screen', pipeline.perScreen],
      ['Intent', pipeline.perIntent],
    ] as const) {
      lines.push(
        '',
        `## ${pipeline.pipeline}: per ${title.toLocaleLowerCase('en-US')}`,
        '',
        `| ${title} | Cases | Quality | Tool intent | Grounding | p50 | p95 | Missing |`,
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...groupRows(groups),
      );
    }
  }

  lines.push(
    '',
    '## Device-stage latency',
    '',
    '| Pipeline | Stage | Samples | p50 | p95 | Successes | Failures |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.stageLatency.map((stage) => [
      `| ${stage.pipeline}`,
      stage.stage,
      stage.latency.count,
      milliseconds(stage.latency.p50Ms),
      milliseconds(stage.latency.p95Ms),
      stage.successes,
      `${stage.failures} |`,
    ].join(' | ')),
    '',
  );
  return `${lines.join('\n')}\n`;
}
