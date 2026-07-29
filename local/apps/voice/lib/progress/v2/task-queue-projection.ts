import {
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskStepV2,
} from '../../workflow/v2/contracts';
import {
  isQueueCancellationRequestedV2,
  isQueuePausedV2,
} from '../../workflow/v2/queue-editing';
import type { TaskRepositoryRecordV2 } from '../../workflow/v2/repository';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import type {
  AuthoritativeTaskQueueProjectionV2,
  QueueItemCapabilityIdV2,
  QueueTaskCapabilityIdV2,
} from './contracts';

const QUEUE_ITEM_KINDS = new Set(['add_cart_item', 'search_products']);
const EDITABLE_STATUSES = new Set(['planned', 'ready']);
const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function editableFutureStep(
  record: TaskRepositoryRecordV2,
  step: PhoneTaskStepV2,
): boolean {
  return (
    QUEUE_ITEM_KINDS.has(step.kind)
    && EDITABLE_STATUSES.has(step.status)
    && step.operationId === undefined
    && record.task.activeStepId !== step.stepId
  );
}

function validRecordIdentity(record: TaskRepositoryRecordV2): boolean {
  const { activeOperation, task } = record;
  if (
    task.steps.length > task.budgets.maxSteps
    || task.steps.length > 50
    || task.steps.some((step) => !STEP_ID_PATTERN.test(step.stepId))
    || (
      task.activeStepId !== undefined
      && !task.steps.some((step) => step.stepId === task.activeStepId)
    )
  ) {
    return false;
  }
  if (!activeOperation) return true;
  const operationStep = task.steps.find(
    (step) => step.stepId === activeOperation.stepId,
  );
  return (
    activeOperation.taskId === task.taskId
    && task.activeStepId === activeOperation.stepId
    && operationStep !== undefined
    && operationStep.operationId === activeOperation.operationId
  );
}

/**
 * Derives the queue control surface from one authoritative repository record.
 * An identity mismatch fails closed by returning no projection.
 */
export function authoritativeTaskQueueProjectionV2(
  record: TaskRepositoryRecordV2,
): AuthoritativeTaskQueueProjectionV2 | undefined {
  if (!validRecordIdentity(record)) return undefined;
  const { task } = record;
  let taskId;
  try {
    taskId = parseLocalIdentifier('task', task.taskId);
  } catch {
    return undefined;
  }
  const terminal = TERMINAL_TASK_STATUSES_V2.has(task.status);
  const cancellationRequested = isQueueCancellationRequestedV2(task);
  const paused = isQueuePausedV2(task);
  const queueEditable =
    !terminal
    && !paused
    && !cancellationRequested
    && record.activeOperation === undefined;
  const editable = queueEditable
    ? task.steps.filter((step) => editableFutureStep(record, step))
    : [];
  const editableIndex = new Map(
    editable.map((step, index) => [step.stepId, index]),
  );

  const taskCapabilities: QueueTaskCapabilityIdV2[] = [];
  if (!terminal && !cancellationRequested) {
    taskCapabilities.push(paused ? 'resume' : 'pause');
    taskCapabilities.push('cancel');
  }

  return {
    version: 2,
    taskId,
    revision: task.revision,
    status: task.status,
    ...(task.activeStepId ? { activeStepId: task.activeStepId } : {}),
    inFlight: record.activeOperation !== undefined,
    capabilities: taskCapabilities,
    steps: task.steps.map((step) => {
      const index = editableIndex.get(step.stepId);
      const capabilities: QueueItemCapabilityIdV2[] = [];
      if (index !== undefined) {
        capabilities.push('refine', 'remove', 'skip');
        if (index > 0) capabilities.push('move_up');
        if (index < editable.length - 1) capabilities.push('move_down');
      }
      return {
        stepId: step.stepId,
        kind: step.kind,
        status: step.status,
        capabilities,
      };
    }),
  };
}
