import { describe, expect, it } from 'vitest';
import { AndroidWorkerRequestSchemaV1, AndroidWorkerResponseSchemaV1 } from '../src/android-worker.js';

const checkout = {
  lines: [{
    productId: 'lays-58',
    name: "Lay's Magic Masala",
    quantity: 1,
    unitPrice: { currency: 'INR' as const, amount: 25 },
    lineTotal: { currency: 'INR' as const, amount: 25 },
  }],
  unavailableItems: [{ query: 'diet coke', reason: 'out_of_stock' as const }],
  fees: [],
  total: { currency: 'INR' as const, amount: 25 },
  addressReference: 'home',
  addressLabel: 'Home',
  paymentMode: 'cod' as const,
  etaMinutes: 8,
  providerFingerprint: 'a'.repeat(64),
};

describe('Android worker protocol', () => {
  it('accepts semantic jobs and rejects raw device operations', () => {
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'readiness', accountKey: 'main' })).toMatchObject({ operation: 'readiness' });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'auth_status', accountKey: 'main' })).toMatchObject({ operation: 'auth_status' });
    expect(() => AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'tap', x: 1, y: 2 })).toThrow();
    expect(() => AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'run_adb', command: 'shell input tap' })).toThrow();
  });

  it('models partial dependency readiness without raw diagnostics', () => {
    const response = AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'readiness',
      status: 'completed',
      dependencies: {
        appium: 'ready',
        emulator: 'ready',
        blinkitApp: 'ready',
        authentication: 'login_required',
      },
    });
    expect(response).toMatchObject({ dependencies: { authentication: 'login_required' } });
    expect(JSON.stringify(response)).not.toMatch(/adb|selector|coordinate|screenshot|xml|path|host/i);
  });

  it('models a sanitized current-screen read without raw Android state', () => {
    expect(AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'current_screen',
      accountKey: 'main',
    })).toMatchObject({ operation: 'current_screen' });

    const response = AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'current_screen',
      status: 'completed',
      screen: {
        kind: 'product_detail',
        searchAction: 'available',
        cartItemCount: 3,
        product: {
          name: "Lay's India's Magic Masala Potato Chips",
          packSize: '58 g',
          price: { currency: 'INR', amount: 25 },
        },
      },
    });

    expect(response).toMatchObject({
      screen: {
        kind: 'product_detail',
        searchAction: 'available',
        product: { packSize: '58 g' },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/adb|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
    expect(() => AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'current_screen',
      status: 'completed',
      screen: { kind: 'product_detail', searchAction: 'available', screenshot: 'secret' },
    })).toThrow();
  });

  it('carries an opaque offer selection from search into preparation', () => {
    const search = AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'search',
      status: 'completed',
      offers: [{ offerId: 'offer_abc', title: 'Brown Bread', packSize: '400 g', price: { currency: 'INR', amount: 45 }, available: true }],
    });
    expect(search).toMatchObject({ offers: [{ offerId: 'offer_abc' }] });
    expect(AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'search',
      status: 'completed',
      offers: [{
        offerId: 'offer_image',
        title: 'Brown Bread',
        price: { currency: 'INR', amount: 45 },
        available: true,
        imageUrl: 'https://cdn.grofers.com/products/bread.png',
      }],
    })).toMatchObject({ offers: [{ imageUrl: expect.stringContaining('grofers.com') }] });
    expect(AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'prepare_checkout',
      accountKey: 'main',
      items: [{ query: 'brown bread', offerId: 'offer_abc', quantity: 1 }],
      addressReference: 'home',
      addressLabel: 'Home',
    })).toMatchObject({ items: [{ offerId: 'offer_abc' }] });
  });

  it('models a sanitized prepared checkout', () => {
    const response = AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_checkout', status: 'prepared', checkout });
    expect(JSON.stringify(response)).not.toMatch(/selector|coordinate|xml|screenshot|phone|otp/i);
  });

  it('models read-only existing-cart inspection and typed preparation', () => {
    const cart = { lines: checkout.lines, unavailableItems: checkout.unavailableItems, subtotal: { currency: 'INR' as const, amount: 25 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, etaMinutes: 8, providerFingerprint: 'b'.repeat(64) };
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'inspect_cart', accountKey: 'main' })).toMatchObject({ operation: 'inspect_cart' });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'inspect_cart', status: 'completed', cart })).toMatchObject({ cart: { addressLabel: 'Home' } });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'prepare_existing_checkout', accountKey: 'main' })).toMatchObject({ operation: 'prepare_existing_checkout' });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_existing_checkout', status: 'prepared', checkout })).toMatchObject({ checkout: { paymentMode: 'cod' } });
  });

  it('models native cart sharing with only a provider URL and verified cart fingerprint', () => {
    const request = AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'share_cart',
      accountKey: 'main',
    });
    const response = AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'share_cart',
      status: 'completed',
      shareUrl: 'https://blinkit.com/cart/share/example',
      cartFingerprint: 'b'.repeat(64),
    });

    expect(request).toMatchObject({ operation: 'share_cart', accountKey: 'main' });
    expect(response).toMatchObject({ operation: 'share_cart', shareUrl: expect.stringContaining('blinkit.com') });
    expect(JSON.stringify(response)).not.toMatch(/clipboard|intent|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
    expect(() => AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'share_cart',
      status: 'completed',
      shareUrl: 'https://evil.example/cart',
      cartFingerprint: 'b'.repeat(64),
    })).toThrow();
    expect(() => AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'share_cart',
      status: 'completed',
      shareUrl: 'https://blinkit.com/cart/share/example',
      cartFingerprint: 'b'.repeat(64),
      clipboard: 'secret',
    })).toThrow();
  });

  it('models importing an official Blinkit share URL as an exact verified cart result', () => {
    const cart = {
      lines: checkout.lines,
      unavailableItems: [],
      subtotal: { currency: 'INR' as const, amount: 25 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'unselected' as const,
      providerFingerprint: 'c'.repeat(64),
    };
    const request = AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'import_shared_cart',
      accountKey: 'main',
      shareUrl: 'https://blinkit.com/cart/share/example',
    });
    const response = AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'import_shared_cart',
      status: 'completed',
      importBehavior: 'merged',
      previousCartFingerprint: 'b'.repeat(64),
      cart,
    });

    expect(request).toMatchObject({ operation: 'import_shared_cart', accountKey: 'main' });
    expect(response).toMatchObject({ importBehavior: 'merged', cart: { providerFingerprint: 'c'.repeat(64) } });
    expect(JSON.stringify(response)).not.toMatch(/url|intent|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
    expect(() => AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'import_shared_cart',
      accountKey: 'main',
      shareUrl: 'http://blinkit.com/cart/share/insecure',
    })).toThrow();
    expect(() => AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'import_shared_cart',
      accountKey: 'main',
      shareUrl: 'https://evil.example/cart',
    })).toThrow();
  });

  it('models narrow cart mutations and refreshed cart results', () => {
    const cart = { lines: checkout.lines, unavailableItems: [], subtotal: { currency: 'INR' as const, amount: 25 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, providerFingerprint: 'b'.repeat(64) };
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'upsert_cart_item', accountKey: 'main', query: 'magic masala chips', offerId: 'offer_abc', quantity: 2 }))
      .toMatchObject({ operation: 'upsert_cart_item', offerId: 'offer_abc', quantity: 2 });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'set_cart_quantity', accountKey: 'main', productId: 'cart_abc', quantity: 3 }))
      .toMatchObject({ operation: 'set_cart_quantity', quantity: 3 });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'remove_cart_item', accountKey: 'main', productId: 'cart_abc' }))
      .toMatchObject({ operation: 'remove_cart_item' });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'clear_cart', accountKey: 'main' }))
      .toMatchObject({ operation: 'clear_cart' });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'set_cart_quantity', status: 'completed', cart }))
      .toMatchObject({ cart: { lines: checkout.lines } });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'upsert_cart_item', status: 'completed', cart }))
      .toMatchObject({ operation: 'upsert_cart_item', cart: { lines: checkout.lines } });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'clear_cart', status: 'empty' }))
      .toMatchObject({ status: 'empty' });
  });

  it('models only safe saved-address and recent-order facts', () => {
    const address = { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' };
    const order = {
      orderReference: 'BLK123456',
      items: [{ name: 'Brown Bread', quantity: 1 }],
      total: { currency: 'INR' as const, amount: 65 },
      orderedAt: '2026-07-23T10:00:00.000Z',
      providerStatus: 'delivered' as const,
    };

    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'list_saved_addresses', accountKey: 'main' }))
      .toMatchObject({ operation: 'list_saved_addresses' });
    expect(AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'list_saved_addresses',
      accountKey: 'main',
      requestedLabel: 'Work',
    })).toMatchObject({ operation: 'list_saved_addresses', requestedLabel: 'Work' });
    expect(() => AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'list_saved_addresses',
      accountKey: 'main',
      requestedLabel: '6th floor, private address 560035',
    })).toThrow();
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'select_saved_address', accountKey: 'main', addressReference: address.addressReference }))
      .toMatchObject({ operation: 'select_saved_address', addressReference: address.addressReference });
    expect(AndroidWorkerRequestSchemaV1.parse({ version: 1, operation: 'recent_orders', accountKey: 'main', limit: 5 }))
      .toMatchObject({ operation: 'recent_orders', limit: 5 });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'list_saved_addresses', status: 'completed', addresses: [address] }))
      .toMatchObject({ addresses: [{ label: 'Home' }] });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'select_saved_address', status: 'completed', selectedAddress: address }))
      .toMatchObject({ selectedAddress: { label: 'Home' } });
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'recent_orders', status: 'completed', orders: [order] }))
      .toMatchObject({ orders: [{ orderReference: 'BLK123456', providerStatus: 'delivered' }] });
    expect(AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'recent_orders',
      status: 'completed',
      orders: [{ ...order, items: [{ name: 'Brown Bread' }] }],
    })).toMatchObject({ orders: [{ items: [{ name: 'Brown Bread' }] }] });
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'list_saved_addresses', status: 'completed', addresses: [{ ...address, rawAddress: 'Private street' }] })).toThrow();
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'recent_orders', status: 'completed', orders: [{ ...order, screenshot: 'secret' }] })).toThrow();
  });

  it('models a read-only exact checkout review for proposal comparison', () => {
    expect(AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'review_checkout',
      accountKey: 'main',
      expected: checkout,
    })).toMatchObject({ operation: 'review_checkout', expected: { providerFingerprint: 'a'.repeat(64) } });
    expect(AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'review_checkout',
      status: 'completed',
      comparison: { matches: true, changes: [], currentProviderFingerprint: checkout.providerFingerprint },
    })).toMatchObject({ operation: 'review_checkout', comparison: { matches: true, changes: [] } });
  });

  it('requires provider evidence for committed worker results', () => {
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'commit_once', status: 'committed' })).toThrow();
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'commit_once', status: 'committed', providerReference: 'order-123' })).toBeTruthy();
  });

  it('binds reconciliation to exact checkout terms and a time window', () => {
    expect(AndroidWorkerRequestSchemaV1.parse({
      version: 1,
      operation: 'reconcile',
      accountKey: 'main',
      expected: {
        proposalId: 'proposal-1',
        proposalHash: 'b'.repeat(64),
        idempotencyKey: 'message-1:proposal-1',
        preparedAt: '2026-07-19T10:00:00.000Z',
        expiresAt: '2026-07-19T10:05:00.000Z',
        checkout,
      },
    })).toBeTruthy();
  });

  it('permits only sanitized worker error stages', () => {
    expect(AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_checkout', status: 'error', stage: 'checkout_unknown' })).toBeTruthy();
    expect(AndroidWorkerResponseSchemaV1.parse({
      version: 1,
      operation: 'prepare_checkout',
      status: 'error',
      stage: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    })).toMatchObject({ stage: 'cod_minimum_not_met', itemSubtotal: 25, requiredSubtotal: 50 });
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_checkout', status: 'error', stage: 'cod_minimum_not_met', itemSubtotal: 25 })).toThrow();
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_checkout', status: 'error', stage: 'product_unavailable', rawAddress: 'secret' })).toThrow();
    expect(() => AndroidWorkerResponseSchemaV1.parse({ version: 1, operation: 'prepare_checkout', status: 'error', stage: 'phone 9999999999' })).toThrow();
  });
});
