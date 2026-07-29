import {
  TERMINAL_STEP_STATUSES_V2,
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskStepV2,
  type PhoneTaskV2,
  type TaskJournalEntryV2,
} from './contracts';
import { assertVerifiedStepsImmutable } from './graph';
import type {
  PhoneTaskRepositoryV2,
  TaskRecoveryOperationV2,
  TaskRepositoryEventV2,
  TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export type RecoveryReconciliationResultV2 = {
  outcome: 'verified_applied' | 'verified_not_applied' | 'ambiguous';
  evidenceRef: string;
};

export interface TaskRecoveryReconcilerV2 {
  reconcile(input: Readonly<{
    mode: 'mutation' | 'final_dispatch';
    operation: TaskRecoveryOperationV2;
    task: PhoneTaskV2;
  }>): Promise<RecoveryReconciliationResultV2>;
}

export type TaskRecoveryOutcomeV2 =
  | 'safe_to_resume'
  | 'mutation_verified'
  | 'mutation_not_applied'
  | 'mutation_ambiguous'
  | 'final_dispatch_verified'
  | 'final_dispatch_not_applied'
  | 'final_dispatch_ambiguous'
  | 'already_safe'
  | 'terminal'
  | 'conflict'
  | 'recovery_failed';

export type TaskRecoveryReportEntryV2 = {
  taskId: string;
  outcome: TaskRecoveryOutcomeV2;
  operationId?: string;
  revision: number;
  detail?: string;
};

function dependenciesSatisfied(
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

function normalizeSteps(steps: PhoneTaskStepV2[]): PhoneTaskStepV2[] {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  return steps.map((step) => {
    if (!['planned', 'ready'].includes(step.status)) return step;
    return {
      ...step,
      status: dependenciesSatisfied(step, byId) ? 'ready' : 'planned',
    };
  });
}

function recoveredTask(input: {
  task: PhoneTaskV2;
  operation: TaskRecoveryOperationV2;
  at: number;
  entryId: string;
  outcome:
    | 'safe_to_resume'
    | 'verified_applied'
    | 'verified_not_applied'
    | 'ambiguous';
  evidenceRef?: string;
}): PhoneTaskV2 {
  const task = parsePhoneTaskV2(structuredClone(input.task));
  const index = task.steps.findIndex(
    (step) => step.stepId === input.operation.stepId,
  );
  const step = task.steps[index];
  if (!step) throw new Error('Recovery operation step does not exist.');
  const steps = task.steps.map((candidate) => ({
    ...candidate,
    dependsOn: [...candidate.dependsOn],
  }));

  if (step.status !== 'verified') {
    if (input.outcome === 'safe_to_resume') {
      if (!['running', 'planned', 'ready', 'failed'].includes(step.status)) {
        throw new Error(`Step ${step.stepId} is not safe to resume.`);
      }
      steps[index] = {
        ...step,
        status: 'ready',
        operationId: undefined,
        lastResultRef: input.evidenceRef,
      };
    } else if (input.outcome === 'verified_applied') {
      steps[index] = {
        ...step,
        status: 'verified',
        lastResultRef: input.evidenceRef ?? input.operation.resultRef,
      };
    } else if (input.outcome === 'verified_not_applied') {
      const finalDispatch =
        input.operation.boundary === 'final_dispatch_attempted';
      steps[index] = {
        ...step,
        status: finalDispatch ? 'blocked' : 'failed',
        lastResultRef: input.evidenceRef,
      };
    } else {
      steps[index] = {
        ...step,
        status: 'ambiguous',
        lastResultRef: input.evidenceRef,
      };
    }
  }

  const normalized = normalizeSteps(steps);
  const allFinished = normalized.every((candidate) =>
    TERMINAL_STEP_STATUSES_V2.has(candidate.status));
  const nextActiveStep = normalized.find((candidate) =>
    ['running', 'waiting_for_user', 'failed', 'blocked', 'ambiguous']
      .includes(candidate.status))
    ?? normalized.find((candidate) => candidate.status === 'ready');
  const status: PhoneTaskV2['status'] = allFinished
    ? 'completed'
    : input.outcome === 'ambiguous'
      ? 'ambiguous'
      : (
          input.outcome === 'verified_not_applied'
          && input.operation.boundary === 'final_dispatch_attempted'
        )
        ? 'blocked'
        : 'active';
  const journalEntry: TaskJournalEntryV2 = {
    entryId: input.entryId,
    at: input.at,
    type: `recovery_${input.outcome}`,
    stepId: step.stepId,
    operationId: input.operation.operationId,
    ...(input.evidenceRef ? { dataRef: input.evidenceRef } : {}),
  };
  if (task.journal.length >= task.budgets.maxJournalEntries) {
    throw new Error('Recovery exceeds the task journal budget.');
  }
  const next = parsePhoneTaskV2({
    ...task,
    revision: task.revision + 1,
    status,
    activeStepId: allFinished ? undefined : nextActiveStep?.stepId,
    steps: normalized,
    pendingInteraction: undefined,
    journal: [...task.journal, journalEntry],
    updatedAt: input.at,
    ...(allFinished ? { terminalAt: input.at } : { terminalAt: undefined }),
  });
  assertVerifiedStepsImmutable(task, next);
  return next;
}

function recoveryEvent(
  task: PhoneTaskV2,
  operation: TaskRecoveryOperationV2,
  at: number,
  outcome: string,
  evidenceRef?: string,
): TaskRepositoryEventV2 {
  return {
    eventId: `recovery:${operation.operationId}:${task.revision}`,
    taskId: task.taskId,
    taskRevision: task.revision,
    at,
    kind: `recovery_${outcome}`,
    ...(evidenceRef ? { dataRef: evidenceRef } : {}),
  };
}

async function reconcileSafely(
  reconciler: TaskRecoveryReconcilerV2,
  record: TaskRepositoryRecordV2,
): Promise<RecoveryReconciliationResultV2> {
  const operation = record.activeOperation!;
  try {
    const result = await reconciler.reconcile({
      mode: operation.boundary === 'final_dispatch_attempted'
        ? 'final_dispatch'
        : 'mutation',
      operation: structuredClone(operation),
      task: structuredClone(record.task),
    });
    if (
      !result
      || !['verified_applied', 'verified_not_applied', 'ambiguous']
        .includes(result.outcome)
      || typeof result.evidenceRef !== 'string'
      || !result.evidenceRef
    ) {
      throw new Error('Invalid recovery reconciliation response.');
    }
    return result;
  } catch {
    return {
      outcome: 'ambiguous',
      evidenceRef: `recovery-error:${operation.operationId}`,
    };
  }
}

export async function recoverRepositoryOnStartupV2(input: {
  repository: PhoneTaskRepositoryV2;
  reconciler: TaskRecoveryReconcilerV2;
  now?: () => number;
}): Promise<TaskRecoveryReportEntryV2[]> {
  const now = input.now ?? Date.now;
  const records = await input.repository.list();
  const reports: TaskRecoveryReportEntryV2[] = [];

  for (const record of records) {
    const operation = record.activeOperation;
    if (TERMINAL_TASK_STATUSES_V2.has(record.task.status)) {
      reports.push({
        taskId: record.task.taskId,
        outcome: 'terminal',
        revision: record.task.revision,
      });
      continue;
    }
    if (!operation) {
      reports.push({
        taskId: record.task.taskId,
        outcome: 'already_safe',
        revision: record.task.revision,
      });
      continue;
    }

    try {
      const at = Math.max(now(), record.task.updatedAt);
      let transitionOutcome:
        | 'safe_to_resume'
        | 'verified_applied'
        | 'verified_not_applied'
        | 'ambiguous';
      let publicOutcome: TaskRecoveryOutcomeV2;
      let evidenceRef: string | undefined;

      if (['not_started', 'before_mutation'].includes(operation.boundary)) {
        transitionOutcome = 'safe_to_resume';
        publicOutcome = 'safe_to_resume';
      } else if (operation.boundary === 'verified') {
        transitionOutcome = 'verified_applied';
        publicOutcome = 'mutation_verified';
        evidenceRef = operation.resultRef ?? `verified:${operation.operationId}`;
      } else {
        const reconciliation = await reconcileSafely(input.reconciler, record);
        transitionOutcome = reconciliation.outcome;
        evidenceRef = reconciliation.evidenceRef;
        if (operation.boundary === 'final_dispatch_attempted') {
          publicOutcome = reconciliation.outcome === 'verified_applied'
            ? 'final_dispatch_verified'
            : reconciliation.outcome === 'verified_not_applied'
              ? 'final_dispatch_not_applied'
              : 'final_dispatch_ambiguous';
        } else {
          publicOutcome = reconciliation.outcome === 'verified_applied'
            ? 'mutation_verified'
            : reconciliation.outcome === 'verified_not_applied'
              ? 'mutation_not_applied'
              : 'mutation_ambiguous';
        }
      }

      const entryId = `recovery:${operation.operationId}:${record.task.revision + 1}`;
      const task = recoveredTask({
        task: record.task,
        operation,
        at,
        entryId,
        outcome: transitionOutcome,
        ...(evidenceRef ? { evidenceRef } : {}),
      });
      await input.repository.commit({
        expectedRevision: record.task.revision,
        task,
        event: recoveryEvent(
          task,
          operation,
          at,
          transitionOutcome,
          evidenceRef,
        ),
      });
      reports.push({
        taskId: task.taskId,
        operationId: operation.operationId,
        outcome: publicOutcome,
        revision: task.revision,
      });
    } catch (error) {
      const current = await input.repository.getById(record.task.taskId);
      reports.push({
        taskId: record.task.taskId,
        operationId: operation.operationId,
        outcome: current?.task.revision === record.task.revision
          ? 'recovery_failed'
          : 'conflict',
        revision: current?.task.revision ?? record.task.revision,
        detail: error instanceof Error ? error.message : 'Unknown recovery failure.',
      });
    }
  }
  return reports;
}
