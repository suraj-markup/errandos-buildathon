import {
  newLocalIdentifier,
  type LocalIdentifier,
} from '../identifiers';
import type {
  PhoneTaskStepV2,
  PhoneTaskV2,
} from './contracts';
import {
  eligibleStepIdsV2,
  transitionPhoneTaskV2,
} from './graph';
import {
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import {
  buildNextActionStepV2,
  settleReadyNextActionV2,
} from './next-action-lifecycle';

const FINAL_CART_STEP_ID = 'step:automatic-final-cart-inspection';
const NEXT_ACTION_STEP_ID = 'step:automatic-next-action';
const PRODUCT_STEP_KINDS = new Set([
  'add_cart_item',
  'search_products',
  'set_cart_item_quantity',
  'remove_cart_item',
]);
const STOP_STEP_KINDS = new Set([
  'await_final_confirmation',
  'checkout',
  'confirm_checkout',
  'inspect_checkout',
  'prepare_checkout_proposal',
  'review_checkout',
]);
const PRODUCT_OUTCOMES = new Set([
  'ask_next',
  'cart_ready',
  'checkout_reviewed',
  'order_placed',
]);

type JsonRecord = Record<string, unknown>;

export type NextStepEnqueueInputV2 = {
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  stepId: string;
  requestPayload: {
    version: 1;
    action: JsonRecord & { action: string };
  };
};

export type NextStepEnqueueV2 = (
  input: NextStepEnqueueInputV2,
) => Promise<unknown>;

export type NextStepDispatchResultV2 =
  | { disposition: 'dispatched' | 'resumed'; record: TaskRepositoryRecordV2 }
  | {
    disposition:
      | 'missing'
      | 'terminal'
      | 'waiting'
      | 'blocked'
      | 'checkout_boundary'
      | 'no_dispatchable_step';
    record?: TaskRepositoryRecordV2;
  };

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function exactOffer(input: JsonRecord): boolean {
  return (
    typeof input['offerId'] === 'string'
    && input['offerId'].trim().length > 0
    && record(input['selectedOffer'])['offerId'] === input['offerId']
  );
}

function broadAdd(step: PhoneTaskStepV2): boolean {
  const input = record(step.input);
  return (
    step.kind === 'add_cart_item'
    && input['action'] === 'add_cart_item'
    && !exactOffer(input)
  );
}

function requestPayload(step: PhoneTaskStepV2): NextStepEnqueueInputV2['requestPayload'] {
  const input = structuredClone(record(step.input));
  if (step.kind === 'search_products') {
    const request = input['request'];
    if (typeof request !== 'string' || request.trim().length === 0) {
      throw new Error(`Search step ${step.stepId} has no product request.`);
    }
    return {
      version: 1,
      action: {
        action: 'search_products',
        request: request.trim(),
      },
    };
  }
  if (step.kind === 'inspect_cart') {
    return { version: 1, action: { action: 'inspect_cart' } };
  }
  if (
    step.kind === 'add_cart_item'
    && input['action'] === 'add_cart_item'
    && exactOffer(input)
  ) {
    return { version: 1, action: input as JsonRecord & { action: string } };
  }
  if (
    ['set_cart_item_quantity', 'remove_cart_item'].includes(step.kind)
    && input['action'] === step.kind
  ) {
    return { version: 1, action: input as JsonRecord & { action: string } };
  }
  throw new Error(`Step ${step.stepId} is not safely dispatchable.`);
}

function hasStopState(task: PhoneTaskV2): boolean {
  return (
    Boolean(task.pendingInteraction)
    || ['paused', 'waiting_for_user', 'waiting_for_phone'].includes(task.status)
    || task.steps.some((step) =>
      ['waiting_for_user', 'failed', 'ambiguous', 'blocked']
        .includes(step.status))
  );
}

function finalCartStep(task: PhoneTaskV2): PhoneTaskStepV2 {
  const products = task.steps.filter((step) =>
    PRODUCT_STEP_KINDS.has(step.kind));
  return {
    stepId: FINAL_CART_STEP_ID,
    adapterId: 'blinkit',
    kind: 'inspect_cart',
    status: products.every((step) =>
      ['verified', 'skipped'].includes(step.status))
      ? 'ready'
      : 'planned',
    dependsOn: products.map((step) => step.stepId),
    input: { action: 'inspect_cart' },
    expectedPostcondition: { kind: 'cart_contents_observed' },
    attempts: 0,
  };
}

function checkoutAvailableAfterInspection(task: PhoneTaskV2): boolean {
  const inspection = task.steps.findLast((step) =>
    step.kind === 'inspect_cart' && step.status === 'verified');
  return Boolean(
    inspection?.lastResultRef
    && !inspection.lastResultRef.endsWith(':cart_empty'),
  );
}

/**
 * Adds the read-only final inspection and its authoritative user decision.
 * Calling this repeatedly is safe and returns an unchanged clone once attached.
 */
export function attachAutomaticFinalCartInspectionV2(
  source: PhoneTaskV2,
): PhoneTaskV2 {
  const task = structuredClone(source);
  if (
    !PRODUCT_OUTCOMES.has(task.desiredTerminalOutcome?.kind ?? '')
    || !task.steps.some((step) => PRODUCT_STEP_KINDS.has(step.kind))
  ) {
    return task;
  }
  const existingInspection = task.steps.find((step) =>
    step.stepId === FINAL_CART_STEP_ID);
  const existingNextAction = task.steps.find((step) =>
    step.kind === 'ask_next');
  if (existingInspection && existingNextAction) return task;
  const additions =
    (existingInspection ? 0 : 1) + (existingNextAction ? 0 : 1);
  if (task.steps.length + additions > task.budgets.maxSteps) {
    throw new Error('Automatic cart completion exceeds the step budget.');
  }
  const inspection = existingInspection ?? finalCartStep(task);
  const nextAction = existingNextAction ?? buildNextActionStepV2({
    adapterId: inspection.adapterId,
    dependsOn: [inspection.stepId],
    stepId: NEXT_ACTION_STEP_ID,
  });
  if (existingNextAction) {
    existingNextAction.dependsOn = [...new Set([
      ...existingNextAction.dependsOn,
      inspection.stepId,
    ])];
    if (['planned', 'ready'].includes(existingNextAction.status)) {
      existingNextAction.status = 'planned';
    }
  }
  const boundaryIndex = task.steps.findIndex((step) =>
    STOP_STEP_KINDS.has(step.kind));
  if (!existingInspection && boundaryIndex < 0) {
    task.steps.push(inspection);
  } else if (!existingInspection) {
    task.steps.splice(boundaryIndex, 0, inspection);
  }
  const nextBoundaryIndex = task.steps.findIndex((step) =>
    STOP_STEP_KINDS.has(step.kind));
  if (!existingNextAction && nextBoundaryIndex < 0) {
    task.steps.push(nextAction);
  } else if (!existingNextAction) {
    task.steps.splice(nextBoundaryIndex, 0, nextAction);
  }
  if (nextBoundaryIndex >= 0) {
    const nextActionIndex = task.steps.findIndex((step) =>
      step.stepId === nextAction.stepId);
    for (let index = nextActionIndex + 1; index < task.steps.length; index += 1) {
      const step = task.steps[index]!;
      if (STOP_STEP_KINDS.has(step.kind)) {
        step.dependsOn = [...new Set([
          ...step.dependsOn,
          nextAction.stepId,
        ])];
      }
    }
  }
  if (task.status === 'completed') {
    task.status = 'active';
    task.terminalAt = undefined;
  }
  return task;
}

export class DurableNextStepDispatcherV2 {
  constructor(private readonly options: {
    enqueue: NextStepEnqueueV2;
    newInteractionId?: () => string;
    newOperationId?: () => LocalIdentifier<'operation'>;
    now?: () => number;
    repository: PhoneTaskRepositoryV2;
  }) {}

  async dispatch(taskId: string): Promise<NextStepDispatchResultV2> {
    for (let conflictAttempts = 0; conflictAttempts < 4; conflictAttempts += 1) {
      let current = await this.options.repository.getById(taskId);
      if (!current) return { disposition: 'missing' };
      let task = current.task;
      if (
        task.status === 'completed'
        && PRODUCT_OUTCOMES.has(task.desiredTerminalOutcome?.kind ?? '')
        && task.steps.some((step) => PRODUCT_STEP_KINDS.has(step.kind))
        && !task.steps.some((step) => step.kind === 'inspect_cart')
      ) {
        const at = Math.max(
          this.options.now?.() ?? Date.now(),
          task.updatedAt,
        );
        const reopened = attachAutomaticFinalCartInspectionV2(task);
        reopened.revision = task.revision + 1;
        reopened.updatedAt = at;
        reopened.journal.push({
          entryId: `automatic-final-cart-attached:${reopened.revision}`,
          at,
          type: 'automatic_final_cart_attached',
          stepId: FINAL_CART_STEP_ID,
        });
        try {
          const committed = await this.options.repository.commit({
            expectedRevision: task.revision,
            task: reopened,
            event: {
              eventId: `automatic-final-cart-attached:${reopened.revision}`,
              taskId: reopened.taskId,
              taskRevision: reopened.revision,
              at,
              kind: 'automatic_final_cart_attached',
              dataRef: FINAL_CART_STEP_ID,
            },
          });
          current = committed;
          task = committed.task;
        } catch (error) {
          if (error instanceof TaskRevisionConflictV2Error) continue;
          throw error;
        }
      }
      if (['completed', 'cancelled'].includes(task.status)) {
        return { disposition: 'terminal', record: current };
      }
      if (
        task.status === 'blocked'
        || task.status === 'ambiguous'
        || task.steps.some((step) =>
          ['blocked', 'ambiguous'].includes(step.status))
      ) {
        return { disposition: 'blocked', record: current };
      }
      if (hasStopState(task)) {
        return { disposition: 'waiting', record: current };
      }

      if (current.activeOperation) {
        const running = task.steps.find((step) =>
          step.stepId === current.activeOperation?.stepId
          && step.status === 'running'
          && step.operationId === current.activeOperation?.operationId);
        if (!running) {
          return { disposition: 'waiting', record: current };
        }
        await this.options.enqueue({
          operationId: current.activeOperation.operationId as LocalIdentifier<'operation'>,
          taskId: task.taskId as LocalIdentifier<'task'>,
          taskRevision: task.revision,
          stepId: running.stepId,
          requestPayload: requestPayload(running),
        });
        return { disposition: 'resumed', record: current };
      }

      const eligible = new Set(eligibleStepIdsV2(task));
      const step = task.steps.find((candidate) =>
        candidate.status === 'ready' && eligible.has(candidate.stepId));
      if (!step) {
        return { disposition: 'no_dispatchable_step', record: current };
      }
      if (step.kind === 'ask_next') {
        const at = Math.max(
          this.options.now?.() ?? Date.now(),
          task.updatedAt,
        );
        const interactionId = this.options.newInteractionId?.()
          ?? `interaction_${crypto.randomUUID()}`;
        const waiting = settleReadyNextActionV2({
          at,
          checkoutAvailable: checkoutAvailableAfterInspection(task),
          expiresAt: at + 15 * 60_000,
          interactionId,
          journalEntryId:
            `automatic-next-action:${task.revision + 1}:${interactionId}`,
          presentationRef:
            `presentation:next-action:${task.revision + 1}`,
          task,
        });
        try {
          const committed = await this.options.repository.commit({
            expectedRevision: task.revision,
            task: waiting,
            event: {
              eventId:
                `automatic-next-action:${waiting.revision}:${interactionId}`,
              taskId: waiting.taskId,
              taskRevision: waiting.revision,
              at,
              kind: 'waiting_for_next_action',
              dataRef: interactionId,
            },
          });
          return { disposition: 'waiting', record: committed };
        } catch (error) {
          if (error instanceof TaskRevisionConflictV2Error) continue;
          throw error;
        }
      }
      if (STOP_STEP_KINDS.has(step.kind)) {
        return { disposition: 'checkout_boundary', record: current };
      }

      if (broadAdd(step)) {
        const at = Math.max(
          this.options.now?.() ?? Date.now(),
          task.updatedAt,
        );
        const next = transitionPhoneTaskV2(task, {
          type: 'replace_step',
          stepId: step.stepId,
          replacement: {
            ...step,
            kind: 'search_products',
          },
          entryId: `automatic-search:${task.revision + 1}:${step.stepId}`,
          at,
        });
        try {
          await this.options.repository.commit({
            expectedRevision: task.revision,
            task: next,
            event: {
              eventId: `automatic-search:${next.revision}:${step.stepId}`,
              taskId: next.taskId,
              taskRevision: next.revision,
              at,
              kind: 'automatic_search_prepared',
              dataRef: step.stepId,
            },
          });
          continue;
        } catch (error) {
          if (error instanceof TaskRevisionConflictV2Error) continue;
          throw error;
        }
      }

      if (
        !PRODUCT_STEP_KINDS.has(step.kind)
        && step.kind !== 'inspect_cart'
      ) {
        return { disposition: 'no_dispatchable_step', record: current };
      }

      const operationId = this.options.newOperationId?.()
        ?? newLocalIdentifier('operation');
      const at = Math.max(this.options.now?.() ?? Date.now(), task.updatedAt);
      const next = transitionPhoneTaskV2(task, {
        type: 'begin_step',
        stepId: step.stepId,
        operationId,
        entryId: `automatic-dispatch:${operationId}`,
        at,
      });
      let claimed: TaskRepositoryRecordV2;
      try {
        claimed = await this.options.repository.commit({
          expectedRevision: task.revision,
          task: next,
          event: {
            eventId: `automatic-dispatch:${operationId}`,
            taskId: next.taskId,
            taskRevision: next.revision,
            at,
            kind: 'automatic_step_dispatched',
            dataRef: step.stepId,
          },
          activeOperation: {
            operationId,
            taskId: next.taskId,
            stepId: step.stepId,
            kind: step.kind,
            boundary: 'before_mutation',
            status: 'running',
            updatedAt: at,
          },
        });
      } catch (error) {
        if (error instanceof TaskRevisionConflictV2Error) continue;
        throw error;
      }
      await this.options.enqueue({
        operationId,
        taskId: claimed.task.taskId as LocalIdentifier<'task'>,
        taskRevision: claimed.task.revision,
        stepId: step.stepId,
        requestPayload: requestPayload(
          claimed.task.steps.find((candidate) =>
            candidate.stepId === step.stepId)!,
        ),
      });
      return { disposition: 'dispatched', record: claimed };
    }
    return { disposition: 'waiting' };
  }
}
