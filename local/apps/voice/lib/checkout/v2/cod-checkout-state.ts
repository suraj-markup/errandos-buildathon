import type {
  AndroidCheckoutReviewV1,
  BlinkitProposalChangeV1,
} from '@errandos/contracts';
import type { AndroidCommitResult } from '@errandos/provider-connectors';
import { buildCodCheckoutProposal } from '../../cod';
import type {
  CodCheckoutAuthorizedStateV2,
  CodCheckoutDispatchingStateV2,
  CodCheckoutReviewStateV2,
  CodCheckoutTerminalStateV2,
  CodFinalConfirmationRejectionReasonV2,
  CodReviewPreparationV2,
  CurrentPaymentMethodV2,
} from './contracts';
import {
  CheckoutConfirmationGrantLedgerV2,
  CheckoutGrantIssueErrorV2,
  checkoutFinalActionDigestV2,
} from './confirmation-grants';

export function prepareCodReviewV2(input: {
  checkout: AndroidCheckoutReviewV1;
  clientId: string;
  codAvailable: boolean;
  now: Date;
  ownerId: string;
  previousPayment?: CurrentPaymentMethodV2;
  proposalTtlMs: number;
  taskId: CodCheckoutReviewStateV2['taskId'];
  taskRevision: number;
}): CodReviewPreparationV2 {
  if (!input.codAvailable) {
    return { prepared: false, reason: 'cod_unavailable' };
  }
  const proposal = buildCodCheckoutProposal(
    input.checkout,
    input.now,
    input.proposalTtlMs,
  );
  return {
    prepared: true,
    state: {
      version: 2,
      phase: 'review_not_ordered',
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      clientId: input.clientId,
      ownerId: input.ownerId,
      ...(input.previousPayment
        ? { previousPayment: structuredClone(input.previousPayment) }
        : {}),
      proposal,
      safetyLabel: 'NOT ORDERED',
      requiresFinalConfirmation: true,
    },
  };
}

export function authorizeCodFinalConfirmationV2(input: {
  confirmationText: string;
  currentTerms: AndroidCheckoutReviewV1;
  grantId?: string;
  ledger: CheckoutConfirmationGrantLedgerV2;
  source: 'interactive_card' | 'voice_coordinator';
  state: CodCheckoutReviewStateV2;
}):
  | { authorized: true; state: CodCheckoutAuthorizedStateV2 }
  | {
      authorized: false;
      reason: CodFinalConfirmationRejectionReasonV2;
      changes?: readonly BlinkitProposalChangeV1[];
    } {
  let grant;
  try {
    grant = input.ledger.issue({
      clientId: input.state.clientId,
      confirmationText: input.confirmationText,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ownerId: input.state.ownerId,
      proposal: input.state.proposal,
      source: input.source,
      taskId: input.state.taskId,
      taskRevision: input.state.taskRevision,
    });
  } catch (error) {
    return {
      authorized: false,
      reason: error instanceof CheckoutGrantIssueErrorV2
        ? error.code
        : 'grant_issue_failed',
    };
  }
  const authorization = input.ledger.authorize({
    actionDigest: checkoutFinalActionDigestV2({
      clientId: input.state.clientId,
      ownerId: input.state.ownerId,
      proposal: input.state.proposal,
      taskId: input.state.taskId,
      taskRevision: input.state.taskRevision,
    }),
    currentTerms: input.currentTerms,
    clientId: input.state.clientId,
    grantId: grant.grantId,
    ownerId: input.state.ownerId,
    paymentMode: 'cod',
    proposal: input.state.proposal,
    source: input.source,
    taskId: input.state.taskId,
    taskRevision: input.state.taskRevision,
  });
  if (!authorization.authorized) return authorization;
  return {
    authorized: true,
    state: {
      ...input.state,
      phase: 'confirmation_authorized',
      grant: authorization.grant,
      requiresFinalConfirmation: false,
    },
  };
}

export function beginCodFinalDispatchV2(
  state: CodCheckoutAuthorizedStateV2,
  now: number = Date.now(),
): CodCheckoutDispatchingStateV2 {
  return {
    ...state,
    phase: 'dispatching',
    dispatchStartedAt: now,
  };
}

export type CodDispatchObservationV2 =
  | AndroidCommitResult
  | {
      outcome: 'disconnected';
      crossedFinalActionBoundary: boolean;
    };

export function settleCodFinalDispatchV2(
  state: CodCheckoutDispatchingStateV2,
  result: CodDispatchObservationV2,
):
  | CodCheckoutReviewStateV2
  | CodCheckoutTerminalStateV2 {
  if (result.outcome === 'committed') {
    return {
      version: 2,
      phase: 'ordered',
      taskId: state.taskId,
      taskRevision: state.taskRevision,
      proposalId: state.proposal.proposalId,
      providerReference: result.providerReference,
    };
  }
  if (result.outcome === 'stale') {
    return {
      version: 2,
      phase: 'blocked',
      taskId: state.taskId,
      taskRevision: state.taskRevision,
      proposalId: state.proposal.proposalId,
      reason: 'proposal_stale',
      requiresFreshReview: true,
    };
  }
  if (
    result.outcome === 'disconnected'
    && !result.crossedFinalActionBoundary
  ) {
    return {
      version: 2,
      phase: 'review_not_ordered',
      taskId: state.taskId,
      taskRevision: state.taskRevision,
      clientId: state.clientId,
      ownerId: state.ownerId,
      ...(state.previousPayment
        ? { previousPayment: state.previousPayment }
        : {}),
      proposal: state.proposal,
      safetyLabel: 'NOT ORDERED',
      requiresFinalConfirmation: true,
      interruption: 'disconnect_before_dispatch',
    };
  }
  return {
    version: 2,
    phase: 'ambiguous',
    taskId: state.taskId,
    taskRevision: state.taskRevision,
    proposalId: state.proposal.proposalId,
    reconciliationRequired: true,
    retryAllowed: false,
    reason: result.outcome === 'disconnected'
      ? 'disconnect_after_dispatch'
      : 'provider_result_ambiguous',
  };
}
