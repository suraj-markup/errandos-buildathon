import type { LocalIdentifier } from '../identifiers';
import {
  transitionPhoneTaskV2,
} from './graph';
import type {
  PendingInteractionV2,
  PhoneTaskV2,
} from './contracts';
import type {
  PhoneTaskRepositoryV2,
  TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export function hasNativeV2Transitions(
  task: PhoneTaskV2,
): boolean {
  return task.journal.some((entry) =>
    entry.type !== 'v1_projection');
}

export async function resolveV2InteractionForCompatibility(input: {
  at?: number;
  repository: PhoneTaskRepositoryV2;
  resolvedStepInput?: unknown;
  responseRef: string;
  task: PhoneTaskV2;
}): Promise<TaskRepositoryRecordV2> {
  const interaction = input.task.pendingInteraction;
  if (!interaction) {
    throw new Error('The V2 task has no interaction to resolve.');
  }
  const at = Math.max(input.at ?? Date.now(), input.task.updatedAt);
  const next = transitionPhoneTaskV2(input.task, {
    type: 'resolve_interaction',
    interactionId: interaction.interactionId,
    responseRef: input.responseRef,
    ...(input.resolvedStepInput === undefined
      ? {}
      : { resolvedStepInput: input.resolvedStepInput }),
    entryId: `interaction-resolved:${interaction.interactionId}:${input.task.revision + 1}`,
    at,
  });
  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId: `interaction-resolved:${interaction.interactionId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'interaction_resolved',
      dataRef: input.responseRef,
    },
  });
}

export async function beginV2CompatibilityExecution(input: {
  at?: number;
  operationId: LocalIdentifier<'operation'>;
  repository: PhoneTaskRepositoryV2;
  stepId: string;
  task: PhoneTaskV2;
}): Promise<TaskRepositoryRecordV2> {
  const at = Math.max(input.at ?? Date.now(), input.task.updatedAt);
  const next = transitionPhoneTaskV2(input.task, {
    type: 'begin_step',
    stepId: input.stepId,
    operationId: input.operationId,
    entryId: `execution-began:${input.operationId}`,
    at,
  });
  const step = next.steps.find((candidate) =>
    candidate.stepId === input.stepId)!;
  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId: `execution-began:${input.operationId}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'execution_began',
      dataRef: input.operationId,
    },
    activeOperation: {
      operationId: input.operationId,
      taskId: next.taskId,
      stepId: step.stepId,
      kind: step.kind,
      boundary: 'before_mutation',
      status: 'running',
      updatedAt: at,
    },
  });
}

export async function markV2CompatibilityMutationAttempted(input: {
  at?: number;
  operationId: LocalIdentifier<'operation'>;
  repository: PhoneTaskRepositoryV2;
  stepId: string;
  taskId: LocalIdentifier<'task'>;
}): Promise<TaskRepositoryRecordV2> {
  const current = await input.repository.getById(input.taskId);
  const operation = current?.activeOperation;
  if (
    !current
    || !operation
    || operation.operationId !== input.operationId
    || operation.stepId !== input.stepId
  ) {
    throw new Error('Authoritative task no longer owns this mutation.');
  }
  if (operation.boundary === 'mutation_attempted') return current;
  if (
    operation.boundary !== 'before_mutation'
    || operation.status !== 'running'
  ) {
    throw new Error('Authoritative task cannot cross the mutation boundary.');
  }
  const at = Math.max(input.at ?? Date.now(), current.task.updatedAt);
  const entryId = `mutation-attempted:${input.operationId}`;
  if (current.task.journal.length >= current.task.budgets.maxJournalEntries) {
    throw new Error('Mutation checkpoint exceeds the task journal budget.');
  }
  const next = parsePhoneTaskV2({
    ...structuredClone(current.task),
    revision: current.task.revision + 1,
    updatedAt: at,
    journal: [...current.task.journal, {
      entryId,
      at,
      type: 'mutation_attempted',
      stepId: input.stepId,
      operationId: input.operationId,
    }],
  });
  return input.repository.commit({
    expectedRevision: current.task.revision,
    task: next,
    event: {
      eventId: entryId,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'mutation_attempted',
      dataRef: input.operationId,
    },
    activeOperation: {
      ...operation,
      boundary: 'mutation_attempted',
      updatedAt: at,
    },
  });
}

function resultRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function verifiedMutation(result: Record<string, unknown>): boolean {
  const verification = resultRecord(result['verification']);
  return (
    ['added', 'already_in_cart'].includes(String(result['status'] ?? ''))
    && verification['outcome'] === 'verified_success'
  );
}

function needsInteraction(result: Record<string, unknown>): boolean {
  return (
    ['needs_clarification', 'search_results'].includes(
      String(result['status'] ?? ''),
    )
    && Array.isArray(result['options'])
    && result['options'].length > 0
  );
}

function mutationMayHaveStarted(result: Record<string, unknown>): boolean {
  const verification = resultRecord(result['verification']);
  const operation = resultRecord(result['operation']);
  return (
    verification['mutationAttempted'] === true
    || ['mutation_attempted', 'ambiguous', 'reconciling'].includes(
      String(operation['status'] ?? result['status'] ?? ''),
    )
  );
}

export async function completeV2CompatibilityExecution(input: {
  at?: number;
  operationId: LocalIdentifier<'operation'>;
  repository: PhoneTaskRepositoryV2;
  result: unknown;
  stepId: string;
  task: PhoneTaskV2;
}): Promise<TaskRepositoryRecordV2> {
  const at = Math.max(input.at ?? Date.now(), input.task.updatedAt);
  const result = resultRecord(input.result);
  const status = String(result['status'] ?? 'execution_failed');
  let next: PhoneTaskV2;
  let kind: string;
  let activeOperation:
    | Parameters<PhoneTaskRepositoryV2['commit']>[0]['activeOperation']
    | undefined;

  if (verifiedMutation(result)) {
    kind = 'execution_verified';
    next = transitionPhoneTaskV2(input.task, {
      type: 'verify_step',
      stepId: input.stepId,
      resultRef: `result:${input.operationId}:${status}`,
      entryId: `execution-verified:${input.operationId}`,
      at,
    });
  } else if (needsInteraction(result)) {
    kind = 'execution_waiting_for_user';
    const interaction: PendingInteractionV2 = {
      interactionId:
        `interaction:${input.operationId}:${input.task.revision + 1}`,
      taskId: input.task.taskId,
      taskRevision: input.task.revision + 1,
      kind: 'product_choice',
      allowedResponses: structuredClone(result['options']),
      presentationRef: `presentation:${input.operationId}`,
      status: 'open',
      createdAt: at,
      expiresAt: at + 5 * 60_000,
    };
    next = transitionPhoneTaskV2(input.task, {
      type: 'wait_for_user',
      stepId: input.stepId,
      interaction,
      entryId: `execution-waiting:${input.operationId}`,
      at,
    });
  } else if (mutationMayHaveStarted(result)) {
    kind = 'execution_ambiguous';
    next = transitionPhoneTaskV2(input.task, {
      type: 'mark_ambiguous',
      stepId: input.stepId,
      resultRef: `result:${input.operationId}:${status}`,
      entryId: `execution-ambiguous:${input.operationId}`,
      at,
    });
    activeOperation = {
      operationId: input.operationId,
      taskId: next.taskId,
      stepId: input.stepId,
      kind: next.steps.find((step) => step.stepId === input.stepId)!.kind,
      boundary: 'mutation_attempted',
      status: 'ambiguous',
      resultRef: `result:${input.operationId}:${status}`,
      updatedAt: at,
    };
  } else {
    kind = 'execution_failed_before_mutation';
    next = transitionPhoneTaskV2(input.task, {
      type: 'fail_step',
      stepId: input.stepId,
      resultRef: `result:${input.operationId}:${status}`,
      entryId: `execution-failed:${input.operationId}`,
      at,
    });
  }

  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId: `${kind}:${input.operationId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind,
      dataRef: `result:${input.operationId}:${status}`,
    },
    ...(activeOperation ? { activeOperation } : {}),
  });
}
