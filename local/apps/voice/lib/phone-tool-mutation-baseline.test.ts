import { describe, expect, it, vi } from 'vitest';
import type {
  AndroidSearchOffer,
  AppiumHttpClient,
} from '@errandos/provider-connectors';
import {
  BlinkitExecutionService,
} from './blinkit-execution';
import {
  executePhoneActionWithService,
} from './phone-tool';
import {
  CompatibilityExecutionSafetyV2,
} from './workflow/v2/compatibility-execution-safety';

const selectedOffer = {
  offerId: 'offer_500',
  packSize: '500 ml',
  priceAmount: 28,
  priceCurrency: 'INR' as const,
  title: 'Amul Taaza Toned Milk',
};

const action = {
  action: 'add_cart_item' as const,
  offerId: selectedOffer.offerId,
  quantity: 1,
  request: selectedOffer.title,
  searchQuery: selectedOffer.title,
  selectedOffer,
};

const money = (amount: number) => ({
  amount,
  currency: 'INR' as const,
});

const cartLine = (
  productId: string,
  name: string,
  quantity: number,
  unitPrice: number,
) => ({
  lineTotal: money(quantity * unitPrice),
  name,
  productId,
  quantity,
  unitPrice: money(unitPrice),
});

const cartReview = (
  lines: ReturnType<typeof cartLine>[],
  fingerprint: string,
) => ({
  addressLabel: 'Home',
  addressReference: 'saved:home',
  lines,
  paymentMode: 'cod' as const,
  providerFingerprint: fingerprint,
  subtotal: money(
    lines.reduce((total, line) => total + line.lineTotal.amount, 0),
  ),
  unavailableItems: [],
});

function productionShapedService(
  baseline: () => Promise<ReturnType<typeof cartReview>>,
) {
  const before = cartReview([
    cartLine('cart-bread', 'Brown Bread', 1, 45),
  ], 'a'.repeat(64));
  const after = cartReview([
    ...before.lines,
    cartLine('cart-milk', selectedOffer.title, 1, 28),
  ], 'b'.repeat(64));
  const driver = {
    clickFinalOrderOnce: vi.fn(async () => undefined),
    currentScreen: vi.fn(async () => ({
      kind: 'cart' as const,
      searchAction: 'recoverable' as const,
    })),
    inspectCart: vi.fn(async () => before),
    inspectCartPreservingVisibleOffer: vi.fn(baseline),
    prepareExistingCheckout: vi.fn(),
    readCheckoutReview: vi.fn(),
    readConfirmation: vi.fn(),
    readOrderHistory: vi.fn(async () => []),
    removeExistingCartItem: vi.fn(),
    search: vi.fn(async () => [] as AndroidSearchOffer[]),
    setExistingCartItemQuantity: vi.fn(),
    upsertCartItem: vi.fn(),
    upsertVisibleCartItem: vi.fn(async (
      _offer: AndroidSearchOffer,
      _quantity: number,
      lifecycle?: {
        onCartInspectionStarted?: () => Promise<void> | void;
        onMutationStarted?: () => Promise<void> | void;
        onVerificationStarted?: () => Promise<void> | void;
      },
    ) => {
      await lifecycle?.onMutationStarted?.();
      await lifecycle?.onVerificationStarted?.();
      await lifecycle?.onCartInspectionStarted?.();
      return {
        before,
        cart: after,
        changed: true,
      };
    }),
  };
  const client = (
    { close: vi.fn(async () => undefined) } as unknown as AppiumHttpClient
  );
  return {
    before,
    driver,
    service: new BlinkitExecutionService({
      createDriver: () => driver as never,
      isDeviceReady: vi.fn(async () => true),
      openClient: vi.fn(async () => client),
      publishStatus: vi.fn(async () => false),
    }),
  };
}

describe('selected-offer mutation baseline composition', () => {
  it('restores the exact choice before mutating the same offer once', async () => {
    const { before, driver, service } = productionShapedService(
      async () => cartReview([...before.lines], 'a'.repeat(64)),
    );

    await expect(executePhoneActionWithService(
      action,
      service,
      {
        callId: 'selected-baseline-success',
        protocolVersion: 2,
        stepKey: 'item:milk:add',
        taskId: 'task_71000000-1234-1234-1234-123456789abc',
        taskRevision: 1,
      },
      new CompatibilityExecutionSafetyV2(),
    )).resolves.toMatchObject({
      ok: true,
      status: 'added',
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    });

    expect(driver.inspectCartPreservingVisibleOffer).toHaveBeenCalledOnce();
    expect(driver.inspectCartPreservingVisibleOffer).toHaveBeenCalledWith({
      available: true,
      offerId: selectedOffer.offerId,
      packSize: selectedOffer.packSize,
      price: { amount: selectedOffer.priceAmount, currency: 'INR' },
      title: selectedOffer.title,
    });
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.search).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).toHaveBeenCalledOnce();
    expect(driver.upsertVisibleCartItem.mock.calls[0]?.[0]).toMatchObject({
      offerId: selectedOffer.offerId,
      title: selectedOffer.title,
    });
  });

  it('fails before mutation when exact search restoration fails', async () => {
    const { driver, service } = productionShapedService(async () => {
      throw new Error('Blinkit cart_baseline_restore failed');
    });

    await expect(executePhoneActionWithService(
      action,
      service,
      {
        callId: 'selected-baseline-failure',
        protocolVersion: 2,
        stepKey: 'item:milk:add',
        taskId: 'task_72000000-1234-1234-1234-123456789abc',
        taskRevision: 1,
      },
      new CompatibilityExecutionSafetyV2(),
    )).resolves.toMatchObject({
      ok: false,
      status: 'execution_failed',
      verification: {
        mutationAttempted: false,
        outcome: 'failed_before_mutation',
        reconciliation: 'inspection_failed',
      },
    });

    expect(driver.inspectCartPreservingVisibleOffer).toHaveBeenCalledOnce();
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.search).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).not.toHaveBeenCalled();
  });
});
