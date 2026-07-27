import { describe, expect, it } from 'vitest';
import {
  RapidoAccountInputSchemaV1,
  RapidoBeginLoginInputSchemaV1,
  RapidoPrepareRideInputSchemaV1,
  RapidoQuoteRidesOutputSchemaV1,
  RapidoReadinessOutputSchemaV1,
  RapidoFailureReasonSchemaV1,
  RapidoResendOtpInputSchemaV1,
  RapidoSubmitOtpInputSchemaV1,
} from '../src/index.js';

describe('Rapido MCP login contracts', () => {
  it('accepts only narrow typed authentication inputs', () => {
    expect(RapidoAccountInputSchemaV1.parse({ accountKey: 'main' })).toEqual({ version: 1, accountKey: 'main' });
    expect(RapidoBeginLoginInputSchemaV1.parse({
      accountKey: 'main',
      phone: '9000000000',
    }).phone).toBe('9000000000');
    expect(RapidoSubmitOtpInputSchemaV1.parse({
      accountKey: 'main',
      otp: '1234',
    }).otp).toBe('1234');
    expect(RapidoResendOtpInputSchemaV1.parse({ accountKey: 'main' })).toEqual({
      version: 1,
      accountKey: 'main',
    });
  });

  it('rejects raw device instructions and malformed values', () => {
    expect(RapidoBeginLoginInputSchemaV1.safeParse({
      accountKey: 'main',
      phone: '9000000000',
      selector: '//*[@clickable=true]',
    }).success).toBe(false);
    expect(RapidoSubmitOtpInputSchemaV1.safeParse({ accountKey: 'main', otp: '12' }).success).toBe(false);
  });

  it('accepts exact ride quotes and enforces one opaque ride selector', () => {
    expect(RapidoQuoteRidesOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      pickupSummary: 'Indiranagar',
      dropoffSummary: 'Kempegowda Airport',
      options: [{
        rideOptionId: 'option_prime',
        name: 'Prime Sedan',
        fareMinimum: { currency: 'INR', amount: 850 },
        fareMaximum: { currency: 'INR', amount: 920 },
        fees: [],
        pickupEtaMinutes: 6,
        available: true,
      }],
    }).options).toHaveLength(1);
    expect(RapidoPrepareRideInputSchemaV1.safeParse({
      accountKey: 'main',
      pickup: { query: 'Indiranagar' },
      dropoff: { query: 'Kempegowda Airport' },
      rideOptionId: 'option_prime',
    }).success).toBe(true);
    expect(RapidoPrepareRideInputSchemaV1.safeParse({
      accountKey: 'main',
      pickup: { query: 'Indiranagar' },
      dropoff: { query: 'Kempegowda Airport' },
      rideOptionId: 'option_prime',
      rideType: 'Prime Sedan',
    }).success).toBe(false);
  });

  it('keeps readiness typed and excludes device internals', () => {
    const value = {
      version: 1,
      accountKey: 'main',
      status: 'ready',
      checks: [
        { component: 'control_plane', status: 'ready' },
        { component: 'worker', status: 'ready' },
        { component: 'appium', status: 'ready' },
        { component: 'emulator', status: 'ready' },
        { component: 'rapido_app', status: 'ready' },
        { component: 'authentication', status: 'ready' },
      ],
    };
    expect(RapidoReadinessOutputSchemaV1.safeParse(value).success).toBe(true);
    expect(RapidoReadinessOutputSchemaV1.safeParse({ ...value, screenshot: 'secret' }).success).toBe(false);
    expect(RapidoFailureReasonSchemaV1.parse('device_verification_failed')).toBe('device_verification_failed');
  });
});
