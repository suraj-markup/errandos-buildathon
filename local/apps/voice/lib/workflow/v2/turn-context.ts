import { randomUUID } from 'node:crypto';
import {
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskV2,
  type TaskTurnContextV2,
} from './contracts';
import type {
  PhoneTaskRepositoryV2,
  TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export type ProductChoiceContinuationV2 = {
  taskId: string;
  taskRevision: number;
  interactionId: string;
  expiresAt: number;
  languageCode: string;
  responseId?: string;
  allowedResponses: unknown;
  stepInput: unknown;
};

export function productChoiceContinuationV2(
  task: PhoneTaskV2,
): ProductChoiceContinuationV2 | undefined {
  const interaction = task.pendingInteraction;
  if (
    task.status !== 'waiting_for_user'
    || interaction?.kind !== 'product_choice'
    || interaction.status !== 'open'
    || !task.turnContext
    || !task.activeStepId
  ) {
    return undefined;
  }
  const step = task.steps.find(({ stepId }) => stepId === task.activeStepId);
  if (!step || step.status !== 'waiting_for_user') return undefined;
  return {
    taskId: task.taskId,
    taskRevision: task.revision,
    interactionId: interaction.interactionId,
    expiresAt: interaction.expiresAt,
    languageCode: task.turnContext.languageCode,
    ...(task.turnContext.responseId
      ? { responseId: task.turnContext.responseId }
      : {}),
    allowedResponses: structuredClone(interaction.allowedResponses),
    stepInput: structuredClone(step.input),
  };
}

export function updateTaskTurnContextV2(
  source: PhoneTaskV2,
  input: TaskTurnContextV2 & { entryId: string },
): PhoneTaskV2 {
  const task = parsePhoneTaskV2(structuredClone(source));
  if (TERMINAL_TASK_STATUSES_V2.has(task.status)) {
    throw new Error('Terminal task turn context cannot be updated.');
  }
  if (input.updatedAt < task.updatedAt) {
    throw new Error('Task turn context cannot move time backwards.');
  }
  if (task.journal.some(({ entryId }) => entryId === input.entryId)) {
    throw new Error('Task turn context entry already exists.');
  }
  if (task.journal.length >= task.budgets.maxJournalEntries) {
    throw new Error('Task turn context exceeds the journal budget.');
  }
  const revision = task.revision + 1;
  return parsePhoneTaskV2({
    ...task,
    revision,
    ...(task.pendingInteraction
      ? {
        pendingInteraction: {
          ...task.pendingInteraction,
          taskRevision: revision,
        },
      }
      : {}),
    turnContext: {
      languageCode: input.languageCode,
      ...(input.responseId ? { responseId: input.responseId } : {}),
      updatedAt: input.updatedAt,
    },
    journal: [...task.journal, {
      entryId: input.entryId,
      at: input.updatedAt,
      type: 'turn_context_updated',
    }],
    updatedAt: input.updatedAt,
  });
}

export async function commitTaskTurnContextV2(input: {
  repository: PhoneTaskRepositoryV2;
  record: TaskRepositoryRecordV2;
  languageCode: string;
  responseId?: string;
  at?: number;
  entryId?: string;
}): Promise<TaskRepositoryRecordV2> {
  const at = input.at ?? Date.now();
  const entryId =
    input.entryId
    ?? `turn_context:${input.record.task.taskId}:${randomUUID()}`;
  const task = updateTaskTurnContextV2(input.record.task, {
    entryId,
    languageCode: input.languageCode,
    ...(input.responseId ? { responseId: input.responseId } : {}),
    updatedAt: at,
  });
  return input.repository.commit({
    expectedRevision: input.record.task.revision,
    task,
    event: {
      eventId: entryId,
      taskId: task.taskId,
      taskRevision: task.revision,
      at,
      kind: 'turn_context_updated',
    },
    ...(input.record.activeOperation
      ? { activeOperation: input.record.activeOperation }
      : {}),
  });
}
