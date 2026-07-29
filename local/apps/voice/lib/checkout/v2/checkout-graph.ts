import type { BlinkitProposalChangeV1 } from '@errandos/contracts';
import type { LocalIdentifier } from '../../workflow/identifiers';
import type {
  CheckoutConfirmationGrantV2,
  CheckoutPaymentChoiceIdV2,
  CurrentPaymentMethodV2,
} from './contracts';

export const CHECKOUT_NODE_KINDS_V2 = [
  'inspect_final_cart',
  'choose_next_action',
  'prepare_checkout',
  'choose_payment_method',
  'review_checkout',
  'await_final_confirmation',
  'dispatch_order',
  'reconcile_order',
] as const;

export type CheckoutNodeKindV2 = typeof CHECKOUT_NODE_KINDS_V2[number];

export type CheckoutNodeStatusV2 =
  | 'active'
  | 'blocked'
  | 'completed'
  | 'planned'
  | 'skipped';

export type CheckoutGraphNodeV2 = {
  kind: CheckoutNodeKindV2;
  status: CheckoutNodeStatusV2;
};

export type CheckoutReviewBindingV2 = {
  proposalId: string;
  proposalHash: string;
  termsDigest: string;
  paymentMode: 'card' | 'cod' | 'other' | 'upi' | 'wallet';
  preparedAt: number;
  expiresAt: number;
};

export type CheckoutGraphPhaseV2 =
  | 'active'
  | 'ambiguous'
  | 'blocked'
  | 'cart_change_requested'
  | 'checkout_reviewed'
  | 'ordered'
  | 'stopped';

export type CheckoutGraphV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  originalGoalIncludesOrder: boolean;
  phase: CheckoutGraphPhaseV2;
  activeNode?: CheckoutNodeKindV2;
  nodes: readonly CheckoutGraphNodeV2[];
  currentPayment?: CurrentPaymentMethodV2;
  codAvailable?: boolean;
  selectedPayment?: 'cod' | 'current';
  review?: CheckoutReviewBindingV2;
  safetyLabel?: 'NOT ORDERED';
  confirmationGrantId?: string;
  dispatchAttempts: 0 | 1;
  providerReference?: string;
  interruption?: 'disconnect_before_dispatch';
  invalidation?: {
    changes: readonly BlinkitProposalChangeV1[];
    requiresFreshReview: true;
  };
  reconciliationRequired?: true;
  retryAllowed?: false;
};

export type CheckoutGraphEventV2 =
  | {
      type: 'cart_inspected';
      currentPayment: CurrentPaymentMethodV2;
      codAvailable: boolean;
    }
  | {
      type: 'next_action_selected';
      choice: 'add_more' | 'review_checkout' | 'stop';
    }
  | { type: 'checkout_prepared' }
  | {
      type: 'payment_selected';
      choice: CheckoutPaymentChoiceIdV2;
    }
  | {
      type: 'review_prepared';
      review: CheckoutReviewBindingV2;
      now: number;
    }
  | {
      type: 'order_requested';
      now: number;
    }
  | {
      type: 'confirmation_authorized';
      grant: CheckoutConfirmationGrantV2 & { consumedAt: number };
      now: number;
    }
  | {
      type: 'checkout_invalidated';
      changes: readonly BlinkitProposalChangeV1[];
    }
  | {
      type: 'dispatch_settled';
      result:
        | { outcome: 'ambiguous' }
        | { outcome: 'committed'; providerReference: string }
        | { outcome: 'stale' }
        | {
            outcome: 'disconnected';
            crossedFinalActionBoundary: boolean;
          };
    }
  | {
      type: 'reconciliation_settled';
      result:
        | { outcome: 'ambiguous' }
        | { outcome: 'not_ordered' }
        | { outcome: 'ordered'; providerReference: string };
    };

export class InvalidCheckoutGraphTransitionV2 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCheckoutGraphTransitionV2';
  }
}

function initialNodes(
  originalGoalIncludesOrder: boolean,
): CheckoutGraphNodeV2[] {
  return CHECKOUT_NODE_KINDS_V2.map((kind) => ({
    kind,
    status: kind === 'inspect_final_cart'
      ? 'active'
      : kind === 'choose_next_action' && originalGoalIncludesOrder
        ? 'skipped'
        : 'planned',
  }));
}

export function createCheckoutGraphV2(input: {
  originalGoalIncludesOrder: boolean;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): CheckoutGraphV2 {
  if (!Number.isSafeInteger(input.taskRevision) || input.taskRevision < 0) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  return {
    version: 2,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    originalGoalIncludesOrder: input.originalGoalIncludesOrder,
    phase: 'active',
    activeNode: 'inspect_final_cart',
    nodes: initialNodes(input.originalGoalIncludesOrder),
    dispatchAttempts: 0,
  };
}

function bounded(value: string, name: string, max = 240): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new InvalidCheckoutGraphTransitionV2(
      `${name} must contain 1-${max} characters.`,
    );
  }
  return normalized;
}

function requireActive(
  graph: CheckoutGraphV2,
  expected: CheckoutNodeKindV2,
): void {
  if (graph.phase !== 'active' || graph.activeNode !== expected) {
    throw new InvalidCheckoutGraphTransitionV2(
      `Expected active checkout node ${expected}; received ${
        graph.activeNode ?? graph.phase
      }.`,
    );
  }
}

function updateNode(
  nodes: readonly CheckoutGraphNodeV2[],
  kind: CheckoutNodeKindV2,
  status: CheckoutNodeStatusV2,
): CheckoutGraphNodeV2[] {
  return nodes.map((node) => node.kind === kind ? { ...node, status } : node);
}

function move(
  graph: CheckoutGraphV2,
  from: CheckoutNodeKindV2,
  to: CheckoutNodeKindV2,
): CheckoutGraphV2 {
  requireActive(graph, from);
  return {
    ...graph,
    activeNode: to,
    nodes: updateNode(updateNode(graph.nodes, from, 'completed'), to, 'active'),
  };
}

function skipRemaining(
  graph: CheckoutGraphV2,
  from: CheckoutNodeKindV2,
  phase: 'cart_change_requested' | 'checkout_reviewed' | 'stopped',
): CheckoutGraphV2 {
  requireActive(graph, from);
  const completed = updateNode(graph.nodes, from, 'completed');
  return {
    ...graph,
    phase,
    activeNode: undefined,
    nodes: completed.map((node) =>
      node.status === 'planned' ? { ...node, status: 'skipped' } : node),
  };
}

function paymentKindForReview(
  graph: CheckoutGraphV2,
): CheckoutReviewBindingV2['paymentMode'] {
  if (graph.selectedPayment === 'cod') return 'cod';
  if (graph.selectedPayment === 'current' && graph.currentPayment) {
    return graph.currentPayment.kind;
  }
  throw new InvalidCheckoutGraphTransitionV2(
    'Checkout review requires a selected payment method.',
  );
}

function validateReview(
  graph: CheckoutGraphV2,
  review: CheckoutReviewBindingV2,
  now: number,
): CheckoutReviewBindingV2 {
  if (!Number.isSafeInteger(review.expiresAt) || review.expiresAt <= now) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Checkout review is already expired.',
    );
  }
  if (
    !Number.isSafeInteger(review.preparedAt)
    || review.preparedAt > now
    || review.preparedAt >= review.expiresAt
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Checkout review has an invalid preparation time.',
    );
  }
  const expectedPayment = paymentKindForReview(graph);
  if (review.paymentMode !== expectedPayment) {
    throw new InvalidCheckoutGraphTransitionV2(
      `Checkout review payment ${review.paymentMode} does not match ${expectedPayment}.`,
    );
  }
  return {
    proposalId: bounded(review.proposalId, 'proposalId'),
    proposalHash: bounded(review.proposalHash, 'proposalHash'),
    termsDigest: bounded(review.termsDigest, 'termsDigest'),
    paymentMode: review.paymentMode,
    preparedAt: review.preparedAt,
    expiresAt: review.expiresAt,
  };
}

function blockForInvalidation(
  graph: CheckoutGraphV2,
  changes: readonly BlinkitProposalChangeV1[],
): CheckoutGraphV2 {
  if (changes.length === 0) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Checkout invalidation requires at least one material change.',
    );
  }
  if (
    graph.phase !== 'active'
    || !graph.review
    || ![
      'await_final_confirmation',
      'dispatch_order',
    ].includes(graph.activeNode ?? '')
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Only a reviewed checkout can be invalidated.',
    );
  }
  return {
    ...graph,
    phase: 'blocked',
    activeNode: undefined,
    nodes: graph.nodes.map((node) =>
      node.kind === graph.activeNode ? { ...node, status: 'blocked' } : node),
    invalidation: {
      changes: [...new Set(changes)],
      requiresFreshReview: true,
    },
    retryAllowed: false,
  };
}

function authorizeConfirmation(
  graph: CheckoutGraphV2,
  grant: CheckoutConfirmationGrantV2 & { consumedAt: number },
  now: number,
): CheckoutGraphV2 {
  requireActive(graph, 'await_final_confirmation');
  const review = graph.review;
  if (!review) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Final confirmation requires a checkout review.',
    );
  }
  if (
    now >= review.expiresAt
    || now >= grant.expiresAt
    || grant.consumedAt > now
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Final confirmation is expired or not yet consumed.',
    );
  }
  if (
    grant.taskId !== graph.taskId
    || grant.taskRevision !== graph.taskRevision
    || grant.proposalId !== review.proposalId
    || grant.proposalHash !== review.proposalHash
    || Date.parse(grant.proposalPreparedAt) !== review.preparedAt
    || Date.parse(grant.proposalExpiresAt) !== review.expiresAt
    || grant.termsDigest !== review.termsDigest
    || grant.paymentMode !== review.paymentMode
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Confirmation grant does not match the reviewed proposal.',
    );
  }
  return {
    ...move(graph, 'await_final_confirmation', 'dispatch_order'),
    confirmationGrantId: bounded(grant.grantId, 'grantId'),
  };
}

function requestOrderAfterReview(
  graph: CheckoutGraphV2,
  now: number,
): CheckoutGraphV2 {
  if (
    graph.phase !== 'checkout_reviewed'
    || graph.activeNode !== undefined
    || !graph.review
    || graph.safetyLabel !== 'NOT ORDERED'
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'An order can only be requested from a completed checkout review.',
    );
  }
  if (now >= graph.review.expiresAt) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Checkout review is already expired.',
    );
  }
  return {
    ...graph,
    originalGoalIncludesOrder: true,
    phase: 'active',
    activeNode: 'await_final_confirmation',
    nodes: graph.nodes.map((node) => {
      if (node.kind === 'await_final_confirmation') {
        return { ...node, status: 'active' };
      }
      if (node.kind === 'dispatch_order' || node.kind === 'reconcile_order') {
        return { ...node, status: 'planned' };
      }
      return node;
    }),
  };
}

function settleDispatch(
  graph: CheckoutGraphV2,
  result: Extract<CheckoutGraphEventV2, { type: 'dispatch_settled' }>['result'],
): CheckoutGraphV2 {
  requireActive(graph, 'dispatch_order');
  if (graph.dispatchAttempts !== 0) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Final dispatch has already crossed the provider action boundary.',
    );
  }
  if (
    result.outcome === 'disconnected'
    && !result.crossedFinalActionBoundary
  ) {
    let nodes = updateNode(graph.nodes, 'dispatch_order', 'planned');
    nodes = updateNode(nodes, 'await_final_confirmation', 'active');
    return {
      ...graph,
      activeNode: 'await_final_confirmation',
      nodes,
      confirmationGrantId: undefined,
      interruption: 'disconnect_before_dispatch',
    };
  }

  const attempted = { ...graph, dispatchAttempts: 1 as const };
  if (result.outcome === 'committed') {
    return {
      ...attempted,
      phase: 'ordered',
      activeNode: undefined,
      nodes: updateNode(
        updateNode(attempted.nodes, 'dispatch_order', 'completed'),
        'reconcile_order',
        'skipped',
      ),
      providerReference: bounded(
        result.providerReference,
        'providerReference',
      ),
    };
  }
  if (result.outcome === 'stale') {
    return {
      ...attempted,
      phase: 'blocked',
      activeNode: undefined,
      nodes: updateNode(attempted.nodes, 'dispatch_order', 'blocked'),
      invalidation: {
        changes: ['provider_fingerprint'],
        requiresFreshReview: true,
      },
      retryAllowed: false,
    };
  }
  return {
    ...attempted,
    phase: 'ambiguous',
    activeNode: 'reconcile_order',
    nodes: updateNode(
      updateNode(attempted.nodes, 'dispatch_order', 'completed'),
      'reconcile_order',
      'active',
    ),
    reconciliationRequired: true,
    retryAllowed: false,
  };
}

function settleReconciliation(
  graph: CheckoutGraphV2,
  result: Extract<
    CheckoutGraphEventV2,
    { type: 'reconciliation_settled' }
  >['result'],
): CheckoutGraphV2 {
  if (
    graph.phase !== 'ambiguous'
    || graph.activeNode !== 'reconcile_order'
    || graph.dispatchAttempts !== 1
  ) {
    throw new InvalidCheckoutGraphTransitionV2(
      'Order reconciliation requires one ambiguous dispatch attempt.',
    );
  }
  if (result.outcome === 'ordered') {
    return {
      ...graph,
      phase: 'ordered',
      activeNode: undefined,
      nodes: updateNode(graph.nodes, 'reconcile_order', 'completed'),
      providerReference: bounded(
        result.providerReference,
        'providerReference',
      ),
      reconciliationRequired: undefined,
    };
  }
  return {
    ...graph,
    phase: result.outcome === 'ambiguous' ? 'ambiguous' : 'blocked',
    activeNode: undefined,
    nodes: updateNode(graph.nodes, 'reconcile_order', 'blocked'),
    reconciliationRequired: true,
    retryAllowed: false,
  };
}

export function transitionCheckoutGraphV2(
  source: CheckoutGraphV2,
  event: CheckoutGraphEventV2,
): CheckoutGraphV2 {
  const graph = structuredClone(source);
  switch (event.type) {
    case 'cart_inspected': {
      requireActive(graph, 'inspect_final_cart');
      bounded(event.currentPayment.label, 'payment label');
      bounded(event.currentPayment.methodRef, 'payment method reference');
      const next = graph.originalGoalIncludesOrder
        ? 'prepare_checkout'
        : 'choose_next_action';
      return {
        ...move(graph, 'inspect_final_cart', next),
        currentPayment: structuredClone(event.currentPayment),
        codAvailable: event.codAvailable,
      };
    }
    case 'next_action_selected':
      requireActive(graph, 'choose_next_action');
      if (event.choice === 'add_more') {
        return skipRemaining(graph, 'choose_next_action', 'cart_change_requested');
      }
      if (event.choice === 'stop') {
        return skipRemaining(graph, 'choose_next_action', 'stopped');
      }
      return move(graph, 'choose_next_action', 'prepare_checkout');
    case 'checkout_prepared':
      return move(graph, 'prepare_checkout', 'choose_payment_method');
    case 'payment_selected':
      requireActive(graph, 'choose_payment_method');
      if (event.choice === 'add_more') {
        return skipRemaining(
          graph,
          'choose_payment_method',
          'cart_change_requested',
        );
      }
      if (event.choice === 'stop') {
        return skipRemaining(graph, 'choose_payment_method', 'stopped');
      }
      if (event.choice === 'use_cod' && !graph.codAvailable) {
        throw new InvalidCheckoutGraphTransitionV2(
          'Cash on Delivery is unavailable.',
        );
      }
      return {
        ...move(graph, 'choose_payment_method', 'review_checkout'),
        selectedPayment: event.choice === 'use_cod' ? 'cod' : 'current',
      };
    case 'review_prepared': {
      requireActive(graph, 'review_checkout');
      const review = validateReview(graph, event.review, event.now);
      if (!graph.originalGoalIncludesOrder) {
        return {
          ...skipRemaining(graph, 'review_checkout', 'checkout_reviewed'),
          review,
          safetyLabel: 'NOT ORDERED',
        };
      }
      return {
        ...move(graph, 'review_checkout', 'await_final_confirmation'),
        review,
        safetyLabel: 'NOT ORDERED',
      };
    }
    case 'order_requested':
      return requestOrderAfterReview(graph, event.now);
    case 'confirmation_authorized':
      return authorizeConfirmation(graph, event.grant, event.now);
    case 'checkout_invalidated':
      return blockForInvalidation(graph, event.changes);
    case 'dispatch_settled':
      return settleDispatch(graph, event.result);
    case 'reconciliation_settled':
      return settleReconciliation(graph, event.result);
  }
}
