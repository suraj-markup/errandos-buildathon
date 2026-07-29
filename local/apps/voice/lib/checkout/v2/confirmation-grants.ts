import { createHash } from 'node:crypto';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import { checkoutTermChanges, isExplicitCodConfirmation } from '../../cod';
import type {
  CheckoutConfirmationGrantV2,
  CheckoutConfirmationSourceV2,
  CheckoutGrantAuthorizationV2,
} from './contracts';
import type { CodCheckoutProposalV1 } from '../../cod';
import type { LocalIdentifier } from '../../workflow/identifiers';

export type CheckoutGrantIssueErrorCodeV2 =
  | 'exact_confirmation_required'
  | 'grant_issue_failed'
  | 'proposal_expired';

export class CheckoutGrantIssueErrorV2 extends Error {
  constructor(readonly code: CheckoutGrantIssueErrorCodeV2) {
    super(code);
    this.name = 'CheckoutGrantIssueErrorV2';
  }
}

function bounded(value: string, name: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${name} must contain 1-${max} characters.`);
  }
  return normalized;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function checkoutFinalActionDigestV2(input: {
  clientId: string;
  ownerId: string;
  proposal: CodCheckoutProposalV1;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): string {
  return digest({
    action: 'confirm_order',
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    clientId: bounded(input.clientId, 'clientId'),
    ownerId: bounded(input.ownerId, 'ownerId'),
    proposalId: input.proposal.proposalId,
    proposalHash: input.proposal.proposalHash,
    proposalPreparedAt: input.proposal.preparedAt,
    proposalExpiresAt: input.proposal.expiresAt,
    paymentMode: input.proposal.paymentMode,
  });
}

export class CheckoutConfirmationGrantLedgerV2 {
  private readonly grants = new Map<string, CheckoutConfirmationGrantV2>();
  private readonly grantIdBySemanticKey = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  issue(input: {
    clientId: string;
    confirmationText: string;
    expiresAt?: number;
    grantId?: string;
    ownerId: string;
    proposal: CodCheckoutProposalV1;
    source: Exclude<CheckoutConfirmationSourceV2, 'realtime_generic'>;
    taskId: LocalIdentifier<'task'>;
    taskRevision: number;
  }): CheckoutConfirmationGrantV2 {
    const now = this.now();
    if (!isExplicitCodConfirmation(input.confirmationText)) {
      throw new CheckoutGrantIssueErrorV2('exact_confirmation_required');
    }
    if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 0) {
      throw new CheckoutGrantIssueErrorV2('grant_issue_failed');
    }
    const proposalExpiry = Date.parse(input.proposal.expiresAt);
    if (!Number.isFinite(proposalExpiry) || proposalExpiry <= now) {
      throw new CheckoutGrantIssueErrorV2('proposal_expired');
    }
    const requestedExpiry = input.expiresAt ?? proposalExpiry;
    if (
      !Number.isSafeInteger(requestedExpiry)
      || requestedExpiry <= now
    ) {
      throw new CheckoutGrantIssueErrorV2('grant_issue_failed');
    }
    const semanticKey = digest({
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      clientId: input.clientId,
      ownerId: input.ownerId,
      actionDigest: checkoutFinalActionDigestV2(input),
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposal.proposalHash,
      proposalPreparedAt: input.proposal.preparedAt,
      proposalExpiresAt: input.proposal.expiresAt,
      paymentMode: input.proposal.paymentMode,
    });
    const existingGrantId = this.grantIdBySemanticKey.get(semanticKey);
    if (existingGrantId) {
      return structuredClone(this.grants.get(existingGrantId)!);
    }
    const grantId = bounded(
      input.grantId ?? `checkout_grant_${crypto.randomUUID()}`,
      'grantId',
    );
    if (this.grants.has(grantId)) {
      throw new Error(`Confirmation grant ${grantId} already exists.`);
    }
    const grant: CheckoutConfirmationGrantV2 = {
      version: 2,
      grantId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      clientId: bounded(input.clientId, 'clientId'),
      ownerId: bounded(input.ownerId, 'ownerId'),
      actionDigest: checkoutFinalActionDigestV2(input),
      proposalId: input.proposal.proposalId,
      proposalHash: input.proposal.proposalHash,
      proposalPreparedAt: input.proposal.preparedAt,
      proposalExpiresAt: input.proposal.expiresAt,
      terms: structuredClone(input.proposal.checkout),
      termsDigest: input.proposal.proposalHash,
      paymentMode: 'cod',
      issuedAt: now,
      expiresAt: Math.min(requestedExpiry, proposalExpiry),
    };
    this.grants.set(grantId, grant);
    this.grantIdBySemanticKey.set(semanticKey, grantId);
    return structuredClone(grant);
  }

  authorize(input: {
    actionDigest: string;
    clientId: string;
    currentTerms: AndroidCheckoutReviewV1;
    grantId: string;
    ownerId: string;
    paymentMode: string;
    proposal: CodCheckoutProposalV1;
    source: CheckoutConfirmationSourceV2;
    taskId: LocalIdentifier<'task'>;
    taskRevision: number;
  }): CheckoutGrantAuthorizationV2 {
    if (input.source === 'realtime_generic') {
      return { authorized: false, reason: 'generic_realtime_forbidden' };
    }
    const grant = this.grants.get(input.grantId);
    if (!grant) return { authorized: false, reason: 'grant_not_found' };
    if (grant.consumedAt !== undefined) {
      return { authorized: false, reason: 'already_consumed' };
    }
    const now = this.now();
    if (
      now >= grant.expiresAt
      || now >= Date.parse(input.proposal.expiresAt)
    ) {
      return { authorized: false, reason: 'grant_expired' };
    }
    if (
      grant.taskId !== input.taskId
      || grant.taskRevision !== input.taskRevision
    ) {
      return { authorized: false, reason: 'task_mismatch' };
    }
    if (grant.clientId !== input.clientId) {
      return { authorized: false, reason: 'client_mismatch' };
    }
    if (grant.ownerId !== input.ownerId) {
      return { authorized: false, reason: 'owner_mismatch' };
    }
    if (
      grant.proposalId !== input.proposal.proposalId
      || grant.proposalHash !== input.proposal.proposalHash
      || grant.proposalPreparedAt !== input.proposal.preparedAt
      || grant.proposalExpiresAt !== input.proposal.expiresAt
      || grant.termsDigest !== input.proposal.proposalHash
    ) {
      return { authorized: false, reason: 'proposal_mismatch' };
    }
    if (
      grant.paymentMode !== 'cod'
      || input.paymentMode !== grant.paymentMode
      || input.currentTerms.paymentMode !== grant.paymentMode
    ) {
      return { authorized: false, reason: 'payment_mismatch' };
    }
    if (grant.actionDigest !== input.actionDigest) {
      return { authorized: false, reason: 'action_mismatch' };
    }
    const changes = checkoutTermChanges(grant.terms, input.currentTerms);
    if (changes.length > 0) {
      return {
        authorized: false,
        reason: 'proposal_changed',
        changes,
      };
    }
    const consumed = { ...grant, consumedAt: now };
    this.grants.set(grant.grantId, consumed);
    return { authorized: true, grant: structuredClone(consumed) };
  }
}
