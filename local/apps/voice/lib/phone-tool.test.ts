import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}));

import {
  executePhoneActionWithService,
  progressStageForResolvedOperation,
  type ReversibleBlinkitExecutionPort,
} from './phone-tool';
import type { PhoneOperationExecutionControl } from './operation-queue';
import { CartMutationExecutionTruthServiceV2 } from './execution/v2/cart-mutation-execution-truth';
import { FileOperationIdempotencyPersistenceV2 } from './execution/v2/file-idempotency-persistence';
import { OperationIdempotencyRegistryV2 } from './execution/v2/idempotency-records';
import { CompatibilityExecutionSafetyV2 } from './workflow/v2/compatibility-execution-safety';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  execFileMock.mockClear();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

function reversibleService(
  initialQuantities: readonly (readonly [string, number])[] = [],
) {
  const quantities = new Map<string, number>(initialQuantities);
  const cartResult = () => quantities.size === 0
    ? { ok: true, status: 'cart_empty' }
    : {
        ok: true,
        status: 'cart_status',
        cart: {
          lines: [...quantities].map(([productId, quantity]) => ({
            productId,
            quantity,
          })),
        },
      };
  return {
    addCartItem: vi.fn(async (input: {
      offerId?: string;
      quantity: number;
    }) => {
      if (input.offerId) quantities.set(input.offerId, input.quantity);
      return { ok: true, status: 'added' };
    }),
    confirmCheckout: vi.fn(async () => ({
      ok: false,
      status: 'final_dispatch_disabled',
    })),
    inspectCart: vi.fn(async () => cartResult()),
    prepareCheckout: vi.fn(async () => ({
      ok: false,
      status: 'confirmation_required',
    })),
    removeCartItem: vi.fn(async (productId: string) => {
      quantities.delete(productId);
      return { ok: true, status: 'removed' };
    }),
    searchProducts: vi.fn(async () => ({ ok: true, status: 'search_results' })),
    setCartItemQuantity: vi.fn(async (
      productId: string,
      quantity: number,
    ) => {
      quantities.set(productId, quantity);
      return {
        ok: true,
        status: 'quantity_updated',
      };
    }),
    quantities,
  };
}

function isolatedExecutionSafety(filePath?: string) {
  return new CompatibilityExecutionSafetyV2({
    truth: new CartMutationExecutionTruthServiceV2(
      new OperationIdempotencyRegistryV2({
        ...(filePath
          ? {
              persistence:
                new FileOperationIdempotencyPersistenceV2(filePath),
            }
          : {}),
      }),
    ),
  });
}

describe('reversible phone action routing', () => {
  it('keeps successful clarification operations waiting for the user', () => {
    expect(progressStageForResolvedOperation(
      { status: 'succeeded' },
      { status: 'search_results' },
    )).toBe('waiting_for_choice');
    expect(progressStageForResolvedOperation(
      { status: 'succeeded' },
      { status: 'confirmation_required' },
    )).toBe('waiting_for_choice');
    expect(progressStageForResolvedOperation(
      { status: 'succeeded' },
      { status: 'final_dispatch_disabled' },
    )).toBe('failed');
  });

  it('routes every reversible Blinkit action through one execution service', async () => {
    const service = reversibleService();
    const port = service as unknown as ReversibleBlinkitExecutionPort;

    await executePhoneActionWithService({ action: 'search_products', request: 'milk' }, port);
    await executePhoneActionWithService({ action: 'inspect_cart' }, port);
    await executePhoneActionWithService({
      action: 'add_cart_item',
      offerId: 'offer-milk',
      quantity: 2,
      request: 'milk',
      searchQuery: 'Amul milk',
    }, port);
    await executePhoneActionWithService({
      action: 'set_cart_item_quantity',
      productId: 'cart-milk',
      quantity: 3,
    }, port);
    await executePhoneActionWithService({
      action: 'remove_cart_item',
      productId: 'cart-milk',
    }, port);
    expect(service.searchProducts).toHaveBeenCalledWith(
      'milk',
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(service.inspectCart).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(service.addCartItem).toHaveBeenNthCalledWith(1, {
      offerId: 'offer-milk',
      quantity: 2,
      request: 'milk',
      searchQuery: 'Amul milk',
    }, expect.objectContaining({ operationId: expect.any(String) }));
    expect(service.setCartItemQuantity).toHaveBeenCalledWith(
      'cart-milk',
      3,
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(service.removeCartItem).toHaveBeenCalledWith(
      'cart-milk',
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('does not gate a fake phone action on injected overlay status telemetry', async () => {
    const service = reversibleService();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let releaseStatus: (() => void) | undefined;
    const statusMayFinish = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const overlayStatusPublisher = vi.fn()
      .mockImplementationOnce(async () => {
        await statusMayFinish;
        return true;
      })
      .mockRejectedValueOnce(new Error('telemetry transport unavailable'))
      .mockResolvedValueOnce(false);

    await expect(executePhoneActionWithService(
      { action: 'search_products', request: 'milk' },
      service as unknown as ReversibleBlinkitExecutionPort,
      { overlayStatusPublisher },
    )).resolves.toMatchObject({
      ok: true,
      status: 'search_results',
    });

    expect(overlayStatusPublisher).toHaveBeenCalledOnce();
    expect(execFileMock).not.toHaveBeenCalled();
    releaseStatus?.();
    await vi.waitFor(() => {
      expect(overlayStatusPublisher).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(warning.mock.calls.map(([line]) => String(line))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"event":"phone.overlay_status.failed"'),
          expect.stringContaining('"event":"phone.overlay_status.unavailable"'),
        ]),
      );
    });
  });

  it('bounds detached overlay telemetry and observes timeout failures', async () => {
    vi.useFakeTimers();
    try {
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      const overlayStatusPublisher = vi.fn(
        () => new Promise<boolean>(() => undefined),
      );

      await expect(executePhoneActionWithService(
        { action: 'search_products', request: 'milk' },
        reversibleService() as unknown as ReversibleBlinkitExecutionPort,
        { overlayStatusPublisher },
      )).resolves.toMatchObject({
        ok: true,
        status: 'search_results',
      });

      for (let statusIndex = 0; statusIndex < 3; statusIndex += 1) {
        await vi.advanceTimersByTimeAsync(1_500);
      }
      expect(overlayStatusPublisher).toHaveBeenCalledTimes(3);
      expect(warning.mock.calls.map(([line]) => String(line))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('"event":"phone.overlay_status.timed_out"'),
        ]),
      );
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses an equivalent cart mutation at the production phone boundary', async () => {
    const service = reversibleService();
    const port = service as unknown as ReversibleBlinkitExecutionPort;
    const executionContext = {
      taskId: 'task_11111111-1234-1234-1234-123456789abc',
      itemId: 'task_item_22222222-1234-1234-1234-123456789abc',
      stepKey: 'item:milk:add',
      taskRevision: 4,
    };
    const action = {
      action: 'add_cart_item' as const,
      offerId: 'offer-milk-boundary',
      quantity: 2,
      request: 'milk',
    };

    await expect(executePhoneActionWithService(
      action,
      port,
      { ...executionContext, callId: 'tool-call-first' },
    )).resolves.toMatchObject({
      ok: true,
      status: 'added',
      executionTruthV2: { action: 'advance' },
    });
    await expect(executePhoneActionWithService(
      action,
      port,
      { ...executionContext, callId: 'tool-call-duplicate' },
    )).resolves.toMatchObject({
      ok: true,
      status: 'duplicate_suppressed',
      executionTruthV2: { action: 'completed' },
    });

    expect(service.addCartItem).toHaveBeenCalledOnce();
  });

  it('executes canonical V2 add, set, and remove as absolute targets', async () => {
    const service = reversibleService([
      ['offer-add', 1],
      ['offer-set', 2],
      ['offer-remove', 4],
    ]);
    const port = service as unknown as ReversibleBlinkitExecutionPort;
    const safety = isolatedExecutionSafety();
    const taskId = 'task_33333333-1234-1234-1234-123456789abc';

    await expect(executePhoneActionWithService({
      action: 'add_cart_item',
      offerId: 'offer-add',
      quantity: 3,
      request: 'three milk',
    }, port, {
      callId: 'canonical-add',
      protocolVersion: 2,
      stepKey: 'item:add:absolute',
      taskId,
      taskRevision: 8,
    }, safety)).resolves.toMatchObject({
      ok: true,
      quantity: 3,
      status: 'added',
      executionTruthV2: { action: 'advance' },
    });
    await expect(executePhoneActionWithService({
      action: 'set_cart_item_quantity',
      productId: 'offer-set',
      quantity: 5,
    }, port, {
      callId: 'canonical-set',
      protocolVersion: 2,
      stepKey: 'item:set:absolute',
      taskId,
      taskRevision: 8,
    }, safety)).resolves.toMatchObject({
      ok: true,
      quantity: 5,
      status: 'quantity_updated',
      executionTruthV2: { action: 'advance' },
    });
    await expect(executePhoneActionWithService({
      action: 'remove_cart_item',
      productId: 'offer-remove',
    }, port, {
      callId: 'canonical-remove',
      protocolVersion: 2,
      stepKey: 'item:remove:absolute',
      taskId,
      taskRevision: 8,
    }, safety)).resolves.toMatchObject({
      ok: true,
      quantity: 0,
      status: 'removed',
      executionTruthV2: { action: 'advance' },
    });

    expect(service.addCartItem).toHaveBeenCalledWith(
      expect.objectContaining({
        offerId: 'offer-add',
        quantity: 3,
      }),
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(service.setCartItemQuantity).toHaveBeenCalledWith(
      'offer-set',
      5,
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect(service.removeCartItem).toHaveBeenCalledWith(
      'offer-remove',
      expect.objectContaining({ operationId: expect.any(String) }),
    );
    expect([...service.quantities]).toEqual([
      ['offer-add', 3],
      ['offer-set', 5],
    ]);
  });

  it('suppresses a semantic duplicate and advances only once after safety restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'errandos-phone-boundary-'));
    temporaryDirectories.push(directory);
    const filePath = join(
      directory,
      '.runtime',
      'cart-mutation-idempotency-v2.json',
    );
    const service = reversibleService();
    const port = service as unknown as ReversibleBlinkitExecutionPort;
    const action = {
      action: 'add_cart_item' as const,
      offerId: 'offer-restart',
      quantity: 2,
      request: 'milk',
    };
    const context = {
      protocolVersion: 2 as const,
      stepKey: 'item:restart:add',
      taskId: 'task_44444444-1234-1234-1234-123456789abc',
      taskRevision: 2,
    };

    await expect(executePhoneActionWithService(
      action,
      port,
      { ...context, callId: 'before-restart' },
      isolatedExecutionSafety(filePath),
    )).resolves.toMatchObject({
      status: 'added',
      executionTruthV2: { action: 'advance' },
    });
    await expect(executePhoneActionWithService(
      action,
      port,
      { ...context, callId: 'after-restart' },
      isolatedExecutionSafety(filePath),
    )).resolves.toMatchObject({
      status: 'duplicate_suppressed',
      executionTruthV2: { action: 'completed' },
      verification: { mutationAttempted: false },
    });

    expect(service.addCartItem).toHaveBeenCalledOnce();
  });

  it('requires a user retry after a fresh snapshot verifies no mutation', async () => {
    const service = reversibleService();
    let quantity = 0;
    let attempts = 0;
    const trace: string[] = [];
    service.inspectCart = vi.fn(async () => {
      trace.push(`inspect:${quantity}`);
      return quantity === 0
        ? { ok: true, status: 'cart_empty' }
        : {
            ok: true,
            status: 'cart_status',
            cart: {
              lines: [{ productId: 'offer-retry', quantity }],
            },
          };
    });
    service.addCartItem = vi.fn(async (input: {
      offerId?: string;
      quantity: number;
    }) => {
      attempts += 1;
      trace.push(`mutate:${input.quantity}`);
      return {
        ok: false,
        status: 'execution_failed',
        verification: {
          mutationAttempted: true,
          outcome: 'ambiguous',
        },
      };
    });

    await expect(executePhoneActionWithService({
      action: 'add_cart_item',
      offerId: 'offer-retry',
      quantity: 2,
      request: 'milk',
    }, service as unknown as ReversibleBlinkitExecutionPort, {
      callId: 'canonical-retry',
      protocolVersion: 2,
      stepKey: 'item:retry:add',
      taskId: 'task_55555555-1234-1234-1234-123456789abc',
      taskRevision: 3,
    }, isolatedExecutionSafety())).resolves.toMatchObject({
      ok: false,
      status: 'retry_requires_user',
      executionTruthV2: {
        action: 'retry_requires_user',
        retryPolicy: 'explicit_user_retry_only',
      },
    });

    expect(service.addCartItem).toHaveBeenCalledOnce();
    expect(service.inspectCart).toHaveBeenCalledTimes(2);
    expect(trace).toEqual([
      'inspect:0',
      'mutate:2',
      'inspect:0',
    ]);
  });

  it('latches a no-progress loop only for the current task revision', async () => {
    const service = reversibleService();
    service.searchProducts = vi.fn(async () => ({
      ok: true,
      status: 'unchanged',
    }));
    const port = service as unknown as ReversibleBlinkitExecutionPort;
    const safety = isolatedExecutionSafety();
    const taskId = 'task_66666666-1234-1234-1234-123456789abc';
    const executeSearch = (callId: string, taskRevision: number) =>
      executePhoneActionWithService({
        action: 'search_products',
        request: 'milk',
      }, port, {
        callId,
        protocolVersion: 2,
        taskId,
        taskRevision,
      }, safety);

    await expect(executeSearch('loop-1', 7)).resolves.toMatchObject({
      status: 'unchanged',
    });
    await expect(executeSearch('loop-2', 7)).resolves.toMatchObject({
      status: 'unchanged',
    });
    await expect(executeSearch('loop-3', 7)).resolves.toMatchObject({
      ok: false,
      status: 'execution_loop_stopped',
      loop: { reason: 'repeated_no_progress' },
    });
    await expect(executeSearch('loop-latched', 7)).resolves.toMatchObject({
      status: 'execution_loop_stopped',
      loop: {
        reason: 'previous_loop_stop',
        taskRevision: 7,
      },
    });
    expect(service.searchProducts).toHaveBeenCalledTimes(3);

    await expect(executeSearch('loop-new-revision', 8)).resolves.toMatchObject({
      ok: true,
      status: 'unchanged',
    });
    expect(service.searchProducts).toHaveBeenCalledTimes(4);
  });

  it('handles voice or card cancellation outside the serialized queue', async () => {
    const service = reversibleService();
    let searchStarted: (() => void) | undefined;
    let finishSearch: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      searchStarted = resolve;
    });
    const mayFinish = new Promise<void>((resolve) => {
      finishSearch = resolve;
    });
    const cancellingSearch = vi.fn(async (
      _request: string,
      control?: PhoneOperationExecutionControl,
    ) => {
      searchStarted?.();
      await mayFinish;
      control?.checkpoint('cancelled after provider step');
      return { ok: true, status: 'search_results' };
    });
    Object.assign(service, { searchProducts: cancellingSearch });
    const taskId = 'task_87654321-1234-1234-1234-123456789abc';
    const running = executePhoneActionWithService({
      action: 'search_products',
      request: 'milk',
    }, service as unknown as ReversibleBlinkitExecutionPort, { taskId });
    await started;

    await expect(executePhoneActionWithService({
      action: 'cancel_current_task',
      taskId,
    }, service as unknown as ReversibleBlinkitExecutionPort))
      .resolves.toMatchObject({
        ok: true,
        status: 'cancellation_requested',
        cancellationPolicy: 'cancel_now',
      });
    finishSearch?.();
    await expect(running).resolves.toMatchObject({
      ok: false,
      status: 'cancelled',
      operation: {
        taskId,
        status: 'cancelled',
      },
    });
    await expect(executePhoneActionWithService({
      action: 'cancel_current_task',
      taskId,
    }, service as unknown as ReversibleBlinkitExecutionPort))
      .resolves.toMatchObject({
        ok: true,
        status: 'already_cancelled',
      });
  });

  it('routes checkout through the unified service without prematurely marking dispatch', async () => {
    const service = reversibleService();
    const port = service as unknown as ReversibleBlinkitExecutionPort;

    await expect(executePhoneActionWithService(
      { action: 'prepare_checkout' },
      port,
    )).resolves.toMatchObject({
      status: 'confirmation_required',
      operation: {
        mutationBoundary: 'not_started',
        status: 'succeeded',
      },
    });
    await expect(executePhoneActionWithService(
      { action: 'confirm_checkout' },
      port,
    )).resolves.toMatchObject({
      status: 'final_dispatch_disabled',
      operation: {
        mutationBoundary: 'not_started',
        status: 'succeeded',
      },
    });
    expect(service.prepareCheckout).toHaveBeenCalledOnce();
    expect(service.confirmCheckout).toHaveBeenCalledOnce();
  });
});
