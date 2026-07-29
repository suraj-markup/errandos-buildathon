import { describe, expect, it } from 'vitest';
import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
} from './shadow-corpus';
import type {
  ControlShadowDecisionV1,
  ControlShadowEvaluator,
} from './shadow-coordinator';
import { runRealtimeShadowEvaluationV1 } from './shadow-runtime';

function decision(testCase: ControlShadowCaseV1): ControlShadowDecisionV1 {
  return {
    ...testCase.expected,
    negatedOrdinals: [...testCase.expected.negatedOrdinals],
    negatedProducts: [...testCase.expected.negatedProducts],
    products: testCase.expected.products.map((product) => ({ ...product })),
    version: 1,
  };
}

function evaluator(
  corpus: readonly ControlShadowCaseV1[],
): ControlShadowEvaluator {
  const byId = new Map(corpus.map((testCase) => [
    testCase.caseId,
    testCase,
  ]));
  return {
    async evaluate(input, context) {
      expect(context.toolMode).toBe('shadow_suppressed');
      return decision(byId.get(input.caseId)!);
    },
  };
}

describe('Realtime shadow evaluation runtime', () => {
  it('produces per-language/screen evidence without raw content or tools', async () => {
    const corpus = CONTROL_SHADOW_CORPUS_V1.slice(0, 8);
    const artifacts = await runRealtimeShadowEvaluationV1({
      corpus,
      realtime: {
        evaluator: evaluator(corpus),
        model: 'gpt-realtime-2.1',
        runId: 'realtime-shadow-test',
      },
      responses: {
        evaluator: evaluator(corpus),
        model: 'gpt-4.1-mini',
        runId: 'responses-shadow-test',
      },
      version: 1,
    });

    expect(artifacts.report.corpus.languageCount).toBeGreaterThanOrEqual(4);
    expect(artifacts.report.pipelines[1]!.perLanguage.length)
      .toBeGreaterThanOrEqual(4);
    expect(artifacts.report.pipelines[1]!.perScreen.length)
      .toBeGreaterThanOrEqual(2);
    expect(artifacts.toolExecutionCount).toBe(0);
    expect(artifacts.json).not.toContain(corpus[0]!.sarvamTranscript);
    expect(artifacts.markdown).not.toContain(corpus[0]!.sarvamTranscript);
    expect(`${artifacts.json}${artifacts.markdown}`).not.toMatch(
      /data:image|base64|screenshot|coordinate|audio/i,
    );
  });
});
