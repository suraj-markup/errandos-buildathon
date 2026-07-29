import type { GeneralMobileAdapterRegistryV2 } from './adapter-registry';
import type {
  GeneralMobileActionV2,
  GeneralMobileExecutionRequestV2,
  GeneralMobileExecutionResultV2,
  GeneralMobileObservationV2,
} from './contracts';

export type InstrumentedRunResultV2 = {
  status:
    | 'blocked'
    | 'cancelled'
    | 'failed'
    | 'replan_exhausted'
    | 'verified';
  attempts: number;
  replans: number;
  results: GeneralMobileExecutionResultV2[];
};

export async function runBoundedGeneralMobilePlanV2(input: {
  registry: GeneralMobileAdapterRegistryV2;
  actions: GeneralMobileActionV2[];
  currentTaskRevision: number;
  observationFor: (
    action: GeneralMobileActionV2,
  ) => GeneralMobileObservationV2 | undefined;
  replan: (context: {
    failedAction: GeneralMobileActionV2;
    result: Extract<
      GeneralMobileExecutionResultV2,
      { status: 'no_progress' | 'stale_target' | 'unexpected_dialog' }
    >;
    replanNumber: number;
  }) => Promise<GeneralMobileActionV2[]>;
  isCancelled?: () => boolean;
  maxActions?: number;
  maxReplans?: number;
}): Promise<InstrumentedRunResultV2> {
  const maxActions = input.maxActions ?? 20;
  const maxReplans = input.maxReplans ?? 2;
  if (
    !Number.isSafeInteger(maxActions)
    || maxActions < 1
    || maxActions > 100
    || !Number.isSafeInteger(maxReplans)
    || maxReplans < 0
    || maxReplans > 5
  ) {
    throw new Error('Invalid general-mobile runner bounds.');
  }
  let queue = [...input.actions];
  let attempts = 0;
  let replans = 0;
  const results: GeneralMobileExecutionResultV2[] = [];

  while (queue.length > 0) {
    if (input.isCancelled?.()) {
      return { status: 'cancelled', attempts, replans, results };
    }
    if (attempts >= maxActions) {
      return { status: 'replan_exhausted', attempts, replans, results };
    }
    const action = queue.shift()!;
    const observation = input.observationFor(action);
    const request: GeneralMobileExecutionRequestV2 = {
      action,
      currentTaskRevision: input.currentTaskRevision,
      ...(observation ? { observation } : {}),
      isCancelled: input.isCancelled,
    };
    const result = await input.registry.execute(request);
    attempts += 1;
    results.push(result);
    if (result.status === 'verified') continue;
    if (result.status === 'cancelled') {
      return { status: 'cancelled', attempts, replans, results };
    }
    if (result.status === 'blocked') {
      return { status: 'blocked', attempts, replans, results };
    }
    if (
      ['no_progress', 'stale_target', 'unexpected_dialog']
        .includes(result.status)
    ) {
      if (replans >= maxReplans) {
        return { status: 'replan_exhausted', attempts, replans, results };
      }
      replans += 1;
      const replacement = await input.replan({
        failedAction: action,
        result: result as Extract<
          GeneralMobileExecutionResultV2,
          { status: 'no_progress' | 'stale_target' | 'unexpected_dialog' }
        >,
        replanNumber: replans,
      });
      if (replacement.length + attempts > maxActions) {
        return { status: 'replan_exhausted', attempts, replans, results };
      }
      queue = [...replacement, ...queue];
      continue;
    }
    return { status: 'failed', attempts, replans, results };
  }
  return { status: 'verified', attempts, replans, results };
}
