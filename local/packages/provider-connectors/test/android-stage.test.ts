import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectBlinkitAndroidStage } from '../src/blinkit/android-stage.js';

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/blinkit-android/${name}.xml`, import.meta.url), 'utf8');

describe('Blinkit Android stage detection', () => {
  it.each([
    ['login', 'login_required'],
    ['otp', 'otp_requested'],
    ['storefront', 'storefront'],
    ['address-picker', 'address_picker'],
    ['checkout', 'checkout'],
    ['payment-sheet', 'payment_sheet'],
    ['confirmation', 'confirmed'],
    ['review-prompt', 'review_prompt'],
    ['location-permission', 'location_permission'],
  ] as const)('detects %s as %s', async (name, stage) => {
    expect(detectBlinkitAndroidStage(await fixture(name))).toBe(stage);
  });

  it('returns unknown for unrecognized UI', () => {
    expect(detectBlinkitAndroidStage('<hierarchy/>')).toBe('unknown');
  });

  it('recognizes the live checkout variant before a payment option is selected', () => {
    expect(detectBlinkitAndroidStage('<hierarchy><node text="Shipment of 2 items"/><node text="Delivering to Home"/><node text="Select payment option"/></hierarchy>')).toBe('checkout');
  });
});
