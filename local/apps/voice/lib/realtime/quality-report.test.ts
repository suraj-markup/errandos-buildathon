import { describe, expect, it } from 'vitest';
import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
} from './shadow-corpus';
import {
  createControlShadowComparisonReportV1,
  type ControlShadowPredictionV1,
} from './shadow-scorer';
import {
  type ControlShadowCoordinatorResultV1,
} from './shadow-coordinator';
import {
  createLocalQualityLatencyReportV1,
  serializeLocalQualityLatencyReportJsonV1,
  serializeLocalQualityLatencyReportMarkdownV1,
} from './quality-report';

const corpus = CONTROL_SHADOW_CORPUS_V1.slice(0, 8);

function predictions(
  latencyBase: number,
): ControlShadowPredictionV1[] {
  return corpus.map((testCase, index) => ({
    caseId: testCase.caseId,
    clarification: testCase.expected.clarification,
    followUp: testCase.expected.followUp,
    ...(testCase.expected.groundingCandidateId
      ? { groundingCandidateId: testCase.expected.groundingCandidateId }
      : {}),
    latencyMs: latencyBase + (index * 10),
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

function coordinatorResult(): ControlShadowCoordinatorResultV1 {
  const responses = predictions(800);
  const realtime = predictions(500);
  realtime[1] = {
    ...realtime[1]!,
    clarification: 'none',
    toolIntent: 'inspect_cart',
  };
  realtime.pop();
  return {
    diagnostics: {
      failures: [{
        caseId: corpus.at(-1)!.caseId,
        errorMessage: `provider exposed ${corpus.at(-1)!.sarvamTranscript}`,
        latencyMs: 1_000,
        pipeline: 'realtime_control',
        reason: 'provider_failure',
        suppressedToolCallCount: 1,
      }] as unknown as ControlShadowCoordinatorResultV1['diagnostics']['failures'],
      suppressedToolCallCount: 3,
      toolExecutionCount: 0,
    },
    report: createControlShadowComparisonReportV1({
      corpus,
      realtime: {
        model: 'gpt-realtime-2.1',
        pipeline: 'realtime_control',
        predictions: realtime,
        runId: 'realtime-2026-07-27',
        version: 1,
      },
      responses: {
        model: 'gpt-4.1-mini',
        pipeline: 'responses_control',
        predictions: responses,
        runId: 'responses-2026-07-27',
        version: 1,
      },
    }),
    schemaVersion: 1,
  };
}

describe('local quality and latency report generator', () => {
  it('groups quality and p50/p95 latency by language, screen, and intent', () => {
    const report = createLocalQualityLatencyReportV1({
      corpus,
      fallbacks: [
        {
          caseId: corpus[1]!.caseId,
          pipeline: 'realtime_control',
          reason: 'quality_guard',
          version: 1,
        },
        {
          caseId: corpus.at(-1)!.caseId,
          pipeline: 'realtime_control',
          reason: 'provider_failure',
          version: 1,
        },
      ],
      result: coordinatorResult(),
      stageSamples: [
        {
          latencyMs: 100,
          pipeline: 'responses_control',
          stage: 'control_model',
          success: true,
          version: 1,
        },
        {
          latencyMs: 300,
          pipeline: 'responses_control',
          stage: 'control_model',
          success: false,
          version: 1,
        },
        {
          latencyMs: 80,
          pipeline: 'realtime_control',
          stage: 'control_model',
          success: true,
          version: 1,
        },
      ],
      version: 1,
    });

    expect(report.corpus).toMatchObject({
      caseCount: 8,
      fingerprint: coordinatorResult().report.corpus.fingerprint,
    });
    expect(report.counts).toMatchObject({
      disagreements: 2,
      failures: { total: 1 },
      fallbacks: { total: 2 },
      suppressedToolCalls: 3,
      toolExecutions: 0,
    });
    expect(report.pipelines[0].perLanguage.map((group) => group.key))
      .toEqual(['en-IN', 'gu-IN', 'hi-IN', 'hi-Latn-IN']);
    expect(report.pipelines[0].perScreen.map((group) => group.key))
      .toEqual(['no_observation', 'product_choices']);
    expect(report.pipelines[0].perIntent.map((group) => group.key))
      .toEqual(['add_product', 'inspect_cart', 'resolve_product_choice']);
    expect(report.pipelines[0].overall.latency).toMatchObject({
      p50Ms: 830,
      p95Ms: 870,
    });
    expect(report.stageLatency).toContainEqual({
      failures: 1,
      latency: {
        count: 2,
        meanMs: 200,
        p50Ms: 100,
        p95Ms: 300,
      },
      pipeline: 'responses_control',
      stage: 'control_model',
      successes: 1,
    });
  });

  it('produces byte-stable JSON and Markdown summaries', () => {
    const input = {
      corpus,
      result: coordinatorResult(),
      version: 1 as const,
    };
    const first = createLocalQualityLatencyReportV1(input);
    const second = createLocalQualityLatencyReportV1(input);

    expect(serializeLocalQualityLatencyReportJsonV1(first))
      .toBe(serializeLocalQualityLatencyReportJsonV1(second));
    expect(serializeLocalQualityLatencyReportMarkdownV1(first))
      .toBe(serializeLocalQualityLatencyReportMarkdownV1(second));
    expect(() => JSON.parse(
      serializeLocalQualityLatencyReportJsonV1(first),
    )).not.toThrow();
    expect(serializeLocalQualityLatencyReportMarkdownV1(first))
      .toContain('# Local Control Quality and Latency Report');
    expect(serializeLocalQualityLatencyReportMarkdownV1(first))
      .toContain(first.corpus.fingerprint);
  });

  it('never leaks transcript, image, provider error, or unsafe telemetry fields', () => {
    const rawTranscript = corpus[0]!.sarvamTranscript;
    const rawImage = 'data:image/png;base64,PRIVATE';
    const unsafeCorpus = corpus.map((testCase, index) => (
      index === 0
        ? {
            ...testCase,
            observation: {
              candidates: [],
              imageDataUrl: rawImage,
              observationToken: 'sanitized_token',
              screenKind: 'product_choices',
            },
          } as ControlShadowCaseV1
        : testCase
    ));
    const unsafeResult = coordinatorResult();
    unsafeResult.report = createControlShadowComparisonReportV1({
      corpus: unsafeCorpus,
      realtime: {
        model: 'gpt-realtime-2.1',
        pipeline: 'realtime_control',
        predictions: predictions(500).slice(0, -1),
        runId: 'realtime-2026-07-27',
        version: 1,
      },
      responses: {
        model: 'gpt-4.1-mini',
        pipeline: 'responses_control',
        predictions: predictions(800),
        runId: 'responses-2026-07-27',
        version: 1,
      },
    });
    const report = createLocalQualityLatencyReportV1({
      corpus: unsafeCorpus,
      result: unsafeResult,
      stageSamples: [{
        latencyMs: 10,
        pipeline: 'realtime_control',
        rawTranscript,
        stage: 'control_model',
        success: true,
        version: 1,
      }] as never,
      version: 1,
    });
    const output = [
      serializeLocalQualityLatencyReportJsonV1(report),
      serializeLocalQualityLatencyReportMarkdownV1(report),
    ].join('\n');

    expect(output).not.toContain(rawTranscript);
    expect(output).not.toContain(rawImage);
    expect(output).not.toMatch(/provider exposed|errorMessage|sarvamTranscript|imageDataUrl/i);
  });

  it('rejects mismatched corpora and arbitrary fallback labels', () => {
    expect(() => createLocalQualityLatencyReportV1({
      corpus: [...corpus].reverse(),
      result: coordinatorResult(),
      version: 1,
    })).toThrow(/case order/);

    expect(() => createLocalQualityLatencyReportV1({
      corpus,
      fallbacks: [{
        caseId: corpus[0]!.caseId,
        pipeline: 'realtime_control',
        reason: 'raw provider exception',
        version: 1,
      }] as never,
      result: coordinatorResult(),
      version: 1,
    })).toThrow(/Invalid redacted fallback/);
  });
});
