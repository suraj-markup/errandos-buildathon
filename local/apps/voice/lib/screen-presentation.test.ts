import { describe, expect, it } from 'vitest';
import type { AndroidCurrentScreenV1 } from '@errandos/contracts';
import {
  selectPrimarySurface,
  type CurrentScreenEvidence,
} from './screen-presentation';
import type { PresentableToolResult } from './voice-presentation';

const evidence = (
  kind: AndroidCurrentScreenV1['kind'],
): CurrentScreenEvidence => ({
  observedAfterAction: true,
  screen: {
    kind,
    searchAction: 'recoverable',
  },
});

const relevantCases: Array<{
  kind: AndroidCurrentScreenV1['kind'];
  relevance: string;
  result: PresentableToolResult;
  subject: string;
}> = [
  {
    kind: 'search_results',
    relevance: 'product_options',
    result: {
      options: [{ offerId: 'offer-1', product: 'Milk' }],
      status: 'search_results',
    },
    subject: 'options',
  },
  {
    kind: 'product_detail',
    relevance: 'product_detail',
    result: { product: 'Milk', status: 'product_detail' },
    subject: 'product',
  },
  {
    kind: 'cart',
    relevance: 'cart_summary',
    result: { cart: { lines: [] }, status: 'cart_status' },
    subject: 'cart',
  },
  {
    kind: 'checkout',
    relevance: 'checkout_summary',
    result: {
      checkout: { addressLabel: 'Home', total: 56 },
      status: 'confirmation_required',
    },
    subject: 'checkout',
  },
  {
    kind: 'payment',
    relevance: 'payment_selection',
    result: { status: 'cod_selected' },
    subject: 'payment',
  },
  {
    kind: 'address_selection',
    relevance: 'address_choices',
    result: { status: 'address_required' },
    subject: 'address',
  },
  {
    kind: 'order_confirmation',
    relevance: 'order_confirmation',
    result: {
      providerReference: 'BLINKIT-123',
      status: 'ordered',
    },
    subject: 'confirmation',
  },
  {
    kind: 'order_history',
    relevance: 'order_history',
    result: { status: 'recent_orders' },
    subject: 'recent_orders',
  },
  {
    kind: 'otp',
    relevance: 'authentication',
    result: { status: 'otp_required' },
    subject: 'authentication',
  },
];

describe('selectPrimarySurface', () => {
  it.each(relevantCases)(
    'uses the verified $kind provider screen for $subject',
    ({ kind, relevance, result, subject }) => {
      const decision = selectPrimarySurface({
        currentScreen: evidence(kind),
        result,
      });

      expect(decision).toMatchObject({
        attentionCue: {
          instruction: 'check_current_screen',
          subject,
        },
        currentScreen: {
          kind,
          relevance,
          verified: true,
        },
        primarySurface: 'provider_screen',
      });
    },
  );

  it('falls back when screen evidence is missing', () => {
    expect(selectPrimarySurface({
      result: {
        cart: { lines: [] },
        status: 'cart_status',
      },
    })).toEqual({ primarySurface: 'overlay_card' });
  });

  it('falls back when the verified screen is unknown', () => {
    expect(selectPrimarySurface({
      currentScreen: evidence('unknown'),
      result: {
        options: [{ offerId: 'offer-1', product: 'Milk' }],
        status: 'search_results',
      },
    })).toEqual({ primarySurface: 'overlay_card' });
  });

  it('does not use a cart screen to support an order-confirmation claim', () => {
    expect(selectPrimarySurface({
      currentScreen: evidence('cart'),
      result: {
        providerReference: 'BLINKIT-123',
        status: 'ordered',
      },
    })).toEqual({ primarySurface: 'overlay_card' });
  });

  it('does not claim success without a verified provider reference', () => {
    expect(selectPrimarySurface({
      currentScreen: evidence('order_confirmation'),
      result: { status: 'ordered' },
    })).toEqual({ primarySurface: 'overlay_card' });
  });

  it('keeps an ambiguous final action on the overlay even on order history', () => {
    expect(selectPrimarySurface({
      currentScreen: evidence('order_history'),
      result: { status: 'order_status_ambiguous' },
    })).toEqual({ primarySurface: 'overlay_card' });
  });
});
