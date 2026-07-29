import type {
  AndroidCheckoutReviewV1,
  AndroidExpectedCheckoutV1,
  BlinkitProposalChangeV1,
} from '@errandos/contracts';
import { checkoutTermChanges } from '../../cod';
import type { LocalIdentifier } from '../../workflow/identifiers';
import {
  createCheckoutGraphV2,
  transitionCheckoutGraphV2,
  type CheckoutGraphV2,
} from './checkout-graph';
import {
  authorizeCodFinalConfirmationV2,
  beginCodFinalDispatchV2,
  prepareCodReviewV2,
  settleCodFinalDispatchV2,
  type CodDispatchObservationV2,
} from './cod-checkout-state';
import { CheckoutConfirmationGrantLedgerV2 } from './confirmation-grants';
import type {
  CheckoutPaymentChoiceIdV2,
  CheckoutPaymentChoiceResolutionV2,
  CheckoutPaymentPresentationV2,
  CodCheckoutAuthorizedStateV2,
  CodCheckoutDispatchingStateV2,
  CodCheckoutReviewStateV2,
  CodCheckoutTerminalStateV2,
  CodFinalConfirmationRejectionReasonV2,
  CurrentPaymentMethodV2,
} from './contracts';
import {
  createCheckoutPaymentPresentationV2,
  resolveCheckoutPaymentChoiceV2,
} from './payment-presentation';

type CodCheckoutStateV2 =
  | CodCheckoutAuthorizedStateV2
  | CodCheckoutDispatchingStateV2
  | CodCheckoutReviewStateV2
  | CodCheckoutTerminalStateV2;

export type CheckoutOrchestrationEventKindV2 =
  | 'checkout_invalidated'
  | 'checkout_opened'
  | 'confirmation_authorized'
  | 'dispatch_settled'
  | 'dispatch_started'
  | 'next_action_selected'
  | 'order_requested'
  | 'payment_options_presented'
  | 'payment_selected'
  | 'reconciliation_settled'
  | 'review_prepared';

export type CheckoutOrchestrationEventV2 = {
  eventId: string;
  kind: CheckoutOrchestrationEventKindV2;
  at: number;
  recordRevision: number;
  detail?: string;
};

export type CheckoutOrchestrationRecordV2 = {
  version: 2;
  checkoutId: string;
  recordRevision: number;
  clientId: string;
  ownerId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  graph: CheckoutGraphV2;
  paymentPresentation?: CheckoutPaymentPresentationV2;
  codState?: CodCheckoutStateV2;
  events: readonly CheckoutOrchestrationEventV2[];
  createdAt: number;
  updatedAt: number;
};

export class CheckoutRecordRevisionConflictV2 extends Error {
  constructor(
    readonly checkoutId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Checkout ${checkoutId} revision conflict: expected ${expectedRevision}, received ${actualRevision}.`,
    );
    this.name = 'CheckoutRecordRevisionConflictV2';
  }
}

export interface CheckoutOrchestrationRepositoryV2 {
  create(
    record: CheckoutOrchestrationRecordV2,
  ): Promise<CheckoutOrchestrationRecordV2>;
  get(
    checkoutId: string,
  ): Promise<CheckoutOrchestrationRecordV2 | undefined>;
  findLatest(input: {
    clientId: string;
    ownerId: string;
    taskId?: LocalIdentifier<'task'>;
  }): Promise<CheckoutOrchestrationRecordV2 | undefined>;
  save(
    record: CheckoutOrchestrationRecordV2,
    expectedRevision: number,
  ): Promise<CheckoutOrchestrationRecordV2>;
}

export class InMemoryCheckoutOrchestrationRepositoryV2
  implements CheckoutOrchestrationRepositoryV2 {
  private readonly records = new Map<string, CheckoutOrchestrationRecordV2>();

  async create(
    record: CheckoutOrchestrationRecordV2,
  ): Promise<CheckoutOrchestrationRecordV2> {
    if (this.records.has(record.checkoutId)) {
      throw new Error(`Checkout ${record.checkoutId} already exists.`);
    }
    const copy = structuredClone(record);
    this.records.set(record.checkoutId, copy);
    return structuredClone(copy);
  }

  async get(
    checkoutId: string,
  ): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    const record = this.records.get(checkoutId);
    return record ? structuredClone(record) : undefined;
  }

  async findLatest(input: {
    clientId: string;
    ownerId: string;
    taskId?: LocalIdentifier<'task'>;
  }): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    const match = [...this.records.values()]
      .filter((record) =>
        record.clientId === input.clientId
        && record.ownerId === input.ownerId
        && (!input.taskId || record.taskId === input.taskId))
      .sort((left, right) =>
        right.updatedAt - left.updatedAt
        || right.recordRevision - left.recordRevision
        || right.checkoutId.localeCompare(left.checkoutId))[0];
    return match ? structuredClone(match) : undefined;
  }

  async save(
    record: CheckoutOrchestrationRecordV2,
    expectedRevision: number,
  ): Promise<CheckoutOrchestrationRecordV2> {
    const current = this.records.get(record.checkoutId);
    if (!current) throw new Error(`Checkout ${record.checkoutId} was not found.`);
    if (current.recordRevision !== expectedRevision) {
      throw new CheckoutRecordRevisionConflictV2(
        record.checkoutId,
        expectedRevision,
        current.recordRevision,
      );
    }
    if (record.recordRevision !== expectedRevision + 1) {
      throw new Error('Checkout save must advance exactly one record revision.');
    }
    const copy = structuredClone(record);
    this.records.set(record.checkoutId, copy);
    return structuredClone(copy);
  }
}

export type CheckoutSessionAuthorityV2 = {
  clientId: string;
  ownerId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
};

export type CheckoutDispatchCommandV2 = {
  actionDigest: string;
  confirmationGrantId: string;
  expected: AndroidExpectedCheckoutV1;
};

export type CheckoutReconciliationObservationV2 =
  | { outcome: 'ambiguous' }
  | { outcome: 'not_ordered' }
  | { outcome: 'ordered'; providerReference: string };

const maxEvents = 64;

function bounded(value: string, name: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`${name} must contain 1-${max} characters.`);
  }
  return normalized;
}

function assertAuthority(
  record: CheckoutOrchestrationRecordV2,
  authority: CheckoutSessionAuthorityV2,
): void {
  if (
    record.clientId !== authority.clientId
    || record.ownerId !== authority.ownerId
    || record.taskId !== authority.taskId
    || record.taskRevision !== authority.taskRevision
  ) {
    throw new Error('Checkout session authority does not match.');
  }
}

function withEvent(
  source: CheckoutOrchestrationRecordV2,
  input: {
    at: number;
    detail?: string;
    kind: CheckoutOrchestrationEventKindV2;
  },
): CheckoutOrchestrationRecordV2 {
  const recordRevision = source.recordRevision + 1;
  const event: CheckoutOrchestrationEventV2 = {
    eventId: `checkout_event_${crypto.randomUUID()}`,
    kind: input.kind,
    at: input.at,
    recordRevision,
    ...(input.detail ? { detail: bounded(input.detail, 'event detail') } : {}),
  };
  return {
    ...source,
    recordRevision,
    updatedAt: input.at,
    events: [...source.events, event].slice(-maxEvents),
  };
}

function blockedCodState(
  state: CodCheckoutReviewStateV2 | CodCheckoutAuthorizedStateV2,
): CodCheckoutTerminalStateV2 {
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

export class CheckoutOrchestrationServiceV2 {
  constructor(
    private readonly repository: CheckoutOrchestrationRepositoryV2,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    checkoutId: string,
  ): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    return this.repository.get(checkoutId);
  }

  async findLatestForAuthority(input: {
    clientId: string;
    ownerId: string;
    taskId?: LocalIdentifier<'task'>;
  }): Promise<CheckoutOrchestrationRecordV2 | undefined> {
    return this.repository.findLatest(input);
  }

  async getForAuthority(
    checkoutId: string,
    authority: CheckoutSessionAuthorityV2,
  ): Promise<CheckoutOrchestrationRecordV2> {
    const record = await this.require(checkoutId);
    assertAuthority(record, authority);
    return record;
  }

  async open(input: CheckoutSessionAuthorityV2 & {
    checkoutId?: string;
    codAvailable: boolean;
    currentPayment: CurrentPaymentMethodV2;
    originalGoalIncludesOrder: boolean;
  }): Promise<CheckoutOrchestrationRecordV2> {
    const at = this.now();
    let graph = createCheckoutGraphV2({
      originalGoalIncludesOrder: input.originalGoalIncludesOrder,
      taskId: input.taskId,
      taskRevision: input.taskRevision,
    });
    graph = transitionCheckoutGraphV2(graph, {
      type: 'cart_inspected',
      currentPayment: input.currentPayment,
      codAvailable: input.codAvailable,
    });
    const checkoutId = bounded(
      input.checkoutId ?? `checkout_session_${crypto.randomUUID()}`,
      'checkoutId',
    );
    return this.repository.create({
      version: 2,
      checkoutId,
      recordRevision: 0,
      clientId: bounded(input.clientId, 'clientId'),
      ownerId: bounded(input.ownerId, 'ownerId'),
      taskId: input.taskId,
      taskRevision: input.taskRevision,
      graph,
      events: [{
        eventId: `checkout_event_${crypto.randomUUID()}`,
        kind: 'checkout_opened',
        at,
        recordRevision: 0,
      }],
      createdAt: at,
      updatedAt: at,
    });
  }

  async presentPaymentOptions(input: {
    checkoutId: string;
    expiresAt: number;
    interactionId?: string;
  }): Promise<CheckoutOrchestrationRecordV2> {
    const current = await this.require(input.checkoutId);
    const at = this.now();
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'checkout_prepared',
    });
    if (!graph.currentPayment || graph.codAvailable === undefined) {
      throw new Error('Checkout payment evidence is missing.');
    }
    const paymentPresentation = createCheckoutPaymentPresentationV2({
      codAvailable: graph.codAvailable,
      currentPayment: graph.currentPayment,
      expiresAt: input.expiresAt,
      ...(input.interactionId ? { interactionId: input.interactionId } : {}),
      now: at,
      taskId: current.taskId,
      taskRevision: current.taskRevision,
    });
    return this.save(
      current,
      withEvent(
        { ...current, graph, paymentPresentation },
        { at, kind: 'payment_options_presented' },
      ),
    );
  }

  async chooseNextAction(input: {
    checkoutId: string;
    choice: 'add_more' | 'review_checkout' | 'stop';
  }): Promise<CheckoutOrchestrationRecordV2> {
    const current = await this.require(input.checkoutId);
    const at = this.now();
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'next_action_selected',
      choice: input.choice,
    });
    return this.save(
      current,
      withEvent(
        { ...current, graph },
        { at, detail: input.choice, kind: 'next_action_selected' },
      ),
    );
  }

  async choosePayment(input: {
    checkoutId: string;
    choiceId: CheckoutPaymentChoiceIdV2 | string;
    interactionId: string;
    taskRevision: number;
  }): Promise<{
    record: CheckoutOrchestrationRecordV2;
    resolution: CheckoutPaymentChoiceResolutionV2;
  }> {
    const current = await this.require(input.checkoutId);
    if (!current.paymentPresentation) {
      throw new Error('Checkout payment options are not active.');
    }
    const at = this.now();
    const resolution = resolveCheckoutPaymentChoiceV2({
      choiceId: input.choiceId,
      interactionId: input.interactionId,
      now: at,
      presentation: current.paymentPresentation,
      taskRevision: input.taskRevision,
    });
    if (!resolution.accepted) return { record: current, resolution };
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'payment_selected',
      choice: resolution.choiceId,
    });
    const next = withEvent(
      { ...current, graph, paymentPresentation: undefined },
      { at, detail: resolution.choiceId, kind: 'payment_selected' },
    );
    return { record: await this.save(current, next), resolution };
  }

  async prepareCodReview(input: CheckoutSessionAuthorityV2 & {
    checkout: AndroidCheckoutReviewV1;
    checkoutId: string;
    proposalTtlMs: number;
  }): Promise<
    | { prepared: false; reason: 'cod_unavailable' }
    | { prepared: true; record: CheckoutOrchestrationRecordV2 }
  > {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    if (
      current.graph.selectedPayment !== 'cod'
      && !(
        current.graph.selectedPayment === 'current'
        && current.graph.currentPayment?.kind === 'cod'
      )
    ) {
      throw new Error('COD was not selected for this checkout.');
    }
    const at = this.now();
    const preparation = prepareCodReviewV2({
      checkout: input.checkout,
      clientId: current.clientId,
      codAvailable: current.graph.codAvailable === true,
      now: new Date(at),
      ownerId: current.ownerId,
      ...(current.graph.currentPayment
        ? { previousPayment: current.graph.currentPayment }
        : {}),
      proposalTtlMs: input.proposalTtlMs,
      taskId: current.taskId,
      taskRevision: current.taskRevision,
    });
    if (!preparation.prepared) return preparation;
    const proposal = preparation.state.proposal;
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'review_prepared',
      review: {
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        termsDigest: proposal.proposalHash,
        paymentMode: 'cod',
        preparedAt: Date.parse(proposal.preparedAt),
        expiresAt: Date.parse(proposal.expiresAt),
      },
      now: at,
    });
    const next = withEvent(
      { ...current, graph, codState: preparation.state },
      { at, detail: proposal.proposalId, kind: 'review_prepared' },
    );
    return { prepared: true, record: await this.save(current, next) };
  }

  async authorizeCod(input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    confirmationText: string;
    currentTerms: AndroidCheckoutReviewV1;
    grantId?: string;
    source: 'interactive_card' | 'voice_coordinator';
  }): Promise<
    | {
        authorized: false;
        reason: CodFinalConfirmationRejectionReasonV2;
        changes?: readonly BlinkitProposalChangeV1[];
        record: CheckoutOrchestrationRecordV2;
      }
    | { authorized: true; record: CheckoutOrchestrationRecordV2 }
  > {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    if (current.codState?.phase !== 'review_not_ordered') {
      return {
        authorized: false,
        reason: current.codState?.phase === 'confirmation_authorized'
          || current.codState?.phase === 'dispatching'
          ? 'already_consumed'
          : 'proposal_mismatch',
        record: current,
      };
    }
    const at = this.now();
    const authorization = authorizeCodFinalConfirmationV2({
      confirmationText: input.confirmationText,
      currentTerms: input.currentTerms,
      ...(input.grantId ? { grantId: input.grantId } : {}),
      ledger: new CheckoutConfirmationGrantLedgerV2({ now: () => at }),
      source: input.source,
      state: current.codState,
    });
    if (!authorization.authorized) {
      if (
        authorization.reason === 'proposal_changed'
        && authorization.changes?.length
      ) {
        const graph = transitionCheckoutGraphV2(current.graph, {
          type: 'checkout_invalidated',
          changes: authorization.changes,
        });
        const next = withEvent(
          {
            ...current,
            graph,
            codState: blockedCodState(current.codState),
          },
          {
            at,
            detail: authorization.changes.join(','),
            kind: 'checkout_invalidated',
          },
        );
        return {
          ...authorization,
          record: await this.save(current, next),
        };
      }
      return { ...authorization, record: current };
    }
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'confirmation_authorized',
      grant: authorization.state.grant,
      now: at,
    });
    const next = withEvent(
      { ...current, graph, codState: authorization.state },
      {
        at,
        detail: authorization.state.grant.grantId,
        kind: 'confirmation_authorized',
      },
    );
    return { authorized: true, record: await this.save(current, next) };
  }

  async requestOrderConfirmation(
    input: CheckoutSessionAuthorityV2 & { checkoutId: string },
  ): Promise<CheckoutOrchestrationRecordV2> {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    const at = this.now();
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'order_requested',
      now: at,
    });
    return this.save(
      current,
      withEvent(
        { ...current, graph },
        { at, kind: 'order_requested' },
      ),
    );
  }

  async beginDispatch(input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    currentTerms: AndroidCheckoutReviewV1;
  }): Promise<
    | {
        started: false;
        reason: 'already_started' | 'expired' | 'not_authorized';
        record: CheckoutOrchestrationRecordV2;
      }
    | {
        started: false;
        reason: 'proposal_changed';
        changes: readonly BlinkitProposalChangeV1[];
        record: CheckoutOrchestrationRecordV2;
      }
    | {
        started: true;
        command: CheckoutDispatchCommandV2;
        record: CheckoutOrchestrationRecordV2;
      }
  > {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    if (current.codState?.phase === 'dispatching') {
      return { started: false, reason: 'already_started', record: current };
    }
    if (current.codState?.phase !== 'confirmation_authorized') {
      return { started: false, reason: 'not_authorized', record: current };
    }
    const at = this.now();
    if (
      at >= current.codState.grant.expiresAt
      || at >= Date.parse(current.codState.proposal.expiresAt)
    ) {
      return { started: false, reason: 'expired', record: current };
    }
    const changes = checkoutTermChanges(
      current.codState.grant.terms,
      input.currentTerms,
    );
    if (changes.length > 0) {
      const graph = transitionCheckoutGraphV2(current.graph, {
        type: 'checkout_invalidated',
        changes,
      });
      const next = withEvent(
        {
          ...current,
          graph,
          codState: blockedCodState(current.codState),
        },
        { at, detail: changes.join(','), kind: 'checkout_invalidated' },
      );
      return {
        started: false,
        reason: 'proposal_changed',
        changes,
        record: await this.save(current, next),
      };
    }
    const dispatching = beginCodFinalDispatchV2(current.codState, at);
    const next = withEvent(
      { ...current, codState: dispatching },
      {
        at,
        detail: dispatching.grant.actionDigest,
        kind: 'dispatch_started',
      },
    );
    let saved: CheckoutOrchestrationRecordV2;
    try {
      saved = await this.save(current, next);
    } catch (error) {
      if (!(error instanceof CheckoutRecordRevisionConflictV2)) throw error;
      const latest = await this.require(input.checkoutId);
      if (latest.codState?.phase === 'dispatching') {
        return { started: false, reason: 'already_started', record: latest };
      }
      throw error;
    }
    return {
      started: true,
      command: {
        actionDigest: dispatching.grant.actionDigest,
        confirmationGrantId: dispatching.grant.grantId,
        expected: {
          proposalId: dispatching.proposal.proposalId,
          proposalHash: dispatching.proposal.proposalHash,
          idempotencyKey: `checkout.v2.${dispatching.grant.actionDigest}`,
          preparedAt: dispatching.proposal.preparedAt,
          expiresAt: dispatching.proposal.expiresAt,
          checkout: structuredClone(dispatching.proposal.checkout),
        },
      },
      record: saved,
    };
  }

  async settleDispatch(input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    result: CodDispatchObservationV2;
  }): Promise<CheckoutOrchestrationRecordV2> {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    if (current.codState?.phase !== 'dispatching') return current;
    const at = this.now();
    const codState = settleCodFinalDispatchV2(current.codState, input.result);
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'dispatch_settled',
      result: input.result,
    });
    return this.save(
      current,
      withEvent(
        { ...current, graph, codState },
        { at, detail: input.result.outcome, kind: 'dispatch_settled' },
      ),
    );
  }

  async settleReconciliation(input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    result: CheckoutReconciliationObservationV2;
  }): Promise<CheckoutOrchestrationRecordV2> {
    const current = await this.require(input.checkoutId);
    assertAuthority(current, input);
    if (
      current.graph.phase !== 'ambiguous'
      || current.graph.activeNode !== 'reconcile_order'
    ) {
      return current;
    }
    const at = this.now();
    const graph = transitionCheckoutGraphV2(current.graph, {
      type: 'reconciliation_settled',
      result: input.result,
    });
    const codState: CodCheckoutStateV2 | undefined =
      input.result.outcome === 'ordered' && current.codState
        ? {
            version: 2,
            phase: 'ordered',
            taskId: current.taskId,
            taskRevision: current.taskRevision,
            proposalId: 'proposal' in current.codState
              ? current.codState.proposal.proposalId
              : current.codState.proposalId,
            providerReference: input.result.providerReference,
          }
        : current.codState;
    return this.save(
      current,
      withEvent(
        { ...current, graph, codState },
        {
          at,
          detail: input.result.outcome,
          kind: 'reconciliation_settled',
        },
      ),
    );
  }

  private async require(
    checkoutId: string,
  ): Promise<CheckoutOrchestrationRecordV2> {
    const record = await this.repository.get(checkoutId);
    if (!record) throw new Error(`Checkout ${checkoutId} was not found.`);
    return record;
  }

  private save(
    current: CheckoutOrchestrationRecordV2,
    next: CheckoutOrchestrationRecordV2,
  ): Promise<CheckoutOrchestrationRecordV2> {
    return this.repository.save(next, current.recordRevision);
  }
}
