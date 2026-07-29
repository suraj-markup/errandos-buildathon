import type {
  AndroidCheckoutReviewV1,
  BlinkitProposalChangeV1,
} from '@errandos/contracts';
import type { LocalIdentifier } from '../../workflow/identifiers';
import type { CodCheckoutProposalV1 } from '../../cod';

export type CheckoutPaymentKindV2 =
  | 'card'
  | 'cod'
  | 'other'
  | 'upi'
  | 'wallet';

export type CurrentPaymentMethodV2 = {
  kind: CheckoutPaymentKindV2;
  label: string;
  methodRef: string;
};

export type CheckoutPaymentChoiceIdV2 =
  | 'continue_current'
  | 'use_cod'
  | 'add_more'
  | 'stop';

export type CheckoutPaymentChoiceV2 = {
  choiceId: CheckoutPaymentChoiceIdV2;
  enabled: boolean;
  label: string;
  selected: boolean;
  disabledReason?: 'cod_unavailable';
};

export type CheckoutPaymentPresentationV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  interactionId: string;
  expiresAt: number;
  mode: 'payment_options';
  safetyLabel: 'NOT ORDERED';
  currentPayment: {
    kind: CheckoutPaymentKindV2;
    publicLabel: string;
  };
  choices: readonly CheckoutPaymentChoiceV2[];
};

export type CheckoutPaymentChoiceResolutionV2 =
  | {
      accepted: true;
      choiceId: CheckoutPaymentChoiceIdV2;
      command:
        | { kind: 'add_more' }
        | { kind: 'prepare_checkout'; payment: 'cod' | 'current' }
        | { kind: 'stop' };
    }
  | {
      accepted: false;
      reason:
        | 'choice_unavailable'
        | 'expired'
        | 'invalid_choice'
        | 'stale_interaction'
        | 'stale_revision';
    };

export type CheckoutConfirmationSourceV2 =
  | 'interactive_card'
  | 'realtime_generic'
  | 'voice_coordinator';

export type CheckoutConfirmationGrantV2 = {
  version: 2;
  grantId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  clientId: string;
  ownerId: string;
  actionDigest: string;
  proposalId: string;
  proposalHash: string;
  proposalPreparedAt: string;
  proposalExpiresAt: string;
  terms: AndroidCheckoutReviewV1;
  termsDigest: string;
  paymentMode: 'cod';
  issuedAt: number;
  expiresAt: number;
  consumedAt?: number;
};

export type CheckoutGrantAuthorizationV2 =
  | {
      authorized: true;
      grant: CheckoutConfirmationGrantV2 & { consumedAt: number };
    }
  | {
      authorized: false;
      reason:
        | 'action_mismatch'
        | 'already_consumed'
        | 'client_mismatch'
        | 'generic_realtime_forbidden'
        | 'grant_expired'
        | 'grant_not_found'
        | 'owner_mismatch'
        | 'payment_mismatch'
        | 'proposal_changed'
        | 'proposal_mismatch'
        | 'task_mismatch';
      changes?: readonly BlinkitProposalChangeV1[];
    };

export type CodFinalConfirmationRejectionReasonV2 =
  | Exclude<
      CheckoutGrantAuthorizationV2,
      { authorized: true }
    >['reason']
  | 'exact_confirmation_required'
  | 'grant_issue_failed'
  | 'proposal_expired';

export type CodCheckoutReviewStateV2 = {
  version: 2;
  phase: 'review_not_ordered';
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  clientId: string;
  ownerId: string;
  previousPayment?: CurrentPaymentMethodV2;
  proposal: CodCheckoutProposalV1;
  safetyLabel: 'NOT ORDERED';
  requiresFinalConfirmation: true;
  interruption?: 'disconnect_before_dispatch';
};

export type CodCheckoutAuthorizedStateV2 = Omit<
  CodCheckoutReviewStateV2,
  'phase' | 'requiresFinalConfirmation'
> & {
  phase: 'confirmation_authorized';
  grant: CheckoutConfirmationGrantV2 & { consumedAt: number };
  requiresFinalConfirmation: false;
};

export type CodCheckoutDispatchingStateV2 = Omit<
  CodCheckoutAuthorizedStateV2,
  'phase'
> & {
  phase: 'dispatching';
  dispatchStartedAt: number;
};

export type CodCheckoutTerminalStateV2 =
  | {
      version: 2;
      phase: 'ordered';
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      proposalId: string;
      providerReference: string;
    }
  | {
      version: 2;
      phase: 'ambiguous';
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      proposalId: string;
      reconciliationRequired: true;
      retryAllowed: false;
      reason: 'disconnect_after_dispatch' | 'provider_result_ambiguous';
    }
  | {
      version: 2;
      phase: 'blocked';
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      proposalId: string;
      reason: 'proposal_stale';
      requiresFreshReview: true;
    };

export type CodReviewPreparationV2 =
  | {
      prepared: true;
      state: CodCheckoutReviewStateV2;
    }
  | {
      prepared: false;
      reason: 'cod_unavailable';
    };
