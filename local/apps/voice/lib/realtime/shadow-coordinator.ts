import {
  type ControlShadowCaseV1,
  type ControlShadowClarification,
  type ControlShadowProductEntityV1,
  type ControlShadowTaskIntent,
  type ControlShadowToolIntent,
  type SanitizedObservationMetadataV1,
} from './shadow-corpus';
import {
  createControlShadowComparisonReportV1,
  type ControlShadowComparisonReportV1,
  type ControlShadowPipeline,
  type ControlShadowPredictionV1,
  type ControlShadowRunInputV1,
} from './shadow-scorer';

export type SanitizedShadowTaskContextV1 = {
  activeItemPosition?: number;
  awaitingClarification: boolean;
  hasPendingCheckout: boolean;
  itemCount: number;
  phase:
    | 'active'
    | 'awaiting_checkout_confirmation'
    | 'awaiting_product_choice'
    | 'cancelled'
    | 'completed'
    | 'failed';
  version: 1;
};

export type ControlShadowTurnV1 = {
  case: ControlShadowCaseV1;
  task: SanitizedShadowTaskContextV1;
  version: 1;
};

export type ControlShadowDecisionV1 = {
  clarification: ControlShadowClarification;
  followUp: boolean;
  groundingCandidateId?: string;
  negatedOrdinals: number[];
  negatedProducts: string[];
  ordinal?: number;
  products: ControlShadowProductEntityV1[];
  taskIntent: ControlShadowTaskIntent;
  toolIntent: ControlShadowToolIntent;
  version: 1;
};

export type ControlShadowEvaluatorInputV1 = {
  caseId: string;
  languageCode: ControlShadowCaseV1['languageCode'];
  observation?: SanitizedObservationMetadataV1;
  sarvamTranscript: string;
  task: SanitizedShadowTaskContextV1;
  version: 1;
};

export type SuppressedToolCallResultV1 = {
  status: 'suppressed';
  version: 1;
};

export type ControlShadowEvaluatorContext = {
  pipeline: ControlShadowPipeline;
  signal: AbortSignal;
  suppressToolCall: (call: {
    arguments?: unknown;
    toolName: string;
  }) => SuppressedToolCallResultV1;
  toolMode: 'shadow_suppressed';
};

export interface ControlShadowEvaluator {
  evaluate(
    input: Readonly<ControlShadowEvaluatorInputV1>,
    context: ControlShadowEvaluatorContext,
  ): Promise<ControlShadowDecisionV1>;
}

export type ControlShadowFailureCategory =
  | 'provider_failure'
  | 'timeout';

export type ControlShadowCoordinatorResultV1 = {
  diagnostics: {
    failures: Array<{
      caseId: string;
      latencyMs: number;
      pipeline: ControlShadowPipeline;
      reason: ControlShadowFailureCategory;
      suppressedToolCallCount: number;
    }>;
    suppressedToolCallCount: number;
    toolExecutionCount: 0;
  };
  report: ControlShadowComparisonReportV1;
  schemaVersion: 1;
};

type EvaluatorResult =
  | {
      kind: 'prediction';
      prediction: ControlShadowPredictionV1;
      suppressedToolCallCount: number;
    }
  | {
      caseId: string;
      kind: 'failure';
      latencyMs: number;
      pipeline: ControlShadowPipeline;
      reason: ControlShadowFailureCategory;
      suppressedToolCallCount: number;
    };

type CoordinatorOptions = {
  monotonicNow?: () => number;
  timeoutMs?: number;
};

const taskPhases = new Set<SanitizedShadowTaskContextV1['phase']>([
  'active',
  'awaiting_checkout_confirmation',
  'awaiting_product_choice',
  'cancelled',
  'completed',
  'failed',
]);

function safeMetricLabel(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value)) {
    throw new Error(`${field} must be a sanitized metric label.`);
  }
  return value;
}

function finiteInteger(
  value: number | undefined,
  field: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function sanitizeTask(
  task: SanitizedShadowTaskContextV1,
): SanitizedShadowTaskContextV1 {
  if (task.version !== 1 || !taskPhases.has(task.phase)) {
    throw new Error('Invalid sanitized shadow task context.');
  }
  if (
    typeof task.awaitingClarification !== 'boolean'
    || typeof task.hasPendingCheckout !== 'boolean'
  ) {
    throw new Error('Invalid sanitized shadow task flags.');
  }
  const itemCount = finiteInteger(task.itemCount, 'task.itemCount', 0)!;
  const activeItemPosition = finiteInteger(
    task.activeItemPosition,
    'task.activeItemPosition',
    1,
  );
  if (
    activeItemPosition !== undefined
    && (itemCount === 0 || activeItemPosition > itemCount)
  ) {
    throw new Error('Active item position must be within the task item count.');
  }
  return {
    ...(activeItemPosition === undefined ? {} : { activeItemPosition }),
    awaitingClarification: task.awaitingClarification,
    hasPendingCheckout: task.hasPendingCheckout,
    itemCount,
    phase: task.phase,
    version: 1,
  };
}

function sanitizeObservation(
  observation: SanitizedObservationMetadataV1 | undefined,
): SanitizedObservationMetadataV1 | undefined {
  if (!observation) return undefined;
  return {
    candidates: observation.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      ordinal: candidate.ordinal,
      role: candidate.role,
    })),
    observationToken: observation.observationToken,
    screenKind: observation.screenKind,
  };
}

function immutableEvaluatorInput(
  turn: ControlShadowTurnV1,
): Readonly<ControlShadowEvaluatorInputV1> {
  const observation = sanitizeObservation(turn.case.observation);
  const input: ControlShadowEvaluatorInputV1 = {
    caseId: turn.case.caseId,
    languageCode: turn.case.languageCode,
    ...(observation ? { observation } : {}),
    sarvamTranscript: turn.case.sarvamTranscript,
    task: sanitizeTask(turn.task),
    version: 1,
  };
  if (input.observation) {
    input.observation.candidates.forEach(Object.freeze);
    Object.freeze(input.observation.candidates);
    Object.freeze(input.observation);
  }
  Object.freeze(input.task);
  return Object.freeze(input);
}

function predictionFromDecision(
  caseId: string,
  decision: ControlShadowDecisionV1,
  latencyMs: number,
): ControlShadowPredictionV1 {
  if (decision.version !== 1) {
    throw new Error('Unsupported shadow decision version.');
  }
  return {
    caseId,
    clarification: decision.clarification,
    followUp: decision.followUp,
    ...(decision.groundingCandidateId
      ? { groundingCandidateId: decision.groundingCandidateId }
      : {}),
    latencyMs,
    negatedOrdinals: [...decision.negatedOrdinals],
    negatedProducts: [...decision.negatedProducts],
    ...(decision.ordinal === undefined ? {} : { ordinal: decision.ordinal }),
    products: decision.products.map((product) => ({ ...product })),
    taskIntent: decision.taskIntent,
    toolIntent: decision.toolIntent,
    version: 1,
  };
}

async function evaluateWithTimeout(input: {
  evaluator: ControlShadowEvaluator;
  evaluatorInput: Readonly<ControlShadowEvaluatorInputV1>;
  monotonicNow: () => number;
  pipeline: ControlShadowPipeline;
  timeoutMs: number;
}): Promise<EvaluatorResult> {
  const startedAt = input.monotonicNow();
  const controller = new AbortController();
  let suppressedToolCallCount = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const evaluation = Promise.resolve().then(() => input.evaluator.evaluate(
    input.evaluatorInput,
    {
      pipeline: input.pipeline,
      signal: controller.signal,
      suppressToolCall: () => {
        suppressedToolCallCount += 1;
        return { status: 'suppressed', version: 1 };
      },
      toolMode: 'shadow_suppressed',
    },
  )).then(
    (decision) => ({ decision, kind: 'decision' as const }),
    () => ({ kind: 'provider_failure' as const }),
  );
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ kind: 'timeout' }),
      input.timeoutMs,
    );
  });

  const outcome = await Promise.race([evaluation, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  const latencyMs = Math.max(0, input.monotonicNow() - startedAt);
  if (outcome.kind === 'timeout') {
    controller.abort();
    return {
      caseId: input.evaluatorInput.caseId,
      kind: 'failure',
      latencyMs,
      pipeline: input.pipeline,
      reason: 'timeout',
      suppressedToolCallCount,
    };
  }
  if (outcome.kind === 'provider_failure') {
    return {
      caseId: input.evaluatorInput.caseId,
      kind: 'failure',
      latencyMs,
      pipeline: input.pipeline,
      reason: 'provider_failure',
      suppressedToolCallCount,
    };
  }
  try {
    return {
      kind: 'prediction',
      prediction: predictionFromDecision(
        input.evaluatorInput.caseId,
        outcome.decision,
        latencyMs,
      ),
      suppressedToolCallCount,
    };
  } catch {
    return {
      caseId: input.evaluatorInput.caseId,
      kind: 'failure',
      latencyMs,
      pipeline: input.pipeline,
      reason: 'provider_failure',
      suppressedToolCallCount,
    };
  }
}

function buildRun(
  pipeline: ControlShadowPipeline,
  model: string,
  runId: string,
  results: readonly EvaluatorResult[],
): ControlShadowRunInputV1 {
  return {
    model,
    pipeline,
    predictions: results.flatMap((result) => (
      result.kind === 'prediction' ? [result.prediction] : []
    )),
    runId,
    version: 1,
  };
}

export async function runControlShadowComparisonV1(input: {
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
  turns: readonly ControlShadowTurnV1[];
  version: 1;
}, options: CoordinatorOptions = {}): Promise<ControlShadowCoordinatorResultV1> {
  if (input.version !== 1) {
    throw new Error('Unsupported shadow coordinator version.');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Shadow evaluator timeout must be positive.');
  }
  const caseIds = new Set<string>();
  for (const turn of input.turns) {
    if (turn.version !== 1) throw new Error('Unsupported shadow turn version.');
    safeMetricLabel(turn.case.caseId, 'caseId');
    if (caseIds.has(turn.case.caseId)) {
      throw new Error(`Duplicate shadow turn: ${turn.case.caseId}.`);
    }
    caseIds.add(turn.case.caseId);
  }
  safeMetricLabel(input.responses.model, 'responses.model');
  safeMetricLabel(input.responses.runId, 'responses.runId');
  safeMetricLabel(input.realtime.model, 'realtime.model');
  safeMetricLabel(input.realtime.runId, 'realtime.runId');

  const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  const results = await Promise.all(input.turns.map(async (turn) => {
    const evaluatorInput = immutableEvaluatorInput(turn);
    const [responses, realtime] = await Promise.all([
      evaluateWithTimeout({
        evaluator: input.responses.evaluator,
        evaluatorInput,
        monotonicNow,
        pipeline: 'responses_control',
        timeoutMs,
      }),
      evaluateWithTimeout({
        evaluator: input.realtime.evaluator,
        evaluatorInput,
        monotonicNow,
        pipeline: 'realtime_control',
        timeoutMs,
      }),
    ]);
    return { realtime, responses };
  }));
  const responsesResults = results.map((result) => result.responses);
  const realtimeResults = results.map((result) => result.realtime);
  const allResults = results.flatMap((result) => [
    result.responses,
    result.realtime,
  ]);
  const report = createControlShadowComparisonReportV1({
    corpus: input.turns.map((turn) => turn.case),
    realtime: buildRun(
      'realtime_control',
      input.realtime.model,
      input.realtime.runId,
      realtimeResults,
    ),
    responses: buildRun(
      'responses_control',
      input.responses.model,
      input.responses.runId,
      responsesResults,
    ),
  });
  return {
    diagnostics: {
      failures: allResults.flatMap((result) => (
        result.kind === 'failure'
          ? [{
              caseId: result.caseId,
              latencyMs: result.latencyMs,
              pipeline: result.pipeline,
              reason: result.reason,
              suppressedToolCallCount: result.suppressedToolCallCount,
            }]
          : []
      )),
      suppressedToolCallCount: allResults.reduce(
        (total, result) => total + result.suppressedToolCallCount,
        0,
      ),
      toolExecutionCount: 0,
    },
    report,
    schemaVersion: 1,
  };
}
