import { describe, expect, it } from 'vitest';
import {
  RapidoAndroidWorkerRequestSchemaV1,
  RapidoAndroidWorkerResponseSchemaV1,
} from '../src/index.js';

describe('Rapido Android worker contracts', () => {
  it('accepts only typed supervised login operations', () => {
    expect(RapidoAndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'rapido_begin_login',
      accountKey: 'main',
      phone: '9000000000',
    }).operation).toBe('rapido_begin_login');
    expect(RapidoAndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'rapido_submit_otp',
      accountKey: 'main',
      otp: '123456',
    }).operation).toBe('rapido_submit_otp');
    expect(RapidoAndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'rapido_resend_otp',
      accountKey: 'main',
    }).operation).toBe('rapido_resend_otp');
  });

  it('rejects raw device controls and malformed secrets', () => {
    expect(RapidoAndroidWorkerRequestSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_begin_login',
      accountKey: 'main',
      phone: '9000000000',
      selector: '//*[@clickable=true]',
    }).success).toBe(false);
    expect(RapidoAndroidWorkerRequestSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_submit_otp',
      accountKey: 'main',
      otp: '123',
    }).success).toBe(false);
  });

  it('rejects private or raw provider data in responses', () => {
    expect(RapidoAndroidWorkerResponseSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_begin_login',
      status: 'otp_sent',
      phone: '9000000000',
    }).success).toBe(false);
    expect(RapidoAndroidWorkerResponseSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_auth_status',
      status: 'login_required',
      source: '<hierarchy/>',
    }).success).toBe(false);
  });

  it('accepts typed ride preparation and exact review responses', () => {
    const ride = {
      pickupReference: 'pickup_1',
      pickupSummary: 'Indiranagar',
      dropoffReference: 'dropoff_1',
      dropoffSummary: 'Kempegowda Airport',
      rideOption: { id: 'option_prime', name: 'Prime Sedan' },
      fareMinimum: { currency: 'INR', amount: 850 },
      fareMaximum: { currency: 'INR', amount: 920 },
      fees: [],
      pickupEtaMinutes: 6,
      paymentMode: 'cash',
      providerFingerprint: 'a'.repeat(64),
    };
    expect(RapidoAndroidWorkerRequestSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_prepare_ride',
      accountKey: 'main',
      pickup: { query: 'Indiranagar' },
      dropoff: { query: 'Kempegowda Airport' },
      rideType: 'Prime Sedan',
      paymentMode: 'cash',
    }).success).toBe(true);
    expect(RapidoAndroidWorkerResponseSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_prepare_ride',
      status: 'prepared',
      ride,
    }).success).toBe(true);
    expect(RapidoAndroidWorkerResponseSchemaV1.safeParse({
      version: 1,
      operation: 'rapido_prepare_ride',
      status: 'prepared',
      ride,
      xml: '<hierarchy/>',
    }).success).toBe(false);
  });
});
