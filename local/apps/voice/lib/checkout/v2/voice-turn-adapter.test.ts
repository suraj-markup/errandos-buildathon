import { describe, expect, it, vi } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { buildCodCheckoutProposal } from '../../cod';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import {
  CheckoutOrchestrationServiceV2,
  InMemoryCheckoutOrchestrationRepositoryV2,
  type CheckoutSessionAuthorityV2,
} from './orchestration-service';
import { VoiceTurnCheckoutAdapterV2 } from './voice-turn-adapter';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const authority: CheckoutSessionAuthorityV2 = {
  clientId: 'android-client-1',
  ownerId: 'pixel-overlay',
  taskId: parseLocalIdentifier(
    'task',
    'task_12345678-1234-1234-1234-123456789abc',
  ),
  taskRevision: 17,
};
const otherTaskId = parseLocalIdentifier(
  'task',
  'task_22345678-1234-1234-1234-123456789abc',
);
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

function phonePrepareResult() {
  return {
    checkout: buildCodCheckoutProposal(
      terms(),
      new Date(NOW),
      60_000,
    ),
    confirmationPhrase: 'Confirm COD order',
    message: 'Review these exact terms. Nothing has been ordered.',
    ok: false,
    status: 'confirmation_required',
  };
}

function fixture() {
  const repository = new InMemoryCheckoutOrchestrationRepositoryV2();
  const service = new CheckoutOrchestrationServiceV2(repository, () => NOW);
  return {
    adapter: new VoiceTurnCheckoutAdapterV2(service, () => NOW),
    repository,
    service,
  };
}

async function prepared() {
  const test = fixture();
  const result = await test.adapter.prepareCodCheckout({
    ...authority,
    currentPayment: {
      kind: 'card',
      label: 'Mastercard',
      methodRef: 'provider_payment_1',
    },
    phoneResult: phonePrepareResult(),
  });
  if (result.status !== 'confirmation_required') {
    throw new Error('Expected checkout preparation.');
  }
  return { ...test, result };
}

describe('voice-turn checkout adapter v2', () => {
  it('translates a phone prepare result into a persisted coordinator result', async () => {
    const { result, service } = await prepared();
    const record = await service.get(result.checkoutId);

    expect(result).toMatchObject({
      checkoutTaskRevision: authority.taskRevision,
      confirmationPhrase: 'Confirm COD order',
      ok: false,
      safetyLabel: 'NOT ORDERED',
      status: 'confirmation_required',
      checkout: { checkout: { paymentMode: 'cod' } },
    });
    expect(result.checkoutId).toMatch(/^checkout_session_/);
    expect(record).toMatchObject({
      taskRevision: authority.taskRevision,
      graph: {
        activeNode: 'await_final_confirmation',
        dispatchAttempts: 0,
        safetyLabel: 'NOT ORDERED',
        selectedPayment: 'cod',
      },
      codState: {
        phase: 'review_not_ordered',
        previousPayment: { kind: 'card', label: 'Mastercard' },
      },
    });
  });

  it('also adopts an already-selected COD phone review', async () => {
    const { adapter, service } = fixture();
    const result = await adapter.prepareCodCheckout({
      ...authority,
      phoneResult: phonePrepareResult(),
    });
    if (result.status !== 'confirmation_required') {
      throw new Error('Expected checkout preparation.');
    }

    expect(await service.get(result.checkoutId)).toMatchObject({
      graph: {
        currentPayment: { kind: 'cod' },
        selectedPayment: 'current',
        activeNode: 'await_final_confirmation',
      },
    });
  });

  it('promotes a review-only goal only after exact later order confirmation', async () => {
    const { adapter, service } = fixture();
    const result = await adapter.prepareCodCheckout({
      ...authority,
      originalGoalIncludesOrder: false,
      phoneResult: phonePrepareResult(),
    });
    if (result.status !== 'confirmation_required') {
      throw new Error('Expected checkout preparation.');
    }
    await expect(service.get(result.checkoutId)).resolves.toMatchObject({
      graph: { phase: 'checkout_reviewed', activeNode: undefined },
    });
    const commit = vi.fn(async () => ({
      ok: true,
      providerReference: 'order-promoted-1',
      status: 'ordered',
    }));
    const base = {
      ...authority,
      checkoutId: result.checkoutId,
      readCurrentTerms: () => terms(),
      commit,
    };

    await expect(adapter.confirmCodCheckout({
      ...base,
      confirmationText: 'yes',
    })).resolves.toMatchObject({ status: 'confirmation_required' });
    expect(commit).not.toHaveBeenCalled();
    await expect(adapter.confirmCodCheckout({
      ...base,
      confirmationText: 'Confirm COD order',
    })).resolves.toMatchObject({
      providerReference: 'order-promoted-1',
      status: 'ordered',
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('fails closed for an incomplete or expired phone review', async () => {
    const { adapter } = fixture();
    await expect(adapter.prepareCodCheckout({
      ...authority,
      phoneResult: {
        ok: false,
        status: 'confirmation_required',
      },
    })).resolves.toMatchObject({
      reason: 'invalid_prepare_result',
      status: 'checkout_orchestration_rejected',
    });

    const expired = phonePrepareResult();
    expired.checkout = {
      ...expired.checkout,
      expiresAt: new Date(NOW).toISOString(),
    };
    await expect(adapter.prepareCodCheckout({
      ...authority,
      phoneResult: expired,
    })).resolves.toMatchObject({
      reason: 'expired_prepare_result',
      status: 'checkout_orchestration_rejected',
    });
  });

  it('never calls commit for vague confirmation or changed exact terms', async () => {
    const { adapter, result } = await prepared();
    const commit = vi.fn();
    await expect(adapter.confirmCodCheckout({
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'yes',
      readCurrentTerms: () => terms(),
      commit,
    })).resolves.toMatchObject({
      ok: false,
      status: 'confirmation_required',
    });
    expect(commit).not.toHaveBeenCalled();

    const changed = await prepared();
    await expect(changed.adapter.confirmCodCheckout({
      ...authority,
      checkoutId: changed.result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms({
        fees: [{ amount: money(7), kind: 'handling', label: 'Handling' }],
        total: money(40),
      }),
      commit,
    })).resolves.toMatchObject({
      changes: expect.arrayContaining(['fees', 'total']),
      ok: false,
      status: 'checkout_changed',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('re-reads terms after authorization and before dispatch', async () => {
    const { adapter, result } = await prepared();
    const readCurrentTerms = vi.fn()
      .mockReturnValueOnce(terms())
      .mockReturnValueOnce(terms({
        lines: [{
          ...terms().lines[0]!,
          lineTotal: money(66),
          quantity: 2,
        }],
        total: money(71),
      }));
    const commit = vi.fn();

    await expect(adapter.confirmCodCheckout({
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms,
      commit,
    })).resolves.toMatchObject({
      changes: expect.arrayContaining(['items', 'total']),
      status: 'checkout_changed',
    });
    expect(readCurrentTerms).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('persists started:true before exposing the legacy commit callback', async () => {
    const { adapter, result, service } = await prepared();
    const commit = vi.fn(async ({ command, checkoutProposal }) => {
      await expect(service.get(result.checkoutId)).resolves.toMatchObject({
        codState: { phase: 'dispatching' },
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'dispatch_started' }),
        ]),
      });
      expect(checkoutProposal.idempotencyKey)
        .toBe(`checkout.v2.${command.actionDigest}`);
      return {
        ok: true,
        providerReference: 'order-safe-1',
        status: 'ordered',
      };
    });

    await expect(adapter.confirmCodCheckout({
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms(),
      commit,
    })).resolves.toEqual({
      checkoutId: result.checkoutId,
      checkoutTaskRevision: authority.taskRevision,
      message: 'COD order confirmed.',
      ok: true,
      providerReference: 'order-safe-1',
      status: 'ordered',
    });
    expect(commit).toHaveBeenCalledOnce();
    await expect(service.get(result.checkoutId)).resolves.toMatchObject({
      graph: { phase: 'ordered', dispatchAttempts: 1 },
      codState: { phase: 'ordered' },
    });
  });

  it('does not call commit again for a duplicate confirmation', async () => {
    const { adapter, result } = await prepared();
    const commit = vi.fn(async () => ({
      ok: true,
      providerReference: 'order-safe-1',
      status: 'ordered',
    }));
    const input = {
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms(),
      commit,
    };

    await adapter.confirmCodCheckout(input);
    await expect(adapter.confirmCodCheckout(input)).resolves.toMatchObject({
      ok: true,
      providerReference: 'order-safe-1',
      status: 'ordered',
    });
    expect(commit).toHaveBeenCalledOnce();
  });

  it('serializes concurrent exact confirmations to one provider commit', async () => {
    const { adapter, result } = await prepared();
    const commit = vi.fn(async () => ({
      ok: true,
      providerReference: 'order-concurrent-1',
      status: 'ordered',
    }));
    const input = {
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms(),
      commit,
    };

    const settled = await Promise.all([
      adapter.confirmCodCheckout(input),
      adapter.confirmCodCheckout(input),
    ]);
    expect(commit).toHaveBeenCalledOnce();
    expect(settled).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerReference: 'order-concurrent-1',
        status: 'ordered',
      }),
    ]));
    expect(settled.every(({ status }) =>
      status === 'ordered' || status === 'order_status_ambiguous')).toBe(true);
  });

  it('makes thrown and ambiguous commit outcomes permanently non-retryable', async () => {
    for (const commit of [
      vi.fn(async () => {
        throw new Error('transport timeout');
      }),
      vi.fn(async () => ({
        ok: false,
        reconciliationRequired: true,
        status: 'order_status_ambiguous',
      })),
    ]) {
      const { adapter, result } = await prepared();
      const input = {
        ...authority,
        checkoutId: result.checkoutId,
        confirmationText: 'Confirm COD order',
        readCurrentTerms: () => terms(),
        commit,
      };
      await expect(adapter.confirmCodCheckout(input)).resolves.toMatchObject({
        ok: false,
        reconciliationRequired: true,
        retryAllowed: false,
        status: 'order_status_ambiguous',
      });
      await adapter.confirmCodCheckout(input);
      expect(commit).toHaveBeenCalledOnce();
    }
  });

  it('does not replay a dispatch reservation recovered after restart', async () => {
    const { adapter, result, service } = await prepared();
    const authorization = await service.authorizeCod({
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      currentTerms: terms(),
      source: 'voice_coordinator',
    });
    if (!authorization.authorized) throw new Error('Expected authorization.');
    const started = await service.beginDispatch({
      ...authority,
      checkoutId: result.checkoutId,
      currentTerms: terms(),
    });
    if (!started.started) throw new Error('Expected dispatch reservation.');
    const commit = vi.fn();

    await expect(adapter.confirmCodCheckout({
      ...authority,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms(),
      commit,
    })).resolves.toMatchObject({
      reconciliationRequired: true,
      retryAllowed: false,
      status: 'order_status_ambiguous',
    });
    expect(commit).not.toHaveBeenCalled();
    await expect(service.get(result.checkoutId)).resolves.toMatchObject({
      graph: {
        phase: 'ambiguous',
        dispatchAttempts: 1,
        activeNode: 'reconcile_order',
      },
    });
  });

  it('requires the exact task revision retained by the prepare result', async () => {
    const { adapter, result } = await prepared();
    const commit = vi.fn();

    await expect(adapter.confirmCodCheckout({
      ...authority,
      taskRevision: result.checkoutTaskRevision + 1,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms: () => terms(),
      commit,
    })).rejects.toThrow('authority does not match');
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['client', { clientId: 'other-client' }],
    ['owner', { ownerId: 'other-owner' }],
    ['task', { taskId: otherTaskId }],
    ['revision', { taskRevision: authority.taskRevision + 1 }],
  ])('rejects mismatched %s authority before phone reads or commit', async (
    _label,
    mismatch,
  ) => {
    const { adapter, result } = await prepared();
    const readCurrentTerms = vi.fn(() => terms());
    const commit = vi.fn();

    await expect(adapter.confirmCodCheckout({
      ...authority,
      ...mismatch,
      checkoutId: result.checkoutId,
      confirmationText: 'Confirm COD order',
      readCurrentTerms,
      commit,
    })).rejects.toThrow('authority does not match');
    expect(readCurrentTerms).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});
