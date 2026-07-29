import { describe, expect, it } from 'vitest';
import type {
  DesiredTerminalOutcomeV2,
  PhoneTaskV2,
} from './contracts';
import {
  buildCommerceContinuationNodesV2,
  transitionCommerceStepVerifiedV2,
  type CommerceContinuationNodeIdsV2,
} from './commerce-continuation';
import { transitionPhoneTaskV2 } from './graph';
import { validTaskV2 } from './test-fixtures';

const nodeIds: CommerceContinuationNodeIdsV2 = {
  askNext: 'step:ask-next',
  reviewCheckout: 'step:review-checkout',
  choosePayment: 'step:choose-payment',
  selectPayment: 'step:select-payment',
  prepareProposal: 'step:prepare-proposal',
  finalConfirmation: 'step:final-confirmation',
  finalDispatch: 'step:final-dispatch',
};

function oneItemTask(outcome: DesiredTerminalOutcomeV2): PhoneTaskV2 {
  const task = validTaskV2();
  task.originalGoal = `Goal ending in ${outcome.kind}`;
  task.desiredTerminalOutcome = outcome;
  task.steps = [task.steps[0]!];
  return task;
}

function begin(task: PhoneTaskV2, stepId: string, label: string): PhoneTaskV2 {
  return transitionPhoneTaskV2(task, {
    type: 'begin_step',
    stepId,
    operationId: `operation:${label}`,
    entryId: `journal:begin:${label}`,
    at: task.updatedAt + 1,
  });
}

function verify(
  task: PhoneTaskV2,
  stepId: string,
  label: string,
  withInteraction = false,
): PhoneTaskV2 {
  const at = task.updatedAt + 1;
  return transitionCommerceStepVerifiedV2({
    task,
    stepId,
    resultRef: `result:${label}`,
    at,
    journalEntryId: `journal:verify:${label}`,
    adapterId: 'blinkit',
    nodeIds,
    ...(withInteraction
      ? {
        interaction: {
          interactionId: `interaction:${label}`,
          presentationRef: `presentation:${label}`,
          expiresAt: at + 100,
          journalEntryId: `journal:interaction:${label}`,
        },
      }
      : {}),
  });
}

function complete(
  task: PhoneTaskV2,
  stepId: string,
  label: string,
  withInteraction = false,
): PhoneTaskV2 {
  return verify(begin(task, stepId, label), stepId, label, withInteraction);
}

describe('desired-outcome commerce graph continuation', () => {
  it('completes a cart-only goal without creating checkout work', () => {
    const task = oneItemTask({ kind: 'cart_ready' });
    const completed = complete(task, 'step:first', 'product');

    expect(completed.status).toBe('completed');
    expect(completed.steps.map((step) => step.kind)).toEqual(['first_action']);
  });

  it('turns cart completion into an interactive ask-next node', () => {
    const task = oneItemTask({ kind: 'ask_next' });
    const waiting = complete(task, 'step:first', 'product', true);

    expect(waiting.status).toBe('waiting_for_user');
    expect(waiting.steps.map((step) => [step.kind, step.status])).toEqual([
      ['first_action', 'verified'],
      ['ask_next', 'waiting_for_user'],
    ]);
    expect(waiting.pendingInteraction).toMatchObject({
      kind: 'next_action',
      allowedResponses: ['add_more', 'review_checkout', 'stop'],
    });
  });

  it('continues directly to checkout review using the saved payment method', () => {
    const task = oneItemTask({
      kind: 'checkout_reviewed',
      paymentPreference: 'provider_saved',
    });
    const afterProduct = complete(task, 'step:first', 'product');

    expect(afterProduct.steps.at(-1)).toMatchObject({
      kind: 'review_checkout',
      status: 'ready',
    });
    const reviewed = complete(
      afterProduct,
      nodeIds.reviewCheckout,
      'review',
    );
    expect(reviewed.status).toBe('completed');
  });

  it('builds COD selection and a NOT ORDERED review without final dispatch', () => {
    const task = oneItemTask({
      kind: 'checkout_reviewed',
      paymentPreference: 'cod',
    });
    const afterProduct = complete(task, 'step:first', 'product');
    const afterReview = complete(
      afterProduct,
      nodeIds.reviewCheckout,
      'review',
    );
    const afterPayment = complete(
      afterReview,
      nodeIds.selectPayment,
      'select-cod',
    );
    const reviewed = complete(
      afterPayment,
      nodeIds.prepareProposal,
      'proposal',
    );

    expect(reviewed.status).toBe('completed');
    expect(reviewed.steps.map((step) => step.kind)).toEqual([
      'first_action',
      'review_checkout',
      'select_payment_method',
      'prepare_checkout_proposal',
    ]);
    expect(reviewed.steps.at(-1)?.expectedPostcondition).toMatchObject({
      kind: 'fresh_checkout_proposal',
      presentationState: 'NOT_ORDERED',
    });
    expect(reviewed.steps.some((step) => step.kind === 'dispatch_order'))
      .toBe(false);
  });

  it('stops an order goal at a fresh confirmation before dispatch', () => {
    const task = oneItemTask({
      kind: 'order_placed',
      paymentPreference: 'cod',
    });
    const afterProduct = complete(task, 'step:first', 'product');
    const afterReview = complete(
      afterProduct,
      nodeIds.reviewCheckout,
      'review',
    );
    const afterPayment = complete(
      afterReview,
      nodeIds.selectPayment,
      'select-cod',
    );
    const waiting = complete(
      afterPayment,
      nodeIds.prepareProposal,
      'proposal',
      true,
    );

    expect(waiting.status).toBe('waiting_for_user');
    expect(waiting.pendingInteraction).toMatchObject({
      kind: 'checkout_confirmation',
      allowedResponses: ['confirm_exact_proposal', 'cancel'],
    });
    expect(waiting.steps.find((step) =>
      step.stepId === nodeIds.finalConfirmation)).toMatchObject({
      status: 'waiting_for_user',
      expectedPostcondition: {
        kind: 'fresh_confirmation_grant',
        singleUse: true,
        expires: true,
      },
    });
    expect(waiting.steps.find((step) =>
      step.stepId === nodeIds.finalDispatch)).toMatchObject({
      status: 'planned',
      attempts: 0,
      input: {
        requiresConfirmationStepId: nodeIds.finalConfirmation,
        genericToolUnavailable: true,
      },
    });
    expect(waiting.steps.find((step) =>
      step.stepId === nodeIds.finalDispatch)?.operationId).toBeUndefined();
  });

  it('builds an explicit payment-choice node when the user must choose', () => {
    const nodes = buildCommerceContinuationNodesV2({
      adapterId: 'blinkit',
      anchorStepIds: ['step:product'],
      desiredTerminalOutcome: {
        kind: 'order_placed',
        paymentPreference: 'ask_user',
      },
      nodeIds,
    });

    expect(nodes.map((step) => step.kind)).toEqual([
      'review_checkout',
      'choose_payment_method',
      'prepare_checkout_proposal',
      'await_final_confirmation',
      'dispatch_order',
    ]);
    expect(nodes.find((step) =>
      step.kind === 'choose_payment_method')?.input).toEqual({
      choices: ['current_method', 'cod', 'add_more', 'stop'],
    });
  });
});
