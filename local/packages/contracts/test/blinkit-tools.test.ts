import { describe, expect, it } from 'vitest';
import {
  BlinkitAddCartItemInputSchemaV1,
  BlinkitCartStatusOutputSchemaV1,
  BlinkitCompareProposalInputSchemaV1,
  BlinkitCompareProposalOutputSchemaV1,
  BlinkitCurrentScreenOutputSchemaV1,
  BlinkitImportSharedCartInputSchemaV1,
  BlinkitImportSharedCartOutputSchemaV1,
  BlinkitListSavedAddressesInputSchemaV1,
  BlinkitListSavedAddressesOutputSchemaV1,
  BlinkitRecentOrdersInputSchemaV1,
  BlinkitRecentOrdersOutputSchemaV1,
  BlinkitRecentOperationsInputSchemaV1,
  BlinkitRecentOperationsOutputSchemaV1,
  BlinkitRemoveCartItemInputSchemaV1,
  BlinkitReadinessOutputSchemaV1,
  BlinkitSetCartItemQuantityInputSchemaV1,
  BlinkitPrepareCodOrderInputSchemaV1,
  BlinkitSearchProductsInputSchemaV1,
  BlinkitSearchProductsOutputSchemaV1,
  BlinkitSelectSavedAddressInputSchemaV1,
  BlinkitSelectSavedAddressOutputSchemaV1,
  BlinkitShareCartOutputSchemaV1,
  BlinkitStartPrepareCodOrderInputSchemaV1,
  BlinkitStartPrepareCodOrderOutputSchemaV1,
  BlinkitOperationStatusInputSchemaV1,
  BlinkitOperationStatusOutputSchemaV1,
  BlinkitPrepareCodOrderOutputSchemaV1,
  BlinkitToolFailureOutputSchemaV1,
} from '../src/blinkit-tools.js';

describe('Blinkit semantic tool contracts', () => {
  it('models exact product selection without device controls', () => {
    const search = BlinkitSearchProductsOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      offers: [{ offerId: 'offer_abc', title: 'Brown Bread', packSize: '400 g', price: { currency: 'INR', amount: 45 }, available: true }],
    });
    expect(JSON.stringify(search)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml/i);
    expect(BlinkitSearchProductsInputSchemaV1.parse({ query: 'brown bread' })).toMatchObject({ accountKey: 'main', limit: 5 });
    expect(BlinkitPrepareCodOrderInputSchemaV1.parse({
      items: [{ query: 'brown bread', offerId: 'offer_abc', quantity: 1 }],
      deliveryAddressRef: 'home',
      deliveryAddressLabel: 'Home',
    })).toMatchObject({ items: [{ offerId: 'offer_abc' }] });
    expect(BlinkitSearchProductsOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      offers: [{
        offerId: 'offer_image',
        title: 'Brown Bread',
        price: { currency: 'INR', amount: 45 },
        available: true,
        imageUrl: 'https://cdn.grofers.com/products/bread.png',
      }],
    })).toMatchObject({ offers: [{ imageUrl: expect.stringContaining('grofers.com') }] });
    expect(() => BlinkitSearchProductsOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      offers: [{
        offerId: 'offer_image',
        title: 'Brown Bread',
        price: { currency: 'INR', amount: 45 },
        available: true,
        imageUrl: 'https://example.com/fake.png',
      }],
    })).toThrow();
  });

  it('rejects raw screen instructions', () => {
    expect(() => BlinkitSearchProductsInputSchemaV1.parse({ query: 'bread', x: 20, y: 40 })).toThrow();
  });

  it('returns sanitized current-cart terms without device state', () => {
    const output = BlinkitCartStatusOutputSchemaV1.parse({ version: 1, status: 'completed', cart: {
      lines: [{ productId: 'cart_abc', name: 'Diet Coke', quantity: 1, unitPrice: { currency: 'INR', amount: 40 }, lineTotal: { currency: 'INR', amount: 40 } }],
      unavailableItems: [], subtotal: { currency: 'INR', amount: 40 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected', providerFingerprint: 'a'.repeat(64),
    } });
    expect(output).toMatchObject({ status: 'completed', cart: { lines: [{ name: 'Diet Coke' }] } });
    expect(JSON.stringify(output)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml/i);
  });

  it('returns only a verified Blinkit share-cart link', () => {
    const output = BlinkitShareCartOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      shareUrl: 'https://blinkit.com/cart/share/example',
      cartFingerprint: 'a'.repeat(64),
    });

    expect(output).toMatchObject({ status: 'completed', shareUrl: expect.stringContaining('blinkit.com') });
    expect(JSON.stringify(output)).not.toMatch(/clipboard|intent|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
    expect(() => BlinkitShareCartOutputSchemaV1.parse({
      ...output,
      shareUrl: 'https://example.com/not-blinkit',
    })).toThrow();
  });

  it('accepts only official Blinkit share links and returns the complete imported cart', () => {
    const input = BlinkitImportSharedCartInputSchemaV1.parse({
      shareUrl: 'https://blinkit.com/cart/share/example',
    });
    const output = BlinkitImportSharedCartOutputSchemaV1.parse({
      version: 1,
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
    });

    expect(input).toMatchObject({ accountKey: 'main' });
    expect(output).toMatchObject({ status: 'completed', importBehavior: 'created', cart: { lines: [{ name: 'Diet Coke' }] } });
    expect(JSON.stringify(output)).not.toMatch(/url|intent|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
    expect(() => BlinkitImportSharedCartInputSchemaV1.parse({ shareUrl: 'https://example.com/cart' })).toThrow();
    expect(() => BlinkitImportSharedCartInputSchemaV1.parse({ shareUrl: 'http://blinkit.com/cart/share/example' })).toThrow();
  });

  it('accepts only opaque typed cart mutations', () => {
    expect(BlinkitAddCartItemInputSchemaV1.parse({ query: 'brown bread', offerId: 'offer_abc', quantity: 2 }))
      .toMatchObject({ accountKey: 'main', query: 'brown bread', offerId: 'offer_abc', quantity: 2 });
    expect(BlinkitSetCartItemQuantityInputSchemaV1.parse({ productId: 'cart_abc', quantity: 3 }))
      .toMatchObject({ accountKey: 'main', productId: 'cart_abc', quantity: 3 });
    expect(BlinkitRemoveCartItemInputSchemaV1.parse({ productId: 'cart_abc' }))
      .toMatchObject({ accountKey: 'main', productId: 'cart_abc' });
    expect(() => BlinkitSetCartItemQuantityInputSchemaV1.parse({ productId: 'cart_abc', quantity: 0 })).toThrow();
    expect(() => BlinkitAddCartItemInputSchemaV1.parse({ query: 'brown bread', offerId: 'offer_abc', quantity: 1, selector: '#add' })).toThrow();
    expect(() => BlinkitRemoveCartItemInputSchemaV1.parse({ productId: 'cart_abc', selector: '#remove' })).toThrow();
  });

  it('reports dependency readiness without exposing device internals', () => {
    const output = BlinkitReadinessOutputSchemaV1.parse({
      version: 1,
      accountKey: 'main',
      status: 'action_required',
      checks: [
        { component: 'control_plane', status: 'ready' },
        { component: 'worker', status: 'ready' },
        { component: 'appium', status: 'ready' },
        { component: 'emulator', status: 'ready' },
        { component: 'blinkit_app', status: 'ready' },
        { component: 'authentication', status: 'action_required', reason: 'login_required' },
      ],
    });

    expect(output.status).toBe('action_required');
    expect(output.checks).toEqual(expect.arrayContaining([{ component: 'authentication', status: 'action_required', reason: 'login_required' }]));
    expect(JSON.stringify(output)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml|path|host/i);
  });

  it('returns only a safe semantic current-screen summary', () => {
    const output = BlinkitCurrentScreenOutputSchemaV1.parse({
      version: 1,
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

    expect(output.screen).toMatchObject({ kind: 'product_detail', searchAction: 'available' });
    expect(JSON.stringify(output)).not.toMatch(/adb|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
  });

  it('returns only safe address labels and recent order summaries', () => {
    expect(BlinkitListSavedAddressesInputSchemaV1.parse({ requestedLabel: 'Work' }))
      .toMatchObject({ accountKey: 'main', requestedLabel: 'Work' });
    expect(() => BlinkitListSavedAddressesInputSchemaV1.parse({
      requestedLabel: '6th floor, private address 560035',
    })).toThrow();
    const addresses = BlinkitListSavedAddressesOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      addresses: [{ addressReference: `address_${'a'.repeat(32)}`, label: 'Home' }],
    });
    const orders = BlinkitRecentOrdersOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      orders: [{ orderReference: 'BLK123456', items: [{ name: 'Brown Bread' }], total: { currency: 'INR', amount: 65 }, orderedAt: '2026-07-23T10:00:00.000Z', providerStatus: 'delivered' }],
    });

    expect(BlinkitRecentOrdersInputSchemaV1.parse({})).toMatchObject({ accountKey: 'main', limit: 5 });
    expect(JSON.stringify({ addresses, orders })).not.toMatch(/rawAddress|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
  });

  it('models exact saved-address selection and proposal comparison', () => {
    const addressReference = `address_${'a'.repeat(32)}`;
    const cart = {
      lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 1, unitPrice: { currency: 'INR' as const, amount: 45 }, lineTotal: { currency: 'INR' as const, amount: 45 } }],
      unavailableItems: [],
      subtotal: { currency: 'INR' as const, amount: 45 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'cod' as const,
      providerFingerprint: 'b'.repeat(64),
    };
    expect(BlinkitSelectSavedAddressInputSchemaV1.parse({ addressReference }))
      .toMatchObject({ accountKey: 'main', addressReference });
    expect(BlinkitSelectSavedAddressOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      selectedAddress: { addressReference, label: 'Home' },
      cartStatus: 'completed',
      cart,
    })).toMatchObject({ selectedAddress: { label: 'Home' }, cartStatus: 'completed' });
    expect(() => BlinkitSelectSavedAddressOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      selectedAddress: { addressReference, label: 'Home' },
      cartStatus: 'unverified',
      cart,
    })).toThrow();
    expect(BlinkitSelectSavedAddressOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      selectedAddress: { addressReference, label: 'Home' },
      cartStatus: 'unverified',
    })).toMatchObject({ selectedAddress: { label: 'Home' }, cartStatus: 'unverified' });

    expect(BlinkitCompareProposalInputSchemaV1.parse({ proposalId: 'proposal_abc' }))
      .toMatchObject({ accountKey: 'main', proposalId: 'proposal_abc' });
    expect(BlinkitCompareProposalOutputSchemaV1.parse({
      version: 1,
      proposalId: 'proposal_abc',
      proposalHash: 'a'.repeat(64),
      proposalStatus: 'prepared',
      status: 'changed',
      changes: ['fees', 'total', 'provider_fingerprint'],
      currentProviderFingerprint: 'b'.repeat(64),
    })).toMatchObject({ status: 'changed', changes: ['fees', 'total', 'provider_fingerprint'] });
    expect(() => BlinkitCompareProposalOutputSchemaV1.parse({
      version: 1,
      proposalId: 'proposal_abc',
      proposalHash: 'a'.repeat(64),
      proposalStatus: 'prepared',
      status: 'changed',
      changes: [],
    })).toThrow();
  });

  it('models durable asynchronous Blinkit preparation without device details', () => {
    const operationId = `operation_${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`;
    const startedAt = '2026-07-23T10:00:00.000Z';
    const expiresAt = '2026-07-23T10:03:00.000Z';
    const input = BlinkitStartPrepareCodOrderInputSchemaV1.parse({
      accountKey: 'main',
      items: [{ query: 'brown bread', quantity: 1, offerId: 'offer_abc' }],
      deliveryAddressRef: 'saved:home',
      deliveryAddressLabel: 'Home',
      idempotencyKey: 'telegram-message-123',
    });
    const started = BlinkitStartPrepareCodOrderOutputSchemaV1.parse({
      version: 1, operationId, status: 'running', startedAt, updatedAt: startedAt, expiresAt,
    });
    const completed = BlinkitOperationStatusOutputSchemaV1.parse({
      ...started,
      status: 'completed',
      updatedAt: '2026-07-23T10:01:00.000Z',
      proposal: {
        version: 1,
        proposalId: 'proposal_async',
        provider: 'blinkit',
        status: 'prepared',
        proposalHash: 'a'.repeat(64),
        summary: { kind: 'grocery', description: 'Brown Bread x1', items: [{ name: 'Brown Bread', quantity: 1 }], paymentMode: 'cod', addressSummary: 'Home' },
        expiresAt: '2026-07-23T10:06:00.000Z',
        requiresExternalApproval: false,
      },
    });

    expect(input).toMatchObject({ idempotencyKey: 'telegram-message-123', accountKey: 'main' });
    expect(BlinkitOperationStatusInputSchemaV1.parse({ operationId })).toMatchObject({ accountKey: 'main', operationId });
    expect(completed).toMatchObject({ status: 'completed', proposal: { proposalId: 'proposal_async' } });
    expect(JSON.stringify({ started, completed })).not.toMatch(/selector|coordinate|screenshot|xml|emulator|host|identity/i);
    expect(() => BlinkitOperationStatusOutputSchemaV1.parse({ ...started, status: 'failed', reason: 'raw_appium_failure' })).toThrow();
  });

  it('lists recent durable operations without request terms or device details', () => {
    const operationId = 'operation_123e4567-e89b-12d3-a456-426614174000';
    expect(BlinkitRecentOperationsInputSchemaV1.parse({})).toMatchObject({ accountKey: 'main', limit: 5 });
    const result = BlinkitRecentOperationsOutputSchemaV1.parse({
      version: 1,
      status: 'completed',
      operations: [{
        operationId,
        status: 'completed',
        startedAt: '2026-07-23T10:00:00.000Z',
        updatedAt: '2026-07-23T10:01:00.000Z',
        expiresAt: '2026-07-23T10:03:00.000Z',
        proposalId: 'proposal_async',
      }],
    });
    expect(result).toMatchObject({ operations: [{ proposalId: 'proposal_async' }] });
    expect(JSON.stringify(result)).not.toMatch(/items|address|idempotency|selector|screenshot|emulator/i);
  });

  it('models ordinary Blinkit failures as successful typed tool results', () => {
    const failure = BlinkitToolFailureOutputSchemaV1.parse({
      version: 1,
      status: 'failed',
      reason: 'screen_blocked',
      retryable: true,
      suggestedAction: 'inspect_screen',
      stage: 'cart_open',
    });
    expect(failure).toEqual({
      version: 1,
      status: 'failed',
      reason: 'screen_blocked',
      retryable: true,
      suggestedAction: 'inspect_screen',
      stage: 'cart_open',
    });
    expect(() => BlinkitToolFailureOutputSchemaV1.parse({
      ...failure,
      stage: 'selector #secret',
    })).toThrow();
  });

  it('models provider checkout constraints as safe structured blocked results', () => {
    const blocked = BlinkitPrepareCodOrderOutputSchemaV1.parse({
      version: 1,
      provider: 'blinkit',
      status: 'blocked',
      reason: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    });
    const operationId = 'operation_123e4567-e89b-12d3-a456-426614174000';
    const operation = BlinkitOperationStatusOutputSchemaV1.parse({
      version: 1,
      operationId,
      status: 'blocked',
      reason: blocked.reason,
      itemSubtotal: blocked.itemSubtotal,
      requiredSubtotal: blocked.requiredSubtotal,
      startedAt: '2026-07-23T10:00:00.000Z',
      updatedAt: '2026-07-23T10:00:20.000Z',
      expiresAt: '2026-07-23T10:03:00.000Z',
    });

    expect(operation).toMatchObject({ status: 'blocked', reason: 'cod_minimum_not_met', itemSubtotal: 25, requiredSubtotal: 50 });
    expect(BlinkitPrepareCodOrderOutputSchemaV1.parse({ version: 1, provider: 'blinkit', status: 'blocked', reason: 'product_unavailable' }))
      .toMatchObject({ status: 'blocked', reason: 'product_unavailable' });
    expect(() => BlinkitPrepareCodOrderOutputSchemaV1.parse({ version: 1, provider: 'blinkit', status: 'blocked', reason: 'cod_minimum_not_met', itemSubtotal: 25 })).toThrow();
    expect(() => BlinkitPrepareCodOrderOutputSchemaV1.parse({ version: 1, provider: 'blinkit', status: 'blocked', reason: 'product_unavailable', selector: '#secret' })).toThrow();
    expect(JSON.stringify({ blocked, operation })).not.toMatch(/selector|coordinate|screenshot|xml|emulator|host|identity/i);
  });
});
