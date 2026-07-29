import { createHash } from 'node:crypto';
import {
  executePhoneAction,
  type PhoneActionArguments,
  type PhoneActionExecutionContext,
} from '../phone-tool';
import {
  newLocalIdentifier,
  type LocalIdentifier,
} from '../workflow/identifiers';
import {
  beginV2CompatibilityExecution,
  completeV2CompatibilityExecution,
  resolveV2InteractionForCompatibility,
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
  type TaskRepositoryRecordV2,
} from '../workflow/v2';
import {
  enqueueProductionBackgroundPhoneOperationV2,
} from '../workflow/v2/background-phone-operation/production-adapter';

type ProductSelectionSourceV2 = 'tap' | 'voice';

type ProductSelectionInteractionV2 = {
  clientId: string;
  interactionId: string;
  offerId: string;
  selectionId: LocalIdentifier<'selection'>;
  source: ProductSelectionSourceV2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
};

type ExactProductChoiceV2 = {
  offerId: string;
  packSize?: string;
  priceAmount: number;
  priceCurrency: 'INR';
  title: string;
};

type ProductSelectionWinnerV2 = {
  offerId: string;
  responseRef: string;
  selectionId?: LocalIdentifier<'selection'>;
  source?: ProductSelectionSourceV2;
};

type ProductSelectionResolutionV2 =
  | {
      acknowledgement: 'accepted';
      action: PhoneActionArguments;
      choice: ExactProductChoiceV2;
      record: TaskRepositoryRecordV2;
      stepId: string;
      winner: ProductSelectionWinnerV2;
    }
  | {
      acknowledgement: 'duplicate';
      record: TaskRepositoryRecordV2;
      winner: ProductSelectionWinnerV2;
    }
  | {
      acknowledgement: 'rejected';
      actualRevision?: number;
      reason:
        | 'already_resolved'
        | 'client_task_mismatch'
        | 'expired'
        | 'stale_interaction'
        | 'stale_task_revision'
        | 'unknown_interaction'
        | 'unknown_offer'
        | 'unknown_task'
        | 'unsupported_interaction';
      status: 403 | 404 | 409 | 422;
      winner?: ProductSelectionWinnerV2;
    };

type ProductSelectionExecutionDependenciesV2 = {
  enqueue?: typeof enqueueProductionBackgroundPhoneOperationV2;
  execute?: (
    action: PhoneActionArguments,
    context: PhoneActionExecutionContext,
  ) => Promise<unknown>;
  now: () => number;
  repository: PhoneTaskRepositoryV2;
};

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactProductChoice(
  allowedResponses: unknown,
  offerId: string,
): ExactProductChoiceV2 | undefined {
  if (!Array.isArray(allowedResponses)) return undefined;
  const matches = allowedResponses
    .map(objectRecord)
    .filter((candidate) => candidate?.['offerId'] === offerId);
  if (matches.length !== 1) return undefined;
  const option = matches[0]!;
  const titleValue =
    option['title'] ?? option['product'] ?? option['spokenLabel'];
  const priceAmount = option['priceAmount'];
  if (
    typeof titleValue !== 'string'
    || !titleValue.trim()
    || titleValue.trim() !== titleValue
    || titleValue.length > 300
    || typeof priceAmount !== 'number'
    || !Number.isFinite(priceAmount)
    || priceAmount < 0
    || option['priceCurrency'] !== 'INR'
  ) {
    return undefined;
  }
  const packSizeValue = option['packSize'] ?? option['size'];
  const packSize = typeof packSizeValue === 'string'
    && packSizeValue.trim()
    && packSizeValue.trim() === packSizeValue
    && packSizeValue.length <= 100
    ? packSizeValue
    : undefined;
  return {
    offerId,
    ...(packSize ? { packSize } : {}),
    priceAmount,
    priceCurrency: 'INR',
    title: titleValue,
  };
}

function selectedStepAction(
  task: PhoneTaskV2,
  choice: ExactProductChoiceV2,
): { action: PhoneActionArguments; stepId: string } | undefined {
  const step = task.steps.find((candidate) =>
    candidate.stepId === task.activeStepId);
  const input = objectRecord(step?.input);
  if (
    !step
    || step.status !== 'waiting_for_user'
    || !['add_cart_item', 'search_products'].includes(step.kind)
    || input?.['action'] !== 'add_cart_item'
  ) {
    return undefined;
  }
  const quantity = Number.isSafeInteger(input['quantity'])
    && (input['quantity'] as number) > 0
    ? input['quantity'] as number
    : 1;
  const request = typeof input['request'] === 'string'
    && input['request'].trim()
    ? input['request']
    : choice.title;
  return {
    action: {
      action: 'add_cart_item',
      offerId: choice.offerId,
      quantity,
      request: choice.title,
      searchQuery: request,
      selectedOffer: choice,
    },
    stepId: step.stepId,
  };
}

function responseRef(input: ProductSelectionInteractionV2): string {
  const digest = createHash('sha256').update(JSON.stringify({
    interactionId: input.interactionId,
    offerId: input.offerId,
    selectionId: input.selectionId,
    source: input.source,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
  })).digest('hex');
  return [
    'product-choice-v2',
    input.source,
    input.selectionId,
    digest,
  ].join(':');
}

function parsedWinnerMetadata(
  value: string,
): Pick<ProductSelectionWinnerV2, 'selectionId' | 'source'> {
  const match =
    /^product-choice-v2:(tap|voice):(selection_[A-Za-z0-9._:-]+):[a-f0-9]{64}$/
      .exec(value);
  if (!match) return {};
  return {
    selectionId: match[2] as LocalIdentifier<'selection'>,
    source: match[1] as ProductSelectionSourceV2,
  };
}

function winnerFromTask(
  task: PhoneTaskV2,
  interactionId: string,
): ProductSelectionWinnerV2 | undefined {
  const entryIndex = task.journal.findIndex((candidate) =>
    candidate.type === 'resolve_interaction'
    && candidate.entryId.startsWith(
      `interaction-resolved:${interactionId}:`,
    ));
  const entry = task.journal[entryIndex];
  if (!entry?.dataRef) return undefined;
  const subsequentStepId = task.journal
    .slice(entryIndex + 1)
    .find((candidate) => candidate.stepId)?.stepId;
  const selectedStep = task.steps.find((step) =>
    step.lastResultRef === entry.dataRef)
    ?? task.steps.find((step) => step.stepId === subsequentStepId);
  const selectedInput = objectRecord(selectedStep?.input);
  const offerId = selectedInput?.['offerId'];
  if (typeof offerId !== 'string' || !offerId) return undefined;
  return {
    offerId,
    responseRef: entry.dataRef,
    ...parsedWinnerMetadata(entry.dataRef),
  };
}

function replayResolution(
  record: TaskRepositoryRecordV2,
  input: ProductSelectionInteractionV2,
): ProductSelectionResolutionV2 | undefined {
  const winner = winnerFromTask(record.task, input.interactionId);
  if (!winner) return undefined;
  if (winner.responseRef === responseRef(input)) {
    return {
      acknowledgement: 'duplicate',
      record,
      winner,
    };
  }
  return {
    acknowledgement: 'rejected',
    actualRevision: record.task.revision,
    reason: 'already_resolved',
    status: 409,
    winner,
  };
}

/**
 * The single authority for product-choice validation, replay interpretation,
 * and compare-and-swap resolution. Both card taps and exact voice choices must
 * pass through this function so a race has one winner and every loser can
 * report that winner from durable task state.
 */
export async function resolveProductSelectionInteractionV2(
  input: ProductSelectionInteractionV2,
  dependencies: Pick<
    ProductSelectionExecutionDependenciesV2,
    'now' | 'repository'
  >,
): Promise<ProductSelectionResolutionV2> {
  const record = await dependencies.repository.getById(input.taskId);
  if (!record) {
    return {
      acknowledgement: 'rejected',
      reason: 'unknown_task',
      status: 404,
    };
  }
  if (record.task.clientId !== input.clientId) {
    return {
      acknowledgement: 'rejected',
      reason: 'client_task_mismatch',
      status: 403,
    };
  }
  const replay = replayResolution(record, input);
  if (replay) return replay;
  if (record.task.revision !== input.taskRevision) {
    return {
      acknowledgement: 'rejected',
      actualRevision: record.task.revision,
      reason: 'stale_task_revision',
      status: 409,
    };
  }
  const pending = record.task.pendingInteraction;
  if (
    !pending
    || pending.interactionId !== input.interactionId
    || pending.kind !== 'product_choice'
  ) {
    return {
      acknowledgement: 'rejected',
      reason: 'unknown_interaction',
      status: 404,
    };
  }
  if (
    pending.taskId !== input.taskId
    || pending.taskRevision !== input.taskRevision
    || pending.status !== 'open'
  ) {
    return {
      acknowledgement: 'rejected',
      reason: 'stale_interaction',
      status: 409,
    };
  }
  if (dependencies.now() >= pending.expiresAt) {
    return {
      acknowledgement: 'rejected',
      reason: 'expired',
      status: 409,
    };
  }
  const choice = exactProductChoice(pending.allowedResponses, input.offerId);
  if (!choice) {
    return {
      acknowledgement: 'rejected',
      reason: 'unknown_offer',
      status: 422,
    };
  }
  const selected = selectedStepAction(record.task, choice);
  if (!selected) {
    return {
      acknowledgement: 'rejected',
      reason: 'unsupported_interaction',
      status: 422,
    };
  }

  const requestedWinner: ProductSelectionWinnerV2 = {
    offerId: input.offerId,
    responseRef: responseRef(input),
    selectionId: input.selectionId,
    source: input.source,
  };
  try {
    const committed = await resolveV2InteractionForCompatibility({
      at: dependencies.now(),
      repository: dependencies.repository,
      resolvedStepInput: selected.action,
      responseRef: requestedWinner.responseRef,
      task: record.task,
    });
    return {
      acknowledgement: 'accepted',
      action: selected.action,
      choice,
      record: committed,
      stepId: selected.stepId,
      winner: requestedWinner,
    };
  } catch (error) {
    if (!(error instanceof TaskRevisionConflictV2Error)) throw error;
    const latest = await dependencies.repository.getById(input.taskId);
    if (latest) {
      const racedReplay = replayResolution(latest, input);
      if (racedReplay) return racedReplay;
    }
    return {
      acknowledgement: 'rejected',
      actualRevision: error.actualRevision,
      reason: 'stale_task_revision',
      status: 409,
    };
  }
}

export async function executeResolvedProductSelectionV2(
  input: Extract<
    ProductSelectionResolutionV2,
    { acknowledgement: 'accepted' }
  >,
  dependencies: ProductSelectionExecutionDependenciesV2,
): Promise<{
  operationId: LocalIdentifier<'operation'>;
  record: TaskRepositoryRecordV2;
  result?: unknown;
}> {
  const operationId = newLocalIdentifier('operation');
  const running = await beginV2CompatibilityExecution({
    at: dependencies.now(),
    operationId,
    repository: dependencies.repository,
    stepId: input.stepId,
    task: input.record.task,
  });
  if (dependencies.enqueue) {
    await dependencies.enqueue({
      operationId,
      requestPayload: { version: 1, action: input.action },
      stepId: input.stepId,
      taskId: running.task.taskId as LocalIdentifier<'task'>,
      taskRevision: running.task.revision,
    });
    return {
      operationId,
      record: running,
    };
  }

  const execute = dependencies.execute ?? executePhoneAction;
  let result: unknown;
  try {
    result = await execute(input.action, {
      callId: `device-selection:${operationId}`,
      operationId,
      protocolVersion: 2,
      stepKey: input.stepId,
      taskId: running.task.taskId,
      taskRevision: running.task.revision,
    });
  } catch (error) {
    result = {
      failure: {
        operation: 'add_cart_item',
        reason: error instanceof Error ? error.message : 'execution_failed',
        recoverable: true,
        stage: 'execution',
      },
      ok: false,
      status: 'execution_failed',
    };
  }
  const completed = await completeV2CompatibilityExecution({
    at: dependencies.now(),
    operationId,
    repository: dependencies.repository,
    result,
    stepId: input.stepId,
    task: running.task,
  });
  return {
    operationId,
    record: completed,
    result,
  };
}
