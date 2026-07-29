import {
  TERMINAL_STEP_STATUSES_V2,
  type PhoneTaskStepV2,
  type PhoneTaskV2,
  type TaskJournalEntryV2,
} from './contracts';
import {
  InvalidPhoneTaskV2TransitionError,
  assertVerifiedStepsImmutable,
} from './graph';
import { parsePhoneTaskV2 } from './validation';

type AddStepPatchV2 = {
  type: 'add_step';
  step: PhoneTaskStepV2;
  beforeStepIds?: string[];
};

type ReplaceStepPatchV2 = {
  type: 'replace_step';
  stepId: string;
  replacement: Omit<PhoneTaskStepV2, 'stepId'>;
};

type SkipStepPatchV2 = {
  type: 'skip_step';
  stepId: string;
  reasonRef: string;
};

type ProposeCheckoutPatchV2 = {
  type: 'propose_checkout';
  step: PhoneTaskStepV2;
  beforeStepIds?: string[];
};

export type PlanPatchOperationV2 =
  | AddStepPatchV2
  | ReplaceStepPatchV2
  | SkipStepPatchV2
  | ProposeCheckoutPatchV2;

export type ModelPlanPatchV2 = {
  version: 2;
  patchId: string;
  taskId: string;
  baseRevision: number;
  reasonRef: string;
  proposedAt: number;
  operations: PlanPatchOperationV2[];
};

export type PlanPatchBoundsV2 = {
  maxBytes: number;
  maxOperations: number;
};

export const DEFAULT_PLAN_PATCH_BOUNDS_V2: PlanPatchBoundsV2 = {
  maxBytes: 64_000,
  maxOperations: 8,
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function parseStepShape(value: unknown): PhoneTaskStepV2 {
  const candidate = record(value, 'plan patch step');
  const fixture: PhoneTaskV2 = {
    version: 2,
    taskId: 'task:patch-validation',
    clientId: 'patch-validation',
    revision: 0,
    originalGoal: 'Validate one proposed plan step',
    goalKind: 'patch_validation',
    status: 'active',
    steps: [{
      ...(candidate as PhoneTaskStepV2),
      dependsOn: [],
      status: typeof candidate['status'] === 'string'
        ? candidate['status'] as PhoneTaskStepV2['status']
        : 'planned',
    }],
    verifiedFacts: [],
    journal: [],
    budgets: {
      maxAttemptsPerStep: 100,
      maxJournalEntries: 1,
      maxSteps: 1,
      maxVerifiedFacts: 1,
    },
    createdAt: 0,
    updatedAt: 0,
  };
  return {
    ...parsePhoneTaskV2(fixture).steps[0]!,
    dependsOn: Array.isArray(candidate['dependsOn'])
      ? candidate['dependsOn'].map((entry) =>
        identifier(entry, 'plan patch dependency'))
      : [],
  };
}

function parseOperation(value: unknown): PlanPatchOperationV2 {
  const input = record(value, 'plan patch operation');
  const type = input['type'];
  if (type === 'add_step' || type === 'propose_checkout') {
    const step = parseStepShape(input['step']);
    const beforeStepIds = input['beforeStepIds'];
    if (beforeStepIds !== undefined && !Array.isArray(beforeStepIds)) {
      throw new Error('Invalid plan patch insertion targets.');
    }
    if (
      type === 'propose_checkout'
      && !['review_checkout', 'inspect_checkout'].includes(step.kind)
    ) {
      throw new Error('A checkout proposal must add a checkout review step.');
    }
    return {
      type,
      step,
      ...(beforeStepIds
        ? {
          beforeStepIds: beforeStepIds.map((entry) =>
            identifier(entry, 'plan patch insertion target')),
        }
        : {}),
    };
  }
  if (type === 'replace_step') {
    const replacement = parseStepShape({
      ...record(input['replacement'], 'plan patch replacement'),
      stepId: 'step:replacement-validation',
    });
    const { stepId: _ignored, ...replacementWithoutId } = replacement;
    return {
      type,
      stepId: identifier(input['stepId'], 'plan patch target step'),
      replacement: replacementWithoutId,
    };
  }
  if (type === 'skip_step') {
    return {
      type,
      stepId: identifier(input['stepId'], 'plan patch target step'),
      reasonRef: identifier(input['reasonRef'], 'plan patch skip reason'),
    };
  }
  throw new Error('Unsupported plan patch operation.');
}

export function parseModelPlanPatchV2(
  value: unknown,
  bounds: PlanPatchBoundsV2 = DEFAULT_PLAN_PATCH_BOUNDS_V2,
): ModelPlanPatchV2 {
  const serialized = JSON.stringify(value);
  if (
    !Number.isSafeInteger(bounds.maxBytes)
    || bounds.maxBytes < 1
    || !Number.isSafeInteger(bounds.maxOperations)
    || bounds.maxOperations < 1
    || !serialized
    || new TextEncoder().encode(serialized).byteLength > bounds.maxBytes
  ) {
    throw new Error('Plan patch exceeds its serialized budget.');
  }
  const input = record(value, 'model plan patch');
  if (input['version'] !== 2) throw new Error('Unsupported plan patch version.');
  if (
    !Number.isSafeInteger(input['baseRevision'])
    || (input['baseRevision'] as number) < 0
    || typeof input['proposedAt'] !== 'number'
    || !Number.isFinite(input['proposedAt'])
    || input['proposedAt'] < 0
    || !Array.isArray(input['operations'])
    || input['operations'].length === 0
    || input['operations'].length > bounds.maxOperations
  ) {
    throw new Error('Invalid or unbounded model plan patch.');
  }
  return {
    version: 2,
    patchId: identifier(input['patchId'], 'plan patch identifier'),
    taskId: identifier(input['taskId'], 'plan patch task identifier'),
    baseRevision: input['baseRevision'] as number,
    reasonRef: identifier(input['reasonRef'], 'plan patch reason reference'),
    proposedAt: input['proposedAt'],
    operations: input['operations'].map(parseOperation),
  };
}

function dependencySatisfied(
  step: PhoneTaskStepV2,
  byId: ReadonlyMap<string, PhoneTaskStepV2>,
): boolean {
  return step.dependsOn.every((dependency) => {
    const dependencyStep = byId.get(dependency);
    return Boolean(
      dependencyStep && TERMINAL_STEP_STATUSES_V2.has(dependencyStep.status),
    );
  });
}

function normalizeReadiness(steps: PhoneTaskStepV2[]): PhoneTaskStepV2[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return steps.map((step) => {
    if (!['planned', 'ready'].includes(step.status)) return step;
    return {
      ...step,
      status: dependencySatisfied(step, byId) ? 'ready' : 'planned',
    };
  });
}

function resetProposedStep(step: PhoneTaskStepV2): PhoneTaskStepV2 {
  return {
    ...structuredClone(step),
    status: 'planned',
    attempts: 0,
    operationId: undefined,
    lastResultRef: undefined,
  };
}

function insertStep(
  steps: PhoneTaskStepV2[],
  operation: AddStepPatchV2 | ProposeCheckoutPatchV2,
): void {
  const step = resetProposedStep(operation.step);
  if (steps.some((candidate) => candidate.stepId === step.stepId)) {
    throw new InvalidPhoneTaskV2TransitionError(
      `Plan patch step ${step.stepId} already exists.`,
    );
  }
  const insertionTargets = new Set(operation.beforeStepIds ?? []);
  for (const targetId of insertionTargets) {
    const index = steps.findIndex((candidate) => candidate.stepId === targetId);
    const target = steps[index];
    if (!target) {
      throw new InvalidPhoneTaskV2TransitionError(
        `Plan patch insertion target ${targetId} does not exist.`,
      );
    }
    if (!['planned', 'ready', 'failed', 'blocked'].includes(target.status)) {
      throw new InvalidPhoneTaskV2TransitionError(
        `Plan patch cannot rewire ${target.status} step ${targetId}.`,
      );
    }
    steps[index] = {
      ...target,
      dependsOn: [...new Set([...target.dependsOn, step.stepId])],
    };
  }
  const targetIndices = [...insertionTargets]
    .map((targetId) => steps.findIndex((candidate) => candidate.stepId === targetId))
    .filter((index) => index >= 0);
  const insertionIndex = targetIndices.length > 0
    ? Math.min(...targetIndices)
    : steps.length;
  steps.splice(insertionIndex, 0, step);
}

export function applyModelPlanPatchV2(input: {
  task: PhoneTaskV2;
  patch: ModelPlanPatchV2;
  appliedAt: number;
  journalEntryId: string;
  bounds?: PlanPatchBoundsV2;
}): PhoneTaskV2 {
  const task = parsePhoneTaskV2(structuredClone(input.task));
  const patch = parseModelPlanPatchV2(input.patch, input.bounds);
  if (task.status === 'cancelled') {
    throw new InvalidPhoneTaskV2TransitionError('Terminal task cannot be replanned.');
  }
  if (
    patch.taskId !== task.taskId
    || patch.baseRevision !== task.revision
    || patch.proposedAt < task.updatedAt
    || patch.proposedAt > input.appliedAt
    || input.appliedAt < task.updatedAt
  ) {
    throw new InvalidPhoneTaskV2TransitionError(
      'Plan patch target or base revision is stale.',
    );
  }
  if (task.pendingInteraction) {
    throw new InvalidPhoneTaskV2TransitionError(
      'Resolve the pending interaction before applying a plan patch.',
    );
  }
  if (task.journal.some((entry) => entry.entryId === input.journalEntryId)) {
    throw new InvalidPhoneTaskV2TransitionError('Plan patch journal entry is duplicate.');
  }
  if (task.journal.length >= task.budgets.maxJournalEntries) {
    throw new InvalidPhoneTaskV2TransitionError('Plan patch exceeds journal budget.');
  }

  let steps = task.steps.map((step) => ({
    ...step,
    dependsOn: [...step.dependsOn],
  }));
  for (const operation of patch.operations) {
    if (operation.type === 'add_step' || operation.type === 'propose_checkout') {
      insertStep(steps, operation);
      continue;
    }
    const index = steps.findIndex((step) => step.stepId === operation.stepId);
    const target = steps[index];
    if (!target) {
      throw new InvalidPhoneTaskV2TransitionError(
        `Plan patch target ${operation.stepId} does not exist.`,
      );
    }
    if (operation.type === 'replace_step') {
      if (!['planned', 'ready', 'failed', 'blocked'].includes(target.status)) {
        throw new InvalidPhoneTaskV2TransitionError(
          `Plan patch cannot replace ${target.status} step ${target.stepId}.`,
        );
      }
      steps[index] = resetProposedStep({
        ...structuredClone(operation.replacement),
        stepId: target.stepId,
      });
    } else {
      if (!['planned', 'ready', 'failed', 'blocked'].includes(target.status)) {
        throw new InvalidPhoneTaskV2TransitionError(
          `Plan patch cannot skip ${target.status} step ${target.stepId}.`,
        );
      }
      steps[index] = {
        ...target,
        status: 'skipped',
        lastResultRef: operation.reasonRef,
      };
    }
  }
  if (steps.length > task.budgets.maxSteps) {
    throw new InvalidPhoneTaskV2TransitionError('Plan patch exceeds step budget.');
  }
  steps = normalizeReadiness(steps);
  const allFinished = steps.every((step) =>
    TERMINAL_STEP_STATUSES_V2.has(step.status));
  const nextReady = steps.find((step) =>
    ['running', 'waiting_for_user', 'failed', 'blocked', 'ambiguous', 'ready']
      .includes(step.status));
  const journalEntry: TaskJournalEntryV2 = {
    entryId: input.journalEntryId,
    at: input.appliedAt,
    type: 'model_plan_patch',
    dataRef: patch.patchId,
  };
  const next = parsePhoneTaskV2({
    ...task,
    revision: task.revision + 1,
    status: allFinished
      ? 'completed'
      : task.pendingInteraction
        ? 'waiting_for_user'
        : 'active',
    activeStepId: allFinished ? undefined : nextReady?.stepId,
    steps,
    journal: [...task.journal, journalEntry],
    updatedAt: input.appliedAt,
    ...(allFinished ? { terminalAt: input.appliedAt } : { terminalAt: undefined }),
  });
  assertVerifiedStepsImmutable(task, next);
  return next;
}
