import { describe, expect, it } from 'vitest';
import { transitionPhoneTaskV2 } from './graph';
import {
  classifyIncomingTaskTurnV2,
  hasUnresolvedMutationV2,
} from './task-lifecycle';
import { validTaskV2 } from './test-fixtures';

function waitingTask() {
  const task = validTaskV2();
  return transitionPhoneTaskV2(task, {
    type: 'wait_for_user',
    stepId: 'step:first',
    entryId: 'journal:wait',
    at: 2,
    interaction: {
      interactionId: 'interaction:choice',
      taskId: task.taskId,
      taskRevision: task.revision + 1,
      kind: 'product_choice',
      allowedResponses: ['one', 'two'],
      presentationRef: 'presentation:choice',
      status: 'open',
      createdAt: 2,
      expiresAt: 100,
    },
  });
}

describe('PhoneTaskV2 explicit continuation and replacement semantics', () => {
  it('distinguishes a bound clarification answer from stale prose', () => {
    const task = waitingTask();
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'clarification_answer',
      interactionId: 'interaction:choice',
      taskRevision: task.revision,
      responseRef: 'response:one',
    })).toEqual({
      action: 'resolve_interaction',
      interactionId: 'interaction:choice',
      responseRef: 'response:one',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'clarification_answer',
      interactionId: 'interaction:choice',
      taskRevision: task.revision - 1,
      responseRef: 'response:stale',
    })).toEqual({ action: 'reject', reason: 'stale_interaction' });
    expect(classifyIncomingTaskTurnV2(validTaskV2(), {
      kind: 'clarification_answer',
      interactionId: 'interaction:choice',
      taskRevision: 0,
      responseRef: 'response:orphaned',
    })).toEqual({ action: 'reject', reason: 'no_pending_interaction' });
  });

  it('distinguishes correction, addition, unrelated replacement, and start-over', () => {
    const task = validTaskV2();
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'correction',
      targetStepId: 'step:first',
      correctionRef: 'patch:correction',
    })).toMatchObject({
      action: 'patch_existing',
      patchKind: 'correction',
      targetStepId: 'step:first',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'addition',
      additionRef: 'patch:addition',
    })).toMatchObject({
      action: 'patch_existing',
      patchKind: 'addition',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'correction',
      targetStepId: 'step:missing',
      correctionRef: 'patch:invalid',
    })).toEqual({
      action: 'reject',
      reason: 'unknown_correction_target',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'unrelated_task',
      replacementGoalRef: 'goal:unrelated',
    })).toEqual({
      action: 'replace_task',
      reason: 'unrelated_task',
      replacementGoalRef: 'goal:unrelated',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'start_over',
    })).toEqual({
      action: 'cancel_task',
      reason: 'start_over',
    });
  });

  it.each([
    ['running step', () => {
      const task = validTaskV2();
      task.steps[0]!.status = 'running';
      return task;
    }],
    ['ambiguous step', () => {
      const task = validTaskV2();
      task.steps[0]!.status = 'ambiguous';
      return task;
    }],
    ['phone operation', () => {
      const task = validTaskV2();
      task.status = 'waiting_for_phone';
      return task;
    }],
    ['ambiguous task', () => {
      const task = validTaskV2();
      task.status = 'ambiguous';
      return task;
    }],
    ['blocked operation', () => {
      const task = validTaskV2();
      task.status = 'blocked';
      task.steps[0]!.status = 'blocked';
      task.steps[0]!.operationId = 'operation:blocked';
      return task;
    }],
    ['fact requiring reconciliation', () => {
      const task = validTaskV2();
      task.verifiedFacts.push({
        factId: 'fact:uncertain-mutation',
        kind: 'mutation_outcome',
        originOperationId: 'operation:uncertain',
        observedAt: 2,
        freshness: { kind: 'task_lifetime' },
        valueRef: 'value:uncertain',
        confidence: 'reconciliation_required',
      });
      return task;
    }],
  ])('never discards an unresolved %s', (_label, taskFactory) => {
    const task = taskFactory();
    expect(hasUnresolvedMutationV2(task)).toBe(true);
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'unrelated_task',
      replacementGoalRef: 'goal:unrelated',
    })).toEqual({
      action: 'reject',
      reason: 'reconciliation_required',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'start_over',
    })).toEqual({
      action: 'reject',
      reason: 'reconciliation_required',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'addition',
      additionRef: 'patch:deferred',
    })).toEqual({
      action: 'reject',
      reason: 'reconciliation_required',
    });
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'correction',
      targetStepId: 'step:first',
      correctionRef: 'patch:deferred',
    })).toEqual({
      action: 'reject',
      reason: 'reconciliation_required',
    });
  });

  it('does not mutate the task while classifying a safe replacement', () => {
    const task = validTaskV2();
    const before = structuredClone(task);
    expect(hasUnresolvedMutationV2(task)).toBe(false);
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'unrelated_task',
      replacementGoalRef: 'goal:unrelated',
    })).toEqual({
      action: 'replace_task',
      reason: 'unrelated_task',
      replacementGoalRef: 'goal:unrelated',
    });
    expect(task).toEqual(before);
  });

  it('does not reopen or replace a terminal task through this active-task API', () => {
    const task = validTaskV2();
    task.status = 'completed';
    task.activeStepId = undefined;
    task.steps[0]!.status = 'verified';
    task.steps[1]!.status = 'skipped';
    task.terminalAt = 2;
    expect(classifyIncomingTaskTurnV2(task, {
      kind: 'start_over',
    })).toEqual({
      action: 'reject',
      reason: 'terminal_task',
    });
  });
});
