import { describe, expect, it } from 'vitest';
import type { AndroidWorkerRequestV1, AndroidWorkerResponseV1, PrincipalId } from '@errandos/contracts';
import { AndroidBlinkitAdapter, AndroidBlinkitAuthCoordinator } from '../src/blinkit/android-adapter.js';
import { AndroidWorkerOperationError } from '../src/android/worker-client.js';
import type { AndroidWorkerPort } from '../src/android/worker-client.js';
import type { DurableProviderState } from '../src/runtime/provider-state.js';

const owner = 'owner' as PrincipalId;
const review = {
  lines: [{ productId: 'crapido-1', name: 'Diet Coke', quantity: 1, unitPrice: { currency: 'INR' as const, amount: 40 }, lineTotal: { currency: 'INR' as const, amount: 40 } }],
  unavailableItems: [], fees: [{ kind: 'handling' as const, label: 'Handling', amount: { currency: 'INR' as const, amount: 5 } }],
  total: { currency: 'INR' as const, amount: 45 }, addressReference: 'home', addressLabel: 'Home', paymentMode: 'cod' as const,
  etaMinutes: 9, providerFingerprint: 'a'.repeat(64),
};

class State implements DurableProviderState {
  public value?: unknown;
  public async put(_owner: PrincipalId, value: unknown): Promise<string> { this.value = value; return 'state-1'; }
  public async get(): Promise<unknown> { return this.value; }
  public async replace(_owner: PrincipalId, _reference: string, value: unknown): Promise<void> { this.value = value; }
}

class Worker implements AndroidWorkerPort {
  public readonly requests: AndroidWorkerRequestV1[] = [];
  public constructor(private readonly response: (request: AndroidWorkerRequestV1) => AndroidWorkerResponseV1) {}
  public async execute(request: AndroidWorkerRequestV1): Promise<AndroidWorkerResponseV1> { this.requests.push(request); return this.response(request); }
}

describe('Android Blinkit adapter', () => {
  it('projects worker dependency status into safe Blinkit readiness', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'readiness',
      status: 'completed',
      dependencies: { appium: 'ready', emulator: 'ready', blinkitApp: 'ready', authentication: 'active' },
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State());

    await expect(adapter.readiness('main')).resolves.toMatchObject({
      version: 1,
      accountKey: 'main',
      status: 'ready',
      checks: expect.arrayContaining([
        { component: 'worker', status: 'ready' },
        { component: 'authentication', status: 'ready' },
      ]),
    });
  });

  it('requires a separate cart verification when address selection returns no cart snapshot', async () => {
    const address = { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' };
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'select_saved_address',
      status: 'completed',
      selectedAddress: address,
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    await expect(adapter.selectSavedAddress('main', address.addressReference)).resolves.toEqual({
      version: 1,
      status: 'completed',
      selectedAddress: address,
      cartStatus: 'unverified',
    });
  });

  it('exposes sanitized Android search results for semantic tools', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'search',
      status: 'completed',
      offers: [{ offerId: 'offer_abc', title: 'Brown Bread', packSize: '400 g', price: { currency: 'INR', amount: 45 }, available: true, imageUrl: 'https://cdn.grofers.com/products/bread.png' }],
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State());

    await expect(adapter.searchProducts({ version: 1, accountKey: 'main', query: 'brown bread', limit: 5 }))
      .resolves.toMatchObject({ status: 'completed', offers: [{ offerId: 'offer_abc', imageUrl: expect.stringContaining('grofers.com') }] });
    expect(worker.requests[0]).toMatchObject({ operation: 'search', query: 'brown bread' });
  });

  it('exposes only the sanitized semantic current screen', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
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
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State());

    await expect(adapter.currentScreen('main')).resolves.toMatchObject({
      version: 1,
      status: 'completed',
      screen: { kind: 'product_detail', searchAction: 'available' },
    });
    expect(worker.requests).toEqual([{ version: 1, operation: 'current_screen', accountKey: 'main' }]);
  });

  it('shares a verified cart only when reversible Android actions are enabled', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'share_cart',
      status: 'completed',
      shareUrl: 'https://blinkit.com/cart/share/example',
      cartFingerprint: 'b'.repeat(64),
    }));
    const disabled = new AndroidBlinkitAdapter(worker, new State());
    const enabled = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    await expect(disabled.shareCart('main')).rejects.toThrow('live Android actions are disabled');
    await expect(enabled.shareCart('main')).resolves.toMatchObject({
      status: 'completed',
      shareUrl: 'https://blinkit.com/cart/share/example',
    });
    expect(worker.requests).toEqual([{ version: 1, operation: 'share_cart', accountKey: 'main' }]);
  });

  it('imports a shared cart only when reversible Android actions are enabled', async () => {
    const cart = {
      lines: review.lines,
      unavailableItems: [],
      subtotal: { currency: 'INR' as const, amount: 40 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'unselected' as const,
      providerFingerprint: 'b'.repeat(64),
    };
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'import_shared_cart',
      status: 'completed',
      importBehavior: 'created',
      cart,
    }));
    const disabled = new AndroidBlinkitAdapter(worker, new State());
    const enabled = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    await expect(disabled.importSharedCart('main', 'https://blinkit.com/cart/share/example'))
      .rejects.toThrow('live Android actions are disabled');
    await expect(enabled.importSharedCart('main', 'https://blinkit.com/cart/share/example'))
      .resolves.toMatchObject({ status: 'completed', importBehavior: 'created', cart: { lines: review.lines } });
    expect(worker.requests).toEqual([{
      version: 1,
      operation: 'import_shared_cart',
      accountKey: 'main',
      shareUrl: 'https://blinkit.com/cart/share/example',
    }]);
  });

  it('preserves a sanitized worker stage from search failures', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'search',
      status: 'error',
      stage: 'search',
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State());

    const failure = await adapter.searchProducts({ version: 1, accountKey: 'main', query: 'milk', limit: 5 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AndroidWorkerOperationError);
    expect(failure).toMatchObject({ stage: 'search' });
  });

  it('exposes only safe saved-address and recent-order reads', async () => {
    const address = { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' };
    const order = { orderReference: 'BLK123456', items: [{ name: 'Brown Bread', quantity: 1 }], total: { currency: 'INR' as const, amount: 65 }, orderedAt: '2026-07-23T10:00:00.000Z', providerStatus: 'delivered' as const };
    const worker = new Worker((request): AndroidWorkerResponseV1 => request.operation === 'list_saved_addresses'
      ? { version: 1, operation: 'list_saved_addresses', status: 'completed', addresses: [address] }
      : { version: 1, operation: 'recent_orders', status: 'completed', orders: [order] });
    const adapter = new AndroidBlinkitAdapter(worker, new State());

    await expect(adapter.listSavedAddresses('main', 'Work')).resolves.toEqual({ version: 1, status: 'completed', addresses: [address] });
    await expect(adapter.recentOrders('main', 5)).resolves.toEqual({ version: 1, status: 'completed', orders: [order] });
    expect(worker.requests).toEqual([
      { version: 1, operation: 'list_saved_addresses', accountKey: 'main', requestedLabel: 'Work' },
      { version: 1, operation: 'recent_orders', accountKey: 'main', limit: 5 },
    ]);
    expect(JSON.stringify({ address, order })).not.toMatch(/rawAddress|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
  });

  it('selects one opaque saved address and returns the verified cart state', async () => {
    const address = { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' };
    const cart = {
      lines: review.lines,
      unavailableItems: [],
      subtotal: { currency: 'INR' as const, amount: 40 },
      addressReference: 'saved:home',
      addressLabel: 'Home',
      paymentMode: 'unselected' as const,
      providerFingerprint: 'b'.repeat(64),
    };
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'select_saved_address',
      status: 'completed',
      selectedAddress: address,
      cart,
    }));
    const disabled = new AndroidBlinkitAdapter(worker, new State());
    const enabled = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    await expect(disabled.selectSavedAddress('main', address.addressReference)).rejects.toThrow('live Android actions are disabled');
    await expect(enabled.selectSavedAddress('main', address.addressReference)).resolves.toMatchObject({
      selectedAddress: address,
      cartStatus: 'completed',
      cart: { addressLabel: 'Home' },
    });
    expect(worker.requests).toEqual([{
      version: 1,
      operation: 'select_saved_address',
      accountKey: 'main',
      addressReference: address.addressReference,
    }]);
  });

  it('prepares an exact COD snapshot through the typed worker', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({ version: 1, operation: 'prepare_checkout', status: 'prepared', checkout: review }));
    const state = new State();
    const adapter = new AndroidBlinkitAdapter(worker, state, { actionsEnabled: true, now: (): Date => new Date('2026-07-19T10:00:00.000Z') });
    const result = await adapter.prepareGrocery(owner, { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'diet coke', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home', paymentMode: 'cod' });
    expect(result.snapshot).toMatchObject({ provider: 'blinkit', principalId: owner, accountReference: 'main', lines: review.lines, unavailableItems: review.unavailableItems, total: review.total, deliveryAddress: { reference: 'home', summary: 'Home' }, paymentMode: 'cod', providerFingerprint: review.providerFingerprint });
    expect(worker.requests[0]).toMatchObject({ operation: 'prepare_checkout', accountKey: 'main', addressReference: 'home', addressLabel: 'Home' });
  });

  it('compares a stored prepared checkout without a final action', async () => {
    const state = new State();
    state.value = {
      version: 1,
      accountKey: 'main',
      preparedAt: '2026-07-19T10:00:00.000Z',
      expiresAt: '2026-07-19T10:05:00.000Z',
      checkout: review,
    };
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'review_checkout',
      status: 'completed',
      comparison: { matches: true, changes: [], currentProviderFingerprint: review.providerFingerprint },
    }));
    const adapter = new AndroidBlinkitAdapter(worker, state);

    await expect(adapter.compareGrocery(owner, 'state-1')).resolves.toEqual({
      matches: true,
      changes: [],
      currentProviderFingerprint: review.providerFingerprint,
    });
    expect(worker.requests).toEqual([{
      version: 1,
      operation: 'review_checkout',
      accountKey: 'main',
      expected: review,
    }]);
  });

  it('preserves a sanitized provider failure stage from requested-cart preparation', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'prepare_checkout',
      status: 'error',
      stage: 'cod_minimum_not_met',
      itemSubtotal: 25,
      requiredSubtotal: 50,
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    const failure = await adapter.prepareGrocery(owner, {
      version: 1,
      provider: 'blinkit',
      accountKey: 'main',
      items: [{ query: 'diet coke', quantity: 1 }],
      deliveryAddressRef: 'home',
      deliveryAddressLabel: 'Home',
      paymentMode: 'cod',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AndroidWorkerOperationError);
    expect(failure).toMatchObject({ stage: 'cod_minimum_not_met', details: { itemSubtotal: 25, requiredSubtotal: 50 } });
  });

  it('inspects and prepares the existing cart through narrow typed jobs', async () => {
    const cart = { lines: review.lines, unavailableItems: review.unavailableItems, subtotal: { currency: 'INR' as const, amount: 40 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, etaMinutes: 9, providerFingerprint: 'b'.repeat(64) };
    const worker = new Worker((request): AndroidWorkerResponseV1 => request.operation === 'inspect_cart'
      ? { version: 1, operation: 'inspect_cart', status: 'completed', cart }
      : { version: 1, operation: 'prepare_existing_checkout', status: 'prepared', checkout: review });
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true, now: (): Date => new Date('2026-07-19T10:00:00.000Z') });

    await expect(adapter.inspectCurrentCart('main')).resolves.toMatchObject({ status: 'completed', cart: { lines: review.lines } });
    await expect(adapter.prepareExistingGrocery(owner, { version: 1, provider: 'blinkit', accountKey: 'main', paymentMode: 'cod' })).resolves.toMatchObject({ snapshot: { lines: review.lines, total: review.total } });
    expect(worker.requests.map(({ operation }) => operation)).toEqual(['inspect_cart', 'prepare_existing_checkout']);
  });

  it('preserves a sanitized provider failure stage from existing-cart preparation', async () => {
    const worker = new Worker((): AndroidWorkerResponseV1 => ({
      version: 1,
      operation: 'prepare_existing_checkout',
      status: 'error',
      stage: 'payment_unavailable',
    }));
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    const failure = await adapter.prepareExistingGrocery(owner, {
      version: 1,
      provider: 'blinkit',
      accountKey: 'main',
      paymentMode: 'cod',
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AndroidWorkerOperationError);
    expect(failure).toMatchObject({ stage: 'payment_unavailable' });
  });

  it('edits the existing cart only through typed mutation jobs', async () => {
    const cart = { lines: review.lines, unavailableItems: [], subtotal: { currency: 'INR' as const, amount: 40 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected' as const, providerFingerprint: 'b'.repeat(64) };
    const worker = new Worker((request): AndroidWorkerResponseV1 => {
      if (request.operation === 'clear_cart') return { version: 1, operation: request.operation, status: 'empty' };
      if (request.operation === 'upsert_cart_item' || request.operation === 'set_cart_quantity' || request.operation === 'remove_cart_item') {
        return { version: 1, operation: request.operation, status: 'completed', cart };
      }
      return { version: 1, operation: 'inspect_cart', status: 'completed', cart };
    });
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true });

    await expect(adapter.addCartItem('main', 'brown bread', 'offer_abc', 2)).resolves.toMatchObject({ status: 'completed' });
    await expect(adapter.setCartItemQuantity('main', 'cart_abc', 2)).resolves.toMatchObject({ status: 'completed' });
    await expect(adapter.removeCartItem('main', 'cart_abc')).resolves.toMatchObject({ status: 'completed' });
    await expect(adapter.clearCart('main')).resolves.toEqual({ version: 1, status: 'empty' });
    expect(worker.requests).toEqual([
      { version: 1, operation: 'upsert_cart_item', accountKey: 'main', query: 'brown bread', offerId: 'offer_abc', quantity: 2 },
      { version: 1, operation: 'set_cart_quantity', accountKey: 'main', productId: 'cart_abc', quantity: 2 },
      { version: 1, operation: 'remove_cart_item', accountKey: 'main', productId: 'cart_abc' },
      { version: 1, operation: 'clear_cart', accountKey: 'main' },
    ]);
  });

  it('keeps cart mutations disabled behind the live-action gate', async () => {
    const adapter = new AndroidBlinkitAdapter(new Worker(() => ({ version: 1, operation: 'clear_cart', status: 'empty' })), new State());

    await expect(adapter.addCartItem('main', 'brown bread', 'offer_abc', 1)).rejects.toThrow('live Android actions are disabled');
    await expect(adapter.clearCart('main')).rejects.toThrow('live Android actions are disabled');
  });

  it('persists exact dispatch authority before sending commit_once', async () => {
    const worker = new Worker((request): AndroidWorkerResponseV1 => request.operation === 'prepare_checkout'
      ? { version: 1, operation: 'prepare_checkout', status: 'prepared', checkout: review }
      : { version: 1, operation: 'commit_once', status: 'committed', providerReference: 'order-1' });
    const state = new State();
    const adapter = new AndroidBlinkitAdapter(worker, state, { actionsEnabled: true, commitEnabled: true, now: (): Date => new Date('2026-07-19T10:00:00.000Z') });
    const prepared = await adapter.prepareGrocery(owner, { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'diet coke', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home', paymentMode: 'cod' });
    expect(await adapter.commit(owner, prepared.providerStateRef, { proposalId: 'proposal-1', proposalHash: 'b'.repeat(64), providerFingerprint: review.providerFingerprint, idempotencyKey: 'message-1:proposal-1' })).toEqual({ outcome: 'committed', providerReference: 'order-1' });
    expect(worker.requests[1]).toMatchObject({ operation: 'commit_once', expected: { proposalId: 'proposal-1', proposalHash: 'b'.repeat(64), idempotencyKey: 'message-1:proposal-1', checkout: review } });
    expect(state.value).toMatchObject({ expected: { proposalId: 'proposal-1' } });
  });

  it('rejects a provider-state fingerprint that is not bound by the proposal', async () => {
    const worker = new Worker((request): AndroidWorkerResponseV1 => request.operation === 'prepare_checkout'
      ? { version: 1, operation: 'prepare_checkout', status: 'prepared', checkout: review }
      : { version: 1, operation: 'commit_once', status: 'committed', providerReference: 'must-not-run' });
    const adapter = new AndroidBlinkitAdapter(worker, new State(), { actionsEnabled: true, commitEnabled: true });
    const prepared = await adapter.prepareGrocery(owner, { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'diet coke', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home', paymentMode: 'cod' });

    await expect(adapter.commit(owner, prepared.providerStateRef, {
      proposalId: 'proposal-1', proposalHash: 'b'.repeat(64), providerFingerprint: 'b'.repeat(64), idempotencyKey: 'message-2:proposal-1',
    })).resolves.toEqual({ outcome: 'stale' });
    expect(worker.requests.map(({ operation }) => operation)).toEqual(['prepare_checkout']);
  });

  it('relays login secrets only in the typed request and never retains them', async () => {
    const worker = new Worker((request): AndroidWorkerResponseV1 => request.operation === 'begin_login'
      ? { version: 1, operation: 'begin_login', status: 'otp_sent' }
      : { version: 1, operation: 'auth_status', status: 'active' });
    const auth = new AndroidBlinkitAuthCoordinator(worker);
    expect(await auth.begin(owner, 'main', '9999999999')).toMatchObject({ status: 'otp_sent' });
    expect(JSON.stringify(auth)).not.toContain('9999999999');
  });
});
