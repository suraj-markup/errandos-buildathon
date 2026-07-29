import { describe, expect, it } from 'vitest';
import type {
  PendingInteractionV2,
  PhoneTaskStepV2,
  PhoneTaskV2,
} from './contracts';
import {
  InvalidPhoneTaskV2TransitionError,
  eligibleStepIdsV2,
  transitionPhoneTaskV2,
} from './graph';
import { validTaskV2 } from './test-fixtures';

function eventBase(sequence: number) {
  return { at: sequence + 1, entryId: `journal:${sequence}` };
}

function begin(
  task: PhoneTaskV2,
  stepId: string,
  sequence: number,
): PhoneTaskV2 {
  return transitionPhoneTaskV2(task, {
    ...eventBase(sequence),
    type: 'begin_step',
    stepId,
    operationId: `operation:${sequence}`,
  });
}

function verify(
  task: PhoneTaskV2,
  stepId: string,
  sequence: number,
): PhoneTaskV2 {
  return transitionPhoneTaskV2(task, {
    ...eventBase(sequence),
    type: 'verify_step',
    stepId,
    resultRef: `result:${sequence}`,
  });
}

describe('PhoneTaskV2 pure graph transitions', () => {
  it('activates dependencies only after verified completion', () => {
    const initial = validTaskV2();
    expect(eligibleStepIdsV2(initial)).toEqual(['step:first']);

    const running = begin(initial, 'step:first', 1);
    expect(running.steps.map((step) => step.status)).toEqual([
      'running',
      'planned',
    ]);

    const verified = verify(running, 'step:first', 2);
    expect(verified.steps.map((step) => step.status)).toEqual([
      'verified',
      'ready',
    ]);
    expect(eligibleStepIdsV2(verified)).toEqual(['step:second']);

    const completed = verify(
      begin(verified, 'step:second', 3),
      'step:second',
      4,
    );
    expect(completed.status).toBe('completed');
    expect(completed.terminalAt).toBe(5);
  });

  it('binds an answer to the open task revision without rerunning prior work', () => {
    const initial = validTaskV2();
    const interaction: PendingInteractionV2 = {
      interactionId: 'interaction:choice',
      taskId: initial.taskId,
      taskRevision: initial.revision + 1,
      kind: 'next_action',
      allowedResponses: ['continue', 'cancel'],
      presentationRef: 'presentation:choice',
      status: 'open',
      createdAt: 2,
      expiresAt: 100,
    };
    const waiting = transitionPhoneTaskV2(initial, {
      ...eventBase(1),
      type: 'wait_for_user',
      stepId: 'step:first',
      interaction,
    });
    expect(waiting).toMatchObject({
      status: 'waiting_for_user',
      activeStepId: 'step:first',
    });

    const resolved = transitionPhoneTaskV2(waiting, {
      ...eventBase(2),
      type: 'resolve_interaction',
      interactionId: interaction.interactionId,
      resolvedStepInput: { selected: 'continue' },
      responseRef: 'response:selected',
    });
    expect(resolved.status).toBe('active');
    expect(resolved.pendingInteraction).toBeUndefined();
    expect(resolved.steps[0]).toMatchObject({
      status: 'ready',
      input: { selected: 'continue' },
      lastResultRef: 'response:selected',
      attempts: 0,
    });
    expect(resolved.journal.at(-1)).toMatchObject({
      dataRef: 'response:selected',
      type: 'resolve_interaction',
    });
  });

  it('rejects stale or unrelated interaction responses', () => {
    const task = validTaskV2();
    expect(() => transitionPhoneTaskV2(task, {
      ...eventBase(1),
      type: 'resolve_interaction',
      interactionId: 'interaction:stale',
      responseRef: 'response:one',
    })).toThrow(InvalidPhoneTaskV2TransitionError);
  });

  it('maps each authoritative next action without creating order work', () => {
    const waitingFor = (choice: string) => {
      const task = validTaskV2();
      task.steps = [{
        ...task.steps[0]!,
        kind: 'ask_next',
        input: { choices: [choice] },
      }];
      return transitionPhoneTaskV2(task, {
        ...eventBase(1),
        type: 'wait_for_user',
        stepId: 'step:first',
        interaction: {
          interactionId: `interaction:${choice}`,
          taskId: task.taskId,
          taskRevision: 1,
          kind: 'next_action',
          allowedResponses: [choice],
          presentationRef: `presentation:${choice}`,
          status: 'open',
          createdAt: 2,
          expiresAt: 100,
        },
      });
    };

    const reviewCart = transitionPhoneTaskV2(waitingFor('review_cart'), {
      ...eventBase(2),
      type: 'resolve_next_action',
      interactionId: 'interaction:review_cart',
      responseRef: 'response:review-cart',
      choice: 'review_cart',
      continuationStepId: 'step:next-action',
    });
    expect(reviewCart.steps).toMatchObject([
      {
        kind: 'inspect_cart',
        status: 'ready',
        input: { action: 'inspect_cart', mode: 'read_only_review' },
      },
      {
        stepId: 'step:next-action',
        kind: 'ask_next',
        status: 'planned',
        dependsOn: ['step:first'],
      },
    ]);

    const keepShopping = transitionPhoneTaskV2(
      waitingFor('add_more'),
      {
        ...eventBase(2),
        type: 'resolve_next_action',
        interactionId: 'interaction:add_more',
        responseRef: 'response:keep-shopping',
        choice: 'add_more',
      },
    );
    expect(keepShopping).toMatchObject({
      status: 'active',
      steps: [{ kind: 'ask_next', status: 'skipped' }],
    });
    expect(keepShopping.pendingInteraction).toBeUndefined();
    expect(keepShopping.terminalAt).toBeUndefined();

    const stop = transitionPhoneTaskV2(waitingFor('stop'), {
      ...eventBase(2),
      type: 'resolve_next_action',
      interactionId: 'interaction:stop',
      responseRef: 'response:stop',
      choice: 'stop',
    });
    expect(stop).toMatchObject({
      status: 'completed',
      steps: [{ kind: 'ask_next', status: 'skipped' }],
    });

    const checkout = transitionPhoneTaskV2(
      waitingFor('review_checkout'),
      {
        ...eventBase(2),
        type: 'resolve_next_action',
        interactionId: 'interaction:review_checkout',
        responseRef: 'response:review-checkout',
        choice: 'review_checkout',
      },
    );
    expect(checkout.steps).toEqual([
      expect.objectContaining({
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
      }),
    ]);
    expect(checkout.steps.some((step) =>
      /dispatch|place_order|confirm/i.test(step.kind))).toBe(false);
  });

  it('rejects next-action resolution on any other interaction kind', () => {
    const task = validTaskV2();
    task.steps[0]!.kind = 'ask_next';
    const waiting = transitionPhoneTaskV2(task, {
      ...eventBase(1),
      type: 'wait_for_user',
      stepId: 'step:first',
      interaction: {
        interactionId: 'interaction:payment',
        taskId: task.taskId,
        taskRevision: 1,
        kind: 'payment_choice',
        allowedResponses: ['stop'],
        presentationRef: 'presentation:payment',
        status: 'open',
        createdAt: 2,
        expiresAt: 100,
      },
    });
    expect(() => transitionPhoneTaskV2(waiting, {
      ...eventBase(2),
      type: 'resolve_next_action',
      interactionId: 'interaction:payment',
      responseRef: 'response:stop',
      choice: 'stop',
    })).toThrow('Only an authoritative next-action step');
  });

  it('cannot select checkout when the persisted prompt omitted it', () => {
    const task = validTaskV2();
    task.steps = [{ ...task.steps[0]!, kind: 'ask_next' }];
    const waiting = transitionPhoneTaskV2(task, {
      ...eventBase(1),
      type: 'wait_for_user',
      stepId: 'step:first',
      interaction: {
        interactionId: 'interaction:no-checkout',
        taskId: task.taskId,
        taskRevision: 1,
        kind: 'next_action',
        allowedResponses: ['review_cart', 'add_more', 'stop'],
        presentationRef: 'presentation:no-checkout',
        status: 'open',
        createdAt: 2,
        expiresAt: 100,
      },
    });
    expect(() => transitionPhoneTaskV2(waiting, {
      ...eventBase(2),
      type: 'resolve_next_action',
      interactionId: 'interaction:no-checkout',
      responseRef: 'response:checkout',
      choice: 'review_checkout',
    })).toThrow('not authorized');
  });

  it('supports replacement, skip, retry, blocked, and ambiguous outcomes', () => {
    const replaced = transitionPhoneTaskV2(validTaskV2(), {
      ...eventBase(1),
      type: 'replace_step',
      stepId: 'step:first',
      replacement: {
        adapterId: 'replacement-adapter',
        kind: 'replacement_action',
        status: 'ready',
        dependsOn: [],
        input: { corrected: true },
        expectedPostcondition: { corrected: true },
        attempts: 2,
      },
    });
    expect(replaced.steps[0]).toMatchObject({
      adapterId: 'replacement-adapter',
      status: 'ready',
      attempts: 0,
    });

    const failed = transitionPhoneTaskV2(
      begin(replaced, 'step:first', 2),
      {
        ...eventBase(3),
        type: 'fail_step',
        stepId: 'step:first',
        resultRef: 'result:failed',
      },
    );
    expect(failed.steps[0]!.status).toBe('failed');
    const retried = transitionPhoneTaskV2(failed, {
      ...eventBase(4),
      type: 'retry_step',
      stepId: 'step:first',
    });
    expect(retried.steps[0]!.status).toBe('ready');

    const blocked = transitionPhoneTaskV2(retried, {
      ...eventBase(5),
      type: 'block_step',
      stepId: 'step:first',
      resultRef: 'result:blocked',
    });
    expect(blocked.status).toBe('blocked');

    const skipped = transitionPhoneTaskV2(blocked, {
      ...eventBase(6),
      type: 'skip_step',
      stepId: 'step:first',
    });
    expect(skipped.steps.map((step) => step.status)).toEqual([
      'skipped',
      'ready',
    ]);

    const ambiguous = transitionPhoneTaskV2(
      begin(skipped, 'step:second', 7),
      {
        ...eventBase(8),
        type: 'mark_ambiguous',
        stepId: 'step:second',
        resultRef: 'result:ambiguous',
      },
    );
    expect(ambiguous.status).toBe('ambiguous');
  });

  it('adds a correction node while keeping the verified node byte-stable', () => {
    const verified = verify(begin(validTaskV2(), 'step:first', 1), 'step:first', 2);
    const originalVerified = structuredClone(verified.steps[0]);
    const correction: PhoneTaskStepV2 = {
      stepId: 'step:first-correction',
      adapterId: 'test-adapter',
      kind: 'correct_first_action',
      status: 'ready',
      dependsOn: [],
      input: { correction: true },
      expectedPostcondition: { corrected: true },
      attempts: 0,
    };

    const corrected = transitionPhoneTaskV2(verified, {
      ...eventBase(3),
      type: 'correct_verified_step',
      stepId: 'step:first',
      correction,
    });

    expect(corrected.steps[0]).toEqual(originalVerified);
    expect(corrected.steps[2]).toMatchObject({
      stepId: 'step:first-correction',
      status: 'ready',
      dependsOn: ['step:first'],
    });
  });

  it('rejects every direct attempt to execute or rewrite a verified step', () => {
    const verified = verify(begin(validTaskV2(), 'step:first', 1), 'step:first', 2);

    expect(() => begin(verified, 'step:first', 3))
      .toThrow(InvalidPhoneTaskV2TransitionError);
    expect(() => transitionPhoneTaskV2(verified, {
      ...eventBase(3),
      type: 'replace_step',
      stepId: 'step:first',
      replacement: {
        ...verified.steps[0]!,
        status: 'ready',
        input: { rewritten: true },
      },
    })).toThrow(InvalidPhoneTaskV2TransitionError);
    expect(() => transitionPhoneTaskV2(verified, {
      ...eventBase(3),
      type: 'skip_step',
      stepId: 'step:first',
    })).toThrow(InvalidPhoneTaskV2TransitionError);
  });

  it('cancels deterministically and rejects later transitions', () => {
    const cancelled = transitionPhoneTaskV2(validTaskV2(), {
      ...eventBase(1),
      type: 'cancel_task',
    });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      terminalAt: 2,
    });
    expect(() => begin(cancelled, 'step:first', 2))
      .toThrow('Terminal task');
  });

  it.each([
    ['verify before running', {
      ...eventBase(1),
      type: 'verify_step' as const,
      stepId: 'step:first',
      resultRef: 'result:invalid',
    }],
    ['begin a dependent step', {
      ...eventBase(1),
      type: 'begin_step' as const,
      stepId: 'step:second',
      operationId: 'operation:invalid',
    }],
    ['skip a running step', {
      ...eventBase(2),
      type: 'skip_step' as const,
      stepId: 'step:first',
    }],
  ])('rejects invalid transition: %s', (name, event) => {
    const task = name === 'skip a running step'
      ? begin(validTaskV2(), 'step:first', 1)
      : validTaskV2();
    expect(() => transitionPhoneTaskV2(task, event))
      .toThrow(InvalidPhoneTaskV2TransitionError);
  });
});
