import type {
  AndroidCurrentScreenV1,
  OverlayAttentionSubjectV1,
  OverlayPrimarySurfaceV1,
  OverlayScreenRelevanceV1,
} from '@errandos/contracts';
import type {
  CurrentScreenEvidence,
  PresentableToolResult,
} from './voice-presentation';

export type { CurrentScreenEvidence } from './voice-presentation';

type ScreenPresentationDecision = {
  attentionCue?: {
    instruction: 'check_current_screen';
    subject: OverlayAttentionSubjectV1;
  };
  currentScreen?: AndroidCurrentScreenV1 & {
    relevance: OverlayScreenRelevanceV1;
    verified: true;
  };
  primarySurface: OverlayPrimarySurfaceV1;
};

type RelevantScreen = {
  kind: AndroidCurrentScreenV1['kind'];
  relevance: OverlayScreenRelevanceV1;
  subject: OverlayAttentionSubjectV1;
};

function relevantScreenFor(
  result: PresentableToolResult,
  kind: AndroidCurrentScreenV1['kind'],
): RelevantScreen | undefined {
  const status = result.status ?? '';

  if (
    ['search_results', 'needs_clarification'].includes(status)
      && kind === 'search_results'
      && result.options?.length
  ) {
    return { kind, relevance: 'product_options', subject: 'options' };
  }

  if (status === 'product_detail' && kind === 'product_detail') {
    return { kind, relevance: 'product_detail', subject: 'product' };
  }

  if (
    [
      'added',
      'already_in_cart',
      'cart_empty',
      'cart_status',
      'quantity_updated',
      'removed',
    ].includes(status)
      && kind === 'cart'
  ) {
    return { kind, relevance: 'cart_summary', subject: 'cart' };
  }

  if (
    status === 'confirmation_required'
      && kind === 'checkout'
      && result.checkout
  ) {
    return { kind, relevance: 'checkout_summary', subject: 'checkout' };
  }

  if (
    ['cod_selected', 'payment_required'].includes(status)
      && kind === 'payment'
  ) {
    return { kind, relevance: 'payment_selection', subject: 'payment' };
  }

  if (status === 'address_required' && kind === 'address_selection') {
    return { kind, relevance: 'address_choices', subject: 'address' };
  }

  if (
    status === 'ordered'
      && kind === 'order_confirmation'
      && result.providerReference
  ) {
    return { kind, relevance: 'order_confirmation', subject: 'confirmation' };
  }

  if (
    ['recent_orders', 'reconciled'].includes(status)
      && kind === 'order_history'
  ) {
    return { kind, relevance: 'order_history', subject: 'recent_orders' };
  }

  if (
    ['authentication_required', 'login_required', 'otp_required'].includes(status)
      && (kind === 'login' || kind === 'otp')
  ) {
    return { kind, relevance: 'authentication', subject: 'authentication' };
  }

  return undefined;
}

export function selectPrimarySurface(input: {
  currentScreen?: CurrentScreenEvidence;
  result: PresentableToolResult;
}): ScreenPresentationDecision {
  const screen = input.currentScreen?.screen;
  if (
    !input.currentScreen?.observedAfterAction
      || !screen
      || screen.kind === 'unknown'
      || input.result.status === 'order_status_ambiguous'
  ) {
    return { primarySurface: 'overlay_card' };
  }

  const relevant = relevantScreenFor(input.result, screen.kind);
  if (!relevant) return { primarySurface: 'overlay_card' };

  return {
    attentionCue: {
      instruction: 'check_current_screen',
      subject: relevant.subject,
    },
    currentScreen: {
      ...screen,
      relevance: relevant.relevance,
      verified: true,
    },
    primarySurface: 'provider_screen',
  };
}
