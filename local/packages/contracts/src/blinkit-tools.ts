import { z } from 'zod';
import { MoneySchema } from './proposals.js';
import { GroceryItemSchema, ProposalOutputSchemaV1 } from './transactions.js';
import { AndroidCartReviewSchemaV1, AndroidCurrentScreenSchemaV1, AndroidImportedCartSchemaV1, AndroidRecentOrderSchemaV1, AndroidSavedAddressSchemaV1, AndroidSharedCartSchemaV1, BlinkitProposalChangeSchemaV1, BlinkitShareUrlSchemaV1 } from './android-worker.js';

const OpaqueId = z.string().trim().min(1).max(200);

export const BlinkitAccountInputSchemaV1 = z.object({
  version: z.literal(1).default(1),
  accountKey: OpaqueId.default('main'),
}).strict();

export const BlinkitBeginLoginInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  phone: z.string().regex(/^\d{10}$/),
}).strict();

export const BlinkitSubmitOtpInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  otp: z.string().regex(/^\d{4,8}$/),
}).strict();

export const BlinkitSearchProductsInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

export const BlinkitSearchOfferSchemaV1 = z.object({
  offerId: OpaqueId,
  title: z.string().trim().min(1).max(300),
  packSize: z.string().trim().min(1).max(100).optional(),
  price: MoneySchema,
  available: z.boolean(),
  imageUrl: z.string().trim().url().max(2_048).refine((value) => {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      return hostname === 'blinkit.com'
        || hostname.endsWith('.blinkit.com')
        || hostname === 'grofers.com'
        || hostname.endsWith('.grofers.com');
    } catch {
      return false;
    }
  }, 'Product image URL must use a Blinkit-owned domain').optional(),
}).strict();

export const BlinkitSearchProductsOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'no_results']),
  offers: z.array(BlinkitSearchOfferSchemaV1).max(10),
}).strict();

export const BlinkitPrepareCodOrderInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  items: z.array(GroceryItemSchema).min(1).max(30),
  deliveryAddressRef: OpaqueId,
  deliveryAddressLabel: z.string().trim().min(1).max(240),
}).strict();

export const BlinkitStartPrepareCodOrderInputSchemaV1 = BlinkitPrepareCodOrderInputSchemaV1.extend({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
}).strict();

const BlinkitOperationIdSchemaV1 = z.string().regex(/^operation_[0-9a-f-]{36}$/);
const BlinkitOperationCommonShapeV1 = {
  version: z.literal(1),
  operationId: BlinkitOperationIdSchemaV1,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
};

export const BlinkitOperationFailureReasonSchemaV1 = z.enum([
  'worker_unreachable',
  'worker_execution_failed',
  'worker_response_invalid',
  'emulator_unavailable',
  'login_required',
  'screen_blocked',
  'cod_minimum_not_met',
  'product_unavailable',
  'quantity_unavailable',
  'address_unserviceable',
  'cod_unavailable',
  'price_changed',
  'checkout_terms_unreadable',
  'provider_timeout',
  'proposal_not_found',
  'proposal_not_comparable',
  'address_not_found',
  'live_actions_disabled',
  'operation_failed',
]);

export const BlinkitToolSuggestedActionSchemaV1 = z.enum([
  'retry',
  'check_readiness',
  'login',
  'inspect_screen',
  'choose_product',
  'choose_address',
  'prepare_fresh_proposal',
  'stop',
]);

export const BlinkitToolFailureOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('failed'),
  reason: BlinkitOperationFailureReasonSchemaV1,
  retryable: z.boolean(),
  suggestedAction: BlinkitToolSuggestedActionSchemaV1,
  stage: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).optional(),
}).strict();

export const BlinkitCheckoutBlockedReasonSchemaV1 = z.enum([
  'cod_minimum_not_met',
  'product_unavailable',
  'quantity_unavailable',
  'address_unserviceable',
  'cod_unavailable',
  'price_changed',
  'checkout_terms_unreadable',
]);

export const BlinkitCheckoutBlockedOutputSchemaV1 = z.object({
  version: z.literal(1),
  provider: z.literal('blinkit'),
  status: z.literal('blocked'),
  reason: BlinkitCheckoutBlockedReasonSchemaV1,
  itemSubtotal: z.number().nonnegative().optional(),
  requiredSubtotal: z.number().positive().optional(),
}).strict().superRefine((value, context) => {
  const hasAmounts = value.itemSubtotal !== undefined || value.requiredSubtotal !== undefined;
  if (value.reason === 'cod_minimum_not_met') {
    if (value.itemSubtotal === undefined || value.requiredSubtotal === undefined) {
      context.addIssue({ code: 'custom', message: 'COD minimum results require both subtotal amounts' });
    } else if (value.requiredSubtotal <= value.itemSubtotal) {
      context.addIssue({ code: 'custom', message: 'Required subtotal must exceed the item subtotal' });
    }
  } else if (hasAmounts) {
    context.addIssue({ code: 'custom', message: 'Subtotal amounts are only valid for COD minimum results' });
  }
});

export const BlinkitPrepareCodOrderOutputSchemaV1 = z.union([
  ProposalOutputSchemaV1,
  BlinkitCheckoutBlockedOutputSchemaV1,
]);

// MCP output schemas must be raw object shapes. This schema is deliberately
// looser than the authoritative union above and every result is parsed through
// BlinkitPrepareCodOrderOutputSchemaV1 before being returned.
export const BlinkitPrepareCodOrderOutputObjectSchemaV1 = z.object({
  version: z.literal(1),
  provider: ProposalOutputSchemaV1.shape.provider,
  status: z.union([ProposalOutputSchemaV1.shape.status, z.literal('blocked')]),
  proposalId: OpaqueId.optional(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  summary: ProposalOutputSchemaV1.shape.summary.optional(),
  expiresAt: z.string().datetime().optional(),
  requiresExternalApproval: z.boolean().optional(),
  reason: BlinkitCheckoutBlockedReasonSchemaV1.optional(),
  itemSubtotal: z.number().nonnegative().optional(),
  requiredSubtotal: z.number().positive().optional(),
}).strict();

export const BlinkitStartPrepareCodOrderOutputSchemaV1 = z.object({
  ...BlinkitOperationCommonShapeV1,
  status: z.literal('running'),
}).strict();

export const BlinkitOperationStatusInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  operationId: BlinkitOperationIdSchemaV1,
}).strict();

export const BlinkitOperationStatusOutputSchemaV1 = z.discriminatedUnion('status', [
  z.object({ ...BlinkitOperationCommonShapeV1, status: z.literal('running') }).strict(),
  z.object({ ...BlinkitOperationCommonShapeV1, status: z.literal('completed'), proposal: ProposalOutputSchemaV1 }).strict(),
  z.object({
    ...BlinkitOperationCommonShapeV1,
    status: z.literal('blocked'),
    reason: BlinkitCheckoutBlockedReasonSchemaV1,
    itemSubtotal: z.number().nonnegative().optional(),
    requiredSubtotal: z.number().positive().optional(),
  }).strict(),
  z.object({ ...BlinkitOperationCommonShapeV1, status: z.literal('failed'), reason: BlinkitOperationFailureReasonSchemaV1 }).strict(),
  z.object({ ...BlinkitOperationCommonShapeV1, status: z.literal('expired') }).strict(),
]).superRefine((value, context) => {
  if (value.status !== 'blocked') return;
  const hasAmounts = value.itemSubtotal !== undefined || value.requiredSubtotal !== undefined;
  if (value.reason === 'cod_minimum_not_met') {
    if (value.itemSubtotal === undefined || value.requiredSubtotal === undefined) {
      context.addIssue({ code: 'custom', message: 'COD minimum results require both subtotal amounts' });
    } else if (value.requiredSubtotal <= value.itemSubtotal) {
      context.addIssue({ code: 'custom', message: 'Required subtotal must exceed the item subtotal' });
    }
  } else if (hasAmounts) {
    context.addIssue({ code: 'custom', message: 'Subtotal amounts are only valid for COD minimum results' });
  }
});

// MCP output schemas are registered as raw object shapes; the discriminated union above
// remains the authoritative parser used by the application service.
export const BlinkitOperationStatusOutputObjectSchemaV1 = z.object({
  ...BlinkitOperationCommonShapeV1,
  status: z.enum(['running', 'completed', 'blocked', 'failed', 'expired']),
  proposal: ProposalOutputSchemaV1.optional(),
  reason: BlinkitOperationFailureReasonSchemaV1.optional(),
  itemSubtotal: z.number().nonnegative().optional(),
  requiredSubtotal: z.number().positive().optional(),
}).strict();

export const BlinkitRecentOperationsInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  limit: z.number().int().min(1).max(20).default(5),
}).strict();

export const BlinkitRecentOperationSchemaV1 = z.object({
  operationId: BlinkitOperationIdSchemaV1,
  status: z.enum(['running', 'completed', 'blocked', 'failed', 'expired']),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  proposalId: OpaqueId.optional(),
  reason: BlinkitOperationFailureReasonSchemaV1.optional(),
}).strict();

export const BlinkitRecentOperationsOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'empty']),
  operations: z.array(BlinkitRecentOperationSchemaV1).max(20),
}).strict();

export const BlinkitCartStatusOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'empty']),
  cart: AndroidCartReviewSchemaV1.optional(),
}).strict();

export const BlinkitCurrentScreenOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('completed'),
  screen: AndroidCurrentScreenSchemaV1,
}).strict();

export const BlinkitShareCartOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('completed'),
  ...AndroidSharedCartSchemaV1.shape,
}).strict();

export const BlinkitImportSharedCartInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  shareUrl: BlinkitShareUrlSchemaV1,
}).strict();

export const BlinkitImportSharedCartOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('completed'),
  ...AndroidImportedCartSchemaV1.shape,
}).strict();

export const BlinkitPrepareExistingCartCodOrderInputSchemaV1 = BlinkitAccountInputSchemaV1;

export const BlinkitAddCartItemInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  query: z.string().trim().min(1).max(200),
  offerId: OpaqueId,
  quantity: z.number().int().min(1).max(20),
}).strict();

export const BlinkitSetCartItemQuantityInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  productId: OpaqueId,
  quantity: z.number().int().min(1).max(20),
}).strict();

export const BlinkitRemoveCartItemInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  productId: OpaqueId,
}).strict();

export const BlinkitClearCartInputSchemaV1 = BlinkitAccountInputSchemaV1;

export const BlinkitListSavedAddressesInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  requestedLabel: z.string().trim().min(1).max(60)
    .refine((label) => !/[,\n\r]|\b\d{6}\b|@/.test(label), 'Use only a saved address label'),
}).partial({ requestedLabel: true }).strict();

export const BlinkitListSavedAddressesOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'empty']),
  addresses: z.array(AndroidSavedAddressSchemaV1).max(20),
}).strict();

export const BlinkitSelectSavedAddressInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  addressReference: AndroidSavedAddressSchemaV1.shape.addressReference,
}).strict();

export const BlinkitSelectSavedAddressOutputObjectSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('completed'),
  selectedAddress: AndroidSavedAddressSchemaV1,
  cartStatus: z.enum(['completed', 'unverified']),
  cart: AndroidCartReviewSchemaV1.optional(),
}).strict();

export const BlinkitSelectSavedAddressOutputSchemaV1 = BlinkitSelectSavedAddressOutputObjectSchemaV1.superRefine((value, context) => {
  if ((value.cartStatus === 'completed') !== (value.cart !== undefined)) {
    context.addIssue({ code: 'custom', path: ['cart'], message: 'Completed cart status requires a cart and unverified status forbids one' });
  }
});

export const BlinkitCompareProposalInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  proposalId: OpaqueId,
}).strict();

export const BlinkitCompareProposalOutputObjectSchemaV1 = z.object({
  version: z.literal(1),
  proposalId: OpaqueId,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalStatus: ProposalOutputSchemaV1.shape.status,
  status: z.enum(['unchanged', 'changed', 'expired']),
  changes: z.array(BlinkitProposalChangeSchemaV1).max(8),
  currentProviderFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const BlinkitCompareProposalOutputSchemaV1 = BlinkitCompareProposalOutputObjectSchemaV1.superRefine((value, context) => {
  if (value.status === 'unchanged' && value.changes.length > 0) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'Unchanged proposals cannot contain changes' });
  }
  if (value.status === 'changed' && value.changes.length === 0) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'Changed proposals require at least one changed field' });
  }
});

export const BlinkitRecentOrdersInputSchemaV1 = BlinkitAccountInputSchemaV1.extend({
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

export const BlinkitRecentOrdersOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'empty']),
  orders: z.array(AndroidRecentOrderSchemaV1).max(10),
}).strict();

export const BlinkitReadinessComponentSchemaV1 = z.enum([
  'control_plane',
  'worker',
  'appium',
  'emulator',
  'blinkit_app',
  'authentication',
]);

export const BlinkitReadinessReasonSchemaV1 = z.enum([
  'worker_unreachable',
  'appium_unavailable',
  'emulator_unavailable',
  'blinkit_app_unavailable',
  'login_required',
  'challenge_required',
  'dependency_unavailable',
  'unexpected_provider_screen',
]);

export const BlinkitReadinessCheckSchemaV1 = z.object({
  component: BlinkitReadinessComponentSchemaV1,
  status: z.enum(['ready', 'action_required', 'unavailable', 'unknown']),
  reason: BlinkitReadinessReasonSchemaV1.optional(),
}).strict();

export const BlinkitReadinessOutputSchemaV1 = z.object({
  version: z.literal(1),
  accountKey: OpaqueId,
  status: z.enum(['ready', 'action_required', 'unavailable']),
  checks: z.array(BlinkitReadinessCheckSchemaV1).length(6),
}).strict();

export type BlinkitSearchProductsInputV1 = z.infer<typeof BlinkitSearchProductsInputSchemaV1>;
export type BlinkitSearchProductsOutputV1 = z.infer<typeof BlinkitSearchProductsOutputSchemaV1>;
export type BlinkitSearchOfferV1 = z.infer<typeof BlinkitSearchOfferSchemaV1>;
export type BlinkitPrepareCodOrderInputV1 = z.infer<typeof BlinkitPrepareCodOrderInputSchemaV1>;
export type BlinkitStartPrepareCodOrderInputV1 = z.infer<typeof BlinkitStartPrepareCodOrderInputSchemaV1>;
export type BlinkitStartPrepareCodOrderOutputV1 = z.infer<typeof BlinkitStartPrepareCodOrderOutputSchemaV1>;
export type BlinkitOperationStatusInputV1 = z.infer<typeof BlinkitOperationStatusInputSchemaV1>;
export type BlinkitOperationStatusOutputV1 = z.infer<typeof BlinkitOperationStatusOutputSchemaV1>;
export type BlinkitOperationFailureReasonV1 = z.infer<typeof BlinkitOperationFailureReasonSchemaV1>;
export type BlinkitToolFailureOutputV1 = z.infer<typeof BlinkitToolFailureOutputSchemaV1>;
export type BlinkitCheckoutBlockedReasonV1 = z.infer<typeof BlinkitCheckoutBlockedReasonSchemaV1>;
export type BlinkitCheckoutBlockedOutputV1 = z.infer<typeof BlinkitCheckoutBlockedOutputSchemaV1>;
export type BlinkitPrepareCodOrderOutputV1 = z.infer<typeof BlinkitPrepareCodOrderOutputSchemaV1>;
export type BlinkitCartStatusOutputV1 = z.infer<typeof BlinkitCartStatusOutputSchemaV1>;
export type BlinkitCurrentScreenOutputV1 = z.infer<typeof BlinkitCurrentScreenOutputSchemaV1>;
export type BlinkitShareCartOutputV1 = z.infer<typeof BlinkitShareCartOutputSchemaV1>;
export type BlinkitImportSharedCartInputV1 = z.infer<typeof BlinkitImportSharedCartInputSchemaV1>;
export type BlinkitImportSharedCartOutputV1 = z.infer<typeof BlinkitImportSharedCartOutputSchemaV1>;
export type BlinkitPrepareExistingCartCodOrderInputV1 = z.infer<typeof BlinkitPrepareExistingCartCodOrderInputSchemaV1>;
export type BlinkitAddCartItemInputV1 = z.infer<typeof BlinkitAddCartItemInputSchemaV1>;
export type BlinkitSetCartItemQuantityInputV1 = z.infer<typeof BlinkitSetCartItemQuantityInputSchemaV1>;
export type BlinkitRemoveCartItemInputV1 = z.infer<typeof BlinkitRemoveCartItemInputSchemaV1>;
export type BlinkitClearCartInputV1 = z.infer<typeof BlinkitClearCartInputSchemaV1>;
export type BlinkitReadinessOutputV1 = z.infer<typeof BlinkitReadinessOutputSchemaV1>;
export type BlinkitListSavedAddressesInputV1 = z.infer<typeof BlinkitListSavedAddressesInputSchemaV1>;
export type BlinkitListSavedAddressesOutputV1 = z.infer<typeof BlinkitListSavedAddressesOutputSchemaV1>;
export type BlinkitRecentOrdersInputV1 = z.infer<typeof BlinkitRecentOrdersInputSchemaV1>;
export type BlinkitRecentOrdersOutputV1 = z.infer<typeof BlinkitRecentOrdersOutputSchemaV1>;
export type BlinkitRecentOperationsInputV1 = z.infer<typeof BlinkitRecentOperationsInputSchemaV1>;
export type BlinkitRecentOperationsOutputV1 = z.infer<typeof BlinkitRecentOperationsOutputSchemaV1>;
export type BlinkitSelectSavedAddressInputV1 = z.infer<typeof BlinkitSelectSavedAddressInputSchemaV1>;
export type BlinkitSelectSavedAddressOutputV1 = z.infer<typeof BlinkitSelectSavedAddressOutputSchemaV1>;
export type BlinkitCompareProposalInputV1 = z.infer<typeof BlinkitCompareProposalInputSchemaV1>;
export type BlinkitCompareProposalOutputV1 = z.infer<typeof BlinkitCompareProposalOutputSchemaV1>;
