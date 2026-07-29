import { describe, expect, it } from 'vitest';
import {
  isCheckoutContinuationIntentV2,
  shouldForceCheckoutContinuationV2,
} from './checkout-intent';

describe('V2 checkout continuation intent', () => {
  it.each([
    'Can you now place the COD for it?',
    'Checkout the cart',
    'Place the order',
    'Ab COD se order kar do',
    'अब ऑर्डर कर दो',
  ])('recognizes checkout continuation: %s', (transcript) => {
    expect(isCheckoutContinuationIntentV2(transcript)).toBe(true);
  });

  it('does not skip an explicit product change embedded before checkout', () => {
    expect(shouldForceCheckoutContinuationV2({
      explicitProductChange: true,
      hasPendingCheckout: false,
      transcript: 'Add bread and then place the order',
    })).toBe(false);
  });

  it('does not replace an open checkout confirmation', () => {
    expect(shouldForceCheckoutContinuationV2({
      explicitProductChange: false,
      hasPendingCheckout: true,
      transcript: 'Confirm COD order',
    })).toBe(false);
  });

  it('forces a checkout-only continuation independent of model tool output', () => {
    expect(shouldForceCheckoutContinuationV2({
      explicitProductChange: false,
      hasPendingCheckout: false,
      transcript: 'Can you now place the COD for it?',
    })).toBe(true);
  });
});
