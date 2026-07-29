import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
  type ControlShadowClarification,
  type ControlShadowLanguageCode,
  type ControlShadowProductEntityV1,
  type ControlShadowTaskIntent,
  type ControlShadowToolIntent,
} from './shadow-corpus';

export type ControlShadowPipeline =
  | 'realtime_control'
  | 'responses_control';

export type ControlShadowPredictionV1 = {
  caseId: string;
  clarification: ControlShadowClarification;
  followUp: boolean;
  groundingCandidateId?: string;
  latencyMs: number;
  negatedOrdinals: number[];
  negatedProducts: string[];
  ordinal?: number;
  products: ControlShadowProductEntityV1[];
  taskIntent: ControlShadowTaskIntent;
  toolIntent: ControlShadowToolIntent;
  version: 1;
};

export type ControlShadowRunInputV1 = {
  model: string;
  pipeline: ControlShadowPipeline;
  predictions: readonly ControlShadowPredictionV1[];
  runId: string;
  version: 1;
};

type AccuracyName =
  | 'clarification'
  | 'entities'
  | 'followUp'
  | 'grounding'
  | 'negation'
  | 'ordinal'
  | 'quantityAndPack'
  | 'taskIntent'
  | 'toolIntent';

export type ControlShadowAccuracyV1 = Record<AccuracyName, number | null>;

export type ControlShadowLatencyV1 = {
  count: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};

export type ControlShadowCaseScoreV1 = {
  accuracy: ControlShadowAccuracyV1;
  caseId: string;
  languageCode: ControlShadowLanguageCode;
  latencyMs: number | null;
  missing: boolean;
  qualityScore: number;
};

export type ControlShadowLanguageScoreV1 = {
  accuracy: ControlShadowAccuracyV1;
  caseCount: number;
  languageCode: ControlShadowLanguageCode;
  latency: ControlShadowLatencyV1;
  qualityScore: number;
};

export type ControlShadowRunScoreV1 = {
  accuracy: ControlShadowAccuracyV1;
  evaluatedCases: number;
  latency: ControlShadowLatencyV1;
  missingCaseIds: string[];
  model: string;
  perCase: ControlShadowCaseScoreV1[];
  perLanguage: ControlShadowLanguageScoreV1[];
  pipeline: ControlShadowPipeline;
  qualityScore: number;
  runId: string;
  totalCases: number;
  version: 1;
};

export type ControlShadowComparisonReportV1 = {
  comparison: {
    latencyMeanDeltaMs: number | null;
    qualityDelta: number;
    realtimeRunId: string;
    responsesRunId: string;
  };
  corpus: {
    caseIds: string[];
    fingerprint: string;
    languageCodes: ControlShadowLanguageCode[];
    version: 1;
  };
  realtime: ControlShadowRunScoreV1;
  responses: ControlShadowRunScoreV1;
  schemaVersion: 1;
};

const accuracyNames: readonly AccuracyName[] = [
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

export function fingerprintControlShadowCorpusV1(
  corpus: readonly ControlShadowCaseV1[],
): string {
  const serialized = JSON.stringify(corpus);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function round(value: number, places: number = 4): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function normalized(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replaceAll(/\s+/g, ' ');
}

function exactStringMultiset(
  expected: readonly string[],
  actual: readonly string[],
): number {
  const expectedCounts = new Map<string, number>();
  const actualCounts = new Map<string, number>();
  for (const value of expected) {
    const key = normalized(value);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  for (const value of actual) {
    const key = normalized(value);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  let intersection = 0;
  for (const [key, count] of expectedCounts) {
    intersection += Math.min(count, actualCounts.get(key) ?? 0);
  }
  const denominator = Math.max(expected.length, actual.length);
  return denominator === 0 ? 1 : intersection / denominator;
}

function entityIdentity(entity: ControlShadowProductEntityV1): string {
  return [
    normalized(entity.product),
    normalized(entity.brand ?? ''),
  ].join('|');
}

function entityQuantityAndPack(entity: ControlShadowProductEntityV1): string {
  return [
    entityIdentity(entity),
    String(entity.quantity),
    entity.packAmount === undefined ? '' : String(entity.packAmount),
    entity.packUnit ?? '',
  ].join('|');
}

function exactNumberSet(
  expected: readonly number[],
  actual: readonly number[],
): number {
  return exactStringMultiset(
    expected.map(String),
    actual.map(String),
  );
}

function scoreCase(
  testCase: ControlShadowCaseV1,
  prediction: ControlShadowPredictionV1 | undefined,
): ControlShadowCaseScoreV1 {
  if (!prediction) {
    return {
      accuracy: {
        clarification: 0,
        entities: 0,
        followUp: 0,
        grounding: testCase.expected.groundingCandidateId ? 0 : null,
        negation: 0,
        ordinal: 0,
        quantityAndPack: 0,
        taskIntent: 0,
        toolIntent: 0,
      },
      caseId: testCase.caseId,
      languageCode: testCase.languageCode,
      latencyMs: null,
      missing: true,
      qualityScore: 0,
    };
  }

  const expected = testCase.expected;
  const negatedProductScore = exactStringMultiset(
    expected.negatedProducts,
    prediction.negatedProducts,
  );
  const negatedOrdinalScore = exactNumberSet(
    expected.negatedOrdinals,
    prediction.negatedOrdinals,
  );
  const accuracy: ControlShadowAccuracyV1 = {
    clarification: Number(prediction.clarification === expected.clarification),
    entities: exactStringMultiset(
      expected.products.map(entityIdentity),
      prediction.products.map(entityIdentity),
    ),
    followUp: Number(prediction.followUp === expected.followUp),
    grounding: expected.groundingCandidateId
      ? Number(
          prediction.groundingCandidateId === expected.groundingCandidateId
          && testCase.observation?.candidates.some(
            (candidate) => candidate.candidateId === prediction.groundingCandidateId,
          ) === true
        )
      : null,
    negation: round((negatedProductScore + negatedOrdinalScore) / 2),
    ordinal: Number(prediction.ordinal === expected.ordinal),
    quantityAndPack: exactStringMultiset(
      expected.products.map(entityQuantityAndPack),
      prediction.products.map(entityQuantityAndPack),
    ),
    taskIntent: Number(prediction.taskIntent === expected.taskIntent),
    toolIntent: Number(prediction.toolIntent === expected.toolIntent),
  };
  const applicable = Object.values(accuracy).filter(
    (value): value is number => value !== null,
  );
  return {
    accuracy,
    caseId: testCase.caseId,
    languageCode: testCase.languageCode,
    latencyMs: prediction.latencyMs,
    missing: false,
    qualityScore: round(
      applicable.reduce((total, value) => total + value, 0) / applicable.length,
    ),
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((total, value) => total + value, 0) / values.length, 2);
}

function nearestRank(
  sortedValues: readonly number[],
  percentile: number,
): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * sortedValues.length) - 1);
  return sortedValues[index] ?? null;
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
    const applicable = cases
      .map((testCase) => testCase.accuracy[name])
      .filter((value): value is number => value !== null);
    return [
      name,
      applicable.length === 0 ? null : round(
        applicable.reduce((total, value) => total + value, 0)
          / applicable.length,
      ),
    ];
  })) as ControlShadowAccuracyV1;
}

function aggregateQuality(accuracy: ControlShadowAccuracyV1): number {
  const applicable = Object.values(accuracy).filter(
    (value): value is number => value !== null,
  );
  return applicable.length === 0
    ? 0
    : round(
        applicable.reduce((total, value) => total + value, 0)
          / applicable.length,
      );
}

function validatePredictions(
  corpus: readonly ControlShadowCaseV1[],
  predictions: readonly ControlShadowPredictionV1[],
): Map<string, ControlShadowPredictionV1> {
  const caseIds = new Set(corpus.map((testCase) => testCase.caseId));
  const byCaseId = new Map<string, ControlShadowPredictionV1>();
  for (const prediction of predictions) {
    if (prediction.version !== 1) {
      throw new Error(`Unsupported prediction version for ${prediction.caseId}.`);
    }
    if (!caseIds.has(prediction.caseId)) {
      throw new Error(`Unknown shadow corpus case: ${prediction.caseId}.`);
    }
    if (byCaseId.has(prediction.caseId)) {
      throw new Error(`Duplicate prediction for ${prediction.caseId}.`);
    }
    if (
      typeof prediction.latencyMs !== 'number'
      || !Number.isFinite(prediction.latencyMs)
      || prediction.latencyMs < 0
    ) {
      throw new Error(`Invalid latency for ${prediction.caseId}.`);
    }
    byCaseId.set(prediction.caseId, prediction);
  }
  return byCaseId;
}

export function scoreControlShadowRunV1(
  input: ControlShadowRunInputV1,
  corpus: readonly ControlShadowCaseV1[] = CONTROL_SHADOW_CORPUS_V1,
): ControlShadowRunScoreV1 {
  if (input.version !== 1) throw new Error('Unsupported shadow run version.');
  if (!input.runId.trim() || !input.model.trim()) {
    throw new Error('Shadow run ID and model are required.');
  }
  const predictions = validatePredictions(corpus, input.predictions);
  const perCase = corpus.map((testCase) => (
    scoreCase(testCase, predictions.get(testCase.caseId))
  ));
  const languageCodes = [...new Set(corpus.map(
    (testCase) => testCase.languageCode,
  ))];
  const perLanguage = languageCodes.map((languageCode) => {
    const languageCases = perCase.filter(
      (testCase) => testCase.languageCode === languageCode,
    );
    const accuracy = aggregateAccuracy(languageCases);
    return {
      accuracy,
      caseCount: languageCases.length,
      languageCode,
      latency: latencySummary(languageCases.flatMap(
        (testCase) => testCase.latencyMs === null ? [] : [testCase.latencyMs],
      )),
      qualityScore: aggregateQuality(accuracy),
    };
  });
  const accuracy = aggregateAccuracy(perCase);
  return {
    accuracy,
    evaluatedCases: input.predictions.length,
    latency: latencySummary(perCase.flatMap(
      (testCase) => testCase.latencyMs === null ? [] : [testCase.latencyMs],
    )),
    missingCaseIds: perCase
      .filter((testCase) => testCase.missing)
      .map((testCase) => testCase.caseId),
    model: input.model,
    perCase,
    perLanguage,
    pipeline: input.pipeline,
    qualityScore: aggregateQuality(accuracy),
    runId: input.runId,
    totalCases: corpus.length,
    version: 1,
  };
}

export function createControlShadowComparisonReportV1(input: {
  realtime: ControlShadowRunInputV1;
  responses: ControlShadowRunInputV1;
  corpus?: readonly ControlShadowCaseV1[];
}): ControlShadowComparisonReportV1 {
  if (input.responses.pipeline !== 'responses_control') {
    throw new Error('Responses run must use the responses_control pipeline.');
  }
  if (input.realtime.pipeline !== 'realtime_control') {
    throw new Error('Realtime run must use the realtime_control pipeline.');
  }
  const corpus = input.corpus ?? CONTROL_SHADOW_CORPUS_V1;
  const responses = scoreControlShadowRunV1(input.responses, corpus);
  const realtime = scoreControlShadowRunV1(input.realtime, corpus);
  const latencyMeanDeltaMs =
    responses.latency.meanMs === null || realtime.latency.meanMs === null
      ? null
      : round(realtime.latency.meanMs - responses.latency.meanMs, 2);
  return {
    comparison: {
      latencyMeanDeltaMs,
      qualityDelta: round(realtime.qualityScore - responses.qualityScore),
      realtimeRunId: realtime.runId,
      responsesRunId: responses.runId,
    },
    corpus: {
      caseIds: corpus.map((testCase) => testCase.caseId),
      fingerprint: fingerprintControlShadowCorpusV1(corpus),
      languageCodes: [...new Set(corpus.map(
        (testCase) => testCase.languageCode,
      ))],
      version: 1,
    },
    realtime,
    responses,
    schemaVersion: 1,
  };
}

/**
 * Stable JSON output for stdout, CI artifacts, or later persistence. The
 * report intentionally has no generated-at timestamp, raw transcript, audio,
 * screenshot, or provider response fields.
 */
export function serializeControlShadowReportV1(
  report: ControlShadowComparisonReportV1,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
