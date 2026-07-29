import type {
  NextActionChoiceV2,
  PhoneTaskStepV2,
  PhoneTaskV2,
} from './contracts';
import { transitionPhoneTaskV2 } from './graph';
import type {
  PhoneTaskRepositoryV2,
  TaskRepositoryRecordV2,
} from './repository';

export function nextActionAllowedResponsesV2(
  checkoutAvailable: boolean,
): NextActionChoiceV2[] {
  return [
    'review_cart',
    'add_more',
    ...(checkoutAvailable ? ['review_checkout' as const] : []),
    'stop',
  ];
}

export function buildNextActionStepV2(input: {
  adapterId: string;
  dependsOn: string[];
  stepId: string;
}): PhoneTaskStepV2 {
  return {
    stepId: input.stepId,
    adapterId: input.adapterId,
    kind: 'ask_next',
    status: 'planned',
    dependsOn: [...input.dependsOn],
    input: {
      choices: [
        'review_cart',
        'add_more',
        'review_checkout',
        'stop',
      ],
    },
    expectedPostcondition: { kind: 'next_action_selected' },
    attempts: 0,
  };
}

export function settleReadyNextActionV2(input: {
  at: number;
  checkoutAvailable: boolean;
  expiresAt: number;
  interactionId: string;
  journalEntryId: string;
  presentationRef: string;
  task: PhoneTaskV2;
}): PhoneTaskV2 {
  const step = input.task.steps.find((candidate) =>
    candidate.kind === 'ask_next' && candidate.status === 'ready');
  if (!step) return input.task;
  return transitionPhoneTaskV2(input.task, {
    type: 'wait_for_user',
    stepId: step.stepId,
    at: Math.max(input.at, input.task.updatedAt),
    entryId: input.journalEntryId,
    interaction: {
      interactionId: input.interactionId,
      taskId: input.task.taskId,
      taskRevision: input.task.revision + 1,
      kind: 'next_action',
      allowedResponses: nextActionAllowedResponsesV2(
        input.checkoutAvailable,
      ),
      presentationRef: input.presentationRef,
      status: 'open',
      createdAt: Math.max(input.at, input.task.updatedAt),
      expiresAt: input.expiresAt,
    },
  });
}

export async function resolveNextActionChoiceV2(input: {
  at: number;
  choice: NextActionChoiceV2;
  continuationStepId?: string;
  repository: PhoneTaskRepositoryV2;
  responseRef: string;
  task: PhoneTaskV2;
}): Promise<TaskRepositoryRecordV2> {
  const interaction = input.task.pendingInteraction;
  if (!interaction || interaction.kind !== 'next_action') {
    throw new Error('The task has no next-action interaction to resolve.');
  }
  const at = Math.max(input.at, input.task.updatedAt);
  const next = transitionPhoneTaskV2(input.task, {
    type: 'resolve_next_action',
    interactionId: interaction.interactionId,
    responseRef: input.responseRef,
    choice: input.choice,
    ...(input.continuationStepId
      ? { continuationStepId: input.continuationStepId }
      : {}),
    entryId:
      `interaction-resolved:${interaction.interactionId}:${input.task.revision + 1}`,
    at,
  });
  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId:
        `interaction-resolved:${interaction.interactionId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'interaction_resolved',
      dataRef: input.responseRef,
    },
  });
}
