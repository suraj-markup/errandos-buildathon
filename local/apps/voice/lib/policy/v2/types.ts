export const phoneActionEffectsV2 = [
  'read_only',
  'navigation',
  'local_edit',
  'reversible_external',
  'external_side_effect',
  'financial',
  'irreversible',
] as const;

export type PhoneActionEffectV2 = (typeof phoneActionEffectsV2)[number];

export const phoneCapabilitiesV2 = [
  'activate',
  'add_cart_item',
  'ask_user',
  'back',
  'cancel_task',
  'clear_text',
  'confirm_order',
  'home',
  'inspect_cart',
  'launch_app',
  'observe',
  'patch_plan',
  'prepare_checkout',
  'reconcile_operation',
  'remove_cart_item',
  'scroll',
  'search_products',
  'select_payment_method',
  'select_product',
  'set_cart_item_quantity',
  'set_text',
  'submit',
  'wait_for_change',
] as const;

export type PhoneCapabilityV2 = (typeof phoneCapabilitiesV2)[number];

type CapabilityIdempotencyV2 =
  | 'none'
  | 'operation_key'
  | 'desired_state'
  | 'at_most_once';

export type CapabilityDescriptorV2 = {
  capability: PhoneCapabilityV2;
  effect: PhoneActionEffectV2;
  idempotency: CapabilityIdempotencyV2;
  requiresConfirmation: boolean;
  requiresFreshObservation: boolean;
};

export type PlannerTurnIntentV2 =
  | 'add_product'
  | 'cancel'
  | 'checkout'
  | 'confirm_order'
  | 'general'
  | 'modify_cart'
  | 'observe'
  | 'product_choice';

export type PolicyTaskStatusV2 =
  | 'active'
  | 'ambiguous'
  | 'blocked'
  | 'cancelled'
  | 'completed'
  | 'paused'
  | 'waiting_for_phone'
  | 'waiting_for_user';

type PendingInteractionKindV2 =
  | 'checkout_confirmation'
  | 'next_action'
  | 'payment_choice'
  | 'product_choice'
  | 'recovery_handoff';

export type ObservationPolicyStateV2 = {
  adapterId: string;
  capturedAt: number;
  expiresAt: number;
  observationId: string;
  restricted: boolean;
};

export type UnresolvedMutationV2 = {
  operationId: string;
  outcome: 'ambiguous' | 'mutation_unverified';
};

export type CapabilityCompilerInputV2 = {
  adapterCapabilities: readonly PhoneCapabilityV2[];
  adapterId: string;
  explicitProductChange: boolean;
  observation?: ObservationPolicyStateV2;
  pendingInteraction?: PendingInteractionKindV2;
  taskStatus: PolicyTaskStatusV2;
  turnIntent: PlannerTurnIntentV2;
  unresolvedMutation?: UnresolvedMutationV2;
};

type ProposedPhoneActionV2 = {
  actionDigest: string;
  adapterId: string;
  capability: PhoneCapabilityV2;
  idempotencyKey?: string;
  sourceObservationId?: string;
};

export type ConfirmationGrantSummaryV2 = {
  actionDigest: string;
  adapterId: string;
  expiresAt: number;
  taskRevision: number;
};

export type PolicyEvaluationInputV2 = {
  action: ProposedPhoneActionV2;
  availableCapabilities: readonly CapabilityDescriptorV2[];
  confirmationGrant?: ConfirmationGrantSummaryV2;
  currentTaskRevision: number;
  now?: number;
  observation?: ObservationPolicyStateV2;
  recoveryHandoffRequired?: boolean;
  unresolvedMutation?: UnresolvedMutationV2;
};

export type PolicyDecisionV2 =
  | { decision: 'allow' }
  | {
      decision: 'block';
      reason:
        | 'adapter_scope_mismatch'
        | 'capability_unavailable'
        | 'confirmation_grant_mismatch'
        | 'confirmation_grant_stale'
        | 'idempotency_key_required'
        | 'observation_adapter_mismatch'
        | 'observation_missing'
        | 'observation_restricted'
        | 'observation_stale';
    }
  | { decision: 'confirm'; reason: 'confirmation_required' }
  | {
      decision: 'handoff';
      reason: 'recovery_state_requires_handoff';
    }
  | {
      decision: 'reconcile';
      operationId: string;
      reason: 'unresolved_mutation';
    };
