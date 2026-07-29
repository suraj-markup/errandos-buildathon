import type { LocalIdentifier } from '../../workflow/identifiers';
import type { CodCheckoutProposalV1 } from '../../cod';
import type {
  CheckoutOrchestrationRecordV2,
  CheckoutOrchestrationServiceV2,
} from './orchestration-service';

export type DurableCheckoutRecoveryV2 =
  | {
      status: 'missing';
    }
  | {
      status: 'payment_selection_required';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
    }
  | {
      status: 'review_expired';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
    }
  | {
      status: 'review_pending';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      checkout: CodCheckoutProposalV1;
      requiresFreshConfirmation: true;
    }
  | {
      status: 'ordered';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      providerReference: string;
    }
  | {
      status: 'ambiguous';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      retryAllowed: false;
    }
  | {
      status: 'blocked';
      checkoutId: string;
      taskId: LocalIdentifier<'task'>;
      taskRevision: number;
      requiresFreshReview: true;
    };

function base(record: CheckoutOrchestrationRecordV2) {
  return {
    checkoutId: record.checkoutId,
    taskId: record.taskId,
    taskRevision: record.taskRevision,
  };
}

export class DurableCheckoutRecoveryServiceV2 {
  constructor(
    private readonly checkout: CheckoutOrchestrationServiceV2,
    private readonly now: () => number = Date.now,
  ) {}

  async recoverLatest(input: {
    clientId: string;
    ownerId: string;
    taskId?: LocalIdentifier<'task'>;
  }): Promise<DurableCheckoutRecoveryV2> {
    const record = await this.checkout.findLatestForAuthority(input);
    if (!record) return { status: 'missing' };

    if (
      record.codState?.phase === 'ordered'
      || record.graph.phase === 'ordered'
    ) {
      const providerReference =
        record.codState?.phase === 'ordered'
          ? record.codState.providerReference
          : record.graph.providerReference;
      if (!providerReference) {
        return { ...base(record), retryAllowed: false, status: 'ambiguous' };
      }
      return { ...base(record), providerReference, status: 'ordered' };
    }
    if (
      record.codState?.phase === 'dispatching'
      || record.codState?.phase === 'ambiguous'
      || record.graph.phase === 'ambiguous'
      || record.graph.reconciliationRequired === true
    ) {
      return { ...base(record), retryAllowed: false, status: 'ambiguous' };
    }
    if (
      record.codState?.phase === 'blocked'
      || record.graph.phase === 'blocked'
    ) {
      return {
        ...base(record),
        requiresFreshReview: true,
        status: 'blocked',
      };
    }
    if (
      record.codState?.phase === 'review_not_ordered'
      || record.codState?.phase === 'confirmation_authorized'
    ) {
      if (Date.parse(record.codState.proposal.expiresAt) <= this.now()) {
        return { ...base(record), status: 'review_expired' };
      }
      return {
        ...base(record),
        checkout: structuredClone(record.codState.proposal),
        requiresFreshConfirmation: true,
        status: 'review_pending',
      };
    }
    return { ...base(record), status: 'payment_selection_required' };
  }
}
