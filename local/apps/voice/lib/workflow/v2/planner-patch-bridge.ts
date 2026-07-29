import type { LlmPlanPatchOperationV2 } from './planner-decision';
import { newLocalIdentifier } from '../identifiers';
import {
  applyModelPlanPatchV2,
  type ModelPlanPatchV2,
  type PlanPatchOperationV2,
} from './plan-patch';
import type { PhoneTaskStepV2, PhoneTaskV2 } from './contracts';
import type {
  PhoneTaskRepositoryV2,
  TaskRepositoryRecordV2,
} from './repository';

function productStep(
  stepId: string,
  request: string,
  quantity: number,
  dependsOn: string[],
): PhoneTaskStepV2 {
  return {
    stepId,
    adapterId: 'blinkit',
    kind: 'add_cart_item',
    status: 'planned',
    dependsOn,
    input: {
      action: 'add_cart_item',
      request,
      quantity,
    },
    expectedPostcondition: {
      kind: 'cart_contains_requested_quantity',
      request,
      quantity,
    },
    attempts: 0,
  };
}

function compileOperations(
  task: PhoneTaskV2,
  proposals: readonly LlmPlanPatchOperationV2[],
): PlanPatchOperationV2[] {
  let tailId = task.steps.at(-1)?.stepId;
  return proposals.map((proposal) => {
    if (proposal.type === 'add_product') {
      const stepId = newLocalIdentifier('task_item');
      const operation: PlanPatchOperationV2 = {
        type: 'add_step',
        step: productStep(
          stepId,
          proposal.request,
          proposal.quantity,
          proposal.beforeStepId
            ? task.steps.find(
                (step) => step.stepId === proposal.beforeStepId,
              )?.dependsOn ?? []
            : tailId
              ? [tailId]
              : [],
        ),
        ...(proposal.beforeStepId
          ? { beforeStepIds: [proposal.beforeStepId] }
          : {}),
      };
      tailId = stepId;
      return operation;
    }
    if (proposal.type === 'replace_product') {
      const { stepId: _ignored, ...replacement } = productStep(
        proposal.stepId,
        proposal.request,
        proposal.quantity,
        task.steps.find((step) => step.stepId === proposal.stepId)
          ?.dependsOn ?? [],
      );
      return {
        type: 'replace_step',
        stepId: proposal.stepId,
        replacement,
      };
    }
    if (proposal.type === 'skip_step') {
      return {
        type: 'skip_step',
        stepId: proposal.stepId,
        reasonRef: `planner-skip:${newLocalIdentifier('selection')}`,
      };
    }
    const stepId = `checkout:${newLocalIdentifier('operation')}`;
    const checkoutDependencies = [
      ...new Set([
        ...task.steps
          .filter((step) =>
            !['verified', 'skipped'].includes(step.status))
          .map((step) => step.stepId),
        ...(tailId ? [tailId] : []),
      ]),
    ];
    const operation: PlanPatchOperationV2 = {
      type: 'propose_checkout',
      step: {
        stepId,
        adapterId: 'blinkit',
        kind: 'review_checkout',
        status: 'planned',
        dependsOn: checkoutDependencies,
        input: {
          action: 'prepare_checkout',
          paymentPreference: proposal.paymentPreference ?? 'ask_user',
        },
        expectedPostcondition: { kind: 'checkout_terms_observed' },
        attempts: 0,
      },
    };
    tailId = stepId;
    return operation;
  });
}

export async function applyLlmPlanPatchesV2(input: {
  proposals: readonly LlmPlanPatchOperationV2[];
  repository: PhoneTaskRepositoryV2;
  task: PhoneTaskV2;
  now?: number;
}): Promise<TaskRepositoryRecordV2> {
  if (input.proposals.length === 0) {
    throw new Error('Cannot apply an empty LLM plan patch.');
  }
  const at = Math.max(input.now ?? Date.now(), input.task.updatedAt);
  const patchId = `patch:${newLocalIdentifier('operation')}`;
  const patch: ModelPlanPatchV2 = {
    version: 2,
    patchId,
    taskId: input.task.taskId,
    baseRevision: input.task.revision,
    reasonRef: `planner-decision:${input.task.revision}`,
    proposedAt: at,
    operations: compileOperations(input.task, input.proposals),
  };
  const next = applyModelPlanPatchV2({
    task: input.task,
    patch,
    appliedAt: at,
    journalEntryId: `plan-patch:${newLocalIdentifier('operation')}`,
  });
  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId: `plan-patch:${patchId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'model_plan_patch',
      dataRef: patchId,
    },
  });
}
