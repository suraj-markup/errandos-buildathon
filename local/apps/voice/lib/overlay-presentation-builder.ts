import {
  OverlayCardSchemaV1,
  OverlayPresentationSchemaV1,
  type OverlayCardV1,
  type OverlayModeV1,
  type OverlayPresentationV1,
  type OverlayProductSelectionBinding,
  type OverlayStructuredTaskProgressV1,
  type OverlayToneV1,
} from '@errandos/contracts';
import { selectPrimarySurface } from './screen-presentation';
import type { PresentableToolResult } from './voice-presentation';
import {
  companionIssueForToolResultV2,
} from './progress/v2/companion-issue';

const waitingStatuses = new Set([
  'address_required',
  'add_confirmation_required',
  'authentication_required',
  'confirmation_required',
  'device_locked',
  'login_required',
  'needs_clarification',
  'otp_required',
  'payment_required',
  'search_results',
]);

const successStatuses = new Set([
  'added',
  'already_in_cart',
  'cart_empty',
  'cart_status',
  'quantity_updated',
  'removed',
  'ordered',
  'reconciled',
]);

const ambiguousStatuses = new Set([
  'order_status_ambiguous',
  'reconciliation_pending',
]);

function moneyFrom(
  value: { amount: number; currency: 'INR' } | string | undefined,
): { amount: number; currency: 'INR' } | undefined {
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replaceAll(',', '');
  const match = /^(?:₹|INR\s*)?(\d+(?:\.\d{1,2})?)$/.exec(normalized);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? { amount, currency: 'INR' } : undefined;
}

/**
 * Adds presentation-only proof at the direct, read-only cart inspection
 * boundary. Callers must not use this for inferred or mutation results.
 */
export function withAuthoritativeCartPresentationProof(
  result: PresentableToolResult,
): PresentableToolResult {
  if (
    result.status !== 'cart_status'
    || !result.cart
    || result.cart.verified === false
    || result.cart.ordered === true
  ) {
    return result;
  }
  return {
    ...result,
    cart: {
      ...result.cart,
      ordered: false,
      verified: true,
    },
  };
}

function verifiedCartSummaryCard(
  result: PresentableToolResult,
): OverlayCardV1 | undefined {
  const cart = result.cart;
  if (
    result.status !== 'cart_status'
    || cart?.verified !== true
    || cart.ordered !== false
    || !cart.addressLabel?.trim()
    || !cart.lines?.length
  ) {
    return undefined;
  }
  const lines = cart.lines.map((line) => {
    const quantity = line.quantity;
    const unitPrice = moneyFrom(line.unitPrice ?? line.price);
    const lineTotal = moneyFrom(line.lineTotal)
      ?? (
        unitPrice
          && typeof quantity === 'number'
          && Number.isSafeInteger(quantity)
          && quantity > 0
          ? {
              amount: Math.round(unitPrice.amount * quantity * 100) / 100,
              currency: 'INR' as const,
            }
          : undefined
      );
    return {
      productId: line.productId,
      name: line.name ?? line.product,
      ...(line.spokenLabel ? { spokenLabel: line.spokenLabel } : {}),
      ...(line.packSize ?? line.size
        ? { packSize: line.packSize ?? line.size }
        : {}),
      quantity,
      unitPrice,
      lineTotal,
    };
  });
  const parsed = OverlayCardSchemaV1.safeParse({
    type: 'cart_summary',
    ordered: false,
    cart: {
      verified: true,
      lines,
      subtotal: moneyFrom(cart.subtotal),
      addressLabel: cart.addressLabel,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

function modeFor(result: PresentableToolResult): OverlayModeV1 {
  const status = result.status ?? '';
  if (ambiguousStatuses.has(status)) return 'ambiguous';
  if (waitingStatuses.has(status)) return 'waiting_for_user';
  if (successStatuses.has(status)) return 'success';
  const issue = companionIssueForToolResultV2(result);
  if (
    issue?.treatment === 'reconciliation'
    || issue?.treatment === 'final_dispatch_attention'
  ) {
    return 'ambiguous';
  }
  if (
    issue?.treatment === 'user_attention'
    || issue?.treatment === 'search_refinement'
    || issue?.treatment === 'checkout_review'
  ) {
    return 'waiting_for_user';
  }
  if (result.ok === false || status.endsWith('_failed') || status.endsWith('_unavailable')) {
    return 'error';
  }
  return 'idle';
}

function toneFor(mode: OverlayModeV1): OverlayToneV1 {
  switch (mode) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'ambiguous':
      return 'ambiguous';
    case 'waiting_for_user':
      return 'attention';
    case 'acting':
    case 'listening':
    case 'reading':
    case 'understanding':
    case 'verifying':
      return 'active';
    default:
      return 'neutral';
  }
}

function cardFor(
  result: PresentableToolResult,
  mode: OverlayModeV1,
  productSelection?: OverlayProductSelectionBinding,
): OverlayCardV1 {
  if (mode === 'ambiguous') {
    return { type: 'ambiguous' };
  }

  if (result.status === 'ordered' && result.providerReference) {
    return {
      providerReference: result.providerReference,
      type: 'receipt',
    };
  }

  const verifiedCartSummary = verifiedCartSummaryCard(result);
  if (verifiedCartSummary) return verifiedCartSummary;

  if (
    ['needs_clarification', 'search_results'].includes(result.status ?? '')
      && result.options?.length
      && result.options.every((option) => option.offerId)
  ) {
    return {
      options: result.options.slice(0, 10).map((option) => ({
        offerId: option.offerId!,
        spokenLabel: option.spokenLabel || option.product || 'Product option',
        title: option.product || option.spokenLabel || 'Product option',
        ...(option.size ? { packSize: option.size } : {}),
      })),
      ...(productSelection ? { selection: productSelection } : {}),
      type: 'product_choices',
    };
  }

  const issue = companionIssueForToolResultV2(result);
  if (mode === 'error' && (issue || result.message?.trim())) {
    return {
      reason: (issue?.detail ?? result.message ?? '').trim().slice(0, 300),
      type: 'provider_constraint',
    };
  }

  return {
    tone: toneFor(mode),
    type: 'compact_status',
  };
}

function normalizedLanguageCode(languageCode: string): string {
  return /^[a-z]{2,3}-[A-Z]{2}$/.test(languageCode)
    ? languageCode
    : 'en-IN';
}

export function buildOverlayPresentation(input: {
  languageCode: string;
  productSelection?: OverlayProductSelectionBinding;
  result: PresentableToolResult;
  spokenText: string;
  taskProgress?: OverlayStructuredTaskProgressV1;
}): OverlayPresentationV1 {
  const mode = modeFor(input.result);
  const surface = selectPrimarySurface({
    currentScreen: input.result.screenEvidence,
    result: input.result,
  });
  const autoCollapse = !input.taskProgress?.terminal && ![
    'ambiguous',
    'error',
    'waiting_for_user',
  ].includes(mode);

  return OverlayPresentationSchemaV1.parse({
    version: 1,
    mode,
    ...(input.taskProgress ? { task: input.taskProgress } : {}),
    primarySurface: surface.primarySurface,
    ...(surface.currentScreen ? { currentScreen: surface.currentScreen } : {}),
    ...(surface.attentionCue ? { attentionCue: surface.attentionCue } : {}),
    card: cardFor(input.result, mode, input.productSelection),
    spoken: {
      languageCode: normalizedLanguageCode(input.languageCode),
      text: input.spokenText.trim().slice(0, 1_000)
        || 'I could not complete that request.',
    },
    behavior: {
      autoCollapse,
      ...(autoCollapse ? { collapseAfterMs: 6_500 } : {}),
      keepVisibleWhileSpeaking: true,
    },
  });
}

export function legacyAssistantStateFor(
  presentation: OverlayPresentationV1,
): 'clarification' | 'error' | 'ready' | 'success' {
  switch (presentation.mode) {
    case 'waiting_for_user':
      return 'clarification';
    case 'ambiguous':
    case 'error':
      return 'error';
    case 'success':
      return 'success';
    default:
      return 'ready';
  }
}
