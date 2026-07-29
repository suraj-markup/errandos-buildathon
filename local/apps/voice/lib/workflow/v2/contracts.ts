export const PHONE_TASK_V2_VERSION = 2 as const;

export type PhoneTaskStatusV2 =
  | 'active'
  | 'paused'
  | 'waiting_for_user'
  | 'waiting_for_phone'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'ambiguous';

export type PhoneTaskStepStatusV2 =
  | 'planned'
  | 'ready'
  | 'running'
  | 'waiting_for_user'
  | 'verified'
  | 'skipped'
  | 'failed'
  | 'ambiguous'
  | 'blocked';

export type DesiredTerminalOutcomeV2 = {
  kind:
    | 'cart_ready'
    | 'ask_next'
    | 'checkout_reviewed'
    | 'order_placed'
    | (string & {});
  paymentPreference?: 'cod' | 'provider_saved' | 'ask_user';
};

export type ProductChoicePolicyModeV2 =
  | 'ask_every_time'
  | 'lowest_price_matching_pack'
  | 'known_brand_then_lowest_price'
  | 'repeat_previous_preference'
  | 'suggested_with_price_limit';

export type ProductChoicePolicyV2 = {
  mode: ProductChoicePolicyModeV2;
  priceCeiling?: {
    amount: number;
    currency: 'INR';
  };
  preferredBrands?: string[];
  previousPreference?: {
    category: string;
    brand?: string;
    packSize?: string;
    productForm?: string;
  };
};

export type PendingInteractionKindV2 =
  | 'product_choice'
  | 'next_action'
  | 'payment_choice'
  | 'checkout_confirmation'
  | 'recovery_handoff';

export type NextActionChoiceV2 =
  | 'review_cart'
  | 'add_more'
  | 'review_checkout'
  | 'stop';

export type PendingInteractionV2 = {
  interactionId: string;
  taskId: string;
  taskRevision: number;
  kind: PendingInteractionKindV2;
  allowedResponses: unknown;
  presentationRef: string;
  status: 'open' | 'resolving' | 'resolved' | 'expired' | 'cancelled';
  createdAt: number;
  expiresAt: number;
};

export type TaskTurnContextV2 = {
  languageCode: string;
  responseId?: string;
  updatedAt: number;
};

export type VerifiedFactFreshnessV2 =
  | { kind: 'task_lifetime' }
  | { kind: 'expires_at'; expiresAt: number }
  | { kind: 'until_provider_change'; providerFingerprint: string };

export type VerifiedFactReferenceV2 = {
  factId: string;
  kind: string;
  originOperationId: string;
  observedAt: number;
  freshness: VerifiedFactFreshnessV2;
  providerFingerprint?: string;
  observationRef?: string;
  valueRef: string;
  confidence: 'verified' | 'uncertain' | 'reconciliation_required';
};

export type TaskJournalEntryV2 = {
  entryId: string;
  at: number;
  type: string;
  stepId?: string;
  operationId?: string;
  dataRef?: string;
};

export type TaskBudgetsV2 = {
  maxAttemptsPerStep: number;
  maxJournalEntries: number;
  maxSteps: number;
  maxVerifiedFacts: number;
};

export type PhoneTaskStepV2 = {
  stepId: string;
  adapterId: string;
  kind: string;
  status: PhoneTaskStepStatusV2;
  dependsOn: string[];
  input: unknown;
  expectedPostcondition: unknown;
  operationId?: string;
  attempts: number;
  lastResultRef?: string;
};

export type PhoneTaskV2 = {
  version: typeof PHONE_TASK_V2_VERSION;
  taskId: string;
  clientId: string;
  revision: number;
  originalGoal: string;
  goalKind: string;
  status: PhoneTaskStatusV2;
  activeStepId?: string;
  steps: PhoneTaskStepV2[];
  desiredTerminalOutcome?: DesiredTerminalOutcomeV2;
  productChoicePolicy?: ProductChoicePolicyV2;
  pendingInteraction?: PendingInteractionV2;
  turnContext?: TaskTurnContextV2;
  verifiedFacts: VerifiedFactReferenceV2[];
  journal: TaskJournalEntryV2[];
  budgets: TaskBudgetsV2;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
};

export const DEFAULT_TASK_BUDGETS_V2: TaskBudgetsV2 = {
  maxAttemptsPerStep: 3,
  maxJournalEntries: 100,
  maxSteps: 50,
  maxVerifiedFacts: 100,
};

export const TERMINAL_TASK_STATUSES_V2 = new Set<PhoneTaskStatusV2>([
  'completed',
  'cancelled',
]);

export const TERMINAL_STEP_STATUSES_V2 = new Set<PhoneTaskStepStatusV2>([
  'verified',
  'skipped',
]);
