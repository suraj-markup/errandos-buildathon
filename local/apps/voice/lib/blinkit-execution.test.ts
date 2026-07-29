import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  AndroidCommitRecord,
  AndroidCommitStore,
  AndroidSearchOffer,
  AppiumHttpClient,
} from '@errandos/provider-connectors';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import {
  BlinkitExecutionService,
  cartItemFingerprint,
  readCurrentScreenEvidence,
  selectExactOffer,
} from './blinkit-execution';

const offers: AndroidSearchOffer[] = [
  {
    available: true,
    offerId: 'offer_500',
    packSize: '500 ml',
    price: { amount: 28, currency: 'INR' },
    title: 'Amul Taaza Toned Milk',
  },
  {
    available: true,
    offerId: 'offer_1l',
    packSize: '1 l',
    price: { amount: 56, currency: 'INR' },
    title: 'Amul Taaza Toned Milk',
  },
];

describe('local Blinkit voice selection', () => {
  it('does not guess when a product name has multiple sizes', () => {
    expect(selectExactOffer('Amul Taaza doodh', offers)).toBeUndefined();
  });

  it('selects one exact product and size', () => {
    expect(selectExactOffer('Amul Taaza doodh 500 ml', offers)?.offerId)
      .toBe('offer_500');
  });

  it('uses a pending opaque offer ID without rematching by rank', () => {
    expect(selectExactOffer('add to cart', offers, 'offer_1l')?.offerId)
      .toBe('offer_1l');
  });

  it('rejects an unavailable or invented offer ID', () => {
    expect(selectExactOffer('add to cart', offers, 'offer_missing'))
      .toBeUndefined();
  });

  it('collapses only identical duplicate provider rows', () => {
    expect(selectExactOffer(
      'Amul Taaza milk 500 ml',
      [offers[0]!, { ...offers[0]! }],
    )?.offerId).toBe('offer_500');
  });

  it('does not guess between the same title and size at different prices', () => {
    expect(selectExactOffer('Amul Taaza milk 500 ml', [
      offers[0]!,
      {
        ...offers[0]!,
        offerId: 'offer_500_premium',
        price: money(30),
      },
    ])).toBeUndefined();
  });

  it('does not collapse title-only provider variants', () => {
    expect(selectExactOffer('Amul Taaza milk', [
      { ...offers[0]!, packSize: undefined },
      {
        ...offers[0]!,
        offerId: 'offer_title_variant',
        packSize: undefined,
        price: money(30),
      },
    ])).toBeUndefined();
  });
});

describe('cart item fingerprint', () => {
  const line = {
    lineTotal: { amount: 50, currency: 'INR' as const },
    name: 'Lay’s Classic Salted',
    productId: 'lays-classic',
    quantity: 2,
    unitPrice: { amount: 25, currency: 'INR' as const },
  };

  it('does not change with transient checkout metadata', () => {
    const cart = {
      addressLabel: 'Home',
      addressReference: 'saved:home',
      etaMinutes: 10,
      lines: [line],
      paymentMode: 'cod' as const,
      providerFingerprint: 'a'.repeat(64),
      subtotal: { amount: 50, currency: 'INR' as const },
      unavailableItems: [],
    };
    const changedMetadata = {
      ...cart,
      etaMinutes: undefined,
      paymentMode: 'other' as const,
      providerFingerprint: 'b'.repeat(64),
    };

    expect(cartItemFingerprint(cart)).toBe(cartItemFingerprint(changedMetadata));
  });

  it('changes when an item quantity changes', () => {
    const cart = {
      lines: [line],
      subtotal: { amount: 50, currency: 'INR' as const },
      unavailableItems: [],
    };
    const changedCart = {
      ...cart,
      lines: [{ ...line, quantity: 3, lineTotal: { amount: 75, currency: 'INR' as const } }],
      subtotal: { amount: 75, currency: 'INR' as const },
    };

    expect(cartItemFingerprint(cart)).not.toBe(cartItemFingerprint(changedCart));
  });

  it('does not change when provider line ordering changes', () => {
    const bread = cartLine('bread', 'Bread', 1, 40);
    const cart = cartReview([line, bread]);
    expect(cartItemFingerprint(cart))
      .toBe(cartItemFingerprint({ ...cart, lines: [bread, line] }));
  });
});

describe('current screen evidence', () => {
  it('marks a successful post-action read as same-operation evidence', async () => {
    await expect(readCurrentScreenEvidence({
      currentScreen: async () => ({
        kind: 'cart',
        searchAction: 'recoverable',
      }),
    })).resolves.toEqual({
      observedAfterAction: true,
      screen: {
        kind: 'cart',
        searchAction: 'recoverable',
      },
    });
  });

  it('does not fail a completed action when the optional screen read fails', async () => {
    await expect(readCurrentScreenEvidence({
      currentScreen: async () => {
        throw new Error('screen unavailable');
      },
    })).resolves.toBeUndefined();
  });
});

const money = (amount: number) => ({ amount, currency: 'INR' as const });
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
  fingerprint = 'a'.repeat(64),
) => ({
  addressLabel: 'Home',
  addressReference: 'saved:home',
  lines,
  paymentMode: 'cod' as const,
  providerFingerprint: fingerprint,
  subtotal: money(lines.reduce((sum, line) => sum + line.lineTotal.amount, 0)),
  unavailableItems: [],
});
const checkoutReview = (
  overrides: Partial<AndroidCheckoutReviewV1> = {},
): AndroidCheckoutReviewV1 => ({
  addressLabel: 'Home',
  addressReference: 'address_home',
  etaMinutes: 12,
  fees: [
    { amount: money(5), kind: 'handling', label: 'Handling fee' },
  ],
  lines: [
    cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 28),
  ],
  paymentMode: 'cod',
  providerFingerprint: 'c'.repeat(64),
  total: money(33),
  unavailableItems: [],
  ...overrides,
});

class MemoryCommitStore implements AndroidCommitStore {
  readonly records = new Map<string, AndroidCommitRecord>();

  async get(idempotencyKey: string) {
    return this.records.get(
      createHash('sha256').update(idempotencyKey).digest('hex'),
    );
  }

  async recordDispatch(record: AndroidCommitRecord) {
    const key = record.idempotencyKeyHash;
    const existing = this.records.get(key);
    if (existing) return { created: false, record: existing };
    this.records.set(key, record);
    return { created: true, record };
  }

  async recordOutcome(
    idempotencyKey: string,
    state: 'ambiguous' | 'committed',
    providerReference?: string,
  ) {
    const key = createHash('sha256').update(idempotencyKey).digest('hex');
    const existing = this.records.get(key);
    if (!existing) throw new Error('missing dispatch');
    if (
      existing.state === 'committed'
      || (existing.state === 'ambiguous' && state === 'ambiguous')
    ) return;
    this.records.set(key, {
      ...existing,
      state,
      ...(providerReference ? { providerReference } : {}),
    });
  }
}

function fakeDriver(overrides: Record<string, unknown> = {}) {
  return {
    clickFinalOrderOnce: vi.fn(async () => undefined),
    currentScreen: vi.fn(async () => ({
      kind: 'search_results' as const,
      searchAction: 'available' as const,
    })),
    inspectCart: vi.fn(async () => undefined),
    prepareExistingCheckout: vi.fn(async () => checkoutReview()),
    readCheckoutReview: vi.fn(async () => checkoutReview()),
    readConfirmation: vi.fn(async () => ({
      providerReference: 'order-safe-1',
      status: 'committed' as const,
    })),
    readOrderHistory: vi.fn(async () => []),
    removeExistingCartItem: vi.fn(async () => undefined),
    search: vi.fn(async () => offers),
    setExistingCartItemQuantity: vi.fn(async () => undefined),
    upsertVisibleCartItem: vi.fn(async () => ({
      cart: cartReview([]),
      changed: true,
    })),
    upsertCartItem: vi.fn(async () => cartReview([])),
    ...overrides,
  };
}

function serviceFor(
  driver: ReturnType<typeof fakeDriver>,
  options: {
    commitStore?: AndroidCommitStore;
    isDeviceReady?: () => Promise<boolean>;
    liveCommitEnabled?: boolean;
    now?: () => Date;
    openClient?: () => Promise<AppiumHttpClient>;
    proposalTtlMs?: number;
  } = {},
) {
  const close = vi.fn(async () => undefined);
  const client = { close } as unknown as AppiumHttpClient;
  const openClient = options.openClient ?? vi.fn(async () => client);
  return {
    close,
    openClient,
    service: new BlinkitExecutionService({
      createDriver: () => driver as never,
      ...(options.commitStore ? { commitStore: options.commitStore } : {}),
      isDeviceReady: options.isDeviceReady ?? vi.fn(async () => true),
      ...(options.liveCommitEnabled !== undefined
        ? { liveCommitEnabled: options.liveCommitEnabled }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      openClient,
      ...(options.proposalTtlMs !== undefined
        ? { proposalTtlMs: options.proposalTtlMs }
        : {}),
      publishStatus: vi.fn(async () => false),
    }),
  };
}

describe('BlinkitExecutionService', () => {
  it('prepares complete checkout terms while keeping the order NOT ORDERED', async () => {
    const driver = fakeDriver();
    const service = serviceFor(driver, {
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      proposalTtlMs: 120_000,
    }).service;

    await expect(service.prepareCheckout()).resolves.toMatchObject({
      checkout: {
        addressLabel: 'Home',
        checkout: {
          fees: [{ kind: 'handling', label: 'Handling fee' }],
          lines: [{
            name: 'Amul Taaza Toned Milk',
            quantity: 1,
            unitPrice: money(28),
          }],
          paymentMode: 'cod',
          total: money(33),
        },
        expiresAt: '2026-07-27T12:02:00.000Z',
        itemCount: 1,
        preparedAt: '2026-07-27T12:00:00.000Z',
        proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      message: expect.stringContaining('Nothing has been ordered'),
      ok: false,
      status: 'confirmation_required',
    });
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();
    expect(driver.readConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    ['zero-item cart', { lines: [] }],
    ['unsupported payment', { paymentMode: 'other' }],
    ['missing provider terms', { providerFingerprint: '' }],
  ])('rejects checkout preparation with %s', async (_label, override) => {
    const driver = fakeDriver({
      prepareExistingCheckout: vi.fn(async () =>
        checkoutReview(override as Partial<AndroidCheckoutReviewV1>)),
    });

    await expect(serviceFor(driver).service.prepareCheckout())
      .resolves.toMatchObject({
        failure: { reason: 'verification_failed', stage: 'verification' },
        ok: false,
        status: 'execution_failed',
      });
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();
  });

  it('keeps final dispatch disabled by default without opening a phone session', async () => {
    const driver = fakeDriver();
    const { service, openClient } = serviceFor(driver);
    const prepared = await service.prepareCheckout() as unknown as {
      checkout: import('./cod').CodCheckoutProposalV1;
    };

    await expect(service.confirmCheckout(prepared.checkout)).resolves.toMatchObject({
      ok: false,
      status: 'final_dispatch_disabled',
    });
    expect(openClient).toHaveBeenCalledOnce();
    expect(driver.readCheckoutReview).not.toHaveBeenCalled();
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();
  });

  it('rejects expired and changed proposals before final dispatch', async () => {
    let now = new Date('2026-07-27T12:00:00.000Z');
    const driver = fakeDriver();
    const store = new MemoryCommitStore();
    const { service } = serviceFor(driver, {
      commitStore: store,
      liveCommitEnabled: true,
      now: () => now,
      proposalTtlMs: 1_000,
    });
    const prepared = await service.prepareCheckout() as unknown as {
      checkout: import('./cod').CodCheckoutProposalV1;
    };

    now = new Date('2026-07-27T12:00:02.000Z');
    await expect(service.confirmCheckout(prepared.checkout)).resolves.toMatchObject({
      changes: ['expiry'],
      status: 'checkout_expired',
    });
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();

    now = new Date('2026-07-27T12:00:00.500Z');
    driver.readCheckoutReview.mockResolvedValueOnce(checkoutReview({
      total: money(34),
      providerFingerprint: 'd'.repeat(64),
    }));
    await expect(service.confirmCheckout(prepared.checkout)).resolves.toMatchObject({
      changes: ['total', 'provider_fingerprint'],
      status: 'checkout_changed',
    });
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();
  });

  it('dispatches unchanged terms at most once across service restart', async () => {
    const driver = fakeDriver();
    const store = new MemoryCommitStore();
    const options = {
      commitStore: store,
      liveCommitEnabled: true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    };
    const firstService = serviceFor(driver, options).service;
    const prepared = await firstService.prepareCheckout() as unknown as {
      checkout: import('./cod').CodCheckoutProposalV1;
    };

    await expect(firstService.confirmCheckout(prepared.checkout))
      .resolves.toMatchObject({
        ok: true,
        providerReference: 'order-safe-1',
        status: 'ordered',
      });
    const restartedService = serviceFor(driver, options).service;
    await expect(restartedService.confirmCheckout(prepared.checkout))
      .resolves.toMatchObject({
        ok: true,
        providerReference: 'order-safe-1',
        status: 'ordered',
      });
    expect(driver.clickFinalOrderOnce).toHaveBeenCalledOnce();
  });

  it('preserves ambiguity and reconciles read-only without retrying dispatch', async () => {
    const driver = fakeDriver({
      clickFinalOrderOnce: vi.fn(async () => {
        throw new Error('transport timeout after possible dispatch');
      }),
      readOrderHistory: vi.fn(async () => []),
    });
    const store = new MemoryCommitStore();
    const options = {
      commitStore: store,
      liveCommitEnabled: true,
      now: () => new Date('2026-07-27T12:00:00.000Z'),
    };
    const service = serviceFor(driver, options).service;
    const prepared = await service.prepareCheckout() as unknown as {
      checkout: import('./cod').CodCheckoutProposalV1;
    };

    await expect(service.confirmCheckout(prepared.checkout)).resolves.toMatchObject({
      ok: false,
      reconciliationRequired: true,
      status: 'order_status_ambiguous',
    });
    await expect(
      serviceFor(driver, options).service.confirmCheckout(prepared.checkout),
    ).resolves.toMatchObject({
      status: 'order_status_ambiguous',
    });
    expect(driver.clickFinalOrderOnce).toHaveBeenCalledOnce();
    expect(driver.readOrderHistory).toHaveBeenCalledTimes(2);
  });

  it('does not cross the dispatch boundary when term inspection times out', async () => {
    const driver = fakeDriver({
      readCheckoutReview: vi.fn(async () => {
        throw new Error('transport timeout before dispatch');
      }),
    });
    const service = serviceFor(driver, {
      commitStore: new MemoryCommitStore(),
      liveCommitEnabled: true,
    }).service;
    const prepared = await service.prepareCheckout() as unknown as {
      checkout: import('./cod').CodCheckoutProposalV1;
    };

    await expect(service.confirmCheckout(prepared.checkout)).resolves.toMatchObject({
      failure: { stage: 'inspection' },
      status: 'execution_failed',
    });
    expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();
  });

  it('keeps read-only search physically separate from every cart mutation', async () => {
    const driver = fakeDriver();
    const { close, service } = serviceFor(driver);

    const result = await service.searchProducts('Amul milk');

    expect(result.status).toBe('search_results');
    expect(driver.search).toHaveBeenCalledOnce();
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).not.toHaveBeenCalled();
    expect(driver.upsertCartItem).not.toHaveBeenCalled();
    expect(driver.setExistingCartItemQuantity).not.toHaveBeenCalled();
    expect(driver.removeExistingCartItem).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('message');
  });

  it('recovers only session creation before executing an operation once', async () => {
    const client = { close: vi.fn(async () => undefined) } as unknown as AppiumHttpClient;
    const openClient = vi.fn()
      .mockRejectedValueOnce(new Error('stale session'))
      .mockResolvedValueOnce(client);
    const driver = fakeDriver();
    const { service } = serviceFor(driver, {
      isDeviceReady: vi.fn(async () => true),
      openClient,
    });

    const result = await service.searchProducts('Amul milk');

    expect(openClient).toHaveBeenCalledTimes(2);
    expect(driver.search).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      execution: { sessionRecovered: true },
      status: 'search_results',
    });
  });

  it.each([
    {
      expected: { reason: 'device_unavailable', stage: 'device' },
      service: () => serviceFor(fakeDriver(), {
        isDeviceReady: vi.fn(async () => false),
        openClient: vi.fn(async () => {
          throw new Error('device offline');
        }),
      }).service,
    },
    {
      expected: { reason: 'session_recovery_failed', stage: 'recovery' },
      service: () => serviceFor(fakeDriver(), {
        isDeviceReady: vi.fn(async () => true),
        openClient: vi.fn(async () => {
          throw new Error('session unavailable');
        }),
      }).service,
    },
    {
      expected: { reason: 'search_failed', stage: 'search' },
      service: () => serviceFor(fakeDriver({
        search: vi.fn(async () => {
          throw new Error('search failed');
        }),
      })).service,
    },
    {
      expected: { reason: 'cart_inspection_failed', stage: 'inspection' },
      service: () => serviceFor(fakeDriver({
        inspectCart: vi.fn(async () => {
          throw new Error('cart inspection failed');
        }),
      })).service,
    },
  ])('returns a typed $expected.stage failure', async ({ expected, service }) => {
    const executionService = service();
    const result = expected.stage === 'inspection'
      ? executionService.inspectCart()
      : executionService.searchProducts('milk');
    await expect(result).resolves.toMatchObject({
      failure: expected,
      ok: false,
      status: 'execution_failed',
    });
  });

  it('distinguishes matching, mutation, and verification failures', async () => {
    const matching = serviceFor(fakeDriver()).service;
    await expect(matching.addCartItem({
      offerId: 'missing-offer',
      quantity: 1,
      request: 'milk',
    })).resolves.toMatchObject({
      failure: { reason: 'offer_not_found', stage: 'matching' },
    });

    const mutation = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => {
        throw new Error('Blinkit cart_item_upsert failed');
      }),
    })).service;
    await expect(mutation.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      failure: { reason: 'mutation_failed', stage: 'mutation' },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_no_change',
      },
    });

    const verification = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        cart: cartReview([
          cartLine('cart-milk', 'Amul Taaza Toned Milk', 2, 28),
        ]),
        changed: true,
      })),
    })).service;
    await expect(verification.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      failure: { reason: 'verification_failed', stage: 'verification' },
    });
  });

  it('classifies a non-unique cart identity as ambiguous', async () => {
    const duplicated = cartReview([
      cartLine('cart-milk-a', 'Amul Taaza Toned Milk', 1, 28),
      cartLine('cart-milk-b', 'Amul Taaza Toned Milk', 1, 28),
    ]);
    const service = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        cart: duplicated,
        changed: true,
      })),
    })).service;

    await expect(service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      ok: false,
      status: 'execution_failed',
      verification: {
        identityResolution: 'ambiguous',
        mutationAttempted: true,
        outcome: 'ambiguous',
      },
    });
  });

  it('classifies a truly absent identity as verified no change', async () => {
    const service = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        cart: cartReview([
          cartLine('cart-bread', 'Whole Wheat Bread', 1, 40),
        ]),
        changed: false,
      })),
    })).service;

    await expect(service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      verification: {
        identityResolution: 'none',
        mutationAttempted: true,
        outcome: 'verified_no_change',
      },
    });
  });

  it('retains expected and observed pack and price conflict evidence', async () => {
    const conflictingLine = {
      ...cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 30),
      packSize: '750 ml',
    };
    const service = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        cart: cartReview([conflictingLine]),
        changed: true,
      })),
    })).service;

    await expect(service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      verification: {
        identityResolution: 'ambiguous',
        mutationAttempted: true,
        outcome: 'ambiguous',
        conflicts: [
          {
            field: 'pack_size',
            expected: '500 ml',
            observed: '750 ml',
          },
          {
            field: 'price',
            expected: '₹28.00',
            observed: '₹30.00',
          },
        ],
      },
    });
  });

  it('reports success when direct control times out but cart reconciliation proves the add', async () => {
    const reconciled = cartReview([
      cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 28),
    ], 'b'.repeat(64));
    const driver = fakeDriver({
      inspectCart: vi.fn(async () => reconciled),
      upsertVisibleCartItem: vi.fn(async (_selection, _quantity, lifecycle) => {
        await lifecycle?.onMutationStarted?.();
        throw new Error('Blinkit cart_item_verify failed');
      }),
    });

    await expect(serviceFor(driver).service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      ok: true,
      status: 'already_in_cart',
      verification: {
        directControl: 'unknown',
        mutationAttempted: true,
        outcome: 'verified_success',
        reconciliation: 'verified',
      },
    });
    expect(driver.upsertVisibleCartItem).toHaveBeenCalledOnce();
    expect(driver.inspectCart).toHaveBeenCalledOnce();
  });

  it('marks a post-mutation inspection failure ambiguous instead of claiming no update', async () => {
    const driver = fakeDriver({
      inspectCart: vi.fn(async () => {
        throw new Error('inspection timeout');
      }),
      upsertVisibleCartItem: vi.fn(async (_selection, _quantity, lifecycle) => {
        await lifecycle?.onMutationStarted?.();
        throw new Error('Blinkit cart_item_verify failed');
      }),
    });

    await expect(serviceFor(driver).service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      ok: false,
      status: 'execution_failed',
      verification: {
        mutationAttempted: true,
        outcome: 'ambiguous',
        reconciliation: 'inspection_failed',
      },
    });
  });

  it('keeps a stale selected offer before the provider boundary retryable', async () => {
    const markMutationAttemptedAtProviderBoundary = vi.fn(async () => undefined);
    const driver = fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => {
        throw new Error('Blinkit cart_item_offer failed');
      }),
    });

    await expect(serviceFor(driver).service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    }, {
      checkpoint: vi.fn(),
      current: vi.fn(() => ({})),
      isCurrent: vi.fn(() => true),
      markFinalDispatchAttempted: vi.fn(),
      markMutationAttempted: vi.fn(),
      markMutationAttemptedAtProviderBoundary,
      markReconciling: vi.fn(),
    } as never)).resolves.toMatchObject({
      ok: false,
      status: 'reselection_required',
      verification: {
        mutationAttempted: false,
        outcome: 'failed_before_mutation',
        reconciliation: 'not_run',
      },
    });
    expect(markMutationAttemptedAtProviderBoundary).not.toHaveBeenCalled();
    expect(driver.inspectCart).not.toHaveBeenCalled();
  });

  it('rejects an add when a non-target cart line changes', async () => {
    const before = cartReview([
      cartLine('other', 'Bread', 1, 40),
    ]);
    const after = cartReview([
      cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 28),
      cartLine('other', 'Bread', 2, 40),
    ], 'b'.repeat(64));
    const service = serviceFor(fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        before,
        cart: after,
        changed: true,
      })),
    })).service;

    await expect(service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    })).resolves.toMatchObject({
      failure: { reason: 'verification_failed', stage: 'verification' },
    });
  });

  it.each([1, 2])(
    'adds the exact offer at requested quantity %i and preserves other lines',
    async (quantity) => {
      const bread = cartLine('other', 'Bread', 1, 40);
      const before = cartReview([bread]);
      const after = cartReview([
        bread,
        cartLine('cart-milk', 'Amul Taaza Toned Milk', quantity, 28),
      ], 'b'.repeat(64));
      const driver = fakeDriver({
        upsertVisibleCartItem: vi.fn(async () => ({
          before,
          cart: after,
          changed: true,
        })),
      });
      const service = serviceFor(driver).service;

      await expect(service.addCartItem({
        offerId: 'offer_500',
        quantity,
        request: 'Amul Taaza Toned Milk',
      })).resolves.toMatchObject({
        ok: true,
        product: 'Amul Taaza Toned Milk',
        quantity,
        status: 'added',
        verification: {
          outcome: 'verified_success',
          unrelatedCartPreserved: true,
        },
      });
      expect(driver.upsertVisibleCartItem)
        .toHaveBeenCalledWith(
          offers[0],
          quantity,
          expect.objectContaining({
            onVerificationStarted: expect.any(Function),
          }),
        );
    },
  );

  it('asks for a choice on a broad add without mutating the cart', async () => {
    const driver = fakeDriver();
    const service = serviceFor(driver).service;

    await expect(service.addCartItem({
      quantity: 1,
      request: 'Amul Taaza doodh',
    })).resolves.toMatchObject({
      ok: false,
      options: expect.arrayContaining([
        expect.objectContaining({ offerId: 'offer_500', size: '500 ml' }),
        expect.objectContaining({ offerId: 'offer_1l', size: '1 l' }),
      ]),
      status: 'needs_clarification',
    });
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).not.toHaveBeenCalled();
    expect(driver.upsertCartItem).not.toHaveBeenCalled();
  });

  it('searches once before delegating cart preservation and mutation for an exact add', async () => {
    const calls: string[] = [];
    const before = cartReview([]);
    const after = cartReview([
      cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 28),
    ], 'b'.repeat(64));
    const driver = fakeDriver({
      search: vi.fn(async () => {
        calls.push('search');
        return offers;
      }),
      upsertVisibleCartItem: vi.fn(async () => {
        calls.push('mutate');
        return { before, cart: after, changed: true };
      }),
    });
    const service = serviceFor(driver).service;

    await expect(service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      request: 'Amul Taaza Toned Milk 500 ml',
    })).resolves.toMatchObject({
      ok: true,
      status: 'added',
    });
    expect(calls).toEqual(['search', 'mutate']);
  });

  it('uses the selected visible offer without discovery or a pre-add cart inspection', async () => {
    const existing = cartReview([
      cartLine('cart-milk', 'Amul Taaza Toned Milk', 2, 28),
    ]);
    const driver = fakeDriver({
      upsertVisibleCartItem: vi.fn(async () => ({
        cart: existing,
        changed: true,
      })),
    });

    await expect(serviceFor(driver).service.addCartItem({
      offerId: 'offer_500',
      quantity: 2,
      request: 'Amul Taaza Toned Milk',
      selectedOffer: {
        offerId: 'offer_500',
        packSize: '500 ml',
        priceAmount: 28,
        priceCurrency: 'INR',
        title: 'Amul Taaza Toned Milk',
      },
    })).resolves.toMatchObject({
      ok: true,
      quantity: 2,
      status: 'added',
    });
    expect(driver.search).not.toHaveBeenCalled();
    expect(driver.inspectCart).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).toHaveBeenCalledWith(
      offers[0],
      2,
      expect.objectContaining({
        onVerificationStarted: expect.any(Function),
      }),
    );
    expect(driver.upsertCartItem).not.toHaveBeenCalled();
  });

  it('reconciles an already-visible add acknowledgment without mutating again', async () => {
    const existing = cartReview([
      cartLine('cart-milk', 'Amul Taaza Toned Milk', 1, 28),
    ]);
    const driver = fakeDriver({
      inspectCart: vi.fn(async () => existing),
    });

    await expect(serviceFor(driver).service.addCartItem({
      offerId: 'offer_500',
      quantity: 1,
      reconcileOnly: true,
      request: 'Amul Taaza Toned Milk',
      selectedOffer: {
        offerId: 'offer_500',
        packSize: '500 ml',
        priceAmount: 28,
        priceCurrency: 'INR',
        title: 'Amul Taaza Toned Milk',
      },
    })).resolves.toMatchObject({
      ok: true,
      product: 'Amul Taaza Toned Milk',
      quantity: 1,
      status: 'already_in_cart',
    });
    expect(driver.inspectCart).toHaveBeenCalledOnce();
    expect(driver.search).not.toHaveBeenCalled();
    expect(driver.upsertVisibleCartItem).not.toHaveBeenCalled();
    expect(driver.upsertCartItem).not.toHaveBeenCalled();
  });

  it('updates and removes only the exact requested cart line', async () => {
    const before = cartReview([
      cartLine('target', 'Milk', 1, 28),
      cartLine('other', 'Bread', 1, 40),
    ]);
    const quantityAfter = cartReview([
      cartLine('target', 'Milk', 3, 28),
      cartLine('other', 'Bread', 1, 40),
    ], 'b'.repeat(64));
    const quantityDriver = fakeDriver({
      inspectCart: vi.fn(async () => before),
      setExistingCartItemQuantity: vi.fn(async () => quantityAfter),
    });

    await expect(
      serviceFor(quantityDriver).service.setCartItemQuantity('target', 3),
    ).resolves.toMatchObject({
      ok: true,
      productId: 'target',
      quantity: 3,
      status: 'quantity_updated',
    });
    expect(quantityDriver.setExistingCartItemQuantity)
      .toHaveBeenCalledWith('target', 3);

    const removalAfter = cartReview([
      cartLine('other', 'Bread', 1, 40),
    ], 'c'.repeat(64));
    const removalDriver = fakeDriver({
      inspectCart: vi.fn(async () => before),
      removeExistingCartItem: vi.fn(async () => removalAfter),
    });

    await expect(
      serviceFor(removalDriver).service.removeCartItem('target'),
    ).resolves.toMatchObject({
      ok: true,
      productId: 'target',
      status: 'removed',
    });
    expect(removalDriver.removeExistingCartItem)
      .toHaveBeenCalledWith('target');
  });

  it('rejects quantity and removal results that alter another cart line', async () => {
    const before = cartReview([
      cartLine('target', 'Milk', 1, 28),
      cartLine('other', 'Bread', 1, 40),
    ]);
    const changedAfter = cartReview([
      cartLine('target', 'Milk', 2, 28),
      cartLine('other', 'Bread', 2, 40),
    ], 'b'.repeat(64));
    const quantityService = serviceFor(fakeDriver({
      inspectCart: vi.fn(async () => before),
      setExistingCartItemQuantity: vi.fn(async () => changedAfter),
    })).service;
    await expect(quantityService.setCartItemQuantity('target', 2))
      .resolves.toMatchObject({
        failure: { reason: 'verification_failed', stage: 'verification' },
      });

    const changedRemoval = cartReview([
      cartLine('other', 'Bread', 2, 40),
    ], 'c'.repeat(64));
    const removalService = serviceFor(fakeDriver({
      inspectCart: vi.fn(async () => before),
      removeExistingCartItem: vi.fn(async () => changedRemoval),
    })).service;
    await expect(removalService.removeCartItem('target'))
      .resolves.toMatchObject({
        failure: { reason: 'verification_failed', stage: 'verification' },
      });
  });
});
