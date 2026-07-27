import { describe, expect, it } from 'vitest';
import { BlinkitCheckoutBlockedError } from '@errandos/provider-connectors';
import { compareCheckout, compareRapidoRide, runAndroidJob, runRapidoAndroidJob } from '../src/android-job-entry.js';

describe('Android worker job entry', () => {
  it('validates one sanitized Rapido login request and response', async () => {
    const output = await runRapidoAndroidJob(JSON.stringify({
      version: 1,
      operation: 'rapido_begin_login',
      accountKey: 'main',
      phone: '9000000000',
    }), {
      execute: async () => ({ version: 1, operation: 'rapido_begin_login', status: 'otp_sent' }),
    });
    expect(JSON.parse(output)).toEqual({ version: 1, operation: 'rapido_begin_login', status: 'otp_sent' });
    expect(output).not.toContain('9000000000');
  });

  it('rejects raw device controls from Rapido worker jobs', async () => {
    let calls = 0;
    const output = await runRapidoAndroidJob(JSON.stringify({
      version: 1,
      operation: 'rapido_auth_status',
      accountKey: 'main',
      coordinate: { x: 1, y: 2 },
    }), {
      execute: async () => {
        calls += 1;
        return { version: 1, operation: 'rapido_auth_status', status: 'login_required' };
      },
    });
    expect(calls).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ status: 'error', stage: 'invalid_request' });
  });

  it('compares exact Rapido ride terms without attempting a final action', async () => {
    const expected = {
      pickupReference: 'pickup_1',
      pickupSummary: 'Indiranagar',
      dropoffReference: 'dropoff_1',
      dropoffSummary: 'Kempegowda Airport',
      rideOption: { id: 'option_prime', name: 'Prime Sedan' },
      fareMinimum: { currency: 'INR' as const, amount: 850 },
      fareMaximum: { currency: 'INR' as const, amount: 920 },
      fees: [],
      pickupEtaMinutes: 6,
      paymentMode: 'cash' as const,
      providerFingerprint: 'a'.repeat(64),
    };
    let reads = 0;
    await expect(compareRapidoRide({
      readRideReview: async () => { reads += 1; return { ...expected, fareMaximum: { currency: 'INR', amount: 950 }, providerFingerprint: 'b'.repeat(64) }; },
    }, expected)).resolves.toEqual({
      matches: false,
      changes: ['fare', 'provider_fingerprint'],
      currentProviderFingerprint: 'b'.repeat(64),
    });
    expect(reads).toBe(1);
  });

  it('validates one request and returns one sanitized response', async () => {
    let calls = 0;
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'auth_status', accountKey: 'main' }), {
      execute: async () => { calls += 1; return { version: 1, operation: 'auth_status', status: 'active' }; },
    });
    expect(calls).toBe(1);
    expect(JSON.parse(output)).toEqual({ version: 1, operation: 'auth_status', status: 'active' });
  });

  it('returns typed readiness dependencies as one sanitized response', async () => {
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'readiness', accountKey: 'main' }), {
      execute: async () => ({
        version: 1,
        operation: 'readiness',
        status: 'completed',
        dependencies: { appium: 'ready', emulator: 'ready', blinkitApp: 'ready', authentication: 'active' },
      }),
    });

    expect(JSON.parse(output)).toMatchObject({ operation: 'readiness', dependencies: { authentication: 'active' } });
  });

  it('accepts a typed cart mutation and returns the refreshed cart', async () => {
    const cart = {
      lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 2, unitPrice: { currency: 'INR' as const, amount: 50 }, lineTotal: { currency: 'INR' as const, amount: 100 } }],
      unavailableItems: [], subtotal: { currency: 'INR' as const, amount: 100 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, providerFingerprint: 'a'.repeat(64),
    };
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'set_cart_quantity', accountKey: 'main', productId: 'cart_abc', quantity: 2 }), {
      execute: async () => ({ version: 1, operation: 'set_cart_quantity', status: 'completed', cart }),
    });

    expect(JSON.parse(output)).toMatchObject({ operation: 'set_cart_quantity', cart: { lines: [{ quantity: 2 }] } });
  });

  it('accepts an exact-offer cart upsert without raw device instructions', async () => {
    const cart = {
      lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 2, unitPrice: { currency: 'INR' as const, amount: 50 }, lineTotal: { currency: 'INR' as const, amount: 100 } }],
      unavailableItems: [], subtotal: { currency: 'INR' as const, amount: 100 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, providerFingerprint: 'a'.repeat(64),
    };
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'upsert_cart_item', accountKey: 'main', query: 'brown bread', offerId: 'offer_abc', quantity: 2 }), {
      execute: async () => ({ version: 1, operation: 'upsert_cart_item', status: 'completed', cart }),
    });

    expect(JSON.parse(output)).toMatchObject({ operation: 'upsert_cart_item', cart: { lines: [{ name: 'Brown Bread', quantity: 2 }] } });
    expect(output).not.toMatch(/selector|coordinate|screenshot|xml/i);
  });

  it('returns only typed safe address and recent-order facts', async () => {
    let requestedLabel: string | undefined;
    const addressOutput = await runAndroidJob(JSON.stringify({ version: 1, operation: 'list_saved_addresses', accountKey: 'main', requestedLabel: 'Work' }), {
      execute: async (request) => {
        requestedLabel = request.operation === 'list_saved_addresses' ? request.requestedLabel : undefined;
        return { version: 1, operation: 'list_saved_addresses', status: 'completed', addresses: [{ addressReference: `address_${'a'.repeat(32)}`, label: 'Home' }] };
      },
    });
    const orderOutput = await runAndroidJob(JSON.stringify({ version: 1, operation: 'recent_orders', accountKey: 'main', limit: 5 }), {
      execute: async () => ({ version: 1, operation: 'recent_orders', status: 'completed', orders: [{ orderReference: 'BLK123456', items: [{ name: 'Brown Bread', quantity: 1 }], total: { currency: 'INR', amount: 65 }, orderedAt: '2026-07-23T10:00:00.000Z', providerStatus: 'delivered' }] }),
    });

    expect(JSON.parse(addressOutput)).toMatchObject({ addresses: [{ label: 'Home' }] });
    expect(requestedLabel).toBe('Work');
    expect(JSON.parse(orderOutput)).toMatchObject({ orders: [{ orderReference: 'BLK123456' }] });
    expect(`${addressOutput}${orderOutput}`).not.toMatch(/rawAddress|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
  });

  it('accepts saved-address selection and read-only checkout review jobs', async () => {
    const address = { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' };
    const checkout = {
      lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 1, unitPrice: { currency: 'INR' as const, amount: 50 }, lineTotal: { currency: 'INR' as const, amount: 50 } }],
      unavailableItems: [],
      fees: [],
      total: { currency: 'INR' as const, amount: 50 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'cod' as const,
      providerFingerprint: 'a'.repeat(64),
    };
    const selected = await runAndroidJob(JSON.stringify({
      version: 1,
      operation: 'select_saved_address',
      accountKey: 'main',
      addressReference: address.addressReference,
    }), {
      execute: async () => ({ version: 1, operation: 'select_saved_address', status: 'completed', selectedAddress: address }),
    });
    const reviewed = await runAndroidJob(JSON.stringify({
      version: 1,
      operation: 'review_checkout',
      accountKey: 'main',
      expected: checkout,
    }), {
      execute: async () => ({
        version: 1,
        operation: 'review_checkout',
        status: 'completed',
        comparison: { matches: true, changes: [], currentProviderFingerprint: checkout.providerFingerprint },
      }),
    });

    expect(JSON.parse(selected)).toMatchObject({ selectedAddress: { label: 'Home' } });
    expect(JSON.parse(reviewed)).toMatchObject({ comparison: { matches: true, changes: [] } });
    expect(`${selected}${reviewed}`).not.toMatch(/selector|coordinate|screenshot|xml|emulator/i);
  });

  it('compares cart and exact checkout terms without a final action', async () => {
    const expected = {
      lines: [{ productId: 'offer_bread', name: 'Brown Bread', quantity: 1, unitPrice: { currency: 'INR' as const, amount: 50 }, lineTotal: { currency: 'INR' as const, amount: 50 } }],
      unavailableItems: [],
      fees: [],
      total: { currency: 'INR' as const, amount: 50 },
      addressReference: 'address_ref',
      addressLabel: 'Home',
      paymentMode: 'cod' as const,
      providerFingerprint: 'a'.repeat(64),
    };
    const cart = {
      lines: [{ ...expected.lines[0]!, productId: 'cart_bread' }],
      unavailableItems: [],
      subtotal: { currency: 'INR' as const, amount: 50 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'cod' as const,
      providerFingerprint: 'b'.repeat(64),
    };
    let reads = 0;
    const same = await compareCheckout({
      readCheckoutReview: async () => { reads += 1; return expected; },
    }, cart, expected);
    expect(same).toEqual({ matches: true, changes: [], currentProviderFingerprint: expected.providerFingerprint });
    expect(reads).toBe(1);

    const changed = await compareCheckout({
      readCheckoutReview: async () => { throw new Error('must not read changed checkout'); },
    }, { ...cart, paymentMode: 'unselected', lines: [{ ...cart.lines[0]!, quantity: 2, lineTotal: { currency: 'INR', amount: 100 } }] }, expected);
    expect(changed).toEqual({ matches: false, changes: ['items', 'payment_mode', 'provider_fingerprint'] });
  });

  it('never exposes login values from provider failures', async () => {
    const input = JSON.stringify({ version: 1, operation: 'begin_login', accountKey: 'main', phone: '9999999999' });
    const output = await runAndroidJob(input, {
      execute: async () => { throw new Error('phone 9999999999 otp 123456'); },
    });
    expect(output).toContain('"status":"error"');
    expect(output).not.toMatch(/9999999999|123456/);
  });

  it('returns only a sanitized provider failure stage', async () => {
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'prepare_checkout', accountKey: 'main', items: [{ query: 'bread', quantity: 1 }], addressReference: 'home', addressLabel: 'Home' }), {
      execute: async () => { throw new Error('Blinkit payment_select failed'); },
    });

    expect(JSON.parse(output)).toEqual({ version: 1, operation: 'prepare_checkout', status: 'error', stage: 'payment_select' });
  });

  it('returns only safe COD-minimum facts from a typed provider constraint', async () => {
    const output = await runAndroidJob(JSON.stringify({ version: 1, operation: 'prepare_checkout', accountKey: 'main', items: [{ query: 'chips', quantity: 1 }], addressReference: 'home', addressLabel: 'Home' }), {
      execute: async () => { throw new BlinkitCheckoutBlockedError('cod_minimum_not_met', { itemSubtotal: 25, requiredSubtotal: 50 }); },
    });

    expect(JSON.parse(output)).toEqual({
      version: 1,
      operation: 'prepare_checkout',
      status: 'error',
      stage: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    });
    expect(output).not.toMatch(/selector|coordinate|screenshot|xml|address/i);
  });

  it('rejects raw device operations without reflecting input', async () => {
    const output = await runAndroidJob('{"version":1,"operation":"run_adb","command":"secret"}', {
      execute: async () => { throw new Error('must not run'); },
    });
    expect(output).toBe('{"version":1,"operation":"auth_status","status":"error","stage":"invalid_request"}\n');
    expect(output).not.toContain('secret');
  });

  it('returns a strict sanitized current-screen result', async () => {
    const output = await runAndroidJob(JSON.stringify({
      version: 1,
      operation: 'current_screen',
      accountKey: 'main',
    }), {
      execute: async () => ({
        version: 1,
        operation: 'current_screen',
        status: 'completed',
        screen: {
          kind: 'product_detail',
          searchAction: 'available',
          cartItemCount: 3,
          product: {
            name: "Lay's Magic Masala Chips",
            packSize: '58 g',
            price: { currency: 'INR', amount: 25 },
          },
        },
      }),
    });

    expect(JSON.parse(output)).toMatchObject({
      operation: 'current_screen',
      screen: { kind: 'product_detail', searchAction: 'available' },
    });
    expect(output).not.toMatch(/adb|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
  });

  it('returns only a verified Blinkit share-cart link', async () => {
    const output = await runAndroidJob(JSON.stringify({
      version: 1,
      operation: 'share_cart',
      accountKey: 'main',
    }), {
      execute: async () => ({
        version: 1,
        operation: 'share_cart',
        status: 'completed',
        shareUrl: 'https://blinkit.com/cart/share/example',
        cartFingerprint: 'a'.repeat(64),
      }),
    });

    expect(JSON.parse(output)).toMatchObject({
      operation: 'share_cart',
      shareUrl: 'https://blinkit.com/cart/share/example',
    });
    expect(output).not.toMatch(/clipboard|intent|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
  });

  it('accepts a typed shared-cart import and returns only the verified resulting cart', async () => {
    const output = await runAndroidJob(JSON.stringify({
      version: 1,
      operation: 'import_shared_cart',
      accountKey: 'main',
      shareUrl: 'https://blinkit.com/cart/share/example',
    }), {
      execute: async () => ({
        version: 1,
        operation: 'import_shared_cart',
        status: 'completed',
        importBehavior: 'created',
        cart: {
          lines: [{ productId: 'cart_abc', name: 'Diet Coke', quantity: 1, unitPrice: { currency: 'INR', amount: 40 }, lineTotal: { currency: 'INR', amount: 40 } }],
          unavailableItems: [],
          subtotal: { currency: 'INR', amount: 40 },
          addressReference: 'saved:home',
          addressLabel: 'Home',
          paymentMode: 'unselected',
          providerFingerprint: 'a'.repeat(64),
        },
      }),
    });

    expect(JSON.parse(output)).toMatchObject({
      operation: 'import_shared_cart',
      importBehavior: 'created',
      cart: { lines: [{ name: 'Diet Coke' }] },
    });
    expect(output).not.toMatch(/shareUrl|intent|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
  });
});
