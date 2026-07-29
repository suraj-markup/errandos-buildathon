import {
  TERMINAL_STEP_STATUSES_V2,
  TERMINAL_TASK_STATUSES_V2,
  type PendingInteractionV2,
  type NextActionChoiceV2,
  type PhoneTaskStepV2,
  type PhoneTaskV2,
  type TaskJournalEntryV2,
} from './contracts';
import { parsePhoneTaskV2 } from './validation';

export class InvalidPhoneTaskV2TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPhoneTaskV2TransitionError';
  }
}

type EventBase = {
  at: number;
  entryId: string;
  dataRef?: string;
};

export type PhoneTaskEventV2 =
  | (EventBase & {
    type: 'begin_step';
    stepId: string;
    operationId: string;
  })
  | (EventBase & {
    type: 'verify_step';
    stepId: string;
    resultRef: string;
  })
  | (EventBase & {
    type: 'wait_for_user';
    stepId: string;
    interaction: PendingInteractionV2;
  })
  | (EventBase & {
    type: 'resolve_interaction';
    interactionId: string;
    responseRef: string;
    resolvedStepInput?: unknown;
  })
  | (EventBase & {
    type: 'resolve_next_action';
    interactionId: string;
    responseRef: string;
    choice: NextActionChoiceV2;
    continuationStepId?: string;
  })
  | (EventBase & {
    type: 'replace_step';
    stepId: string;
    replacement: Omit<PhoneTaskStepV2, 'stepId'>;
  })
  | (EventBase & {
    type: 'skip_step';
    stepId: string;
  })
  | (EventBase & {
    type: 'correct_verified_step';
    stepId: string;
    correction: PhoneTaskStepV2;
  })
  | (EventBase & {
    type: 'retry_step';
    stepId: string;
  })
  | (EventBase & {
    type: 'fail_step';
    stepId: string;
    resultRef: string;
  })
  | (EventBase & {
    type: 'block_step';
    stepId: string;
    resultRef: string;
  })
  | (EventBase & {
    type: 'mark_ambiguous';
    stepId: string;
    resultRef: string;
  })
  | (EventBase & {
    type: 'cancel_task';
  });

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertVerifiedStepsImmutable(
  previous: PhoneTaskV2,
  next: PhoneTaskV2,
): void {
  const nextById = new Map(next.steps.map((step) => [step.stepId, step]));
  for (const previousStep of previous.steps) {
    if (previousStep.status !== 'verified') continue;
    if (!sameValue(previousStep, nextById.get(previousStep.stepId))) {
      throw new InvalidPhoneTaskV2TransitionError(
        `Verified step ${previousStep.stepId} is immutable.`,
      );
    }
  }
}

function dependenciesSatisfied(
  step: PhoneTaskStepV2,
  byId: ReadonlyMap<string, PhoneTaskStepV2>,
): boolean {
  return step.dependsOn.every((dependency) => {
    const dependencyStep = byId.get(dependency);
    return dependencyStep
      ? TERMINAL_STEP_STATUSES_V2.has(dependencyStep.status)
      : false;
  });
}

export function eligibleStepIdsV2(task: PhoneTaskV2): string[] {
  const byId = new Map(task.steps.map((step) => [step.stepId, step]));
  return task.steps
    .filter(
      (step) =>
        ['planned', 'ready'].includes(step.status)
        && dependenciesSatisfied(step, byId),
    )
    .map((step) => step.stepId);
}

function normalizeReadiness(steps: PhoneTaskStepV2[]): PhoneTaskStepV2[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return steps.map((step) => {
    if (!['planned', 'ready'].includes(step.status)) return step;
    return {
      ...step,
      status: dependenciesSatisfied(step, byId) ? 'ready' : 'planned',
    };
  });
}

function eventJournal(event: PhoneTaskEventV2): TaskJournalEntryV2 {
  const stepId = 'stepId' in event ? event.stepId : undefined;
  const operationId = event.type === 'begin_step'
    ? event.operationId
    : undefined;
  const dataRef = (
    event.type === 'resolve_interaction'
    || event.type === 'resolve_next_action'
  )
    ? event.responseRef
    : event.dataRef;
  return {
    entryId: event.entryId,
    at: event.at,
    type: event.type === 'resolve_next_action'
      ? 'resolve_interaction'
      : event.type,
    ...(stepId ? { stepId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(dataRef ? { dataRef } : {}),
  };
}

function requireStep(
  task: PhoneTaskV2,
  stepId: string,
): { index: number; step: PhoneTaskStepV2 } {
  const index = task.steps.findIndex((step) => step.stepId === stepId);
  const step = task.steps[index];
  if (index < 0 || !step) {
    throw new InvalidPhoneTaskV2TransitionError(`Unknown step ${stepId}.`);
  }
  return { index, step };
}

function requireStatus(
  step: PhoneTaskStepV2,
  allowed: readonly PhoneTaskStepV2['status'][],
): void {
  if (!allowed.includes(step.status)) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Step ${step.stepId} cannot transition from ${step.status}.`,
    );
  }
}

function replaceAt(
  steps: PhoneTaskStepV2[],
  index: number,
  step: PhoneTaskStepV2,
): void {
  steps[index] = step;
}

function clearInteractionForStep(
  task: PhoneTaskV2,
  stepId: string,
): PendingInteractionV2 | undefined {
  return task.activeStepId === stepId ? undefined : task.pendingInteraction;
}

export function transitionPhoneTaskV2(
  source: PhoneTaskV2,
  event: PhoneTaskEventV2,
): PhoneTaskV2 {
  const task = parsePhoneTaskV2(structuredClone(source));
  if (TERMINAL_TASK_STATUSES_V2.has(task.status)) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Terminal task ${task.taskId} cannot transition.`,
    );
  }
  if (event.at < task.updatedAt) {
    throw new InvalidPhoneTaskV2TransitionError(
      'A transition cannot move task time backwards.',
    );
  }
  if (task.journal.some((entry) => entry.entryId === event.entryId)) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Journal entry ${event.entryId} already exists.`,
    );
  }
  if (task.journal.length >= task.budgets.maxJournalEntries) {
    throw new InvalidPhoneTaskV2TransitionError('Task journal budget is exhausted.');
  }

  let steps = task.steps.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  let pendingInteraction = task.pendingInteraction
    ? structuredClone(task.pendingInteraction)
    : undefined;
  let activeStepId = task.activeStepId;
  let forcedTaskStatus: PhoneTaskV2['status'] | undefined;
  let keepActiveWhenAllFinished = false;

  if (event.type === 'cancel_task') {
    forcedTaskStatus = 'cancelled';
    pendingInteraction = undefined;
    activeStepId = undefined;
  } else if (
    event.type === 'resolve_interaction'
    || event.type === 'resolve_next_action'
  ) {
    if (
      !pendingInteraction
      || pendingInteraction.interactionId !== event.interactionId
      || !['open', 'resolving'].includes(pendingInteraction.status)
    ) {
      throw new InvalidPhoneTaskV2TransitionError(
        'The pending interaction does not match this response.',
      );
    }
    if (!activeStepId) {
      throw new InvalidPhoneTaskV2TransitionError(
        'The pending interaction has no active step.',
      );
    }
    const { index, step } = requireStep(task, activeStepId);
    requireStatus(step, ['waiting_for_user']);
    if (event.type === 'resolve_next_action') {
      if (
        pendingInteraction.kind !== 'next_action'
        || step.kind !== 'ask_next'
      ) {
        throw new InvalidPhoneTaskV2TransitionError(
          'Only an authoritative next-action step accepts this choice.',
        );
      }
      const allowedResponses = Array.isArray(
        pendingInteraction.allowedResponses,
      )
        ? pendingInteraction.allowedResponses
        : [];
      if (
        !allowedResponses.includes(event.choice)
      ) {
        throw new InvalidPhoneTaskV2TransitionError(
          'The selected next action is not authorized by this interaction.',
        );
      }
      if (event.choice === 'review_cart') {
        if (
          !event.continuationStepId
          || steps.some((candidate) =>
            candidate.stepId === event.continuationStepId)
          || steps.length >= task.budgets.maxSteps
        ) {
          throw new InvalidPhoneTaskV2TransitionError(
            'Review cart requires one unique continuation step.',
          );
        }
        replaceAt(steps, index, {
          ...step,
          kind: 'inspect_cart',
          status: 'ready',
          input: {
            action: 'inspect_cart',
            mode: 'read_only_review',
          },
          expectedPostcondition: { kind: 'cart_contents_observed' },
          lastResultRef: event.responseRef,
        });
        steps.push({
          stepId: event.continuationStepId,
          adapterId: step.adapterId,
          kind: 'ask_next',
          status: 'planned',
          dependsOn: [step.stepId],
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
        });
      } else if (event.choice === 'review_checkout') {
        replaceAt(steps, index, {
          ...step,
          kind: 'review_checkout',
          status: 'ready',
          input: {
            action: 'prepare_checkout',
            mode: 'read_only_review',
          },
          expectedPostcondition: {
            kind: 'checkout_terms_observed',
            dispatch: false,
          },
          lastResultRef: event.responseRef,
        });
      } else {
        replaceAt(steps, index, {
          ...step,
          status: 'skipped',
          lastResultRef: event.responseRef,
        });
        if (event.choice === 'add_more') {
          keepActiveWhenAllFinished = true;
        }
      }
      pendingInteraction = undefined;
      activeStepId = undefined;
      forcedTaskStatus = event.choice === 'add_more'
        ? 'active'
        : undefined;
    } else {
    const resolvedStepKind =
      step.kind === 'search_products'
      && event.resolvedStepInput
      && typeof event.resolvedStepInput === 'object'
      && !Array.isArray(event.resolvedStepInput)
      && (event.resolvedStepInput as { action?: unknown }).action
        === 'add_cart_item'
        ? 'add_cart_item'
        : step.kind;
    replaceAt(steps, index, {
      ...step,
      kind: resolvedStepKind,
      status: 'ready',
      lastResultRef: event.responseRef,
      ...(event.resolvedStepInput === undefined
        ? {}
        : { input: structuredClone(event.resolvedStepInput) }),
    });
    pendingInteraction = undefined;
    forcedTaskStatus = 'active';
    }
  } else {
    const { index, step } = requireStep(task, event.stepId);
    switch (event.type) {
      case 'begin_step':
        requireStatus(step, ['ready']);
        if (!eligibleStepIdsV2({ ...task, steps }).includes(step.stepId)) {
          throw new InvalidPhoneTaskV2TransitionError(
            `Step ${step.stepId} has unmet dependencies.`,
          );
        }
        if (steps.some((candidate) => candidate.status === 'running')) {
          throw new InvalidPhoneTaskV2TransitionError(
            'Only one step may run at a time.',
          );
        }
        if (step.attempts >= task.budgets.maxAttemptsPerStep) {
          throw new InvalidPhoneTaskV2TransitionError(
            `Step ${step.stepId} exhausted its attempt budget.`,
          );
        }
        replaceAt(steps, index, {
          ...step,
          status: 'running',
          operationId: event.operationId,
          attempts: step.attempts + 1,
        });
        activeStepId = step.stepId;
        break;
      case 'verify_step':
        requireStatus(step, ['running']);
        replaceAt(steps, index, {
          ...step,
          status: 'verified',
          lastResultRef: event.resultRef,
        });
        activeStepId = undefined;
        break;
      case 'wait_for_user':
        requireStatus(step, ['ready', 'running']);
        if (
          pendingInteraction
          || event.interaction.taskId !== task.taskId
          || event.interaction.taskRevision !== task.revision + 1
          || !['open', 'resolving'].includes(event.interaction.status)
        ) {
          throw new InvalidPhoneTaskV2TransitionError(
            'Invalid or conflicting pending interaction.',
          );
        }
        replaceAt(steps, index, { ...step, status: 'waiting_for_user' });
        pendingInteraction = structuredClone(event.interaction);
        activeStepId = step.stepId;
        forcedTaskStatus = 'waiting_for_user';
        break;
      case 'replace_step':
        requireStatus(step, [
          'planned',
          'ready',
          'waiting_for_user',
          'failed',
          'ambiguous',
          'blocked',
        ]);
        replaceAt(steps, index, {
          ...structuredClone(event.replacement),
          stepId: step.stepId,
          attempts: 0,
          status: 'planned',
          operationId: undefined,
          lastResultRef: undefined,
        });
        pendingInteraction = clearInteractionForStep(task, step.stepId);
        if (activeStepId === step.stepId) activeStepId = undefined;
        forcedTaskStatus = 'active';
        break;
      case 'skip_step':
        requireStatus(step, [
          'planned',
          'ready',
          'waiting_for_user',
          'failed',
          'ambiguous',
          'blocked',
        ]);
        replaceAt(steps, index, { ...step, status: 'skipped' });
        pendingInteraction = clearInteractionForStep(task, step.stepId);
        if (activeStepId === step.stepId) activeStepId = undefined;
        forcedTaskStatus = 'active';
        break;
      case 'correct_verified_step':
        requireStatus(step, ['verified']);
        if (
          steps.some((candidate) => candidate.stepId === event.correction.stepId)
          || steps.length >= task.budgets.maxSteps
        ) {
          throw new InvalidPhoneTaskV2TransitionError(
            'Correction step is duplicate or exceeds the step budget.',
          );
        }
        steps.push({
          ...structuredClone(event.correction),
          status: 'planned',
          dependsOn: [
            ...new Set([...event.correction.dependsOn, step.stepId]),
          ],
          attempts: 0,
          operationId: undefined,
          lastResultRef: undefined,
        });
        forcedTaskStatus = 'active';
        break;
      case 'retry_step':
        requireStatus(step, ['failed']);
        replaceAt(steps, index, {
          ...step,
          status: 'planned',
          operationId: undefined,
          lastResultRef: undefined,
        });
        activeStepId = undefined;
        forcedTaskStatus = 'active';
        break;
      case 'fail_step':
        requireStatus(step, ['running']);
        replaceAt(steps, index, {
          ...step,
          status: 'failed',
          lastResultRef: event.resultRef,
        });
        activeStepId = step.stepId;
        forcedTaskStatus = 'active';
        break;
      case 'block_step':
        requireStatus(step, ['planned', 'ready', 'running', 'failed']);
        replaceAt(steps, index, {
          ...step,
          status: 'blocked',
          lastResultRef: event.resultRef,
        });
        activeStepId = step.stepId;
        forcedTaskStatus = 'blocked';
        break;
      case 'mark_ambiguous':
        requireStatus(step, ['running']);
        replaceAt(steps, index, {
          ...step,
          status: 'ambiguous',
          lastResultRef: event.resultRef,
        });
        activeStepId = step.stepId;
        forcedTaskStatus = 'ambiguous';
        break;
    }
  }

  steps = normalizeReadiness(steps);
  const allFinished = steps.every((step) =>
    TERMINAL_STEP_STATUSES_V2.has(step.status));
  const nextStatus = allFinished && !keepActiveWhenAllFinished
    ? 'completed'
    : forcedTaskStatus ?? (pendingInteraction ? 'waiting_for_user' : 'active');
  const nextRevision = task.revision + 1;
  if (pendingInteraction) pendingInteraction.taskRevision = nextRevision;
  const next: PhoneTaskV2 = {
    ...task,
    revision: nextRevision,
    status: nextStatus,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    steps,
    ...(pendingInteraction
      ? { pendingInteraction }
      : { pendingInteraction: undefined }),
    journal: [...task.journal, eventJournal(event)],
    updatedAt: event.at,
    ...(['completed', 'cancelled'].includes(nextStatus)
      ? { terminalAt: event.at }
      : { terminalAt: undefined }),
  };
  assertVerifiedStepsImmutable(task, next);
  return parsePhoneTaskV2(next);
}
