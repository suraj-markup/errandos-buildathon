import { describe, expect, it, vi } from 'vitest';
import type {
  PhoneActionArguments,
  PhoneActionExecutionContext,
} from '../phone-tool';
import {
  realtimePhoneToolDefinitions,
  SafeRealtimePhoneToolAdapter,
  SafeRealtimeToolError,
} from './safe-phone-tools';

const taskId = 'task_12345678-1234-1234-1234-123456789abc';
const itemId = 'task_item_12345678-1234-1234-1234-123456789abc';
const binding = { itemId, taskId, version: 1 as const };

function call(
  name: string,
  arguments_: Record<string, unknown>,
  callId = 'call_12345678',
) {
  return {
    arguments: JSON.stringify(arguments_),
    callId,
    name,
    version: 1 as const,
  };
}

describe('safe Realtime phone tool adapter', () => {
  it('publishes no tools in shadow mode and only narrow read tools initially', () => {
    expect(realtimePhoneToolDefinitions('none')).toEqual([]);
    expect(realtimePhoneToolDefinitions('read_only').map(({ name }) => name))
      .toEqual(['inspect_cart', 'search_products']);
    expect(realtimePhoneToolDefinitions('reversible_cart').map(({ name }) => name))
      .not.toContain('confirm_checkout');
  });

  it('validates and binds read-only calls to the shared phone executor', async () => {
    const execute = vi.fn(async () => ({ ok: true, status: 'cart_empty' }));
    const adapter = new SafeRealtimePhoneToolAdapter({
      capability: 'read_only',
      execute,
      queueTimeoutMs: 123,
      deviceTimeoutMs: 456,
    });

    const result = await adapter.execute(call('inspect_cart', {}), binding);

    expect(result).toMatchObject({
      authority: 'local_phone_adapter',
      callId: 'call_12345678',
      replayed: false,
      status: 'completed',
      toolName: 'inspect_cart',
    });
    expect(result.operationId).toMatch(/^operation_/);
    expect(execute).toHaveBeenCalledWith(
      { action: 'inspect_cart' },
      expect.objectContaining({
        operationId: result.operationId,
        taskId,
        itemId,
        queueTimeoutMs: 123,
        deviceTimeoutMs: 456,
      }),
    );
  });

  it('authorizes an exact offer against authoritative state before execution', async () => {
    const execute = vi.fn(async (
      _action: PhoneActionArguments,
      _context: PhoneActionExecutionContext,
    ) => ({ ok: true, status: 'added' }));
    const authorize = vi.fn(({ action }) => ({
      ...action,
      selectedOffer: {
        offerId: 'offer_1',
        title: 'Amul Taaza Toned Milk',
        packSize: '500 ml',
        priceAmount: 29,
        priceCurrency: 'INR',
      },
    }));
    const adapter = new SafeRealtimePhoneToolAdapter({
      authorize,
      capability: 'reversible_cart',
      execute,
    });

    await adapter.execute(call('add_cart_item', {
      offerId: 'offer_1',
      quantity: 1,
      request: 'Amul Taaza Toned Milk',
    }), binding);

    expect(authorize).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0]).toMatchObject({
      action: 'add_cart_item',
      offerId: 'offer_1',
      selectedOffer: { offerId: 'offer_1', packSize: '500 ml' },
    });
  });

  it('deduplicates an in-flight call and prevents reconnect replay', async () => {
    let resolveExecution!: (value: unknown) => void;
    const execute = vi.fn(() => new Promise((resolve) => {
      resolveExecution = resolve;
    }));
    const adapter = new SafeRealtimePhoneToolAdapter({
      capability: 'reversible_cart',
      execute,
    });
    const toolCall = call('add_cart_item', {
      offerId: 'offer_1',
      quantity: 1,
      request: 'milk',
    });

    const first = adapter.execute(toolCall, binding);
    const duplicate = adapter.execute(toolCall, binding);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    resolveExecution({ ok: true, status: 'added' });

    await expect(first).resolves.toMatchObject({ replayed: false });
    await expect(duplicate).resolves.toMatchObject({ replayed: true });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects schema errors, obsolete tasks, and reused call IDs', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const adapter = new SafeRealtimePhoneToolAdapter({
      capability: 'reversible_cart',
      execute,
      isCurrentTask: ({ taskId: candidate }) => candidate === taskId,
    });
    await expect(adapter.execute(
      call('add_cart_item', { request: 'milk', quantity: 0 }),
      binding,
    )).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(adapter.execute(
      call('inspect_cart', { unexpected: true }, 'call_unknown12'),
      binding,
    )).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(adapter.execute(
      call('inspect_cart', {}, 'call_obsolete1'),
      {
        taskId: 'task_87654321-1234-1234-1234-123456789abc',
        version: 1,
      },
    )).rejects.toMatchObject({ code: 'obsolete_task' });

    await adapter.execute(call('inspect_cart', {}), binding);
    await expect(adapter.execute(
      call('search_products', { request: 'milk' }),
      binding,
    )).rejects.toMatchObject({ code: 'call_id_reused' });
  });

  it('keeps final order dispatch unavailable in every capability', async () => {
    const adapter = new SafeRealtimePhoneToolAdapter({
      capability: 'broader',
      execute: vi.fn(),
    });

    await expect(adapter.execute(
      call('confirm_checkout', {}),
      binding,
    )).rejects.toEqual(expect.objectContaining<Partial<SafeRealtimeToolError>>({
      code: 'final_dispatch_forbidden',
    }));
  });

  it('returns a structured function output tied to the local operation', async () => {
    const adapter = new SafeRealtimePhoneToolAdapter({
      capability: 'read_only',
      execute: vi.fn(async () => ({
        ok: true,
        status: 'cart_empty',
        screenEvidence: { bounds: [1, 2, 3, 4] },
        addressLabel: 'private address',
        paymentMode: 'private payment',
      })),
    });
    const result = await adapter.execute(call('inspect_cart', {}), binding);
    const event = adapter.functionCallOutput(result);
    const output = JSON.parse(
      (event['item'] as { output: string }).output,
    ) as Record<string, unknown>;

    expect(event).toMatchObject({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call_12345678',
      },
    });
    expect(output).toMatchObject({
      authority: 'local_phone_adapter',
      operationId: result.operationId,
      status: 'completed',
      toolName: 'inspect_cart',
    });
    expect(JSON.stringify(output)).not.toMatch(
      /screenEvidence|bounds|addressLabel|paymentMode|private address/i,
    );
  });
});
