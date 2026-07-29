import { z } from 'zod';
import {
  AndroidCartLineSchemaV1,
  AndroidCartReviewSchemaV1,
  AndroidCheckoutReviewSchemaV1,
  AndroidCurrentScreenSchemaV1,
  BlinkitProposalChangeSchemaV1,
} from './android-worker.js';
import { MoneySchema } from './proposals.js';

const OpaqueReferenceSchema = z.string().trim().min(1).max(200);
const LocalIdentifierSchema = (kind: string): z.ZodString => z.string()
  .regex(new RegExp(`^${kind}_[A-Za-z0-9-]{8,80}$`));

export const OverlayProductSelectionBindingSchemaV1 = z.object({
  version: z.literal(1),
  clientId: OpaqueReferenceSchema,
  taskId: LocalIdentifierSchema('task'),
  taskRevision: z.number().int().nonnegative(),
  clarificationId: LocalIdentifierSchema('clarification'),
  selectionId: LocalIdentifierSchema('selection'),
  expiresAt: z.string().datetime(),
}).strict();

export const OverlayProductSelectionBindingSchemaV2 = z.object({
  version: z.literal(2),
  clientId: OpaqueReferenceSchema,
  taskId: LocalIdentifierSchema('task'),
  taskRevision: z.number().int().nonnegative(),
  interactionId: OpaqueReferenceSchema,
  selectionId: LocalIdentifierSchema('selection'),
  expiresAt: z.string().datetime(),
}).strict();

export const OverlayProductSelectionBindingSchema =
  z.discriminatedUnion('version', [
    OverlayProductSelectionBindingSchemaV1,
    OverlayProductSelectionBindingSchemaV2,
  ]);

export const OverlayModeSchemaV1 = z.enum([
  'idle',
  'listening',
  'understanding',
  'reading',
  'acting',
  'verifying',
  'waiting_for_user',
  'success',
  'error',
  'ambiguous',
]);

export const OverlayPrimarySurfaceSchemaV1 = z.enum([
  'provider_screen',
  'overlay_card',
]);

export const OverlayScreenRelevanceSchemaV1 = z.enum([
  'product_options',
  'product_detail',
  'cart_summary',
  'checkout_summary',
  'payment_selection',
  'address_choices',
  'order_confirmation',
  'order_history',
  'authentication',
]);

export const OverlayAttentionSubjectSchemaV1 = z.enum([
  'options',
  'product',
  'cart',
  'checkout',
  'payment',
  'address',
  'confirmation',
  'recent_orders',
  'authentication',
]);

export const OverlayToneSchemaV1 = z.enum([
  'neutral',
  'active',
  'attention',
  'success',
  'error',
  'ambiguous',
  'confirmation',
]);

const OverlayProductImageUrlSchemaV1 = z.string().trim().url().max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      return url.protocol === 'https:'
        && (hostname === 'blinkit.com'
        || hostname.endsWith('.blinkit.com')
        || hostname === 'grofers.com'
        || hostname.endsWith('.grofers.com'));
    } catch {
      return false;
    }
  }, 'Product image URL must use HTTPS on a Blinkit-owned domain');

const OverlayUnitPriceSchemaV1 = z.object({
  ...MoneySchema.shape,
  unit: z.string().trim().min(1).max(40),
}).strict();

const OverlayProductRecommendationSchemaV1 = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  label: z.string().trim().min(1).max(100),
}).strict();

export const OverlayProductChoiceSchemaV1 = z.object({
  offerId: OpaqueReferenceSchema,
  title: z.string().trim().min(1).max(300),
  spokenLabel: z.string().trim().min(1).max(300),
  packSize: z.string().trim().min(1).max(100).optional(),
  price: MoneySchema.optional(),
  imageUrl: OverlayProductImageUrlSchemaV1.optional(),
  unitPrice: OverlayUnitPriceSchemaV1.optional(),
  availabilityConstraint: z.string().trim().min(1).max(160).optional(),
  recommendation: OverlayProductRecommendationSchemaV1.optional(),
}).strict();

const OverlayVerifiedCartLineSchemaV1 = z.object({
  ...AndroidCartLineSchemaV1.shape,
  spokenLabel: z.string().trim().min(1).max(300).optional(),
  packSize: z.string().trim().min(1).max(100).optional(),
}).strict();

export const OverlayVerifiedCartSummarySchemaV1 = z.object({
  verified: z.literal(true),
  lines: z.array(OverlayVerifiedCartLineSchemaV1).min(1).max(30),
  subtotal: MoneySchema,
  addressLabel: AndroidCartReviewSchemaV1.shape.addressLabel,
}).strict().superRefine((cart, context) => {
  const minor = (amount: number): number => Math.round(amount * 100);
  let expectedSubtotal = 0;
  cart.lines.forEach((line, index) => {
    const expectedLineTotal = minor(line.unitPrice.amount) * line.quantity;
    const actualLineTotal = minor(line.lineTotal.amount);
    if (actualLineTotal !== expectedLineTotal) {
      context.addIssue({
        code: 'custom',
        message: 'lineTotal must equal unitPrice times quantity',
        path: ['lines', index, 'lineTotal'],
      });
    }
    expectedSubtotal += actualLineTotal;
  });
  if (minor(cart.subtotal.amount) !== expectedSubtotal) {
    context.addIssue({
      code: 'custom',
      message: 'subtotal must equal the sum of line totals',
      path: ['subtotal'],
    });
  }
});

export const OverlayCardSchemaV1 = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('compact_status'),
    tone: OverlayToneSchemaV1,
  }).strict(),
  z.object({
    type: z.literal('product_choices'),
    options: z.array(OverlayProductChoiceSchemaV1).min(1).max(10),
    selection: OverlayProductSelectionBindingSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal('cart_summary'),
    ordered: z.literal(false),
    cart: OverlayVerifiedCartSummarySchemaV1,
  }).strict(),
  z.object({
    type: z.literal('checkout_review'),
    checkout: AndroidCheckoutReviewSchemaV1,
    ordered: z.literal(false),
  }).strict(),
  z.object({
    type: z.literal('changed_terms'),
    changes: z.array(BlinkitProposalChangeSchemaV1).min(1).max(8),
  }).strict(),
  z.object({
    type: z.literal('provider_constraint'),
    reason: z.string().trim().min(1).max(300),
  }).strict(),
  z.object({
    type: z.literal('receipt'),
    providerReference: OpaqueReferenceSchema,
  }).strict(),
  z.object({
    type: z.literal('ambiguous'),
    reconciliationId: OpaqueReferenceSchema.optional(),
  }).strict(),
]);

const VerifiedCurrentScreenSchemaV1 = z.object({
  ...AndroidCurrentScreenSchemaV1.shape,
  relevance: OverlayScreenRelevanceSchemaV1,
  verified: z.literal(true),
}).strict();

const AttentionCueSchemaV1 = z.object({
  instruction: z.literal('check_current_screen'),
  subject: OverlayAttentionSubjectSchemaV1,
}).strict();

export const OverlayTaskProgressStageSchemaV1 = z.enum([
  'queued',
  'waiting_for_provider',
  'searching',
  'waiting_for_choice',
  'adding',
  'verifying',
  'reconciling',
  'completed',
  'failed',
  'cancelled',
  'ambiguous',
]);

export const OverlayTaskCancellationPolicySchemaV1 = z.enum([
  'cancel_now',
  'stop_after_current_step',
  'reconcile_only',
  'not_cancellable',
]);

const OverlayStructuredTaskProgressSchemaV1 = z.object({
  version: z.literal(1),
  taskId: LocalIdentifierSchema('task'),
  itemId: LocalIdentifierSchema('task_item').optional(),
  operationId: LocalIdentifierSchema('operation'),
  title: z.string().trim().min(1).max(120),
  step: z.string().trim().min(1).max(200),
  stage: OverlayTaskProgressStageSchemaV1,
  sequence: z.number().int().nonnegative(),
  position: z.object({
    current: z.number().int().positive(),
    total: z.number().int().positive().optional(),
  }).strict().optional(),
  cancellation: z.object({
    available: z.boolean(),
    policy: OverlayTaskCancellationPolicySchemaV1,
  }).strict(),
  terminal: z.boolean(),
}).strict().superRefine((value, context) => {
  const terminalStage = [
    'completed',
    'failed',
    'cancelled',
    'ambiguous',
  ].includes(value.stage);
  if (value.terminal !== terminalStage) {
    context.addIssue({
      code: 'custom',
      message: 'terminal must match the progress stage',
      path: ['terminal'],
    });
  }
  if (
    value.position?.total !== undefined
    && value.position.current > value.position.total
  ) {
    context.addIssue({
      code: 'custom',
      message: 'current position cannot exceed total',
      path: ['position', 'current'],
    });
  }
  if (
    value.cancellation.available
      !== (
        value.cancellation.policy === 'cancel_now'
        || value.cancellation.policy === 'stop_after_current_step'
      )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'cancellation availability must match its policy',
      path: ['cancellation', 'available'],
    });
  }
});

// Accepted for wire compatibility with presentation-v1 producers that shipped
// before semantic execution checkpoints. New producers must emit the versioned
// shape above; native rendering treats this legacy shape as text-only.
const OverlayLegacyTaskProgressSchemaV1 = z.object({
  title: z.string().trim().min(1).max(120),
  step: z.string().trim().min(1).max(200).optional(),
  progress: z.number().min(0).max(1).optional(),
}).strict();

export const OverlayPresentationSchemaV1 = z.object({
  version: z.literal(1),
  mode: OverlayModeSchemaV1,
  task: z.union([
    OverlayStructuredTaskProgressSchemaV1,
    OverlayLegacyTaskProgressSchemaV1,
  ]).optional(),
  primarySurface: OverlayPrimarySurfaceSchemaV1,
  currentScreen: VerifiedCurrentScreenSchemaV1.optional(),
  attentionCue: AttentionCueSchemaV1.optional(),
  card: OverlayCardSchemaV1,
  spoken: z.object({
    text: z.string().trim().min(1).max(1_000),
    languageCode: z.string().regex(/^[a-z]{2,3}-[A-Z]{2}$/),
  }).strict(),
  behavior: z.object({
    autoCollapse: z.boolean(),
    collapseAfterMs: z.number().int().min(0).max(60_000).optional(),
    keepVisibleWhileSpeaking: z.boolean(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.currentScreen?.kind === 'unknown') {
    context.addIssue({
      code: 'custom',
      message: 'A verified current screen must have a recognized kind',
      path: ['currentScreen', 'kind'],
    });
  }

  if (value.primarySurface === 'provider_screen') {
    if (!value.currentScreen) {
      context.addIssue({
        code: 'custom',
        message: 'Provider-screen presentation requires a verified current screen',
        path: ['currentScreen'],
      });
    }
    if (!value.attentionCue) {
      context.addIssue({
        code: 'custom',
        message: 'Provider-screen presentation requires an attention cue',
        path: ['attentionCue'],
      });
    }
  } else if (value.attentionCue) {
    context.addIssue({
      code: 'custom',
      message: 'Overlay-card presentation cannot direct attention to the provider screen',
      path: ['attentionCue'],
    });
  }

  if (value.mode === 'ambiguous' && value.card.type !== 'ambiguous') {
    context.addIssue({
      code: 'custom',
      message: 'Ambiguous mode requires an ambiguous card',
      path: ['card', 'type'],
    });
  }
});

export type OverlayModeV1 = z.infer<typeof OverlayModeSchemaV1>;
export type OverlayPrimarySurfaceV1 = z.infer<typeof OverlayPrimarySurfaceSchemaV1>;
export type OverlayScreenRelevanceV1 = z.infer<typeof OverlayScreenRelevanceSchemaV1>;
export type OverlayAttentionSubjectV1 = z.infer<typeof OverlayAttentionSubjectSchemaV1>;
export type OverlayToneV1 = z.infer<typeof OverlayToneSchemaV1>;
export type OverlayProductChoiceV1 = z.infer<typeof OverlayProductChoiceSchemaV1>;
export type OverlayVerifiedCartSummaryV1 = z.infer<
  typeof OverlayVerifiedCartSummarySchemaV1
>;
export type OverlayProductSelectionBindingV1 = z.infer<
  typeof OverlayProductSelectionBindingSchemaV1
>;
export type OverlayProductSelectionBindingV2 = z.infer<
  typeof OverlayProductSelectionBindingSchemaV2
>;
export type OverlayProductSelectionBinding = z.infer<
  typeof OverlayProductSelectionBindingSchema
>;
export type OverlayTaskProgressStageV1 = z.infer<
  typeof OverlayTaskProgressStageSchemaV1
>;
export type OverlayTaskCancellationPolicyV1 = z.infer<
  typeof OverlayTaskCancellationPolicySchemaV1
>;
export type OverlayStructuredTaskProgressV1 = z.infer<
  typeof OverlayStructuredTaskProgressSchemaV1
>;
export type OverlayCardV1 = z.infer<typeof OverlayCardSchemaV1>;
export type OverlayPresentationV1 = z.infer<typeof OverlayPresentationSchemaV1>;
