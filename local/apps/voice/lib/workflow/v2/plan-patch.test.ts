import { describe, expect, it } from 'vitest';
import type { PhoneTaskStepV2 } from './contracts';
import {
  InvalidPhoneTaskV2TransitionError,
  transitionPhoneTaskV2,
} from './graph';
import {
  applyModelPlanPatchV2,
  parseModelPlanPatchV2,
  type ModelPlanPatchV2,
  type PlanPatchOperationV2,
} from './plan-patch';
import { validTaskV2 } from './test-fixtures';

function verifiedFirstTask() {
  const running = transitionPhoneTaskV2(validTaskV2(), {
    type: 'begin_step',
    stepId: 'step:first',
    operationId: 'operation:first',
    entryId: 'journal:begin-first',
    at: 2,
  });
  return transitionPhoneTaskV2(running, {
    type: 'verify_step',
    stepId: 'step:first',
    resultRef: 'result:first',
    entryId: 'journal:verify-first',
    at: 3,
  });
}

function proposedStep(
  stepId: string,
  subject: string,
  dependsOn: string[] = [],
): PhoneTaskStepV2 {
  return {
    stepId,
    adapterId: 'test-adapter',
    kind: 'add_item',
    status: 'planned',
    dependsOn,
    input: { subject },
    expectedPostcondition: { kind: 'item_added', subject },
    attempts: 0,
  };
}

function patch(
  taskId: string,
  revision: number,
  operations: PlanPatchOperationV2[],
): ModelPlanPatchV2 {
  return {
    version: 2,
    patchId: `patch:${revision}:${operations.length}`,
    taskId,
    baseRevision: revision,
    reasonRef: 'planner-decision:test',
    proposedAt: 3,
    operations,
  };
}

function apply(
  operations: PlanPatchOperationV2[],
  task = verifiedFirstTask(),
) {
  return applyModelPlanPatchV2({
    task,
    patch: patch(task.taskId, task.revision, operations),
    appliedAt: 4,
    journalEntryId: `journal:patch:${operations.length}`,
  });
}

describe('bounded model-proposed PhoneTaskV2 plan patches', () => {
  it('adds bread before future work without changing verified milk', () => {
    const task = verifiedFirstTask();
    const verifiedMilk = structuredClone(task.steps[0]);

    const next = apply([{
      type: 'add_step',
      step: proposedStep('step:bread', 'bread', ['step:first']),
      beforeStepIds: ['step:second'],
    }], task);

    expect(next.steps[0]).toEqual(verifiedMilk);
    expect(next.steps.map((step) => [
      step.stepId,
      step.status,
      step.dependsOn,
    ])).toEqual([
      ['step:first', 'verified', []],
      ['step:bread', 'ready', ['step:first']],
      ['step:second', 'planned', ['step:first', 'step:bread']],
    ]);
  });

  it('replaces milk before execution while retaining the stable step identity', () => {
    const task = validTaskV2();
    const replacement = proposedStep('ignored', 'oat milk');
    const { stepId: _ignored, ...replacementWithoutId } = replacement;

    const next = applyModelPlanPatchV2({
      task,
      patch: {
        ...patch(task.taskId, task.revision, [{
          type: 'replace_step',
          stepId: 'step:first',
          replacement: replacementWithoutId,
        }]),
        proposedAt: 1,
      },
      appliedAt: 2,
      journalEntryId: 'journal:replace-milk',
    });

    expect(next.steps[0]).toMatchObject({
      stepId: 'step:first',
      status: 'ready',
      input: { subject: 'oat milk' },
      attempts: 0,
    });
  });

  it('skips an unavailable future item and completes when nothing remains', () => {
    const task = verifiedFirstTask();
    const verified = structuredClone(task.steps[0]);

    const next = apply([{
      type: 'skip_step',
      stepId: 'step:second',
      reasonRef: 'reason:unavailable',
    }], task);

    expect(next.steps[0]).toEqual(verified);
    expect(next.steps[1]).toMatchObject({
      status: 'skipped',
      lastResultRef: 'reason:unavailable',
    });
    expect(next.status).toBe('completed');
  });

  it('can skip unavailable work and propose checkout atomically', () => {
    const task = verifiedFirstTask();
    const checkout = {
      ...proposedStep('step:checkout', 'checkout', ['step:first']),
      kind: 'review_checkout',
      input: { mode: 'read_only_review' },
      expectedPostcondition: { kind: 'checkout_terms_observed' },
    };

    const next = apply([
      {
        type: 'skip_step',
        stepId: 'step:second',
        reasonRef: 'reason:unavailable',
      },
      {
        type: 'propose_checkout',
        step: checkout,
      },
    ], task);

    expect(next.steps[0]).toEqual(task.steps[0]);
    expect(next.steps.at(-1)).toMatchObject({
      stepId: 'step:checkout',
      kind: 'review_checkout',
      status: 'ready',
    });
    expect(next.status).toBe('active');
  });

  it.each([
    ['replace', {
      type: 'replace_step' as const,
      stepId: 'step:first',
      replacement: (() => {
        const { stepId: _ignored, ...rest } = proposedStep('ignored', 'rewrite');
        return rest;
      })(),
    }],
    ['skip', {
      type: 'skip_step' as const,
      stepId: 'step:first',
      reasonRef: 'reason:model-changed-mind',
    }],
  ])('rejects an attempt to %s verified history', (_name, operation) => {
    expect(() => apply([operation])).toThrow(InvalidPhoneTaskV2TransitionError);
  });

  it('rejects stale, oversized, and interaction-conflicting patches', () => {
    const task = verifiedFirstTask();
    const stale = patch(task.taskId, task.revision - 1, [{
      type: 'add_step',
      step: proposedStep('step:bread', 'bread', ['step:first']),
    }]);
    expect(() => applyModelPlanPatchV2({
      task,
      patch: stale,
      appliedAt: 4,
      journalEntryId: 'journal:stale',
    })).toThrow('stale');

    expect(() => parseModelPlanPatchV2({
      ...patch(task.taskId, task.revision, []),
      operations: Array.from({ length: 9 }, (_, index) => ({
        type: 'add_step',
        step: proposedStep(`step:new-${index}`, `item-${index}`),
      })),
    })).toThrow('unbounded');

    const waiting = transitionPhoneTaskV2(validTaskV2(), {
      type: 'wait_for_user',
      stepId: 'step:first',
      entryId: 'journal:wait',
      at: 2,
      interaction: {
        interactionId: 'interaction:one',
        taskId: task.taskId,
        taskRevision: 1,
        kind: 'next_action',
        allowedResponses: ['continue'],
        presentationRef: 'presentation:one',
        status: 'open',
        createdAt: 2,
        expiresAt: 100,
      },
    });
    expect(() => applyModelPlanPatchV2({
      task: waiting,
      patch: {
        ...patch(waiting.taskId, waiting.revision, [{
          type: 'add_step',
          step: proposedStep('step:bread', 'bread'),
        }]),
        proposedAt: 2,
      },
      appliedAt: 3,
      journalEntryId: 'journal:while-waiting',
    })).toThrow('pending interaction');
  });
});
