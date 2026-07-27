import { describe, expect, it } from 'vitest';
import {
  BlinkitCheckoutBlockedError,
  parseCodMinimumConstraint,
} from '../src/blinkit/android-constraints.js';
import { hasCashOnDeliveryEvidence } from '../src/blinkit/android-review.js';

describe('Blinkit Android checkout constraints', () => {
  it('extracts a provider-stated COD minimum without retaining screen data', () => {
    expect(parseCodMinimumConstraint(
      'Cash on Delivery is available only above a minimum order value of ₹50',
      25,
    )).toEqual({ itemSubtotal: 25, requiredSubtotal: 50 });
    expect(parseCodMinimumConstraint(
      'Add items worth ₹25 more to use Cash on Delivery',
      25,
    )).toEqual({ itemSubtotal: 25, requiredSubtotal: 50 });
  });

  it('does not infer a COD restriction from a generic cart upsell', () => {
    expect(parseCodMinimumConstraint('Add products worth ₹83 more', 25)).toBeUndefined();
  });

  it('does not treat unavailable COD copy as selected payment evidence', () => {
    expect(hasCashOnDeliveryEvidence('Cash on Delivery is not available for this order')).toBe(false);
    expect(hasCashOnDeliveryEvidence('Pay on Delivery')).toBe(true);
  });

  it('serializes only the allowlisted blocked facts', () => {
    const error = new BlinkitCheckoutBlockedError('cod_minimum_not_met', {
      itemSubtotal: 25,
      requiredSubtotal: 50,
    });
    expect(error.toOutput()).toEqual({
      version: 1,
      provider: 'blinkit',
      status: 'blocked',
      reason: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    });
  });
});
