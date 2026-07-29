import { createHash } from 'node:crypto';
import {
  TERMINAL_STEP_STATUSES_V2,
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskStepV2,
  type PhoneTaskV2,
  type TaskJournalEntryV2,
} from './contracts';
import { InvalidPhoneTaskV2TransitionError } from './graph';
import {
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type TaskRecoveryOperationV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export type QueueEditCommandV2 =
  | {
      command: 'refine';
      request: string;
      quantity?: number;
      stepId: string;
    }
  | { command: 'remove'; stepId: string }
  | { command: 'skip'; stepId: string }
  | { command: 'reorder'; orderedStepIds: string[] }
  | { command: 'pause' }
  | { command: 'resume' }
  | { command: 'cancel' };

export type QueueEditOutcomeV2 =
  | 'updated'
  | 'paused'
  | 'resumed'
  | 'cancelled'
  | 'cancellation_requested';

export type QueueEditResultV2 = {
  commandId: string;
  outcome: QueueEditOutcomeV2;
  record: TaskRepositoryRecordV2;
};

const QUEUE_ITEM_KINDS = new Set(['add_cart_item', 'search_products']);

function commandFingerprint(command: QueueEditCommandV2): string {
  return createHash('sha256')
    .update(JSON.stringify(command))
    .digest('hex');
}

export function queueEditJournalEntryIdV2(commandId: string): string {
  return `queue-edit:${commandId}`;
}

export function queueEditDataRefV2(command: QueueEditCommandV2): string {
  return `queue-command:${commandFingerprint(command)}`;
}

export function priorQueueEditV2(
  task: PhoneTaskV2,
  input: { command: QueueEditCommandV2; commandId: string },
): 'duplicate' | 'command_id_conflict' | undefined {
  const entry = task.journal.find(
    (candidate) =>
      candidate.entryId === queueEditJournalEntryIdV2(input.commandId),
  );
  if (!entry) return undefined;
  return entry.dataRef === queueEditDataRefV2(input.command)
    ? 'duplicate'
    : 'command_id_conflict';
}

function editableFutureStep(
  task: PhoneTaskV2,
  stepId: string,
): { index: number; step: PhoneTaskStepV2 } {
  const index = task.steps.findIndex((step) => step.stepId === stepId);
  const step = task.steps[index];
  if (!step) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Unknown queue step ${stepId}.`,
    );
  }
  if (
    !QUEUE_ITEM_KINDS.has(step.kind)
    || !['planned', 'ready'].includes(step.status)
    || step.operationId
    || task.activeStepId === step.stepId
  ) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Queue step ${stepId} is not an editable future item.`,
    );
  }
  return { index, step };
}

function normalizeReadiness(steps: PhoneTaskStepV2[]): PhoneTaskStepV2[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return steps.map((step) => {
    if (!['planned', 'ready'].includes(step.status)) return step;
    const ready = step.dependsOn.every((dependency) => {
      const candidate = byId.get(dependency);
      return Boolean(
        candidate && TERMINAL_STEP_STATUSES_V2.has(candidate.status),
      );
    });
    return { ...step, status: ready ? 'ready' : 'planned' };
  });
}

function latestQueueControl(
  task: PhoneTaskV2,
): 'pause' | 'resume' | 'cancel' | undefined {
  for (let index = task.journal.length - 1; index >= 0; index -= 1) {
    const type = task.journal[index]?.type;
    if (type === 'queue_paused') return 'pause';
    if (type === 'queue_resumed') return 'resume';
    if (type === 'queue_cancellation_requested') return 'cancel';
  }
  return undefined;
}

export function isQueuePausedV2(task: PhoneTaskV2): boolean {
  return task.status === 'paused' || latestQueueControl(task) === 'pause';
}

export function isQueueCancellationRequestedV2(task: PhoneTaskV2): boolean {
  return latestQueueControl(task) === 'cancel';
}

function journalType(
  command: QueueEditCommandV2,
  outcome: QueueEditOutcomeV2,
): string {
  if (outcome === 'cancellation_requested') {
    return 'queue_cancellation_requested';
  }
  switch (command.command) {
    case 'pause':
      return 'queue_paused';
    case 'resume':
      return 'queue_resumed';
    case 'cancel':
      return 'queue_cancelled';
    default:
      return `queue_${command.command}`;
  }
}

function applyCommand(input: {
  at: number;
  command: QueueEditCommandV2;
  commandId: string;
  record: TaskRepositoryRecordV2;
}): {
  activeOperation?: TaskRecoveryOperationV2;
  outcome: QueueEditOutcomeV2;
  task: PhoneTaskV2;
} {
  const source = parsePhoneTaskV2(structuredClone(input.record.task));
  if (TERMINAL_TASK_STATUSES_V2.has(source.status)) {
    throw new InvalidPhoneTaskV2TransitionError(
      'A terminal task cannot be edited.',
    );
  }
  if (input.at < source.updatedAt) {
    throw new InvalidPhoneTaskV2TransitionError(
      'A queue edit cannot move task time backwards.',
    );
  }
  if (source.journal.length >= source.budgets.maxJournalEntries) {
    throw new InvalidPhoneTaskV2TransitionError(
      'Queue edit exceeds the task journal budget.',
    );
  }

  let steps = source.steps.map((step) => structuredClone(step));
  let status = source.status;
  let terminalAt = source.terminalAt;
  let pendingInteraction = source.pendingInteraction
    ? structuredClone(source.pendingInteraction)
    : undefined;
  let activeStepId = source.activeStepId;
  let outcome: QueueEditOutcomeV2 = 'updated';

  if (input.command.command === 'pause') {
    if (isQueuePausedV2(source) || isQueueCancellationRequestedV2(source)) {
      throw new InvalidPhoneTaskV2TransitionError(
        'The task is already paused or awaiting cancellation.',
      );
    }
    status = 'paused';
    outcome = 'paused';
  } else if (input.command.command === 'resume') {
    if (!isQueuePausedV2(source) || isQueueCancellationRequestedV2(source)) {
      throw new InvalidPhoneTaskV2TransitionError(
        'Only a paused task may resume.',
      );
    }
    status = pendingInteraction ? 'waiting_for_user' : 'active';
    outcome = 'resumed';
  } else if (input.command.command === 'cancel') {
    if (isQueueCancellationRequestedV2(source)) {
      throw new InvalidPhoneTaskV2TransitionError(
        'Task cancellation is already requested.',
      );
    }
    if (input.record.activeOperation) {
      status = 'paused';
      outcome = 'cancellation_requested';
    } else {
      status = 'cancelled';
      terminalAt = input.at;
      pendingInteraction = undefined;
      activeStepId = undefined;
      outcome = 'cancelled';
    }
  } else {
    if (source.status === 'paused' || isQueueCancellationRequestedV2(source)) {
      throw new InvalidPhoneTaskV2TransitionError(
        'Resume the task before editing its queue.',
      );
    }
    if (input.record.activeOperation) {
      throw new InvalidPhoneTaskV2TransitionError(
        'Future items cannot change while a phone operation is active.',
      );
    }
    if (input.command.command === 'refine') {
      const { index, step } = editableFutureStep(
        source,
        input.command.stepId,
      );
      steps[index] = {
        ...step,
        kind: 'search_products',
        input: {
          action: 'search_products',
          request: input.command.request,
          ...(input.command.quantity === undefined
            ? {}
            : { quantity: input.command.quantity }),
        },
        expectedPostcondition: { kind: 'product_options_observed' },
        attempts: 0,
        operationId: undefined,
        lastResultRef: undefined,
      };
    } else if (
      input.command.command === 'remove'
      || input.command.command === 'skip'
    ) {
      const { index, step } = editableFutureStep(
        source,
        input.command.stepId,
      );
      steps[index] = {
        ...step,
        status: 'skipped',
        lastResultRef: `${input.command.command}:${input.commandId}`,
      };
    } else {
      const ordered = input.command.orderedStepIds;
      if (ordered.length < 2 || new Set(ordered).size !== ordered.length) {
        throw new InvalidPhoneTaskV2TransitionError(
          'A reorder requires at least two unique future items.',
        );
      }
      const targets = ordered.map((stepId) =>
        editableFutureStep(source, stepId).step);
      const targetIds = new Set(ordered);
      const indices = ordered.map((stepId) =>
        source.steps.findIndex((step) => step.stepId === stepId));
      const sortedIndices = [...indices].sort((left, right) => left - right);
      const externalDependencies = [...new Set(
        targets.flatMap((step) =>
          step.dependsOn.filter((dependency) => !targetIds.has(dependency))),
      )];
      const rewired = targets.map((step, index) => ({
        ...step,
        dependsOn: [
          ...(index === 0 ? externalDependencies : []),
          ...(index === 0 ? [] : [ordered[index - 1]!]),
        ],
      }));
      for (let index = 0; index < sortedIndices.length; index += 1) {
        steps[sortedIndices[index]!] = rewired[index]!;
      }
    }
    steps = normalizeReadiness(steps);
  }

  const entry: TaskJournalEntryV2 = {
    entryId: queueEditJournalEntryIdV2(input.commandId),
    at: input.at,
    type: journalType(input.command, outcome),
    dataRef: queueEditDataRefV2(input.command),
    ...('stepId' in input.command
      ? { stepId: input.command.stepId }
      : {}),
    ...(input.record.activeOperation
      ? { operationId: input.record.activeOperation.operationId }
      : {}),
  };
  const task = parsePhoneTaskV2({
    ...source,
    revision: source.revision + 1,
    status,
    steps,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    ...(pendingInteraction
      ? {
          pendingInteraction: {
            ...pendingInteraction,
            taskRevision: source.revision + 1,
          },
        }
      : { pendingInteraction: undefined }),
    journal: [...source.journal, entry],
    updatedAt: input.at,
    ...(terminalAt === undefined ? { terminalAt: undefined } : { terminalAt }),
  });
  return {
    task,
    outcome,
    ...(input.record.activeOperation
      ? { activeOperation: structuredClone(input.record.activeOperation) }
      : {}),
  };
}

export async function commitQueueEditV2(input: {
  at: number;
  command: QueueEditCommandV2;
  commandId: string;
  expectedRevision: number;
  repository: PhoneTaskRepositoryV2;
  taskId: string;
}): Promise<QueueEditResultV2> {
  const current = await input.repository.getById(input.taskId);
  if (!current) throw new Error('Unknown task.');
  const prior = priorQueueEditV2(current.task, input);
  if (prior === 'duplicate') {
    return {
      commandId: input.commandId,
      outcome: current.task.status === 'cancelled'
        ? 'cancelled'
        : input.command.command === 'pause'
          ? 'paused'
          : input.command.command === 'resume'
            ? 'resumed'
            : input.command.command === 'cancel'
              ? 'cancellation_requested'
              : 'updated',
      record: current,
    };
  }
  if (prior === 'command_id_conflict') {
    throw new InvalidPhoneTaskV2TransitionError(
      'Queue command identifier was already used for another edit.',
    );
  }
  if (current.task.revision !== input.expectedRevision) {
    throw new TaskRevisionConflictV2Error(
      input.taskId,
      input.expectedRevision,
      current.task.revision,
    );
  }
  const applied = applyCommand({
    at: input.at,
    command: input.command,
    commandId: input.commandId,
    record: current,
  });
  const record = await input.repository.commit({
    expectedRevision: input.expectedRevision,
    task: applied.task,
    event: {
      eventId: queueEditJournalEntryIdV2(input.commandId),
      taskId: applied.task.taskId,
      taskRevision: applied.task.revision,
      at: input.at,
      kind: applied.task.journal.at(-1)!.type,
      dataRef: applied.task.journal.at(-1)!.dataRef,
    },
    ...(applied.activeOperation
      ? { activeOperation: applied.activeOperation }
      : {}),
  });
  return {
    commandId: input.commandId,
    outcome: applied.outcome,
    record,
  };
}
