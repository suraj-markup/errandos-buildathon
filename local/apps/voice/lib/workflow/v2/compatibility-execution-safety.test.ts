import { describe, expect, it, vi } from 'vitest';
import {
  newLocalIdentifier,
  parseLocalIdentifier,
} from '../identifiers';
import { CompatibilityExecutionSafetyV2 } from './compatibility-execution-safety';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const itemId = parseLocalIdentifier(
  'task_item',
  'task_item_12345678-1234-1234-1234-123456789abc',
);

function context(callId: string, taskRevision = 1) {
  return {
    callId,
    itemId,
    operationId: newLocalIdentifier('operation'),
    stepKey: 'item:milk:set-quantity',
    taskId,
    taskRevision,
  };
}

function cartInspection(quantity: number) {
  return quantity === 0
    ? { ok: true, status: 'cart_empty' }
    : {
        ok: true,
        status: 'cart_status',
        cart: {
          lines: [{
            productId: 'offer-milk',
            quantity,
          }],
        },
      };
}

describe('V2 compatibility execution safety', () => {
  it('suppresses semantic duplicate mutations and advances only once', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 100 });
    let quantity = 0;
    const execute = vi.fn(async (action: { quantity?: number }) => {
      quantity = action.quantity ?? quantity;
      return {
        ok: true,
        status: 'added',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });
    const inspectCart = vi.fn(async () => cartInspection(quantity));
    const action = {
      action: 'add_cart_item',
      offerId: 'offer-milk',
      quantity: 2,
      request: 'milk',
    } as const;

    const first = await safety.execute({
      action,
      context: context('model-call-1'),
      execute,
      inspectCart,
    });
    const duplicate = await safety.execute({
      action,
      context: context('model-call-2'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      offerId: 'offer-milk',
      quantity: 2,
    }));
    expect(first).toMatchObject({
      status: 'added',
      executionTruthV2: { action: 'advance' },
    });
    expect(duplicate).toMatchObject({
      status: 'duplicate_suppressed',
      executionTruthV2: { action: 'completed' },
      verification: { outcome: 'duplicate_suppressed' },
    });
  });

  it('binds an exact selected offer to the provider cart line identity', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 150 });
    let quantity = 0;
    const execute = vi.fn(async (action: { quantity?: number }) => {
      quantity = action.quantity ?? quantity;
      return {
        ok: true,
        status: 'added',
        product: 'Amul Taaza Toned Milk',
        price: '₹29.00',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });
    const inspectCart = vi.fn(async () => quantity === 0
      ? { ok: true, status: 'cart_empty' }
      : {
          ok: true,
          status: 'cart_status',
          cart: {
            lines: [{
              productId: 'cart-provider-line-id',
              product: 'Amul Taaza Toned Milk',
              price: '₹29.00',
              quantity,
            }],
          },
        });

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'offer-search-result-id',
        quantity: 1,
        request: 'Amul Taaza Toned Milk',
        selectedOffer: {
          offerId: 'offer-search-result-id',
          priceAmount: 29,
          title: 'Amul Taaza Toned Milk',
        },
      },
      context: context('model-call-provider-identity'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      status: 'added',
      executionTruthV2: { action: 'advance' },
      verification: { outcome: 'verified_success' },
    });
  });

  it('reconciles Potato (Alugadde) to the Blinkit Potato cart line with one mutation', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 175 });
    let quantity = 0;
    const execute = vi.fn(async (action: { quantity?: number }) => {
      quantity = action.quantity ?? quantity;
      return {
        ok: true,
        status: 'added',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });
    const inspectCart = vi.fn(async () => quantity === 0
      ? { ok: true, status: 'cart_empty' }
      : {
          ok: true,
          status: 'cart_status',
          cart: {
            lines: [{
              productId: 'blinkit-cart-potato-line',
              product: 'Potato',
              price: '₹27.00',
              quantity,
            }],
          },
        });

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'blinkit-search-potato-1kg',
        quantity: 1,
        request: 'one kilo potato',
        selectedOffer: {
          offerId: 'blinkit-search-potato-1kg',
          packSize: '1 kg',
          priceAmount: 27,
          priceCurrency: 'INR',
          title: 'Potato (Alugadde)',
        },
      },
      context: context('model-call-provider-alias'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      offerId: 'blinkit-search-potato-1kg',
      quantity: 1,
    }));
    expect(inspectCart).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      offerId: 'blinkit-search-potato-1kg',
      quantity: 1,
      status: 'added',
      executionTruthV2: { action: 'advance' },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    });
  });

  it('honors explicit provider evidence that no physical mutation was attempted', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 180 });
    const execute = vi.fn(async () => ({
      ok: false,
      status: 'reselection_required',
      verification: {
        mutationAttempted: false,
        outcome: 'failed_before_mutation',
        reconciliation: 'not_run',
      },
    }));
    const inspectCart = vi.fn(async () => cartInspection(0));

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'stale-offer',
        quantity: 1,
        request: 'milk',
      },
      context: context('model-call-stale-offer'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(inspectCart).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'retry_allowed',
      verification: {
        mutationAttempted: false,
      },
    });
  });

  it('reuses retained provider post-cart evidence without another inspection', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 190 });
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'added',
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
        postCart: cartInspection(1),
        reconciliation: 'verified',
      },
    }));
    const inspectCart = vi.fn(async () => cartInspection(0));

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'offer-milk',
        quantity: 1,
        request: 'milk',
      },
      context: context('model-call-retained-post-cart'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(inspectCart).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'added',
      executionTruthV2: { action: 'advance' },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    });
  });

  it('uses the requested quantity as an absolute desired state', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 200 });
    let quantity = 1;
    const execute = vi.fn(async (action: { quantity?: number }) => {
      quantity = action.quantity ?? quantity;
      return {
        ok: true,
        status: 'quantity_updated',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_success',
        },
      };
    });

    await safety.execute({
      action: {
        action: 'set_cart_item_quantity',
        productId: 'offer-milk',
        quantity: 3,
      },
      context: context('model-call-absolute'),
      execute,
      inspectCart: async () => cartInspection(quantity),
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({
      action: 'set_cart_item_quantity',
      productId: 'offer-milk',
      quantity: 3,
    });
    expect(quantity).toBe(3);
  });

  it('requires a new user-authorized operation after verified-not-applied', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 300 });
    let quantity = 0;
    let attempts = 0;
    const execute = vi.fn(async (action: { quantity?: number }) => {
      attempts += 1;
      if (attempts === 2) quantity = action.quantity ?? quantity;
      return {
        ok: attempts === 2,
        status: attempts === 2 ? 'added' : 'execution_failed',
        verification: {
          mutationAttempted: true,
          outcome: attempts === 2 ? 'verified_success' : 'ambiguous',
        },
      };
    });
    const inspectCart = vi.fn(async () => cartInspection(quantity));

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'offer-milk',
        quantity: 2,
        request: 'milk',
      },
      context: context('model-call-reconcile'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(inspectCart).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      status: 'retry_requires_user',
      executionTruthV2: {
        action: 'retry_requires_user',
        retryPolicy: 'explicit_user_retry_only',
      },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_not_applied',
      },
    });

    const explicitRetry = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'offer-milk',
        quantity: 2,
        request: 'milk',
      },
      context: {
        ...context('explicit-user-retry'),
        stepKey: 'item:milk:explicit-user-retry',
      },
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(explicitRetry).toMatchObject({
      ok: true,
      status: 'added',
      executionTruthV2: { action: 'advance' },
      verification: {
        mutationAttempted: true,
        outcome: 'verified_success',
      },
    });
  });

  it('does not offer explicit retry when post-mutation state is ambiguous', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 350 });
    let inspections = 0;
    const execute = vi.fn(async () => ({
      ok: false,
      status: 'execution_failed',
      verification: {
        mutationAttempted: true,
        outcome: 'ambiguous',
      },
    }));
    const inspectCart = vi.fn(async () => {
      inspections += 1;
      return cartInspection(inspections === 1 ? 0 : 1);
    });

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'offer-milk',
        quantity: 2,
        request: 'milk',
      },
      context: context('model-call-ambiguous'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      status: 'mutation_outcome_ambiguous',
      executionTruthV2: {
        action: 'stop',
        retryPolicy: 'stop_and_ask_user',
      },
      verification: {
        mutationAttempted: true,
        outcome: 'ambiguous',
      },
    });
    expect(result).not.toMatchObject({ status: 'retry_requires_user' });
  });

  it('stops on a non-unique provider identity instead of offering retry', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 375 });
    let mutationAttempted = false;
    const execute = vi.fn(async () => {
      mutationAttempted = true;
      return {
        ok: false,
        status: 'execution_failed',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_no_change',
        },
      };
    });
    const inspectCart = vi.fn(async () => mutationAttempted
      ? {
          ok: true,
          status: 'cart_status',
          cart: {
            lines: [
              {
                productId: 'cart-paneer-a',
                product: 'Amul Fresh Malai Paneer',
                packSize: '200 g',
                price: '₹105',
                quantity: 1,
              },
              {
                productId: 'cart-paneer-b',
                product: 'Amul Fresh Malai Paneer',
                packSize: '200 g',
                price: '₹105',
                quantity: 1,
              },
            ],
          },
        }
      : cartInspection(0));

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'search-paneer-200g',
        quantity: 1,
        request: 'paneer 200 g',
        selectedOffer: {
          offerId: 'search-paneer-200g',
          packSize: '200 g',
          priceAmount: 105,
          priceCurrency: 'INR',
          title: 'Amul Fresh Malai Paneer',
        },
      },
      context: context('model-call-non-unique'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      status: 'mutation_outcome_ambiguous',
      executionTruthV2: {
        action: 'stop',
        retryPolicy: 'stop_and_ask_user',
      },
      verification: {
        identityResolution: 'ambiguous',
        mutationAttempted: true,
        outcome: 'ambiguous',
      },
    });
    expect(result).not.toMatchObject({ status: 'retry_requires_user' });
  });

  it('retains expected and observed pack and price conflicts when stopping', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 390 });
    let mutationAttempted = false;
    const execute = vi.fn(async () => {
      mutationAttempted = true;
      return {
        ok: false,
        status: 'execution_failed',
        verification: {
          mutationAttempted: true,
          outcome: 'verified_no_change',
        },
      };
    });
    const inspectCart = vi.fn(async () => mutationAttempted
      ? {
          ok: true,
          status: 'cart_status',
          cart: {
            lines: [{
              productId: 'cart-paneer-250g',
              product: 'Amul Fresh Malai Paneer',
              packSize: '250 g',
              price: '₹120',
              quantity: 1,
            }],
          },
        }
      : cartInspection(0));

    const result = await safety.execute({
      action: {
        action: 'add_cart_item',
        offerId: 'search-paneer-200g',
        quantity: 1,
        request: 'paneer 200 g',
        selectedOffer: {
          offerId: 'search-paneer-200g',
          packSize: '200 g',
          priceAmount: 105,
          priceCurrency: 'INR',
          title: 'Amul Fresh Malai Paneer',
        },
      },
      context: context('model-call-term-conflict'),
      execute,
      inspectCart,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: 'mutation_outcome_ambiguous',
      verification: {
        identityResolution: 'ambiguous',
        conflicts: [
          {
            field: 'pack_size',
            expected: '200 g',
            observed: '250 g',
          },
          {
            field: 'price',
            expected: '₹105.00',
            observed: '₹120.00',
          },
        ],
      },
    });
    expect(result).not.toMatchObject({ status: 'retry_requires_user' });
  });

  it('stops and latches a repeated search/cart/back cycle', async () => {
    const safety = new CompatibilityExecutionSafetyV2({ now: () => 400 });
    const execute = vi.fn(async () => ({
      ok: true,
      status: 'unchanged',
    }));
    const actions = [
      'search_products',
      'inspect_cart',
      'open_blinkit',
      'search_products',
      'inspect_cart',
      'open_blinkit',
    ] as const;
    let result: unknown;

    for (const action of actions) {
      result = await safety.execute({
        action: { action },
        context: context(`loop-${action}`),
        execute,
        inspectCart: async () => cartInspection(0),
      });
    }

    expect(result).toMatchObject({
      ok: false,
      status: 'execution_loop_stopped',
      loop: {
        cycleLength: 3,
        reason: 'repeated_cycle',
      },
    });
    await expect(safety.execute({
      action: { action: 'search_products' },
      context: context('loop-latched'),
      execute,
      inspectCart: async () => cartInspection(0),
    })).resolves.toMatchObject({
      status: 'execution_loop_stopped',
      loop: { reason: 'previous_loop_stop' },
    });
    expect(execute).toHaveBeenCalledTimes(6);
  });
});
