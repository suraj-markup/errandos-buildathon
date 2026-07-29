import { describe, expect, it, vi } from 'vitest';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
} from './control-session';
import {
  SafeRealtimePhoneToolAdapter,
} from './safe-phone-tools';
import { RealtimeSafeToolBridge } from './tool-bridge';

const binding = {
  itemId: 'task_item_12345678-1234-1234-1234-123456789abc',
  taskId: 'task_12345678-1234-1234-1234-123456789abc',
  version: 1 as const,
};

function done(
  name: string,
  arguments_: Record<string, unknown>,
  callId = 'call_12345678',
): RealtimeServerEvent {
  return {
    type: 'response.done',
    response: {
      output: [{
        type: 'function_call',
        name,
        call_id: callId,
        arguments: JSON.stringify(arguments_),
      }],
    },
  };
}

describe('Realtime safe tool bridge', () => {
  it('routes complete calls through the safe adapter and returns structured output', async () => {
    const send = vi.fn(async (_event: RealtimeClientEvent) => undefined);
    const execute = vi.fn(async () => ({ ok: true, status: 'cart_empty' }));
    const tools = new SafeRealtimePhoneToolAdapter({
      capability: 'read_only',
      execute,
    });
    const bridge = new RealtimeSafeToolBridge({ send }, tools);

    const result = await bridge.handleResponseDone({
      binding,
      event: done('inspect_cart', {}),
    });

    expect(result).toMatchObject({
      rejected: [],
      responseRequested: true,
      version: 1,
    });
    expect(result.executed).toHaveLength(1);
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_12345678',
        }),
      }),
    );
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'response.create',
      response: { output_modalities: ['text'] },
    });
  });

  it('returns schema rejection without executing a phone action', async () => {
    const send = vi.fn(async (_event: RealtimeClientEvent) => undefined);
    const execute = vi.fn();
    const tools = new SafeRealtimePhoneToolAdapter({
      capability: 'reversible_cart',
      execute,
    });
    const bridge = new RealtimeSafeToolBridge({ send }, tools);

    const result = await bridge.handleResponseDone({
      binding,
      event: done('add_cart_item', {
        offerId: 'offer_1',
        quantity: 0,
        request: 'milk',
      }),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.rejected).toEqual([{
      callId: 'call_12345678',
      code: 'invalid_arguments',
      toolName: 'add_cart_item',
    }]);
    expect(send.mock.calls[0]![0]).toMatchObject({
      item: { type: 'function_call_output', call_id: 'call_12345678' },
    });
  });

  it('does not request irrelevant model follow-up after deterministic terminal output', async () => {
    const send = vi.fn(async (_event: RealtimeClientEvent) => undefined);
    const tools = new SafeRealtimePhoneToolAdapter({
      capability: 'read_only',
      execute: vi.fn(async () => ({ ok: true, status: 'cart_empty' })),
    });
    const bridge = new RealtimeSafeToolBridge({ send }, tools);

    const result = await bridge.handleResponseDone({
      binding,
      continueAfterResult: () => false,
      event: done('inspect_cart', {}),
    });

    expect(result.responseRequested).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps final order dispatch unavailable and returns a local error code', async () => {
    const send = vi.fn(async (_event: RealtimeClientEvent) => undefined);
    const execute = vi.fn();
    const tools = new SafeRealtimePhoneToolAdapter({
      capability: 'broader',
      execute,
    });
    const bridge = new RealtimeSafeToolBridge({ send }, tools);

    const result = await bridge.handleResponseDone({
      binding,
      event: done('confirm_checkout', {}),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result.rejected[0]).toMatchObject({
      code: 'final_dispatch_forbidden',
    });
  });
});
