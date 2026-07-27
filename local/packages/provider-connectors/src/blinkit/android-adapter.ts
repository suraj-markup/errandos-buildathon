import { randomUUID } from 'node:crypto';
import {
  AndroidExpectedCheckoutSchemaV1,
  GroceryProposalSnapshotSchemaV1,
  type AndroidCheckoutComparisonV1,
  type AndroidCheckoutReviewV1,
  type AndroidExpectedCheckoutV1,
  type BlinkitCartStatusOutputV1,
  type BlinkitCurrentScreenOutputV1,
  type BlinkitImportSharedCartOutputV1,
  type BlinkitListSavedAddressesOutputV1,
  type BlinkitReadinessOutputV1,
  type BlinkitRecentOrdersOutputV1,
  type BlinkitSearchProductsInputV1,
  type BlinkitSearchProductsOutputV1,
  type BlinkitShareCartOutputV1,
  type BlinkitSelectSavedAddressOutputV1,
  type PrepareExistingGroceryInput,
  type PrepareGroceryInput,
  type PrincipalId,
} from '@errandos/contracts';
import type {
  CommitDispatchContext,
  CommitResult,
  PreparedProviderState,
  TransactionProviderPort,
} from '@errandos/application';
import { AndroidWorkerOperationError, type AndroidWorkerPort } from '../android/worker-client.js';
import type { DurableProviderState } from '../runtime/provider-state.js';

interface StoredAndroidCheckout {
  version: 1;
  accountKey: string;
  preparedAt: string;
  expiresAt: string;
  checkout: AndroidCheckoutReviewV1;
  expected?: AndroidExpectedCheckoutV1;
}

export interface AndroidBlinkitAdapterOptions {
  actionsEnabled?: boolean;
  commitEnabled?: boolean;
  now?: () => Date;
  quoteTtlMs?: number;
}

export class AndroidBlinkitAdapter implements TransactionProviderPort {
  private readonly now: () => Date;
  private readonly quoteTtlMs: number;

  public constructor(
    private readonly worker: AndroidWorkerPort,
    private readonly state: DurableProviderState,
    private readonly options: AndroidBlinkitAdapterOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.quoteTtlMs = options.quoteTtlMs ?? 5 * 60_000;
  }

  public async searchProducts(input: BlinkitSearchProductsInputV1): Promise<BlinkitSearchProductsOutputV1> {
    const response = await this.worker.execute({
      version: 1,
      operation: 'search',
      accountKey: input.accountKey,
      query: input.query,
      limit: input.limit,
    });
    if (response.operation !== 'search') throw new Error('Android Blinkit search failed');
    if (response.status === 'error') throw workerOperationError(response);
    return {
      version: 1,
      status: response.offers.length > 0 ? 'completed' : 'no_results',
      offers: response.offers,
    };
  }

  public async currentScreen(accountKey: string): Promise<BlinkitCurrentScreenOutputV1> {
    const response = await this.worker.execute({ version: 1, operation: 'current_screen', accountKey });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'current_screen' || response.status !== 'completed') {
      throw new Error('Android Blinkit current screen failed');
    }
    return { version: 1, status: 'completed', screen: response.screen };
  }

  public async readiness(accountKey: string): Promise<BlinkitReadinessOutputV1> {
    const unavailable = (): BlinkitReadinessOutputV1 => ({
      version: 1,
      accountKey,
      status: 'unavailable',
      checks: [
        { component: 'control_plane', status: 'ready' },
        { component: 'worker', status: 'unavailable', reason: 'worker_unreachable' },
        { component: 'appium', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'emulator', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'blinkit_app', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'authentication', status: 'unknown', reason: 'dependency_unavailable' },
      ],
    });

    let response: Awaited<ReturnType<AndroidWorkerPort['execute']>>;
    try {
      response = await this.worker.execute({ version: 1, operation: 'readiness', accountKey });
    } catch {
      return unavailable();
    }
    if (response.operation !== 'readiness' || response.status !== 'completed') return unavailable();

    const dependencies = response.dependencies;
    const authentication = dependencies.authentication === 'active'
      ? { component: 'authentication' as const, status: 'ready' as const }
      : dependencies.authentication === 'login_required'
        ? { component: 'authentication' as const, status: 'action_required' as const, reason: 'login_required' as const }
        : dependencies.authentication === 'challenge_required'
          ? { component: 'authentication' as const, status: 'action_required' as const, reason: 'challenge_required' as const }
          : { component: 'authentication' as const, status: 'unknown' as const, reason: 'unexpected_provider_screen' as const };
    const checks: BlinkitReadinessOutputV1['checks'] = [
      { component: 'control_plane', status: 'ready' },
      { component: 'worker', status: 'ready' },
      dependencies.appium === 'ready'
        ? { component: 'appium', status: 'ready' }
        : { component: 'appium', status: 'unavailable', reason: 'appium_unavailable' },
      dependencies.emulator === 'ready'
        ? { component: 'emulator', status: 'ready' }
        : dependencies.emulator === 'unavailable'
          ? { component: 'emulator', status: 'unavailable', reason: 'emulator_unavailable' }
          : { component: 'emulator', status: 'unknown', reason: 'dependency_unavailable' },
      dependencies.blinkitApp === 'ready'
        ? { component: 'blinkit_app', status: 'ready' }
        : dependencies.blinkitApp === 'unavailable'
          ? { component: 'blinkit_app', status: 'unavailable', reason: 'blinkit_app_unavailable' }
          : { component: 'blinkit_app', status: 'unknown', reason: 'dependency_unavailable' },
      authentication,
    ];
    const status = checks.some((check) => check.status === 'unavailable' || check.status === 'unknown')
      ? 'unavailable'
      : checks.some((check) => check.status === 'action_required')
        ? 'action_required'
        : 'ready';
    return { version: 1, accountKey, status, checks };
  }

  public async inspectCurrentCart(accountKey: string): Promise<BlinkitCartStatusOutputV1> {
    const response = await this.worker.execute({ version: 1, operation: 'inspect_cart', accountKey });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'inspect_cart') throw new Error('Android Blinkit cart inspection failed');
    return response.status === 'empty'
      ? { version: 1, status: 'empty' }
      : { version: 1, status: 'completed', cart: response.cart };
  }

  public async shareCart(accountKey: string): Promise<BlinkitShareCartOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({ version: 1, operation: 'share_cart', accountKey });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'share_cart' || response.status !== 'completed') {
      throw new Error('Android Blinkit cart share failed');
    }
    return {
      version: 1,
      status: 'completed',
      shareUrl: response.shareUrl,
      cartFingerprint: response.cartFingerprint,
    };
  }

  public async importSharedCart(accountKey: string, shareUrl: string): Promise<BlinkitImportSharedCartOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({
      version: 1,
      operation: 'import_shared_cart',
      accountKey,
      shareUrl,
    });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'import_shared_cart' || response.status !== 'completed') {
      throw new Error('Android Blinkit shared cart import failed');
    }
    return {
      version: 1,
      status: 'completed',
      importBehavior: response.importBehavior,
      ...(response.previousCartFingerprint ? { previousCartFingerprint: response.previousCartFingerprint } : {}),
      cart: response.cart,
    };
  }

  public async listSavedAddresses(accountKey: string, requestedLabel?: string): Promise<BlinkitListSavedAddressesOutputV1> {
    const response = await this.worker.execute({
      version: 1,
      operation: 'list_saved_addresses',
      accountKey,
      ...(requestedLabel ? { requestedLabel } : {}),
    });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'list_saved_addresses' || response.status !== 'completed') throw new Error('Android Blinkit address list failed');
    return { version: 1, status: response.addresses.length > 0 ? 'completed' : 'empty', addresses: response.addresses };
  }

  public async selectSavedAddress(accountKey: string, addressReference: string): Promise<BlinkitSelectSavedAddressOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({
      version: 1,
      operation: 'select_saved_address',
      accountKey,
      addressReference,
    });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'select_saved_address' || response.status !== 'completed') {
      throw new Error('Android Blinkit address selection failed');
    }
    return {
      version: 1,
      status: 'completed',
      selectedAddress: response.selectedAddress,
      cartStatus: response.cart ? 'completed' : 'unverified',
      ...(response.cart ? { cart: response.cart } : {}),
    };
  }

  public async recentOrders(accountKey: string, limit: number): Promise<BlinkitRecentOrdersOutputV1> {
    const response = await this.worker.execute({ version: 1, operation: 'recent_orders', accountKey, limit });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'recent_orders' || response.status !== 'completed') throw new Error('Android Blinkit recent orders failed');
    return { version: 1, status: response.orders.length > 0 ? 'completed' : 'empty', orders: response.orders };
  }

  public async addCartItem(accountKey: string, query: string, offerId: string, quantity: number): Promise<BlinkitCartStatusOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({ version: 1, operation: 'upsert_cart_item', accountKey, query, offerId, quantity });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'upsert_cart_item' || response.status !== 'completed') throw new Error('Android Blinkit cart item add failed');
    return { version: 1, status: 'completed', cart: response.cart };
  }

  public async setCartItemQuantity(accountKey: string, productId: string, quantity: number): Promise<BlinkitCartStatusOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({ version: 1, operation: 'set_cart_quantity', accountKey, productId, quantity });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'set_cart_quantity') throw new Error('Android Blinkit cart quantity update failed');
    return response.status === 'empty'
      ? { version: 1, status: 'empty' }
      : { version: 1, status: 'completed', cart: response.cart };
  }

  public async removeCartItem(accountKey: string, productId: string): Promise<BlinkitCartStatusOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({ version: 1, operation: 'remove_cart_item', accountKey, productId });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'remove_cart_item') throw new Error('Android Blinkit cart item removal failed');
    return response.status === 'empty'
      ? { version: 1, status: 'empty' }
      : { version: 1, status: 'completed', cart: response.cart };
  }

  public async clearCart(accountKey: string): Promise<BlinkitCartStatusOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.execute({ version: 1, operation: 'clear_cart', accountKey });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'clear_cart') throw new Error('Android Blinkit cart clear failed');
    return response.status === 'empty'
      ? { version: 1, status: 'empty' }
      : { version: 1, status: 'completed', cart: response.cart };
  }

  public async prepareGrocery(owner: PrincipalId, input: PrepareGroceryInput): Promise<PreparedProviderState> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    if (input.paymentMode !== 'cod') throw new Error('Android Blinkit supports COD only');
    if (!input.deliveryAddressLabel) throw new Error('Android Blinkit requires a saved address label');
    const response = await this.worker.execute({
      version: 1,
      operation: 'prepare_checkout',
      accountKey: input.accountKey,
      items: input.items,
      addressReference: input.deliveryAddressRef,
      addressLabel: input.deliveryAddressLabel,
    });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'prepare_checkout' || response.status !== 'prepared') throw new Error('Android Blinkit preparation failed');
    return this.createPreparedState(owner, input.accountKey, response.checkout);
  }

  public async prepareExistingGrocery(owner: PrincipalId, input: PrepareExistingGroceryInput): Promise<PreparedProviderState> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    if (input.paymentMode !== 'cod') throw new Error('Android Blinkit supports COD only');
    const response = await this.worker.execute({ version: 1, operation: 'prepare_existing_checkout', accountKey: input.accountKey });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'prepare_existing_checkout' || response.status !== 'prepared') throw new Error('Android Blinkit existing cart preparation failed');
    return this.createPreparedState(owner, input.accountKey, response.checkout);
  }

  private async createPreparedState(owner: PrincipalId, accountKey: string, checkout: AndroidCheckoutReviewV1): Promise<PreparedProviderState> {
    const preparedAt = this.now();
    const expiresAt = new Date(preparedAt.getTime() + this.quoteTtlMs);
    const snapshot = GroceryProposalSnapshotSchemaV1.parse({
      version: 1,
      kind: 'grocery',
      provider: 'blinkit',
      principalId: owner,
      accountReference: accountKey,
      revision: 1,
      lines: checkout.lines,
      unavailableItems: checkout.unavailableItems,
      fees: checkout.fees,
      total: checkout.total,
      deliveryAddress: { reference: checkout.addressReference, summary: checkout.addressLabel },
      ...(checkout.etaMinutes ? { etaMinutes: checkout.etaMinutes } : {}),
      paymentMode: 'cod',
      providerFingerprint: checkout.providerFingerprint,
      preparedAt: preparedAt.toISOString(),
      quoteExpiresAt: expiresAt.toISOString(),
    });
    const stored: StoredAndroidCheckout = {
      version: 1,
      accountKey,
      preparedAt: preparedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      checkout,
    };
    return { snapshot, providerStateRef: await this.state.put(owner, stored) };
  }

  public async compareGrocery(owner: PrincipalId, providerStateRef: string): Promise<AndroidCheckoutComparisonV1> {
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    const response = await this.worker.execute({
      version: 1,
      operation: 'review_checkout',
      accountKey: stored.accountKey,
      expected: stored.checkout,
    });
    if (response.status === 'error') throw workerOperationError(response);
    if (response.operation !== 'review_checkout' || response.status !== 'completed') {
      throw new Error('Android Blinkit checkout review failed');
    }
    return response.comparison;
  }

  public async commit(owner: PrincipalId, providerStateRef: string, context: CommitDispatchContext): Promise<CommitResult> {
    if (!this.options.actionsEnabled || !this.options.commitEnabled) throw new Error('live Android commit is disabled');
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    if (!context.providerFingerprint || context.providerFingerprint !== stored.checkout.providerFingerprint) return { outcome: 'stale' };
    const expected = AndroidExpectedCheckoutSchemaV1.parse({
      proposalId: context.proposalId,
      proposalHash: context.proposalHash,
      idempotencyKey: context.idempotencyKey,
      preparedAt: stored.preparedAt,
      expiresAt: stored.expiresAt,
      checkout: stored.checkout,
    });
    await this.state.replace(owner, providerStateRef, { ...stored, expected });
    const response = await this.worker.execute({ version: 1, operation: 'commit_once', accountKey: stored.accountKey, expected });
    if (response.operation !== 'commit_once' || response.status === 'error') throw new Error('Android Blinkit commit failed');
    if (response.status === 'committed') return { outcome: 'committed', providerReference: response.providerReference };
    return { outcome: response.status };
  }

  public async reconcile(owner: PrincipalId, providerStateRef: string): Promise<CommitResult | { outcome: 'pending' }> {
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    if (!stored.expected) return { outcome: 'pending' };
    const response = await this.worker.execute({ version: 1, operation: 'reconcile', accountKey: stored.accountKey, expected: stored.expected });
    if (response.operation !== 'reconcile' || response.status === 'error') return { outcome: 'pending' };
    return response.status === 'committed'
      ? { outcome: 'committed', providerReference: response.providerReference }
      : { outcome: 'pending' };
  }
}

export class AndroidBlinkitAuthCoordinator {
  public constructor(private readonly worker: AndroidWorkerPort) {}

  public async status(_owner: PrincipalId, accountKey: string): Promise<{ status: 'active' | 'login_required' | 'challenge_required' }> {
    const response = await this.worker.execute({ version: 1, operation: 'auth_status', accountKey });
    if (response.operation !== 'auth_status' || response.status === 'error') return { status: 'challenge_required' };
    return { status: response.status };
  }

  public async begin(_owner: PrincipalId, accountKey: string, phone: string): Promise<{ sessionId: string; status: 'otp_sent' | 'active' }> {
    const response = await this.worker.execute({ version: 1, operation: 'begin_login', accountKey, phone });
    if (response.operation !== 'begin_login' || response.status === 'error') throw new Error('Android Blinkit login failed');
    return { sessionId: `android_${randomUUID()}`, status: response.status };
  }

  public async submitOtp(_owner: PrincipalId, accountKey: string, otp: string): Promise<{ sessionId: string; status: 'active' | 'challenge_required' }> {
    const response = await this.worker.execute({ version: 1, operation: 'submit_otp', accountKey, otp });
    if (response.operation !== 'submit_otp' || response.status === 'error') throw new Error('Android Blinkit OTP failed');
    return { sessionId: `android_${randomUUID()}`, status: response.status };
  }

  public async closeAll(): Promise<void> {}

  public toJSON(): Record<string, never> { return {}; }
}

function parseStored(value: unknown): StoredAndroidCheckout {
  if (typeof value !== 'object' || value === null) throw new Error('Android Blinkit state invalid');
  const state = value as Partial<StoredAndroidCheckout>;
  if (state.version !== 1 || typeof state.accountKey !== 'string' || typeof state.preparedAt !== 'string' || typeof state.expiresAt !== 'string' || !state.checkout) throw new Error('Android Blinkit state invalid');
  return {
    version: 1,
    accountKey: state.accountKey,
    preparedAt: state.preparedAt,
    expiresAt: state.expiresAt,
    checkout: state.checkout,
    ...(state.expected ? { expected: AndroidExpectedCheckoutSchemaV1.parse(state.expected) } : {}),
  };
}

function workerOperationError(response: {
  stage: string;
  itemSubtotal?: number | undefined;
  requiredSubtotal?: number | undefined;
}): AndroidWorkerOperationError {
  const details = response.itemSubtotal !== undefined && response.requiredSubtotal !== undefined
    ? { itemSubtotal: response.itemSubtotal, requiredSubtotal: response.requiredSubtotal }
    : undefined;
  return new AndroidWorkerOperationError(response.stage, details);
}
