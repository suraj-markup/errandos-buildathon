import { describe, expect, it } from 'vitest';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { buildCodCheckoutProposal } from '../../cod';
import {
  CheckoutConfirmationGrantLedgerV2,
  checkoutFinalActionDigestV2,
} from './confirmation-grants';

const NOW = Date.parse('2026-07-28T06:00:00.000Z');
const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
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

function fixture() {
  const checkout = terms();
  const proposal = buildCodCheckoutProposal(
    checkout,
    new Date(NOW),
    60_000,
  );
  const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => NOW });
  const grant = ledger.issue({
    clientId: 'android-client-1',
    confirmationText: 'Confirm COD order',
    grantId: 'checkout_grant_12345678',
    ownerId: 'pixel-overlay',
    proposal,
    source: 'voice_coordinator',
    taskId,
    taskRevision: 8,
  });
  const authorization = {
    actionDigest: checkoutFinalActionDigestV2({
      clientId: 'android-client-1',
      ownerId: 'pixel-overlay',
      proposal,
      taskId,
      taskRevision: 8,
    }),
    currentTerms: checkout,
    clientId: 'android-client-1',
    grantId: grant.grantId,
    ownerId: 'pixel-overlay',
    paymentMode: 'cod',
    proposal,
    source: 'voice_coordinator' as const,
    taskId,
    taskRevision: 8,
  };
  return { authorization, checkout, grant, ledger, proposal };
}

describe('checkout confirmation grants v2', () => {
  it('binds task revision, action, proposal, terms, payment, owner, and expiry', () => {
    const { grant, proposal } = fixture();

    expect(grant).toMatchObject({
      taskId,
      taskRevision: 8,
      clientId: 'android-client-1',
      ownerId: 'pixel-overlay',
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      proposalPreparedAt: proposal.preparedAt,
      proposalExpiresAt: proposal.expiresAt,
      termsDigest: proposal.proposalHash,
      paymentMode: 'cod',
      expiresAt: Date.parse(proposal.expiresAt),
    });
    expect(grant.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(grant.terms).toEqual(proposal.checkout);
  });

  it('keeps final dispatch unavailable to generic Realtime tools', () => {
    const { authorization, ledger } = fixture();

    expect(ledger.authorize({
      ...authorization,
      source: 'realtime_generic',
    })).toEqual({
      authorized: false,
      reason: 'generic_realtime_forbidden',
    });
  });

  it('rejects changed cart and changed fees without consuming the grant', () => {
    const cartFixture = fixture();
    expect(cartFixture.ledger.authorize({
      ...cartFixture.authorization,
      currentTerms: terms({
        lines: [{
          ...cartFixture.checkout.lines[0]!,
          quantity: 2,
          lineTotal: money(66),
        }],
        total: money(71),
      }),
    })).toMatchObject({
      authorized: false,
      reason: 'proposal_changed',
      changes: expect.arrayContaining(['items', 'total']),
    });

    const feeFixture = fixture();
    expect(feeFixture.ledger.authorize({
      ...feeFixture.authorization,
      currentTerms: terms({
        fees: [{ amount: money(7), kind: 'handling', label: 'Handling' }],
        total: money(40),
      }),
    })).toMatchObject({
      authorized: false,
      reason: 'proposal_changed',
      changes: expect.arrayContaining(['fees', 'total']),
    });
  });

  it('rejects expired, mismatched-client, owner, and task grants', () => {
    let now = NOW;
    const proposal = buildCodCheckoutProposal(
      terms(),
      new Date(NOW),
      1_000,
    );
    const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => now });
    const grant = ledger.issue({
      clientId: 'android-client-1',
      confirmationText: 'Confirm COD order',
      ownerId: 'pixel-overlay',
      proposal,
      source: 'interactive_card',
      taskId,
      taskRevision: 2,
    });
    const base = {
      actionDigest: checkoutFinalActionDigestV2({
        clientId: 'android-client-1',
        ownerId: 'pixel-overlay',
        proposal,
        taskId,
        taskRevision: 2,
      }),
      currentTerms: proposal.checkout,
      clientId: 'android-client-1',
      grantId: grant.grantId,
      ownerId: 'pixel-overlay',
      paymentMode: 'cod',
      proposal,
      source: 'interactive_card' as const,
      taskId,
      taskRevision: 2,
    };
    expect(ledger.authorize({
      ...base,
      clientId: 'other-client',
    })).toEqual({ authorized: false, reason: 'client_mismatch' });
    expect(ledger.authorize({
      ...base,
      ownerId: 'other-owner',
    })).toEqual({ authorized: false, reason: 'owner_mismatch' });
    expect(ledger.authorize({
      ...base,
      taskId: otherTaskId,
    })).toEqual({ authorized: false, reason: 'task_mismatch' });
    expect(ledger.authorize({
      ...base,
      taskRevision: 3,
    })).toEqual({ authorized: false, reason: 'task_mismatch' });
    now = NOW + 1_000;
    expect(ledger.authorize(base))
      .toEqual({ authorized: false, reason: 'grant_expired' });
  });

  it('consumes an exact confirmation once and rejects its duplicate', () => {
    const { authorization, ledger } = fixture();

    expect(ledger.authorize(authorization)).toMatchObject({
      authorized: true,
      grant: { consumedAt: NOW },
    });
    expect(ledger.authorize(authorization)).toEqual({
      authorized: false,
      reason: 'already_consumed',
    });
  });

  it('does not authorize a different review window with identical terms', () => {
    const { authorization, ledger } = fixture();
    const refreshedProposal = buildCodCheckoutProposal(
      authorization.currentTerms,
      new Date(NOW + 500),
      60_000,
    );

    expect(ledger.authorize({
      ...authorization,
      actionDigest: checkoutFinalActionDigestV2({
        clientId: 'android-client-1',
        ownerId: 'pixel-overlay',
        proposal: refreshedProposal,
        taskId,
        taskRevision: 8,
      }),
      proposal: refreshedProposal,
    })).toEqual({
      authorized: false,
      reason: 'proposal_mismatch',
    });
  });

  it('rejects action and payment binding mismatches without consuming', () => {
    const action = fixture();
    expect(action.ledger.authorize({
      ...action.authorization,
      actionDigest: 'f'.repeat(64),
    })).toEqual({ authorized: false, reason: 'action_mismatch' });

    const payment = fixture();
    expect(payment.ledger.authorize({
      ...payment.authorization,
      paymentMode: 'card',
    })).toEqual({ authorized: false, reason: 'payment_mismatch' });
  });

  it('treats the exact expiry millisecond as expired', () => {
    let now = NOW;
    const proposal = buildCodCheckoutProposal(
      terms(),
      new Date(NOW),
      1_000,
    );
    const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => now });
    const grant = ledger.issue({
      clientId: 'android-client-1',
      confirmationText: 'Confirm COD order',
      ownerId: 'pixel-overlay',
      proposal,
      source: 'voice_coordinator',
      taskId,
      taskRevision: 8,
    });
    now = Date.parse(proposal.expiresAt);

    expect(ledger.authorize({
      actionDigest: checkoutFinalActionDigestV2({
        clientId: 'android-client-1',
        ownerId: 'pixel-overlay',
        proposal,
        taskId,
        taskRevision: 8,
      }),
      clientId: 'android-client-1',
      currentTerms: proposal.checkout,
      grantId: grant.grantId,
      ownerId: 'pixel-overlay',
      paymentMode: 'cod',
      proposal,
      source: 'voice_coordinator',
      taskId,
      taskRevision: 8,
    })).toEqual({ authorized: false, reason: 'grant_expired' });
  });

  it('does not issue a grant for a generic yes or add-to-cart statement', () => {
    const { proposal } = fixture();
    const ledger = new CheckoutConfirmationGrantLedgerV2({ now: () => NOW });

    for (const confirmationText of [
      'yes',
      'add it to cart',
      'do not confirm COD order',
      'translate Confirm COD order into Hindi',
      'COD order confirm karo',
    ]) {
      expect(() => ledger.issue({
        clientId: 'android-client-1',
        confirmationText,
        ownerId: 'pixel-overlay',
        proposal,
        source: 'voice_coordinator',
        taskId,
        taskRevision: 8,
      })).toThrow('exact_confirmation_required');
    }
  });
});
