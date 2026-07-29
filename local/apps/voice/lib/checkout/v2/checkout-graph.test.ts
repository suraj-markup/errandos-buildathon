import { describe, expect, it } from 'vitest';
import type { CheckoutConfirmationGrantV2 } from './contracts';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  CHECKOUT_NODE_KINDS_V2,
  createCheckoutGraphV2,
  transitionCheckoutGraphV2,
  type CheckoutGraphV2,
  type CheckoutReviewBindingV2,
} from './checkout-graph';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const payment = {
  kind: 'card' as const,
  label: 'Mastercard',
  methodRef: 'provider_payment_1',
};
const review: CheckoutReviewBindingV2 = {
  proposalId: 'checkout_proposal_1',
  proposalHash: 'a'.repeat(64),
  termsDigest: 'a'.repeat(64),
  paymentMode: 'cod',
  preparedAt: NOW,
  expiresAt: NOW + 60_000,
};

function create(order = true): CheckoutGraphV2 {
  return createCheckoutGraphV2({
    originalGoalIncludesOrder: order,
    taskId,
    taskRevision: 7,
  });
}

function inspected(order = true): CheckoutGraphV2 {
  return transitionCheckoutGraphV2(create(order), {
    type: 'cart_inspected',
    currentPayment: payment,
    codAvailable: true,
  });
}

function awaitingConfirmation(): CheckoutGraphV2 {
  let graph = inspected();
  graph = transitionCheckoutGraphV2(graph, { type: 'checkout_prepared' });
  graph = transitionCheckoutGraphV2(graph, {
    type: 'payment_selected',
    choice: 'use_cod',
  });
  return transitionCheckoutGraphV2(graph, {
    type: 'review_prepared',
    review,
    now: NOW,
  });
}

function grant(
  overrides: Partial<CheckoutConfirmationGrantV2> = {},
): CheckoutConfirmationGrantV2 & { consumedAt: number } {
  return {
    version: 2,
    grantId: 'checkout_grant_1',
    taskId,
    taskRevision: 7,
    clientId: 'android-client-1',
    ownerId: 'pixel-overlay',
    actionDigest: 'b'.repeat(64),
    proposalId: review.proposalId,
    proposalHash: review.proposalHash,
    proposalPreparedAt: new Date(NOW).toISOString(),
    proposalExpiresAt: new Date(review.expiresAt).toISOString(),
    terms: {} as CheckoutConfirmationGrantV2['terms'],
    termsDigest: review.termsDigest,
    paymentMode: 'cod',
    issuedAt: NOW,
    expiresAt: review.expiresAt,
    consumedAt: NOW,
    ...overrides,
  };
}

function dispatching(): CheckoutGraphV2 {
  return transitionCheckoutGraphV2(awaitingConfirmation(), {
    type: 'confirmation_authorized',
    grant: grant(),
    now: NOW + 1,
  });
}

describe('checkout graph v2', () => {
  it('declares all checkout nodes and routes an order goal into preparation', () => {
    const graph = inspected();

    expect(graph.nodes.map(({ kind }) => kind)).toEqual(
      CHECKOUT_NODE_KINDS_V2,
    );
    expect(graph.activeNode).toBe('prepare_checkout');
    expect(graph.nodes.find(({ kind }) => kind === 'choose_next_action'))
      .toMatchObject({ status: 'skipped' });
  });

  it('routes a cart-only goal to next action before checkout', () => {
    let graph = inspected(false);
    expect(graph.activeNode).toBe('choose_next_action');

    graph = transitionCheckoutGraphV2(graph, {
      type: 'next_action_selected',
      choice: 'review_checkout',
    });
    expect(graph.activeNode).toBe('prepare_checkout');
  });

  it('completes a cart-only checkout review without creating order authority', () => {
    let graph = inspected(false);
    graph = transitionCheckoutGraphV2(graph, {
      type: 'next_action_selected',
      choice: 'review_checkout',
    });
    graph = transitionCheckoutGraphV2(graph, { type: 'checkout_prepared' });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'payment_selected',
      choice: 'continue_current',
    });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'review_prepared',
      review: {
        ...review,
        paymentMode: 'card',
      },
      now: NOW,
    });

    expect(graph).toMatchObject({
      phase: 'checkout_reviewed',
      activeNode: undefined,
      selectedPayment: 'current',
      safetyLabel: 'NOT ORDERED',
      dispatchAttempts: 0,
    });
    expect(graph.confirmationGrantId).toBeUndefined();
  });

  it('promotes a fresh cart-only review after a later explicit order request', () => {
    let graph = inspected(false);
    graph = transitionCheckoutGraphV2(graph, {
      type: 'next_action_selected',
      choice: 'review_checkout',
    });
    graph = transitionCheckoutGraphV2(graph, { type: 'checkout_prepared' });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'payment_selected',
      choice: 'use_cod',
    });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'review_prepared',
      review,
      now: NOW,
    });

    expect(transitionCheckoutGraphV2(graph, {
      type: 'order_requested',
      now: NOW + 1,
    })).toMatchObject({
      originalGoalIncludesOrder: true,
      phase: 'active',
      activeNode: 'await_final_confirmation',
      safetyLabel: 'NOT ORDERED',
      dispatchAttempts: 0,
    });
  });

  it('shows current payment choices and refuses unavailable COD', () => {
    let graph = transitionCheckoutGraphV2(create(), {
      type: 'cart_inspected',
      currentPayment: payment,
      codAvailable: false,
    });
    graph = transitionCheckoutGraphV2(graph, { type: 'checkout_prepared' });

    expect(graph).toMatchObject({
      activeNode: 'choose_payment_method',
      currentPayment: payment,
      codAvailable: false,
    });
    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'payment_selected',
      choice: 'use_cod',
    })).toThrow('Cash on Delivery is unavailable');
  });

  it('selects COD for a NOT-ORDERED review before confirmation or dispatch', () => {
    const graph = awaitingConfirmation();

    expect(graph).toMatchObject({
      phase: 'active',
      activeNode: 'await_final_confirmation',
      selectedPayment: 'cod',
      review,
      safetyLabel: 'NOT ORDERED',
      dispatchAttempts: 0,
    });
    expect(graph.nodes.find(({ kind }) => kind === 'dispatch_order'))
      .toMatchObject({ status: 'planned' });
  });

  it('binds final confirmation to the exact task revision and proposal', () => {
    const graph = awaitingConfirmation();

    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'confirmation_authorized',
      grant: grant({ proposalHash: 'c'.repeat(64) }),
      now: NOW + 1,
    })).toThrow('does not match the reviewed proposal');
    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'confirmation_authorized',
      grant: grant({ taskRevision: 8 }),
      now: NOW + 1,
    })).toThrow('does not match the reviewed proposal');
    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'confirmation_authorized',
      grant: grant({ termsDigest: 'd'.repeat(64) }),
      now: NOW + 1,
    })).toThrow('does not match the reviewed proposal');
    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'confirmation_authorized',
      grant: grant({ paymentMode: 'card' as never }),
      now: NOW + 1,
    })).toThrow('does not match the reviewed proposal');

    expect(transitionCheckoutGraphV2(graph, {
      type: 'confirmation_authorized',
      grant: grant(),
      now: NOW + 1,
    })).toMatchObject({
      activeNode: 'dispatch_order',
      confirmationGrantId: 'checkout_grant_1',
      dispatchAttempts: 0,
    });
  });

  it('invalidates a reviewed proposal after changed cart or fees', () => {
    for (const changes of [['items'], ['fees']] as const) {
      expect(transitionCheckoutGraphV2(awaitingConfirmation(), {
        type: 'checkout_invalidated',
        changes,
      })).toMatchObject({
        phase: 'blocked',
        invalidation: {
          changes,
          requiresFreshReview: true,
        },
        retryAllowed: false,
      });
    }
  });

  it('rejects an expired review and an expired confirmation grant', () => {
    let graph = inspected();
    graph = transitionCheckoutGraphV2(graph, { type: 'checkout_prepared' });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'payment_selected',
      choice: 'use_cod',
    });
    expect(() => transitionCheckoutGraphV2(graph, {
      type: 'review_prepared',
      review: { ...review, expiresAt: NOW },
      now: NOW,
    })).toThrow('already expired');

    expect(() => transitionCheckoutGraphV2(awaitingConfirmation(), {
      type: 'confirmation_authorized',
      grant: grant({ expiresAt: NOW }),
      now: NOW,
    })).toThrow('expired');
  });

  it('requires a fresh confirmation after a proven pre-dispatch disconnect', () => {
    const graph = transitionCheckoutGraphV2(dispatching(), {
      type: 'dispatch_settled',
      result: {
        outcome: 'disconnected',
        crossedFinalActionBoundary: false,
      },
    });

    expect(graph).toMatchObject({
      phase: 'active',
      activeNode: 'await_final_confirmation',
      dispatchAttempts: 0,
      interruption: 'disconnect_before_dispatch',
    });
    expect(graph.confirmationGrantId).toBeUndefined();
  });

  it('allows one committed final dispatch and rejects a duplicate result', () => {
    const ordered = transitionCheckoutGraphV2(dispatching(), {
      type: 'dispatch_settled',
      result: {
        outcome: 'committed',
        providerReference: 'order-safe-1',
      },
    });

    expect(ordered).toMatchObject({
      phase: 'ordered',
      dispatchAttempts: 1,
      providerReference: 'order-safe-1',
    });
    expect(() => transitionCheckoutGraphV2(ordered, {
      type: 'dispatch_settled',
      result: {
        outcome: 'committed',
        providerReference: 'order-duplicate',
      },
    })).toThrow('Expected active checkout node dispatch_order');
  });

  it('routes post-boundary disconnect and ambiguous results to reconciliation', () => {
    for (const result of [
      {
        outcome: 'disconnected' as const,
        crossedFinalActionBoundary: true,
      },
      { outcome: 'ambiguous' as const },
    ]) {
      const graph = transitionCheckoutGraphV2(dispatching(), {
        type: 'dispatch_settled',
        result,
      });
      expect(graph).toMatchObject({
        phase: 'ambiguous',
        activeNode: 'reconcile_order',
        dispatchAttempts: 1,
        reconciliationRequired: true,
        retryAllowed: false,
      });
    }
  });

  it('only marks an ambiguous dispatch ordered after provider evidence', () => {
    const ambiguous = transitionCheckoutGraphV2(dispatching(), {
      type: 'dispatch_settled',
      result: { outcome: 'ambiguous' },
    });
    const ordered = transitionCheckoutGraphV2(ambiguous, {
      type: 'reconciliation_settled',
      result: {
        outcome: 'ordered',
        providerReference: 'receipt-1',
      },
    });

    expect(ordered).toMatchObject({
      phase: 'ordered',
      providerReference: 'receipt-1',
      dispatchAttempts: 1,
    });
    expect(ordered.reconciliationRequired).toBeUndefined();
  });
});
