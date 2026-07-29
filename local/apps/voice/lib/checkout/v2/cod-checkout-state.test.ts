import { describe, expect, it } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  authorizeCodFinalConfirmationV2,
  beginCodFinalDispatchV2,
  prepareCodReviewV2,
  settleCodFinalDispatchV2,
} from './cod-checkout-state';
import { CheckoutConfirmationGrantLedgerV2 } from './confirmation-grants';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const money = (amount: number) => ({ amount, currency: 'INR' as const });
const checkout: AndroidCheckoutReviewV1 = {
  addressLabel: 'Home',
  addressReference: 'address_home',
  etaMinutes: 12,
  fees: [{ amount: money(5), kind: 'handling', label: 'Handling' }],
  lines: [{
    lineTotal: money(33),
    name: 'Milk',
    productId: 'milk',
    quantity: 1,
    unitPrice: money(33),
  }],
  paymentMode: 'cod',
  providerFingerprint: 'c'.repeat(64),
  total: money(38),
  unavailableItems: [],
};

function review() {
  const result = prepareCodReviewV2({
    checkout,
    clientId: 'android-client-1',
    codAvailable: true,
    now: new Date(NOW),
    ownerId: 'pixel-overlay',
    previousPayment: {
      kind: 'card',
      label: 'Mastercard',
      methodRef: 'provider_payment_1',
    },
    proposalTtlMs: 60_000,
    taskId,
    taskRevision: 5,
  });
  if (!result.prepared) throw new Error('Expected COD review.');
  return result.state;
}

function dispatching() {
  const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => NOW });
  const authorized = authorizeCodFinalConfirmationV2({
    confirmationText: 'Confirm COD order',
    currentTerms: checkout,
    ledger,
    source: 'voice_coordinator',
    state: review(),
  });
  if (!authorized.authorized) throw new Error('Expected authorization.');
  return beginCodFinalDispatchV2(authorized.state, NOW);
}

describe('COD checkout state v2', () => {
  it('moves Mastercard to a fresh COD review that remains NOT ORDERED', () => {
    const state = review();

    expect(state).toMatchObject({
      phase: 'review_not_ordered',
      safetyLabel: 'NOT ORDERED',
      requiresFinalConfirmation: true,
      previousPayment: { kind: 'card', label: 'Mastercard' },
      proposal: {
        paymentMode: 'cod',
        checkout: { paymentMode: 'cod' },
      },
    });
  });

  it('does not prepare a COD proposal when COD is unavailable', () => {
    expect(prepareCodReviewV2({
      checkout,
      clientId: 'android-client-1',
      codAvailable: false,
      now: new Date(NOW),
      ownerId: 'pixel-overlay',
      proposalTtlMs: 60_000,
      taskId,
      taskRevision: 5,
    })).toEqual({ prepared: false, reason: 'cod_unavailable' });
  });

  it('does not mint a second authorization from a stale review state', () => {
    const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => NOW });
    const staleReview = review();
    const first = authorizeCodFinalConfirmationV2({
      confirmationText: 'Confirm COD order',
      currentTerms: checkout,
      ledger,
      source: 'voice_coordinator',
      state: staleReview,
    });
    expect(first.authorized).toBe(true);

    expect(authorizeCodFinalConfirmationV2({
      confirmationText: 'Confirm COD order',
      currentTerms: checkout,
      ledger,
      source: 'voice_coordinator',
      state: staleReview,
    })).toEqual({ authorized: false, reason: 'already_consumed' });
  });

  it('returns to NOT ORDERED review after a proven pre-dispatch disconnect', () => {
    expect(settleCodFinalDispatchV2(dispatching(), {
      outcome: 'disconnected',
      crossedFinalActionBoundary: false,
    })).toMatchObject({
      phase: 'review_not_ordered',
      safetyLabel: 'NOT ORDERED',
      requiresFinalConfirmation: true,
      interruption: 'disconnect_before_dispatch',
    });
  });

  it('makes a post-dispatch disconnect permanently ambiguous', () => {
    expect(settleCodFinalDispatchV2(dispatching(), {
      outcome: 'disconnected',
      crossedFinalActionBoundary: true,
    })).toMatchObject({
      phase: 'ambiguous',
      reconciliationRequired: true,
      retryAllowed: false,
      reason: 'disconnect_after_dispatch',
    });
  });

  it('preserves an ambiguous provider result and never reports ordered', () => {
    expect(settleCodFinalDispatchV2(dispatching(), {
      outcome: 'ambiguous',
    })).toMatchObject({
      phase: 'ambiguous',
      reconciliationRequired: true,
      retryAllowed: false,
      reason: 'provider_result_ambiguous',
    });
  });

  it('reports ordered only for a committed provider result', () => {
    expect(settleCodFinalDispatchV2(dispatching(), {
      outcome: 'committed',
      providerReference: 'order-safe-1',
    })).toMatchObject({
      phase: 'ordered',
      providerReference: 'order-safe-1',
    });
  });
});
