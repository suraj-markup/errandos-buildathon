import { describe, expect, it } from 'vitest';
import {
  assessRestrictedScreen,
  sanitizeSemanticText,
  type RestrictedScreenClass,
} from './privacy';

function fixture(...labels: string[]): string {
  return `<hierarchy>${labels
    .map((label) => `<node text="${label}" content-desc="" />`)
    .join('')}</hierarchy>`;
}

describe('restricted screen privacy', () => {
  const cases: Array<[RestrictedScreenClass, string, string]> = [
    ['authentication', 'com.grofers.customerapp', fixture('Sign in to continue')],
    ['otp', 'com.grofers.customerapp', fixture('Enter the 6-digit verification code')],
    ['payment_credentials', 'com.grofers.customerapp', fixture('Enter CVV')],
    ['address', 'com.grofers.customerapp', fixture('Delivery address', 'House no')],
    ['phone_number', 'com.grofers.customerapp', fixture('Mobile number')],
    ['notification', 'com.android.systemui', fixture('Silent notifications', 'Clear all')],
    ['account_details', 'com.grofers.customerapp', fixture('Profile details', 'Email')],
  ];

  it.each(cases)('blocks %s without returning source text', (kind, packageName, source) => {
    const result = assessRestrictedScreen({ packageName, source });

    expect(result.restricted).toBe(true);
    expect(result.classes).toContain(kind);
    expect(JSON.stringify(result)).not.toContain(source);
    expect(result.safeFallback).toEqual({
      kind: 'restricted_screen',
      message: 'This screen contains private information, so visual context was not captured.',
    });
  });

  it.each([
    fixture('Milk', 'Add to cart', '₹29'),
    fixture('Delivery in 10 minutes'),
    fixture('Payment offer: 10% cashback'),
    fixture('Account for 2 items in cart'),
    fixture('Mobile phone cover'),
    fixture('Delivery address'),
  ])('does not block ordinary shopping copy', (source) => {
    expect(assessRestrictedScreen({
      packageName: 'com.grofers.customerapp',
      source,
    })).toEqual({ classes: [], restricted: false });
  });

  it('removes sensitive values from semantic labels', () => {
    expect(sanitizeSemanticText('Call +91 98765 43210')).toBeUndefined();
    expect(sanitizeSemanticText('name@example.com')).toBeUndefined();
    expect(sanitizeSemanticText('Card 4242 4242 4242 4242')).toBeUndefined();
    expect(sanitizeSemanticText('42 Private Street, Bengaluru 560035')).toBeUndefined();
    expect(sanitizeSemanticText('Amul Taaza 500 ml')).toBe('Amul Taaza 500 ml');
  });
});
