import { z } from 'zod';
import { MoneySchema } from './proposals.js';

const Id = z.string().trim().min(1).max(200);
const SecretPhone = z.string().regex(/^\d{10}$/);
const SecretOtp = z.string().regex(/^\d{4,8}$/);
const WorkerOperationSchema = z.enum(['readiness', 'current_screen', 'auth_status', 'begin_login', 'submit_otp', 'search', 'inspect_cart', 'share_cart', 'import_shared_cart', 'upsert_cart_item', 'set_cart_quantity', 'remove_cart_item', 'clear_cart', 'list_saved_addresses', 'select_saved_address', 'recent_orders', 'review_checkout', 'prepare_checkout', 'prepare_existing_checkout', 'commit_once', 'reconcile']);
const FeeKindSchema = z.enum(['delivery', 'handling', 'platform', 'surge', 'booking', 'tax', 'discount', 'other']);

export const AndroidCartLineSchemaV1 = z.object({
  productId: Id,
  name: z.string().trim().min(1).max(300),
  quantity: z.number().int().positive().max(100),
  unitPrice: MoneySchema,
  lineTotal: MoneySchema,
}).strict();

export const UnavailableGroceryItemSchemaV1 = z.object({
  query: z.string().trim().min(1).max(200),
  reason: z.enum(['out_of_stock', 'not_found', 'ambiguous']),
}).strict();

export const AndroidCheckoutReviewSchemaV1 = z.object({
  lines: z.array(AndroidCartLineSchemaV1).min(1).max(30),
  unavailableItems: z.array(UnavailableGroceryItemSchemaV1).max(30),
  fees: z.array(z.object({ kind: FeeKindSchema, label: z.string().trim().min(1).max(120), amount: MoneySchema }).strict()).max(30),
  total: MoneySchema,
  addressReference: Id,
  addressLabel: z.string().trim().min(1).max(100),
  paymentMode: z.literal('cod'),
  etaMinutes: z.number().int().positive().max(24 * 60).optional(),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const AndroidCartReviewSchemaV1 = z.object({
  lines: z.array(AndroidCartLineSchemaV1).min(1).max(30),
  unavailableItems: z.array(UnavailableGroceryItemSchemaV1).max(30),
  subtotal: MoneySchema,
  addressReference: Id,
  addressLabel: z.string().trim().min(1).max(100),
  paymentMode: z.enum(['cod', 'other', 'unselected']),
  etaMinutes: z.number().int().positive().max(24 * 60).optional(),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const BlinkitProposalChangeSchemaV1 = z.enum([
  'items',
  'unavailable_items',
  'fees',
  'total',
  'address',
  'payment_mode',
  'eta',
  'provider_fingerprint',
]);

export const AndroidCheckoutComparisonSchemaV1 = z.object({
  matches: z.boolean(),
  changes: z.array(BlinkitProposalChangeSchemaV1).max(8),
  currentProviderFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.matches && value.changes.length > 0) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'Matching checkout cannot contain changes' });
  }
  if (!value.matches && value.changes.length === 0) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'Changed checkout requires at least one changed field' });
  }
});

export const AndroidExpectedCheckoutSchemaV1 = z.object({
  proposalId: Id,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
  preparedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  checkout: AndroidCheckoutReviewSchemaV1,
}).strict();

export const AndroidSavedAddressSchemaV1 = z.object({
  addressReference: z.string().regex(/^address_[a-f0-9]{32}$/),
  label: z.string().trim().min(1).max(60),
}).strict();

export const AndroidRecentOrderStatusSchemaV1 = z.enum([
  'placed', 'confirmed', 'preparing', 'packed', 'out_for_delivery',
  'delivered', 'cancelled', 'refunded', 'failed', 'unknown',
]);

export const AndroidRecentOrderSchemaV1 = z.object({
  orderReference: Id,
  items: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    quantity: z.number().int().positive().max(100).optional(),
  }).strict()).min(1).max(50),
  total: MoneySchema,
  orderedAt: z.string().datetime(),
  providerStatus: AndroidRecentOrderStatusSchemaV1,
}).strict();

export const AndroidScreenKindSchemaV1 = z.enum([
  'home',
  'search',
  'search_results',
  'product_detail',
  'cart',
  'checkout',
  'payment',
  'address_selection',
  'login',
  'otp',
  'location_prompt',
  'review_prompt',
  'order_confirmation',
  'order_history',
  'unknown',
]);

export const AndroidCurrentScreenSchemaV1 = z.object({
  kind: AndroidScreenKindSchemaV1,
  searchAction: z.enum(['available', 'recoverable', 'blocked']),
  cartItemCount: z.number().int().nonnegative().max(100).optional(),
  product: z.object({
    name: z.string().trim().min(1).max(300),
    packSize: z.string().trim().min(1).max(100).optional(),
    price: MoneySchema.optional(),
  }).strict().optional(),
}).strict();

export const BlinkitShareUrlSchemaV1 = z.string().trim().url().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && (hostname === 'blinkit.com' || hostname.endsWith('.blinkit.com'));
  } catch {
    return false;
  }
}, 'Share URL must use HTTPS on the Blinkit domain');

export const AndroidSharedCartSchemaV1 = z.object({
  shareUrl: BlinkitShareUrlSchemaV1,
  cartFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const BlinkitCartImportBehaviorSchemaV1 = z.enum(['created', 'merged', 'updated', 'unchanged']);

export const AndroidImportedCartSchemaV1 = z.object({
  importBehavior: BlinkitCartImportBehaviorSchemaV1,
  previousCartFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  cart: AndroidCartReviewSchemaV1,
}).strict();

const RequestedItemSchema = z.object({
  query: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(20),
  offerId: Id.optional(),
}).strict();

export const AndroidWorkerRequestSchemaV1 = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('readiness'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('current_screen'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('auth_status'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('begin_login'), accountKey: Id, phone: SecretPhone }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('submit_otp'), accountKey: Id, otp: SecretOtp }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('search'), accountKey: Id, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('inspect_cart'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('share_cart'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('import_shared_cart'), accountKey: Id, shareUrl: BlinkitShareUrlSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('upsert_cart_item'), accountKey: Id, query: z.string().trim().min(1).max(200), offerId: Id, quantity: z.number().int().min(1).max(20) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('set_cart_quantity'), accountKey: Id, productId: Id, quantity: z.number().int().min(1).max(20) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('remove_cart_item'), accountKey: Id, productId: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('clear_cart'), accountKey: Id }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal('list_saved_addresses'),
    accountKey: Id,
    requestedLabel: z.string().trim().min(1).max(60)
      .refine((label) => !/[,\n\r]|\b\d{6}\b|@/.test(label), 'Use only a saved address label')
      .optional(),
  }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('select_saved_address'), accountKey: Id, addressReference: AndroidSavedAddressSchemaV1.shape.addressReference }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('recent_orders'), accountKey: Id, limit: z.number().int().min(1).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('review_checkout'), accountKey: Id, expected: AndroidCheckoutReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('prepare_checkout'), accountKey: Id, items: z.array(RequestedItemSchema).min(1).max(30), addressReference: Id, addressLabel: z.string().trim().min(1).max(100) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('prepare_existing_checkout'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('commit_once'), accountKey: Id, expected: AndroidExpectedCheckoutSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('reconcile'), accountKey: Id, expected: AndroidExpectedCheckoutSchemaV1 }).strict(),
]);

const SearchOfferSchema = z.object({
  offerId: Id,
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

const AndroidWorkerErrorResponseSchemaV1 = z.object({
  version: z.literal(1),
  operation: WorkerOperationSchema,
  status: z.literal('error'),
  stage: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  itemSubtotal: z.number().nonnegative().optional(),
  requiredSubtotal: z.number().positive().optional(),
}).strict().superRefine((value, context) => {
  const hasAmounts = value.itemSubtotal !== undefined || value.requiredSubtotal !== undefined;
  if (value.stage === 'cod_minimum_not_met') {
    if (value.itemSubtotal === undefined || value.requiredSubtotal === undefined) {
      context.addIssue({ code: 'custom', message: 'COD minimum errors require both subtotal amounts' });
    } else if (value.requiredSubtotal <= value.itemSubtotal) {
      context.addIssue({ code: 'custom', message: 'Required subtotal must exceed the item subtotal' });
    }
  } else if (hasAmounts) {
    context.addIssue({ code: 'custom', message: 'Subtotal amounts are only valid for COD minimum errors' });
  }
});

export const AndroidWorkerResponseSchemaV1 = z.union([
  z.object({
    version: z.literal(1),
    operation: z.literal('readiness'),
    status: z.literal('completed'),
    dependencies: z.object({
      appium: z.enum(['ready', 'unavailable']),
      emulator: z.enum(['ready', 'unavailable', 'unknown']),
      blinkitApp: z.enum(['ready', 'unavailable', 'unknown']),
      authentication: z.enum(['active', 'login_required', 'challenge_required', 'unknown']),
    }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('current_screen'), status: z.literal('completed'), screen: AndroidCurrentScreenSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('auth_status'), status: z.enum(['active', 'login_required', 'challenge_required']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('begin_login'), status: z.enum(['otp_sent', 'active']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('submit_otp'), status: z.enum(['active', 'challenge_required']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('search'), status: z.literal('completed'), offers: z.array(SearchOfferSchema).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('inspect_cart'), status: z.literal('completed'), cart: AndroidCartReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('inspect_cart'), status: z.literal('empty') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('share_cart'), status: z.literal('completed'), ...AndroidSharedCartSchemaV1.shape }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('import_shared_cart'), status: z.literal('completed'), ...AndroidImportedCartSchemaV1.shape }).strict(),
  z.object({ version: z.literal(1), operation: z.enum(['upsert_cart_item', 'set_cart_quantity', 'remove_cart_item', 'clear_cart']), status: z.literal('completed'), cart: AndroidCartReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.enum(['set_cart_quantity', 'remove_cart_item', 'clear_cart']), status: z.literal('empty') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('list_saved_addresses'), status: z.literal('completed'), addresses: z.array(AndroidSavedAddressSchemaV1).max(20) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('select_saved_address'), status: z.literal('completed'), selectedAddress: AndroidSavedAddressSchemaV1, cart: AndroidCartReviewSchemaV1.optional() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('recent_orders'), status: z.literal('completed'), orders: z.array(AndroidRecentOrderSchemaV1).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('review_checkout'), status: z.literal('completed'), comparison: AndroidCheckoutComparisonSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('prepare_checkout'), status: z.literal('prepared'), checkout: AndroidCheckoutReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('prepare_existing_checkout'), status: z.literal('prepared'), checkout: AndroidCheckoutReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('commit_once'), status: z.literal('committed'), providerReference: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('commit_once'), status: z.enum(['stale', 'ambiguous']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('reconcile'), status: z.literal('committed'), providerReference: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('reconcile'), status: z.literal('pending') }).strict(),
  AndroidWorkerErrorResponseSchemaV1,
]);

export type AndroidWorkerRequestV1 = z.infer<typeof AndroidWorkerRequestSchemaV1>;
export type AndroidWorkerResponseV1 = z.infer<typeof AndroidWorkerResponseSchemaV1>;
export type AndroidCheckoutReviewV1 = z.infer<typeof AndroidCheckoutReviewSchemaV1>;
export type AndroidCartReviewV1 = z.infer<typeof AndroidCartReviewSchemaV1>;
export type AndroidCheckoutComparisonV1 = z.infer<typeof AndroidCheckoutComparisonSchemaV1>;
export type BlinkitProposalChangeV1 = z.infer<typeof BlinkitProposalChangeSchemaV1>;
export type AndroidExpectedCheckoutV1 = z.infer<typeof AndroidExpectedCheckoutSchemaV1>;
export type UnavailableGroceryItemV1 = z.infer<typeof UnavailableGroceryItemSchemaV1>;
export type AndroidSavedAddressV1 = z.infer<typeof AndroidSavedAddressSchemaV1>;
export type AndroidRecentOrderV1 = z.infer<typeof AndroidRecentOrderSchemaV1>;
export type AndroidCurrentScreenV1 = z.infer<typeof AndroidCurrentScreenSchemaV1>;
export type AndroidScreenKindV1 = z.infer<typeof AndroidScreenKindSchemaV1>;
export type AndroidSharedCartV1 = z.infer<typeof AndroidSharedCartSchemaV1>;
export type BlinkitCartImportBehaviorV1 = z.infer<typeof BlinkitCartImportBehaviorSchemaV1>;
export type AndroidImportedCartV1 = z.infer<typeof AndroidImportedCartSchemaV1>;
