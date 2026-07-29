import { describe, expect, it, vi } from 'vitest';
import {
  CONTROL_SHADOW_CORPUS_V1,
  type ControlShadowCaseV1,
} from './shadow-corpus';
import {
  runControlShadowComparisonV1,
  type ControlShadowDecisionV1,
  type ControlShadowEvaluator,
  type ControlShadowEvaluatorInputV1,
  type ControlShadowTurnV1,
} from './shadow-coordinator';

function decisionFor(testCase: ControlShadowCaseV1): ControlShadowDecisionV1 {
  return {
    clarification: testCase.expected.clarification,
    followUp: testCase.expected.followUp,
    ...(testCase.expected.groundingCandidateId
      ? { groundingCandidateId: testCase.expected.groundingCandidateId }
      : {}),
    negatedOrdinals: [...testCase.expected.negatedOrdinals],
    negatedProducts: [...testCase.expected.negatedProducts],
    ...(testCase.expected.ordinal === undefined
      ? {}
      : { ordinal: testCase.expected.ordinal }),
    products: testCase.expected.products.map((product) => ({ ...product })),
    taskIntent: testCase.expected.taskIntent,
    toolIntent: testCase.expected.toolIntent,
    version: 1,
  };
}

function turn(testCase: ControlShadowCaseV1): ControlShadowTurnV1 {
  return {
    case: testCase,
    task: {
      ...(testCase.expected.followUp ? { activeItemPosition: 1 } : {}),
      awaitingClarification: testCase.expected.followUp,
      hasPendingCheckout: false,
      itemCount: testCase.expected.followUp ? 2 : 1,
      phase: testCase.expected.followUp
        ? 'awaiting_product_choice'
        : 'active',
      version: 1,
    },
    version: 1,
  };
}

function evaluator(
  evaluate: ControlShadowEvaluator['evaluate'],
): ControlShadowEvaluator {
  return { evaluate };
}

function coordinatorInput(input: {
  realtime: ControlShadowEvaluator;
  responses: ControlShadowEvaluator;
  turns?: readonly ControlShadowTurnV1[];
}) {
  return {
    realtime: {
      evaluator: input.realtime,
      model: 'gpt-realtime-2.1',
      runId: 'realtime-shadow',
    },
    responses: {
      evaluator: input.responses,
      model: 'gpt-4.1-mini',
      runId: 'responses-shadow',
    },
    turns: input.turns ?? [turn(CONTROL_SHADOW_CORPUS_V1[0]!)],
    version: 1 as const,
  };
}

describe('Realtime shadow coordinator', () => {
  it('passes identical transcript, task, and sanitized observation to both evaluators', async () => {
    const testCase = CONTROL_SHADOW_CORPUS_V1.find(
      (entry) => entry.observation,
    )!;
    const seen: ControlShadowEvaluatorInputV1[] = [];
    const recordingEvaluator = evaluator(async (input) => {
      seen.push(structuredClone(input));
      return decisionFor(testCase);
    });

    await runControlShadowComparisonV1(coordinatorInput({
      realtime: recordingEvaluator,
      responses: recordingEvaluator,
      turns: [turn(testCase)],
    }));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toMatchObject({
      caseId: testCase.caseId,
      observation: {
        observationToken: testCase.observation!.observationToken,
      },
      sarvamTranscript: testCase.sarvamTranscript,
      task: {
        awaitingClarification: true,
        phase: 'awaiting_product_choice',
      },
    });
  });

  it('reports Responses-versus-Realtime disagreement without executing tools', async () => {
    const testCase = CONTROL_SHADOW_CORPUS_V1[0]!;
    const responses = evaluator(async (_input, context) => {
      expect(context.toolMode).toBe('shadow_suppressed');
      expect(context.suppressToolCall({
        arguments: { request: testCase.sarvamTranscript },
        toolName: 'add_cart_item',
      })).toEqual({ status: 'suppressed', version: 1 });
      return decisionFor(testCase);
    });
    const realtime = evaluator(async (_input, context) => {
      context.suppressToolCall({
        arguments: { request: 'private product words' },
        toolName: 'inspect_cart',
      });
      return {
        ...decisionFor(testCase),
        taskIntent: 'inspect_cart',
        toolIntent: 'inspect_cart',
      };
    });

    const result = await runControlShadowComparisonV1(coordinatorInput({
      realtime,
      responses,
    }));

    expect(result.report.responses.qualityScore).toBe(1);
    expect(result.report.realtime.qualityScore).toBeLessThan(1);
    expect(result.report.comparison.qualityDelta).toBeLessThan(0);
    expect(result.diagnostics).toMatchObject({
      failures: [],
      suppressedToolCallCount: 2,
      toolExecutionCount: 0,
    });
  });

  it('redacts provider failures and scores that pipeline case as missing', async () => {
    const testCase = CONTROL_SHADOW_CORPUS_V1[0]!;
    const privateFailure =
      `provider failed for ${testCase.sarvamTranscript} with sk-secret`;
    const result = await runControlShadowComparisonV1(coordinatorInput({
      realtime: evaluator(async () => {
        throw new Error(privateFailure);
      }),
      responses: evaluator(async () => decisionFor(testCase)),
    }));
    const serialized = JSON.stringify(result);

    expect(result.diagnostics.failures).toMatchObject([{
      caseId: testCase.caseId,
      pipeline: 'realtime_control',
      reason: 'provider_failure',
    }]);
    expect(result.report.realtime.missingCaseIds).toEqual([testCase.caseId]);
    expect(serialized).not.toContain(privateFailure);
    expect(serialized).not.toContain('sk-secret');
  });

  it('bounds a hung evaluator and reports a timeout without persisting input', async () => {
    const testCase = CONTROL_SHADOW_CORPUS_V1[0]!;
    const abortObserved = vi.fn();
    const result = await runControlShadowComparisonV1(coordinatorInput({
      realtime: evaluator(async (_input, context) => (
        await new Promise<ControlShadowDecisionV1>(() => {
          context.signal.addEventListener('abort', abortObserved);
        })
      )),
      responses: evaluator(async () => decisionFor(testCase)),
    }), { timeoutMs: 5 });

    expect(result.diagnostics.failures).toMatchObject([{
      caseId: testCase.caseId,
      pipeline: 'realtime_control',
      reason: 'timeout',
    }]);
    expect(abortObserved).toHaveBeenCalledTimes(1);
    expect(result.report.realtime.evaluatedCases).toBe(0);
  });

  it('never persists raw transcripts, image-like extras, tool arguments, or errors', async () => {
    const base = CONTROL_SHADOW_CORPUS_V1.find(
      (entry) => entry.observation,
    )!;
    const rawImage = 'data:image/png;base64,PRIVATE';
    const rawTranscript = base.sarvamTranscript;
    const rawArgument = 'private-tool-argument';
    const unsafeCase = {
      ...base,
      observation: {
        ...base.observation!,
        imageDataUrl: rawImage,
      },
    } as ControlShadowCaseV1;
    const toolAttempt = evaluator(async (_input, context) => {
      context.suppressToolCall({
        arguments: { rawArgument },
        toolName: 'add_cart_item',
      });
      return decisionFor(base);
    });

    const result = await runControlShadowComparisonV1(coordinatorInput({
      realtime: toolAttempt,
      responses: toolAttempt,
      turns: [turn(unsafeCase)],
    }));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(rawTranscript);
    expect(serialized).not.toContain(rawImage);
    expect(serialized).not.toContain(rawArgument);
    expect(serialized).not.toMatch(/sarvamTranscript|imageDataUrl|arguments/);
    expect(result.diagnostics.toolExecutionCount).toBe(0);
    expect(result.diagnostics.suppressedToolCallCount).toBe(2);
  });
});
