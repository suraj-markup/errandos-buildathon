/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it, vi } from 'vitest';

const publishOverlayStatusMock = vi.hoisted(
  () => vi.fn(async () => true),
);

vi.mock('./overlay', () => ({
  publishOverlayStatus: publishOverlayStatusMock,
}));

import {
  AndroidCartMutationVerificationError,
  AppiumSessionPool,
  type AppiumHttpClient,
  type AndroidSearchOffer,
} from '@errandos/provider-connectors';
import {
  BlinkitExecutionService,
  type BlinkitExecutionSubstageMetric,
} from './blinkit-execution';
import type { PhoneOperationExecutionControl } from './operation-queue';

const selectedPotato: AndroidSearchOffer = {
  available: true,
  offerId: 'offer-potato',
  packSize: '1 kg',
  price: { amount: 27, currency: 'INR' },
  title: 'Potato (Alugadde)',
};

const potatoCart = {
  addressLabel: 'Home',
  addressReference: 'address_home',
  lines: [{
    lineTotal: { amount: 27, currency: 'INR' as const },
    name: 'Potato',
    productId: 'blinkit-potato',
    quantity: 1,
    unitPrice: { amount: 27, currency: 'INR' as const },
  }],
  paymentMode: 'cod' as const,
  providerFingerprint: 'a'.repeat(64),
  subtotal: { amount: 27, currency: 'INR' as const },
  unavailableItems: [],
};

function correlatedControl(): PhoneOperationExecutionControl {
  const operation = {
    operationId: 'operation_11111111-1111-4111-8111-111111111111',
    taskId: 'task_22222222-2222-4222-8222-222222222222',
    itemId: 'task_item_33333333-3333-4333-8333-333333333333',
    stepId: 'step:add-potato',
  };
  return {
    checkpoint: vi.fn(),
    current: () => operation,
    isCurrent: () => true,
    markFinalDispatchAttempted: vi.fn(),
    markMutationAttempted: vi.fn(),
    markReconciling: vi.fn(),
    operationId: operation.operationId,
  } as unknown as PhoneOperationExecutionControl;
}

function searchDriver(overrides: Record<string, unknown> = {}) {
  return {
    clickFinalOrderOnce: vi.fn(),
    currentScreen: vi.fn(async () => ({
      kind: 'search_results' as const,
      searchAction: 'available' as const,
    })),
    inspectCart: vi.fn(async () => undefined),
    prepareExistingCheckout: vi.fn(),
    readCheckoutReview: vi.fn(),
    readConfirmation: vi.fn(),
    readOrderHistory: vi.fn(),
    removeExistingCartItem: vi.fn(),
    search: vi.fn(async () => [selectedPotato]),
    setExistingCartItemQuantity: vi.fn(),
    upsertCartItem: vi.fn(),
    upsertVisibleCartItem: vi.fn(),
    ...overrides,
  };
}

function selectedOfferInput() {
  return {
    offerId: selectedPotato.offerId,
    quantity: 1,
    request: selectedPotato.title,
    selectedOffer: {
      offerId: selectedPotato.offerId,
      packSize: selectedPotato.packSize,
      priceAmount: selectedPotato.price.amount,
      priceCurrency: selectedPotato.price.currency,
      title: selectedPotato.title,
    },
  };
}

describe('Blinkit latency and driver integration', () => {
  it('does not invoke the ADB-backed status transport in unit tests', async () => {
    publishOverlayStatusMock.mockClear();
    const driver = searchDriver();
    const service = new BlinkitExecutionService({
      createDriver: () => driver as never,
      openClient: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      } as unknown as AppiumHttpClient)),
    });

    await expect(service.searchProducts('potato')).resolves.toMatchObject({
      ok: true,
      status: 'search_results',
    });
    expect(driver.search).toHaveBeenCalledOnce();
    expect(publishOverlayStatusMock).not.toHaveBeenCalled();
  });

  it('never gates phone work on unresolved or rejected overlay status delivery', async () => {
    vi.useFakeTimers();
    try {
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const publishStatus = vi.fn()
        .mockImplementationOnce(
          () => new Promise<boolean>(() => undefined),
        )
        .mockRejectedValueOnce(new Error('overlay transport unavailable'));
      const driver = searchDriver();
      const service = new BlinkitExecutionService({
        createDriver: () => driver as never,
        openClient: vi.fn(async () => ({
          close: vi.fn(async () => undefined),
        } as unknown as AppiumHttpClient)),
        publishStatus,
      });

      await expect(service.searchProducts('potato')).resolves.toMatchObject({
        ok: true,
        status: 'search_results',
      });
      expect(driver.search).toHaveBeenCalledOnce();
      expect(publishStatus).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_500);
      await vi.waitFor(() => {
        expect(publishStatus).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        const lines = warning.mock.calls.map(([line]) => String(line));
        expect(lines).toEqual(expect.arrayContaining([
          expect.stringContaining('"event":"blinkit.overlay_status.failed"'),
          expect.stringContaining('"event":"blinkit.overlay_status.timed_out"'),
        ]));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses one health-checked Appium session and emits correlated acquisition metrics', async () => {
    const close = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      close,
      currentPackage: vi.fn(async () => 'com.grofers.customerapp'),
    }));
    const pool = new AppiumSessionPool({ createSession });
    const metrics: BlinkitExecutionSubstageMetric[] = [];
    const driver = searchDriver();
    let tick = 0;
    const service = new BlinkitExecutionService({
      appiumSessionPool: pool as unknown as AppiumSessionPool<AppiumHttpClient>,
      createDriver: () => driver as never,
      nowMs: () => tick++,
      publishStatus: vi.fn(async () => false),
      recordSubstageMetric: (metric) => metrics.push(metric),
      sessionDeviceKey: 'pixel-1',
    });
    const control = correlatedControl();

    await service.searchProducts('potato', control);
    await service.searchProducts('potato', control);

    expect(createSession).toHaveBeenCalledOnce();
    expect(driver.search).toHaveBeenCalledTimes(2);
    expect(metrics.filter(({ substage }) => substage === 'session_acquisition'))
      .toMatchObject([
        { sessionRecreated: false, sessionReused: false },
        { sessionRecreated: false, sessionReused: true },
      ]);
    expect(metrics.every((metric) => (
      metric.operationId === control.current().operationId
      && metric.taskId === control.current().taskId
      && metric.itemId === control.current().itemId
      && metric.stepId === control.current().stepId
    ))).toBe(true);
    await pool.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses the accepted exact offer without search and records mutation substages', async () => {
    const metrics: BlinkitExecutionSubstageMetric[] = [];
    const driver = searchDriver({
      upsertVisibleCartItem: vi.fn(async (
        _offer,
        _quantity,
        checkpoints: {
          onCartInspectionStarted?: () => Promise<void> | void;
          onMutationStarted?: () => Promise<void> | void;
          onVerificationStarted?: () => Promise<void> | void;
        },
      ) => {
        await checkpoints.onMutationStarted?.();
        await checkpoints.onVerificationStarted?.();
        await checkpoints.onCartInspectionStarted?.();
        return { cart: potatoCart, changed: true };
      }),
    });
    const client = {
      close: vi.fn(async () => undefined),
    } as unknown as AppiumHttpClient;
    const service = new BlinkitExecutionService({
      createDriver: () => driver as never,
      openClient: vi.fn(async () => client),
      publishStatus: vi.fn(async () => false),
      recordSubstageMetric: (metric) => metrics.push(metric),
    });

    await expect(service.addCartItem(selectedOfferInput())).resolves.toMatchObject({
      ok: true,
      product: 'Potato (Alugadde)',
      quantity: 1,
      status: 'added',
    });
    expect(driver.search).not.toHaveBeenCalled();
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(metrics.map(({ substage }) => substage)).toEqual(expect.arrayContaining([
      'add_control_discovery',
      'candidate_extraction',
      'cart_inspection',
      'local_verification',
      'mutation',
      'screen_recognition',
      'session_acquisition',
    ]));
  });

  it('reconciles Potato/Alugadde from the retained single cart observation', async () => {
    const driver = searchDriver({
      upsertVisibleCartItem: vi.fn(async () => {
        throw new AndroidCartMutationVerificationError(potatoCart);
      }),
    });
    const service = new BlinkitExecutionService({
      createDriver: () => driver as never,
      openClient: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      } as unknown as AppiumHttpClient)),
      publishStatus: vi.fn(async () => false),
    });

    await expect(service.addCartItem(selectedOfferInput())).resolves.toMatchObject({
      ok: true,
      quantity: 1,
      status: 'already_in_cart',
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
        reconciliation: 'verified',
      },
    });
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).toHaveBeenCalledOnce();
  });

  it('performs at most one ordinary cart inspection after an untyped mutation failure', async () => {
    const driver = searchDriver({
      inspectCart: vi.fn(async () => undefined),
      upsertVisibleCartItem: vi.fn(async () => {
        throw new Error('transport lost after mutation');
      }),
    });
    const service = new BlinkitExecutionService({
      createDriver: () => driver as never,
      openClient: vi.fn(async () => ({
        close: vi.fn(async () => undefined),
      } as unknown as AppiumHttpClient)),
      publishStatus: vi.fn(async () => false),
    });

    await expect(service.addCartItem(selectedOfferInput())).resolves.toMatchObject({
      ok: false,
      verification: {
        mutationAttempted: true,
        outcome: 'verified_no_change',
      },
    });
    expect(driver.inspectCart).toHaveBeenCalledOnce();
    expect(driver.upsertVisibleCartItem).toHaveBeenCalledOnce();
  });
});
