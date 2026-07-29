import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import {
  isExplicitCodConfirmation,
  isCodCheckoutProposal,
  type CodCheckoutProposalV1,
} from '../../cod';
import type {
  CurrentPaymentMethodV2,
} from './contracts';
import {
  CheckoutRecordRevisionConflictV2,
  type CheckoutDispatchCommandV2,
  type CheckoutOrchestrationRecordV2,
  type CheckoutOrchestrationServiceV2,
  type CheckoutSessionAuthorityV2,
} from './orchestration-service';

export type PhoneToolCheckoutResultV2 = {
  changes?: readonly string[];
  checkout?: unknown;
  confirmationPhrase?: string;
  message?: string;
  ok?: boolean;
  operation?: {
    mutationBoundary?: string;
    status?: string;
  };
  providerReference?: string;
  reconciliationRequired?: boolean;
  screenEvidence?: unknown;
  status?: string;
};

export type VoiceTurnPreparedCodCheckoutV2 = {
  checkout: CodCheckoutProposalV1;
  checkoutId: string;
  checkoutTaskRevision: number;
  confirmationPhrase: 'Confirm COD order';
  message: string;
  ok: false;
  orchestrationRevision: number;
  safetyLabel: 'NOT ORDERED';
  status: 'confirmation_required';
};

export type VoiceTurnCheckoutFailureV2 = {
  checkoutId?: string;
  checkoutTaskRevision?: number;
  message: string;
  ok: false;
  reason:
    | 'cod_unavailable'
    | 'expired_prepare_result'
    | 'invalid_prepare_result'
    | 'orchestration_conflict';
  status: 'checkout_orchestration_rejected';
};

export type VoiceTurnCodConfirmationResultV2 =
  | {
      checkoutId: string;
      checkoutTaskRevision: number;
      message: string;
      ok: true;
      providerReference: string;
      status: 'ordered';
    }
  | {
      changes?: readonly string[];
      checkoutId: string;
      checkoutTaskRevision: number;
      message: string;
      ok: false;
      status:
        | 'checkout_changed'
        | 'checkout_expired'
        | 'confirmation_required'
        | 'final_dispatch_disabled';
    }
  | {
      checkoutId: string;
      checkoutTaskRevision: number;
      message: string;
      ok: false;
      reconciliationRequired: true;
      retryAllowed: false;
      status: 'order_status_ambiguous';
    };

export type VoiceTurnCheckoutCommitV2 = (
  input: {
    command: CheckoutDispatchCommandV2;
    checkoutProposal: CodCheckoutProposalV1;
  },
) => Promise<PhoneToolCheckoutResultV2>;

function currentCodPayment(): CurrentPaymentMethodV2 {
  return {
    kind: 'cod',
    label: 'Cash on Delivery',
    methodRef: 'phone_checkout_cod',
  };
}

function confirmedResult(
  record: CheckoutOrchestrationRecordV2,
): VoiceTurnCodConfirmationResultV2 | undefined {
  if (record.graph.phase !== 'ordered' || !record.graph.providerReference) {
    return undefined;
  }
  return {
    checkoutId: record.checkoutId,
    checkoutTaskRevision: record.taskRevision,
    message: 'COD order confirmed.',
    ok: true,
    providerReference: record.graph.providerReference,
    status: 'ordered',
  };
}

function ambiguousResult(
  record: CheckoutOrchestrationRecordV2,
): VoiceTurnCodConfirmationResultV2 {
  return {
    checkoutId: record.checkoutId,
    checkoutTaskRevision: record.taskRevision,
    message:
      'The final order result is uncertain. Nothing will be retried while order history is reconciled.',
    ok: false,
    reconciliationRequired: true,
    retryAllowed: false,
    status: 'order_status_ambiguous',
  };
}

function rejection(
  record: CheckoutOrchestrationRecordV2,
  status:
    | 'checkout_changed'
    | 'checkout_expired'
    | 'confirmation_required'
    | 'final_dispatch_disabled',
  message: string,
  changes?: readonly string[],
): VoiceTurnCodConfirmationResultV2 {
  return {
    checkoutId: record.checkoutId,
    checkoutTaskRevision: record.taskRevision,
    message,
    ok: false,
    status,
    ...(changes?.length ? { changes } : {}),
  };
}

export class VoiceTurnCheckoutAdapterV2 {
  constructor(
    private readonly service: CheckoutOrchestrationServiceV2,
    private readonly now: () => number = Date.now,
  ) {}

  async prepareCodCheckout(input: CheckoutSessionAuthorityV2 & {
    codAvailable?: boolean;
    currentPayment?: CurrentPaymentMethodV2;
    originalGoalIncludesOrder?: boolean;
    phoneResult: PhoneToolCheckoutResultV2;
  }): Promise<VoiceTurnPreparedCodCheckoutV2 | VoiceTurnCheckoutFailureV2> {
    const proposal = input.phoneResult.checkout;
    if (
      input.phoneResult.status !== 'confirmation_required'
      || !proposal
      || typeof proposal !== 'object'
      || !isCodCheckoutProposal(proposal as CodCheckoutProposalV1)
    ) {
      return {
        message:
          input.phoneResult.message
          ?? 'The phone did not return a complete COD checkout review.',
        ok: false,
        reason: 'invalid_prepare_result',
        status: 'checkout_orchestration_rejected',
      };
    }
    const codProposal = proposal as CodCheckoutProposalV1;
    const now = this.now();
    const proposalTtlMs = Date.parse(codProposal.expiresAt) - now;
    if (proposalTtlMs <= 0) {
      return {
        message: 'The reviewed checkout expired. Prepare it again.',
        ok: false,
        reason: 'expired_prepare_result',
        status: 'checkout_orchestration_rejected',
      };
    }
    const codAvailable = input.codAvailable ?? true;
    if (!codAvailable) {
      return {
        message: 'Cash on Delivery is unavailable for this checkout.',
        ok: false,
        reason: 'cod_unavailable',
        status: 'checkout_orchestration_rejected',
      };
    }
    try {
      let record = await this.service.open({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        codAvailable,
        currentPayment: input.currentPayment ?? currentCodPayment(),
        originalGoalIncludesOrder: input.originalGoalIncludesOrder ?? true,
      });
      if (record.graph.activeNode === 'choose_next_action') {
        record = await this.service.chooseNextAction({
          checkoutId: record.checkoutId,
          choice: 'review_checkout',
        });
      }
      record = await this.service.presentPaymentOptions({
        checkoutId: record.checkoutId,
        expiresAt: Math.min(
          Date.parse(codProposal.expiresAt),
          now + 30_000,
        ),
      });
      const currentIsCod = record.graph.currentPayment?.kind === 'cod';
      const selection = await this.service.choosePayment({
        checkoutId: record.checkoutId,
        choiceId: currentIsCod ? 'continue_current' : 'use_cod',
        interactionId: record.paymentPresentation!.interactionId,
        taskRevision: record.taskRevision,
      });
      if (!selection.resolution.accepted) {
        return {
          checkoutId: record.checkoutId,
          checkoutTaskRevision: record.taskRevision,
          message: 'Cash on Delivery is unavailable for this checkout.',
          ok: false,
          reason: 'cod_unavailable',
          status: 'checkout_orchestration_rejected',
        };
      }
      const prepared = await this.service.prepareCodReview({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkout: codProposal.checkout,
        checkoutId: record.checkoutId,
        proposalTtlMs,
      });
      if (!prepared.prepared) {
        return {
          checkoutId: record.checkoutId,
          checkoutTaskRevision: record.taskRevision,
          message: 'Cash on Delivery is unavailable for this checkout.',
          ok: false,
          reason: 'cod_unavailable',
          status: 'checkout_orchestration_rejected',
        };
      }
      const state = prepared.record.codState;
      if (state?.phase !== 'review_not_ordered') {
        throw new Error('Checkout review was not persisted.');
      }
      return {
        checkout: state.proposal,
        checkoutId: prepared.record.checkoutId,
        checkoutTaskRevision: prepared.record.taskRevision,
        confirmationPhrase: 'Confirm COD order',
        message: 'Review these exact terms. Nothing has been ordered.',
        ok: false,
        orchestrationRevision: prepared.record.recordRevision,
        safetyLabel: 'NOT ORDERED',
        status: 'confirmation_required',
      };
    } catch (error) {
      return {
        message: 'Checkout state changed concurrently. Prepare it again.',
        ok: false,
        reason: error instanceof CheckoutRecordRevisionConflictV2
          ? 'orchestration_conflict'
          : 'invalid_prepare_result',
        status: 'checkout_orchestration_rejected',
      };
    }
  }

  async confirmCodCheckout(input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    confirmationText: string;
    readCurrentTerms: () =>
      | AndroidCheckoutReviewV1
      | Promise<AndroidCheckoutReviewV1>;
    commit: VoiceTurnCheckoutCommitV2;
  }): Promise<VoiceTurnCodConfirmationResultV2> {
    let record = await this.service.getForAuthority(
      input.checkoutId,
      input,
    );
    const existing = confirmedResult(record);
    if (existing) return existing;
    if (
      record.graph.phase === 'ambiguous'
      || record.codState?.phase === 'ambiguous'
    ) {
      return ambiguousResult(record);
    }
    if (record.codState?.phase === 'dispatching') {
      record = await this.service.settleDispatch({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
        result: { outcome: 'ambiguous' },
      });
      return ambiguousResult(record);
    }
    if (record.graph.phase === 'checkout_reviewed') {
      if (!isExplicitCodConfirmation(input.confirmationText)) {
        return rejection(
          record,
          'confirmation_required',
          'The final order is locked. Say “Confirm COD order” after reviewing the total and address.',
        );
      }
      record = await this.service.requestOrderConfirmation({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
      });
    }

    let currentTerms = await input.readCurrentTerms();
    if (record.codState?.phase === 'review_not_ordered') {
      try {
        const authorization = await this.service.authorizeCod({
          clientId: input.clientId,
          ownerId: input.ownerId,
          taskId: input.taskId,
          taskRevision: input.taskRevision,
          checkoutId: record.checkoutId,
          confirmationText: input.confirmationText,
          currentTerms,
          source: 'voice_coordinator',
        });
        record = authorization.record;
        if (!authorization.authorized) {
          if (authorization.reason === 'proposal_changed') {
            return rejection(
              record,
              'checkout_changed',
              'Checkout terms changed. Review and confirm a fresh proposal.',
              authorization.changes,
            );
          }
          if (
            authorization.reason === 'grant_expired'
            || authorization.reason === 'proposal_expired'
          ) {
            return rejection(
              record,
              'checkout_expired',
              'The reviewed checkout expired. Prepare it again.',
              ['expiry'],
            );
          }
          return rejection(
            record,
            'confirmation_required',
            'The final order is locked. Say “Confirm COD order” after reviewing the total and address.',
          );
        }
      } catch (error) {
        if (!(error instanceof CheckoutRecordRevisionConflictV2)) throw error;
        record = await this.service.getForAuthority(record.checkoutId, input);
        const ordered = confirmedResult(record);
        if (ordered) return ordered;
        if (
          record.codState?.phase === 'dispatching'
          || record.codState?.phase === 'ambiguous'
        ) {
          return ambiguousResult(record);
        }
        if (record.codState?.phase !== 'confirmation_authorized') {
          return rejection(
            record,
            'confirmation_required',
            'Checkout state changed concurrently. Review it before confirming again.',
          );
        }
      }
    } else if (record.codState?.phase !== 'confirmation_authorized') {
      return rejection(
        record,
        'confirmation_required',
        'Prepare and review a fresh COD checkout first.',
      );
    }

    currentTerms = await input.readCurrentTerms();
    const dispatch = await this.service.beginDispatch({
      clientId: input.clientId,
      ownerId: input.ownerId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      checkoutId: record.checkoutId,
      currentTerms,
    });
    record = dispatch.record;
    if (!dispatch.started) {
      const ordered = confirmedResult(record);
      if (ordered) return ordered;
      if (dispatch.reason === 'proposal_changed') {
        return rejection(
          record,
          'checkout_changed',
          'Checkout terms changed. Review and confirm a fresh proposal.',
          dispatch.changes,
        );
      }
      if (dispatch.reason === 'expired') {
        return rejection(
          record,
          'checkout_expired',
          'The reviewed checkout expired. Prepare it again.',
          ['expiry'],
        );
      }
      if (dispatch.reason === 'already_started') {
        return ambiguousResult(record);
      }
      return rejection(
        record,
        'confirmation_required',
        'An exact, fresh checkout confirmation is required.',
      );
    }

    const dispatching = dispatch.record.codState;
    if (dispatching?.phase !== 'dispatching') {
      throw new Error('Dispatch reservation was not persisted.');
    }
    const checkoutProposal: CodCheckoutProposalV1 = {
      ...dispatching.proposal,
      idempotencyKey: dispatch.command.expected.idempotencyKey,
    };
    let phoneResult: PhoneToolCheckoutResultV2;
    try {
      phoneResult = await input.commit({
        command: dispatch.command,
        checkoutProposal,
      });
    } catch {
      record = await this.service.settleDispatch({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
        result: { outcome: 'ambiguous' },
      });
      return ambiguousResult(record);
    }
    if (
      phoneResult.status === 'ordered'
      && typeof phoneResult.providerReference === 'string'
      && phoneResult.providerReference.trim()
    ) {
      record = await this.service.settleDispatch({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
        result: {
          outcome: 'committed',
          providerReference: phoneResult.providerReference,
        },
      });
      return confirmedResult(record)!;
    }
    if (
      phoneResult.status === 'checkout_changed'
      || phoneResult.status === 'checkout_expired'
    ) {
      record = await this.service.settleDispatch({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
        result: { outcome: 'stale' },
      });
      return rejection(
        record,
        phoneResult.status,
        phoneResult.message
          ?? 'The checkout changed. Prepare and review it again.',
        phoneResult.changes,
      );
    }
    if (phoneResult.status === 'final_dispatch_disabled') {
      record = await this.service.settleDispatch({
        clientId: input.clientId,
        ownerId: input.ownerId,
        taskId: input.taskId,
        taskRevision: input.taskRevision,
        checkoutId: record.checkoutId,
        result: {
          outcome: 'disconnected',
          crossedFinalActionBoundary: false,
        },
      });
      return rejection(
        record,
        'final_dispatch_disabled',
        phoneResult.message ?? 'Final order dispatch is disabled.',
      );
    }
    const crossedFinalActionBoundary =
      phoneResult.status === 'order_status_ambiguous'
      || phoneResult.operation?.mutationBoundary === 'final_dispatch_attempted';
    record = await this.service.settleDispatch({
      clientId: input.clientId,
      ownerId: input.ownerId,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      checkoutId: record.checkoutId,
      result: crossedFinalActionBoundary
        ? { outcome: 'ambiguous' }
        : {
            outcome: 'disconnected',
            crossedFinalActionBoundary: false,
          },
    });
    return crossedFinalActionBoundary
      ? ambiguousResult(record)
      : rejection(
          record,
          'confirmation_required',
          phoneResult.message
            ?? 'Phone execution stopped before dispatch. Confirm again after reviewing the terms.',
        );
  }
}
