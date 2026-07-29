import {
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskV2,
} from './contracts';
import { parsePhoneTaskV2 } from './validation';

export type IncomingTaskTurnV2 =
  | {
    kind: 'clarification_answer';
    interactionId: string;
    taskRevision: number;
    responseRef: string;
  }
  | {
    kind: 'correction';
    targetStepId: string;
    correctionRef: string;
  }
  | {
    kind: 'addition';
    additionRef: string;
  }
  | {
    kind: 'unrelated_task';
    replacementGoalRef: string;
  }
  | {
    kind: 'start_over';
  };

export type TaskTurnDispositionV2 =
  | {
    action: 'resolve_interaction';
    interactionId: string;
    responseRef: string;
  }
  | {
    action: 'patch_existing';
    patchKind: 'addition' | 'correction';
    patchRef: string;
    targetStepId?: string;
  }
  | {
    action: 'replace_task';
    reason: 'unrelated_task';
    replacementGoalRef: string;
  }
  | {
    action: 'cancel_task';
    reason: 'start_over';
  }
  | {
    action: 'reject';
    reason:
      | 'no_pending_interaction'
      | 'reconciliation_required'
      | 'stale_interaction'
      | 'terminal_task'
      | 'unknown_correction_target';
  };

export function hasUnresolvedMutationV2(taskValue: PhoneTaskV2): boolean {
  const task = parsePhoneTaskV2(taskValue);
  return (
    ['waiting_for_phone', 'ambiguous'].includes(task.status)
    || task.steps.some((step) =>
      ['running', 'ambiguous'].includes(step.status)
      || (step.status === 'blocked' && Boolean(step.operationId)))
    || task.verifiedFacts.some((fact) =>
      fact.confidence === 'reconciliation_required')
  );
}

export function classifyIncomingTaskTurnV2(
  taskValue: PhoneTaskV2,
  turn: IncomingTaskTurnV2,
): TaskTurnDispositionV2 {
  const task = parsePhoneTaskV2(structuredClone(taskValue));
  if (turn.kind === 'clarification_answer') {
    if (!task.pendingInteraction) {
      return { action: 'reject', reason: 'no_pending_interaction' };
    }
    if (
      task.pendingInteraction.interactionId !== turn.interactionId
      || task.pendingInteraction.taskRevision !== turn.taskRevision
    ) {
      return { action: 'reject', reason: 'stale_interaction' };
    }
    return {
      action: 'resolve_interaction',
      interactionId: turn.interactionId,
      responseRef: turn.responseRef,
    };
  }

  if (TERMINAL_TASK_STATUSES_V2.has(task.status)) {
    return { action: 'reject', reason: 'terminal_task' };
  }
  if (hasUnresolvedMutationV2(task)) {
    return { action: 'reject', reason: 'reconciliation_required' };
  }
  if (turn.kind === 'correction') {
    if (!task.steps.some((step) => step.stepId === turn.targetStepId)) {
      return { action: 'reject', reason: 'unknown_correction_target' };
    }
    return {
      action: 'patch_existing',
      patchKind: 'correction',
      patchRef: turn.correctionRef,
      targetStepId: turn.targetStepId,
    };
  }
  if (turn.kind === 'addition') {
    return {
      action: 'patch_existing',
      patchKind: 'addition',
      patchRef: turn.additionRef,
    };
  }
  if (turn.kind === 'start_over') {
    return { action: 'cancel_task', reason: 'start_over' };
  }
  return {
    action: 'replace_task',
    reason: 'unrelated_task',
    replacementGoalRef: turn.replacementGoalRef,
  };
}
