import { describe, expect, it } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  CheckoutOrchestrationServiceV2,
  InMemoryCheckoutOrchestrationRepositoryV2,
  type CheckoutSessionAuthorityV2,
} from './orchestration-service';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const authority: CheckoutSessionAuthorityV2 = {
  clientId: 'android-client-1',
  ownerId: 'pixel-overlay',
  taskId,
  taskRevision: 9,
};
const currentPayment = {
  kind: 'card' as const,
  label: 'Mastercard 5555555555554444',
  methodRef: 'provider_payment_1',
};
const money = (amount: number) => ({ amount, currency: 'INR' as const });

function terms(
  overrides: Partial<AndroidCheckoutReviewV1> = {},
): AndroidCheckoutReviewV1 {
  return {
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
    ...overrides,
  };
}

async function reviewed(options: {
  codAvailable?: boolean;
  now?: () => number;
} = {}) {
  const repository = new InMemoryCheckoutOrchestrationRepositoryV2();
  const service = new CheckoutOrchestrationServiceV2(
    repository,
    options.now ?? (() => NOW),
  );
  const opened = await service.open({
    ...authority,
    checkoutId: 'checkout_session_1',
    codAvailable: options.codAvailable ?? true,
    currentPayment,
    originalGoalIncludesOrder: true,
  });
  const presented = await service.presentPaymentOptions({
    checkoutId: opened.checkoutId,
    expiresAt: NOW + 30_000,
    interactionId: 'checkout_payment_1',
  });
  const selected = await service.choosePayment({
    checkoutId: opened.checkoutId,
    choiceId: 'use_cod',
    interactionId: presented.paymentPresentation!.interactionId,
    taskRevision: authority.taskRevision,
  });
  if (!selected.resolution.accepted) {
    throw new Error('Expected COD selection.');
  }
  const prepared = await service.prepareCodReview({
    ...authority,
    checkoutId: opened.checkoutId,
    checkout: terms(),
    proposalTtlMs: 60_000,
  });
  if (!prepared.prepared) throw new Error('Expected COD review.');
  return { repository, service, record: prepared.record };
}

async function authorized(options: { now?: () => number } = {}) {
  const result = await reviewed(options);
  const confirmation = await result.service.authorizeCod({
    ...authority,
    checkoutId: result.record.checkoutId,
    confirmationText: 'Confirm COD order',
    currentTerms: terms(),
    grantId: 'checkout_grant_1',
    source: 'voice_coordinator',
  });
  if (!confirmation.authorized) throw new Error('Expected authorization.');
  return { ...result, record: confirmation.record };
}

describe('checkout orchestration service v2', () => {
  it('routes cart-only completion through an explicit next action', async () => {
    const repository = new InMemoryCheckoutOrchestrationRepositoryV2();
    const service = new CheckoutOrchestrationServiceV2(
      repository,
      () => NOW,
    );
    const opened = await service.open({
      ...authority,
      checkoutId: 'checkout_cart_only',
      codAvailable: true,
      currentPayment,
      originalGoalIncludesOrder: false,
    });
    expect(opened.graph.activeNode).toBe('choose_next_action');

    const continued = await service.chooseNextAction({
      checkoutId: opened.checkoutId,
      choice: 'review_checkout',
    });
    expect(continued.graph.activeNode).toBe('prepare_checkout');
    expect(continued.events.at(-1)).toMatchObject({
      kind: 'next_action_selected',
      detail: 'review_checkout',
    });
  });

  it('persists Mastercard-to-COD options, review, and NOT ORDERED state', async () => {
    const { repository, record } = await reviewed();

    expect(record.graph).toMatchObject({
      activeNode: 'await_final_confirmation',
      currentPayment: { kind: 'card', label: currentPayment.label },
      selectedPayment: 'cod',
      safetyLabel: 'NOT ORDERED',
      dispatchAttempts: 0,
    });
    expect(record.codState).toMatchObject({
      phase: 'review_not_ordered',
      clientId: authority.clientId,
      ownerId: authority.ownerId,
      safetyLabel: 'NOT ORDERED',
      previousPayment: { kind: 'card', label: currentPayment.label },
      proposal: { checkout: { paymentMode: 'cod' } },
    });
    expect(record.events.map(({ kind }) => kind)).toEqual([
      'checkout_opened',
      'payment_options_presented',
      'payment_selected',
      'review_prepared',
    ]);
    expect((await repository.get(record.checkoutId))?.recordRevision).toBe(3);
  });

  it('keeps unavailable COD disabled and cannot prepare it', async () => {
    const repository = new InMemoryCheckoutOrchestrationRepositoryV2();
    const service = new CheckoutOrchestrationServiceV2(
      repository,
      () => NOW,
    );
    const opened = await service.open({
      ...authority,
      checkoutId: 'checkout_no_cod',
      codAvailable: false,
      currentPayment,
      originalGoalIncludesOrder: true,
    });
    const presented = await service.presentPaymentOptions({
      checkoutId: opened.checkoutId,
      expiresAt: NOW + 30_000,
    });
    const result = await service.choosePayment({
      checkoutId: opened.checkoutId,
      choiceId: 'use_cod',
      interactionId: presented.paymentPresentation!.interactionId,
      taskRevision: authority.taskRevision,
    });

    expect(result.resolution).toEqual({
      accepted: false,
      reason: 'choice_unavailable',
    });
    expect(result.record.recordRevision).toBe(1);
    expect(result.record.graph.activeNode).toBe('choose_payment_method');
  });

  it('binds exact confirmation to client, owner, task, action, and terms', async () => {
    const { service, record } = await authorized();
    const state = record.codState;
    if (state?.phase !== 'confirmation_authorized') {
      throw new Error('Expected authorized state.');
    }

    expect(state.grant).toMatchObject({
      clientId: authority.clientId,
      ownerId: authority.ownerId,
      taskId: authority.taskId,
      taskRevision: authority.taskRevision,
      paymentMode: 'cod',
      proposalHash: state.proposal.proposalHash,
      terms: state.proposal.checkout,
      termsDigest: state.proposal.proposalHash,
      consumedAt: NOW,
    });
    expect(state.grant.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(service.beginDispatch({
      ...authority,
      clientId: 'other-client',
      checkoutId: record.checkoutId,
      currentTerms: terms(),
    })).rejects.toThrow('authority does not match');
  });

  it('requires the exact phrase and consumes confirmation only once', async () => {
    const reviewedResult = await reviewed();
    const vague = await reviewedResult.service.authorizeCod({
      ...authority,
      checkoutId: reviewedResult.record.checkoutId,
      confirmationText: 'yes',
      currentTerms: terms(),
      source: 'voice_coordinator',
    });
    expect(vague).toMatchObject({
      authorized: false,
      reason: 'exact_confirmation_required',
    });

    const exact = await reviewedResult.service.authorizeCod({
      ...authority,
      checkoutId: reviewedResult.record.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: terms(),
      source: 'voice_coordinator',
    });
    expect(exact.authorized).toBe(true);
    const duplicate = await reviewedResult.service.authorizeCod({
      ...authority,
      checkoutId: reviewedResult.record.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: terms(),
      source: 'voice_coordinator',
    });
    expect(duplicate).toMatchObject({
      authorized: false,
      reason: 'already_consumed',
    });
  });

  it.each([
    {
      name: 'cart',
      changed: terms({
        lines: [{
          ...terms().lines[0]!,
          lineTotal: money(66),
          quantity: 2,
        }],
        total: money(71),
      }),
      expected: ['items', 'total'],
    },
    {
      name: 'fees',
      changed: terms({
        fees: [{ amount: money(7), kind: 'handling', label: 'Handling' }],
        total: money(40),
      }),
      expected: ['fees', 'total'],
    },
  ])('invalidates a changed $name before authorization', async ({
    changed,
    expected,
  }) => {
    const { service, record } = await reviewed();
    const result = await service.authorizeCod({
      ...authority,
      checkoutId: record.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: changed,
      source: 'voice_coordinator',
    });

    expect(result).toMatchObject({
      authorized: false,
      reason: 'proposal_changed',
      changes: expect.arrayContaining(expected),
      record: {
        graph: {
          phase: 'blocked',
          dispatchAttempts: 0,
          retryAllowed: false,
        },
        codState: {
          phase: 'blocked',
          requiresFreshReview: true,
        },
      },
    });
    expect(result.record.events.at(-1)?.kind).toBe('checkout_invalidated');
  });

  it('invalidates changed terms after confirmation but before dispatch', async () => {
    const { service, record } = await authorized();
    const result = await service.beginDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      currentTerms: terms({
        fees: [{ amount: money(6), kind: 'handling', label: 'Handling' }],
        total: money(39),
      }),
    });

    expect(result).toMatchObject({
      started: false,
      reason: 'proposal_changed',
      changes: expect.arrayContaining(['fees', 'total']),
      record: {
        graph: { phase: 'blocked', dispatchAttempts: 0 },
      },
    });
  });

  it('reserves final dispatch once before exposing the provider command', async () => {
    const { service, record } = await authorized();
    const inputs = {
      ...authority,
      checkoutId: record.checkoutId,
      currentTerms: terms(),
    };
    const [first, second] = await Promise.all([
      service.beginDispatch(inputs),
      service.beginDispatch(inputs),
    ]);
    const started = [first, second].filter((result) => result.started);
    const rejected = [first, second].filter((result) => !result.started);

    expect(started).toHaveLength(1);
    expect(rejected).toEqual([
      expect.objectContaining({ reason: 'already_started' }),
    ]);
    expect(started[0]).toMatchObject({
      command: {
        confirmationGrantId: 'checkout_grant_1',
        expected: {
          checkout: { paymentMode: 'cod' },
        },
      },
      record: {
        codState: { phase: 'dispatching' },
        graph: { dispatchAttempts: 0 },
      },
    });
    if (started[0]?.started) {
      expect(started[0].command.expected.idempotencyKey)
        .toBe(`checkout.v2.${started[0].command.actionDigest}`);
    }
  });

  it('never reports ordered for a post-boundary disconnect and reconciles safely', async () => {
    const { service, record } = await authorized();
    const started = await service.beginDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      currentTerms: terms(),
    });
    if (!started.started) throw new Error('Expected dispatch reservation.');
    const ambiguous = await service.settleDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      result: {
        outcome: 'disconnected',
        crossedFinalActionBoundary: true,
      },
    });

    expect(ambiguous).toMatchObject({
      graph: {
        phase: 'ambiguous',
        activeNode: 'reconcile_order',
        dispatchAttempts: 1,
        reconciliationRequired: true,
        retryAllowed: false,
      },
      codState: {
        phase: 'ambiguous',
        reason: 'disconnect_after_dispatch',
      },
    });
    const ordered = await service.settleReconciliation({
      ...authority,
      checkoutId: record.checkoutId,
      result: {
        outcome: 'ordered',
        providerReference: 'order-safe-1',
      },
    });
    expect(ordered).toMatchObject({
      graph: { phase: 'ordered', providerReference: 'order-safe-1' },
      codState: { phase: 'ordered', providerReference: 'order-safe-1' },
    });
  });

  it('returns to NOT ORDERED after a proven pre-boundary disconnect', async () => {
    const { service, record } = await authorized();
    const started = await service.beginDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      currentTerms: terms(),
    });
    if (!started.started) throw new Error('Expected dispatch reservation.');
    const disconnected = await service.settleDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      result: {
        outcome: 'disconnected',
        crossedFinalActionBoundary: false,
      },
    });

    expect(disconnected).toMatchObject({
      graph: {
        activeNode: 'await_final_confirmation',
        dispatchAttempts: 0,
        safetyLabel: 'NOT ORDERED',
      },
      codState: {
        phase: 'review_not_ordered',
        requiresFinalConfirmation: true,
        safetyLabel: 'NOT ORDERED',
      },
    });
    expect(await service.beginDispatch({
      ...authority,
      checkoutId: record.checkoutId,
      currentTerms: terms(),
    })).toMatchObject({ started: false, reason: 'not_authorized' });
  });

  it('does not dispatch an expired confirmed proposal', async () => {
    let now = NOW;
    const result = await authorized({ now: () => now });
    now = NOW + 60_000;

    expect(await result.service.beginDispatch({
      ...authority,
      checkoutId: result.record.checkoutId,
      currentTerms: terms(),
    })).toMatchObject({
      started: false,
      reason: 'expired',
      record: { graph: { dispatchAttempts: 0 } },
    });
  });
});
