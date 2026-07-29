import type {
  DesiredTerminalOutcomeV2,
  PendingInteractionKindV2,
  PhoneTaskStepV2,
  PhoneTaskV2,
} from './contracts';
import {
  transitionPhoneTaskV2,
  type PhoneTaskEventV2,
} from './graph';
import { parsePhoneTaskV2 } from './validation';

export type CommerceContinuationNodeIdsV2 = {
  askNext: string;
  reviewCheckout: string;
  choosePayment: string;
  selectPayment: string;
  prepareProposal: string;
  finalConfirmation: string;
  finalDispatch: string;
};

export type CommerceContinuationBuildInputV2 = {
  adapterId: string;
  anchorStepIds: string[];
  desiredTerminalOutcome: DesiredTerminalOutcomeV2;
  nodeIds: CommerceContinuationNodeIdsV2;
};

export type CommerceInteractionConfigV2 = {
  expiresAt: number;
  interactionId: string;
  presentationRef: string;
};

const continuationKinds = new Set([
  'ask_next',
  'review_checkout',
  'choose_payment_method',
  'select_payment_method',
  'prepare_checkout_proposal',
  'await_final_confirmation',
  'dispatch_order',
]);

function plannedStep(input: {
  stepId: string;
  adapterId: string;
  kind: string;
  dependsOn: string[];
  value: unknown;
  postcondition: unknown;
}): PhoneTaskStepV2 {
  return {
    stepId: input.stepId,
    adapterId: input.adapterId,
    kind: input.kind,
    status: 'planned',
    dependsOn: [...input.dependsOn],
    input: input.value,
    expectedPostcondition: input.postcondition,
    attempts: 0,
  };
}

export function buildCheckoutReviewNodeV2(input: {
  stepId: string;
  adapterId: string;
  dependsOn: string[];
}): PhoneTaskStepV2 {
  return plannedStep({
    ...input,
    kind: 'review_checkout',
    value: { mode: 'read_only_review' },
    postcondition: {
      kind: 'checkout_terms_observed',
      requires: ['items', 'fees', 'total', 'address', 'payment_mode'],
    },
  });
}

export function buildPaymentNodeV2(input: {
  chooseStepId: string;
  selectStepId: string;
  adapterId: string;
  dependsOn: string[];
  preference: DesiredTerminalOutcomeV2['paymentPreference'];
}): PhoneTaskStepV2 | undefined {
  if (input.preference === 'provider_saved') return undefined;
  if (input.preference === 'cod') {
    return plannedStep({
      stepId: input.selectStepId,
      adapterId: input.adapterId,
      kind: 'select_payment_method',
      dependsOn: input.dependsOn,
      value: { paymentMethod: 'cod' },
      postcondition: {
        kind: 'payment_method_selected',
        paymentMethod: 'cod',
      },
    });
  }
  return plannedStep({
    stepId: input.chooseStepId,
    adapterId: input.adapterId,
    kind: 'choose_payment_method',
    dependsOn: input.dependsOn,
    value: {
      choices: ['current_method', 'cod', 'add_more', 'stop'],
    },
    postcondition: { kind: 'payment_choice_resolved' },
  });
}

export function buildFinalConfirmationNodesV2(input: {
  confirmationStepId: string;
  dispatchStepId: string;
  adapterId: string;
  dependsOn: string[];
}): PhoneTaskStepV2[] {
  const confirmation = plannedStep({
    stepId: input.confirmationStepId,
    adapterId: input.adapterId,
    kind: 'await_final_confirmation',
    dependsOn: input.dependsOn,
    value: {
      requiresFreshProposal: true,
      allowedResponses: ['confirm_exact_proposal', 'cancel'],
    },
    postcondition: {
      kind: 'fresh_confirmation_grant',
      binds: ['task_revision', 'proposal_hash', 'terms', 'payment_mode'],
      singleUse: true,
      expires: true,
    },
  });
  const dispatch = plannedStep({
    stepId: input.dispatchStepId,
    adapterId: input.adapterId,
    kind: 'dispatch_order',
    dependsOn: [confirmation.stepId],
    value: {
      requiresConfirmationStepId: confirmation.stepId,
      genericToolUnavailable: true,
    },
    postcondition: {
      kind: 'order_dispatch_verified_or_ambiguous',
      atMostOnce: true,
    },
  });
  return [confirmation, dispatch];
}

export function buildCommerceContinuationNodesV2(
  input: CommerceContinuationBuildInputV2,
): PhoneTaskStepV2[] {
  const outcome = input.desiredTerminalOutcome;
  if (outcome.kind === 'cart_ready') return [];
  if (outcome.kind === 'ask_next') {
    return [plannedStep({
      stepId: input.nodeIds.askNext,
      adapterId: input.adapterId,
      kind: 'ask_next',
      dependsOn: input.anchorStepIds,
      value: {
        choices: ['add_more', 'review_checkout', 'stop'],
      },
      postcondition: { kind: 'next_action_selected' },
    })];
  }
  if (!['checkout_reviewed', 'order_placed'].includes(outcome.kind)) {
    throw new Error(`Unsupported commerce terminal outcome ${outcome.kind}.`);
  }

  const review = buildCheckoutReviewNodeV2({
    stepId: input.nodeIds.reviewCheckout,
    adapterId: input.adapterId,
    dependsOn: input.anchorStepIds,
  });
  const result: PhoneTaskStepV2[] = [review];
  const payment = buildPaymentNodeV2({
    chooseStepId: input.nodeIds.choosePayment,
    selectStepId: input.nodeIds.selectPayment,
    adapterId: input.adapterId,
    dependsOn: [review.stepId],
    preference: outcome.paymentPreference,
  });
  if (payment) result.push(payment);

  if (outcome.kind === 'checkout_reviewed' && outcome.paymentPreference !== 'cod') {
    return result;
  }
  const proposalDependency = payment?.stepId ?? review.stepId;
  const proposal = plannedStep({
    stepId: input.nodeIds.prepareProposal,
    adapterId: input.adapterId,
    kind: 'prepare_checkout_proposal',
    dependsOn: [proposalDependency],
    value: {
      paymentPreference: outcome.paymentPreference ?? 'ask_user',
      dispatch: false,
    },
    postcondition: {
      kind: 'fresh_checkout_proposal',
      presentationState: 'NOT_ORDERED',
    },
  });
  result.push(proposal);

  if (outcome.kind === 'order_placed') {
    result.push(...buildFinalConfirmationNodesV2({
      confirmationStepId: input.nodeIds.finalConfirmation,
      dispatchStepId: input.nodeIds.finalDispatch,
      adapterId: input.adapterId,
      dependsOn: [proposal.stepId],
    }));
  }
  return result;
}

function interactiveKind(
  step: PhoneTaskStepV2,
): PendingInteractionKindV2 | undefined {
  if (step.kind === 'ask_next') return 'next_action';
  if (step.kind === 'choose_payment_method') return 'payment_choice';
  if (step.kind === 'await_final_confirmation') return 'checkout_confirmation';
  return undefined;
}

function settleReadyInteractionV2(input: {
  task: PhoneTaskV2;
  at: number;
  journalEntryId: string;
  interaction: CommerceInteractionConfigV2;
}): PhoneTaskV2 {
  const step = input.task.steps.find((candidate) =>
    candidate.status === 'ready' && Boolean(interactiveKind(candidate)));
  if (!step) return input.task;
  const kind = interactiveKind(step)!;
  const allowedResponses = step.kind === 'ask_next'
    ? ['add_more', 'review_checkout', 'stop']
    : step.kind === 'choose_payment_method'
      ? ['current_method', 'cod', 'add_more', 'stop']
      : ['confirm_exact_proposal', 'cancel'];
  return transitionPhoneTaskV2(input.task, {
    type: 'wait_for_user',
    stepId: step.stepId,
    at: input.at,
    entryId: input.journalEntryId,
    interaction: {
      interactionId: input.interaction.interactionId,
      taskId: input.task.taskId,
      taskRevision: input.task.revision + 1,
      kind,
      allowedResponses,
      presentationRef: input.interaction.presentationRef,
      status: 'open',
      createdAt: input.at,
      expiresAt: input.interaction.expiresAt,
    },
  });
}

export function transitionCommerceStepVerifiedV2(input: {
  task: PhoneTaskV2;
  stepId: string;
  resultRef: string;
  at: number;
  journalEntryId: string;
  adapterId: string;
  nodeIds: CommerceContinuationNodeIdsV2;
  interaction?: CommerceInteractionConfigV2 & {
    journalEntryId: string;
  };
}): PhoneTaskV2 {
  const task = parsePhoneTaskV2(structuredClone(input.task));
  const target = task.steps.find((step) => step.stepId === input.stepId);
  if (!target) throw new Error(`Unknown commerce step ${input.stepId}.`);
  let source = task;
  const hasContinuation = task.steps.some((step) =>
    continuationKinds.has(step.kind));
  const nonContinuationSteps = task.steps.filter((step) =>
    !continuationKinds.has(step.kind));
  const completingLastWorkStep = !continuationKinds.has(target.kind)
    && nonContinuationSteps
      .filter((step) => step.stepId !== target.stepId)
      .every((step) => ['verified', 'skipped'].includes(step.status));

  if (
    completingLastWorkStep
    && !hasContinuation
    && task.desiredTerminalOutcome
  ) {
    const nodes = buildCommerceContinuationNodesV2({
      adapterId: input.adapterId,
      anchorStepIds: nonContinuationSteps.map((step) => step.stepId),
      desiredTerminalOutcome: task.desiredTerminalOutcome,
      nodeIds: input.nodeIds,
    });
    if (task.steps.length + nodes.length > task.budgets.maxSteps) {
      throw new Error('Commerce continuation exceeds task step budget.');
    }
    source = parsePhoneTaskV2({
      ...task,
      steps: [...task.steps, ...nodes],
    });
  }

  const verification: PhoneTaskEventV2 = {
    type: 'verify_step',
    stepId: input.stepId,
    resultRef: input.resultRef,
    at: input.at,
    entryId: input.journalEntryId,
  };
  const verified = transitionPhoneTaskV2(source, verification);
  if (!input.interaction) return verified;
  return settleReadyInteractionV2({
    task: verified,
    at: input.at,
    journalEntryId: input.interaction.journalEntryId,
    interaction: input.interaction,
  });
}
