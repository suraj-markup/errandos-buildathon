import { describe, expect, it } from 'vitest';
import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
} from './shadow-corpus';
import {
  createControlShadowComparisonReportV1,
  scoreControlShadowRunV1,
  serializeControlShadowReportV1,
  type ControlShadowPipeline,
  type ControlShadowPredictionV1,
  type ControlShadowRunInputV1,
} from './shadow-scorer';

function perfectPredictions(
  latency: number,
): ControlShadowPredictionV1[] {
  return CONTROL_SHADOW_CORPUS_V1.map((testCase) => ({
    caseId: testCase.caseId,
    clarification: testCase.expected.clarification,
    followUp: testCase.expected.followUp,
    ...(testCase.expected.groundingCandidateId
      ? { groundingCandidateId: testCase.expected.groundingCandidateId }
      : {}),
    latencyMs: latency,
    negatedOrdinals: [...testCase.expected.negatedOrdinals],
    negatedProducts: [...testCase.expected.negatedProducts],
    ...(testCase.expected.ordinal === undefined
      ? {}
      : { ordinal: testCase.expected.ordinal }),
    products: testCase.expected.products.map((product) => ({ ...product })),
    taskIntent: testCase.expected.taskIntent,
    toolIntent: testCase.expected.toolIntent,
    version: 1,
  }));
}

function run(
  pipeline: ControlShadowPipeline,
  predictions: readonly ControlShadowPredictionV1[],
): ControlShadowRunInputV1 {
  return {
    model: pipeline === 'realtime_control'
      ? 'gpt-realtime-2.1'
      : 'gpt-4.1-mini',
    pipeline,
    predictions,
    runId: pipeline,
    version: 1,
  };
}

describe('multilingual Realtime control shadow corpus', () => {
  it('covers six language groups and required control phenomena', () => {
    expect(new Set(CONTROL_SHADOW_CORPUS_V1.map(
      (testCase) => testCase.languageCode,
    ))).toEqual(new Set([
      'bn-IN',
      'en-IN',
      'gu-IN',
      'hi-IN',
      'hi-Latn-IN',
      'mr-IN',
    ]));
    expect(CONTROL_SHADOW_CORPUS_V1.some(
      (testCase) => testCase.expected.followUp,
    )).toBe(true);
    expect(CONTROL_SHADOW_CORPUS_V1.some(
      (testCase) => testCase.expected.ordinal !== undefined,
    )).toBe(true);
    expect(CONTROL_SHADOW_CORPUS_V1.some(
      (testCase) => testCase.expected.negatedProducts.length > 0
        || testCase.expected.negatedOrdinals.length > 0,
    )).toBe(true);
    expect(CONTROL_SHADOW_CORPUS_V1.some(
      (testCase) => testCase.expected.products.some(
        (product) => product.quantity > 1,
      ),
    )).toBe(true);
  });

  it('contains sanitized observation metadata but no raw media or geometry', () => {
    const serialized = JSON.stringify(CONTROL_SHADOW_CORPUS_V1);
    expect(serialized).not.toMatch(/base64|data:image|screenshot|audio|bounds|coordinate/i);
    expect(CONTROL_SHADOW_CORPUS_V1.filter(
      (testCase) => testCase.observation,
    ).length).toBeGreaterThan(0);
  });
});
describe('deterministic multilingual control shadow scorer', () => {
  it('scores an exact run perfectly by case and language', () => {
    const score = scoreControlShadowRunV1(run(
      'responses_control',
      perfectPredictions(800),
    ));

    expect(score.totalCases).toBe(CONTROL_SHADOW_CORPUS_V1.length);
    expect(score.evaluatedCases).toBe(CONTROL_SHADOW_CORPUS_V1.length);
    expect(score.missingCaseIds).toEqual([]);
    expect(score.qualityScore).toBe(1);
    expect(score.accuracy).toMatchObject({
      clarification: 1,
      entities: 1,
      followUp: 1,
      grounding: 1,
      negation: 1,
      ordinal: 1,
      quantityAndPack: 1,
      taskIntent: 1,
      toolIntent: 1,
    });
    expect(score.perLanguage).toHaveLength(6);
    expect(score.perLanguage.every(
      (language) => language.qualityScore === 1,
    )).toBe(true);
    expect(score.latency).toEqual({
      count: CONTROL_SHADOW_CORPUS_V1.length,
      meanMs: 800,
      p50Ms: 800,
      p95Ms: 800,
    });
  });

  it('surfaces entity, quantity, ordinal, negation, grounding, and latency errors', () => {
    const predictions = perfectPredictions(500);
    const followUpIndex = predictions.findIndex(
      (prediction) => prediction.caseId === 'hinglish_negated_brand_followup',
    );
    predictions[followUpIndex] = {
      ...predictions[followUpIndex]!,
      groundingCandidateId: 'option_1',
      negatedOrdinals: [],
      negatedProducts: [],
      ordinal: 1,
      products: [{
        brand: 'Amul Taaza',
        packAmount: 1,
        packUnit: 'l',
        product: 'milk',
        quantity: 2,
      }],
      toolIntent: 'add_cart_item',
    };
    const score = scoreControlShadowRunV1(run(
      'realtime_control',
      predictions,
    ));
    const failed = score.perCase.find(
      (testCase) => testCase.caseId === 'hinglish_negated_brand_followup',
    );

    expect(failed?.accuracy).toMatchObject({
      entities: 1,
      grounding: 0,
      negation: 0,
      ordinal: 0,
      quantityAndPack: 0,
      toolIntent: 0,
    });
    expect(failed?.qualityScore).toBeLessThan(1);
    expect(score.qualityScore).toBeLessThan(1);
  });

  it('scores missing cases as failures without inventing latency', () => {
    const corpus = CONTROL_SHADOW_CORPUS_V1.slice(0, 2);
    const score = scoreControlShadowRunV1(
      run('responses_control', perfectPredictions(100).slice(0, 1)),
      corpus,
    );

    expect(score.evaluatedCases).toBe(1);
    expect(score.missingCaseIds).toEqual([corpus[1]!.caseId]);
    expect(score.perCase[1]).toMatchObject({
      latencyMs: null,
      missing: true,
      qualityScore: 0,
    });
    expect(score.latency.count).toBe(1);
  });

  it('builds a comparable report with deterministic CLI-friendly JSON', () => {
    const responsesPredictions = perfectPredictions(900);
    const realtimePredictions = perfectPredictions(600);
    const first = createControlShadowComparisonReportV1({
      realtime: run('realtime_control', [...realtimePredictions].reverse()),
      responses: run('responses_control', [...responsesPredictions].reverse()),
    });
    const second = createControlShadowComparisonReportV1({
      realtime: run('realtime_control', realtimePredictions),
      responses: run('responses_control', responsesPredictions),
    });

    expect(first.comparison).toEqual({
      latencyMeanDeltaMs: -300,
      qualityDelta: 0,
      realtimeRunId: 'realtime_control',
      responsesRunId: 'responses_control',
    });
    expect(serializeControlShadowReportV1(first))
      .toBe(serializeControlShadowReportV1(second));
    expect(() => JSON.parse(serializeControlShadowReportV1(first))).not.toThrow();
    expect(serializeControlShadowReportV1(first))
      .not.toMatch(/sarvamTranscript|screenshot|audio|data:image/i);
  });

  it('rejects duplicate, unknown, versioned, and invalid-latency predictions', () => {
    const prediction = perfectPredictions(100)[0]!;
    const corpus: readonly ControlShadowCaseV1[] =
      CONTROL_SHADOW_CORPUS_V1.slice(0, 1);

    expect(() => scoreControlShadowRunV1(run(
      'responses_control',
      [prediction, prediction],
    ), corpus)).toThrow(/Duplicate prediction/);
    expect(() => scoreControlShadowRunV1(run(
      'responses_control',
      [{ ...prediction, caseId: 'unknown_case' }],
    ), corpus)).toThrow(/Unknown shadow corpus case/);
    expect(() => scoreControlShadowRunV1(run(
      'responses_control',
      [{ ...prediction, version: 2 as 1 }],
    ), corpus)).toThrow(/Unsupported prediction version/);
    expect(() => scoreControlShadowRunV1(run(
      'responses_control',
      [{ ...prediction, latencyMs: Number.NaN }],
    ), corpus)).toThrow(/Invalid latency/);
  });
});
