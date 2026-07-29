import { describe, expect, it } from 'vitest';
import {
  canonicalPhoneCommandsV2,
  parseDirectPhoneTask,
  parsePhoneToolCommand,
  PhoneCommandValidationError,
} from './phone-command';
import { realtimePhoneToolDefinitions } from './realtime/safe-phone-tools';

describe('phone command validation', () => {
  it('keeps read-only product search separate from cart mutation', () => {
    expect(parsePhoneToolCommand(
      'search_products',
      JSON.stringify({ request: 'Amul milk' }),
    )).toEqual({
      action: 'search_products',
      request: 'Amul milk',
    });
  });

  it('requires an explicit valid quantity for cart additions', () => {
    expect(parsePhoneToolCommand(
      'add_cart_item',
      JSON.stringify({
        request: 'Amul Taaza 500 ml',
        offerId: 'offer_500',
        quantity: 2,
      }),
    )).toEqual({
      action: 'add_cart_item',
      request: 'Amul Taaza 500 ml',
      offerId: 'offer_500',
      quantity: 2,
    });

    expect(() => parsePhoneToolCommand(
      'add_cart_item',
      JSON.stringify({ request: 'Amul Taaza', offerId: null }),
    )).toThrow(PhoneCommandValidationError);
    expect(() => parsePhoneToolCommand(
      'add_cart_item',
      JSON.stringify({ request: 'Amul Taaza', offerId: null, quantity: 0 }),
    )).toThrow('quantity must be a whole number');
  });

  it('requires an exact cart product ID for quantity changes and removal', () => {
    expect(parsePhoneToolCommand(
      'set_cart_item_quantity',
      JSON.stringify({ productId: 'cart_exact', quantity: 3 }),
    )).toEqual({
      action: 'set_cart_item_quantity',
      productId: 'cart_exact',
      quantity: 3,
    });
    expect(parsePhoneToolCommand(
      'remove_cart_item',
      JSON.stringify({ productId: 'cart_exact' }),
    )).toEqual({
      action: 'remove_cart_item',
      productId: 'cart_exact',
    });
    expect(() => parsePhoneToolCommand(
      'remove_cart_item',
      JSON.stringify({ productId: '' }),
    )).toThrow('productId must be an exact cart product ID');
  });

  it('rejects malformed and unsupported commands', () => {
    expect(() => parsePhoneToolCommand('search_products', '{'))
      .toThrow('not valid JSON');
    expect(() => parsePhoneToolCommand('delete_everything', '{}'))
      .toThrow('Unsupported phone command');
  });

  it('keeps final actions outside the direct Realtime task bridge', () => {
    expect(() => parseDirectPhoneTask({
      action: 'confirm_checkout',
      expectedFingerprint: 'fingerprint',
    })).toThrow('direct phone task is not supported');
  });

  it('accepts only canonical checkout commands', () => {
    expect(parsePhoneToolCommand(
      'prepare_checkout',
      '{}',
      { protocolVersion: 2 },
    ))
      .toEqual({ action: 'prepare_checkout' });
    expect(parsePhoneToolCommand(
      'confirm_checkout',
      '{}',
      { protocolVersion: 2 },
    ))
      .toEqual({ action: 'confirm_checkout' });
  });

  it('rejects unsupported protocol versions', () => {
    expect(() => parsePhoneToolCommand(
      'inspect_cart',
      '{}',
      { protocolVersion: 3 as 2 },
    )).toThrow('Unsupported phone command protocol version: 3');
  });

  it('validates cancellation against the current task identity', () => {
    const taskId = 'task_12345678-1234-1234-1234-123456789abc';
    expect(parsePhoneToolCommand(
      'cancel_current_task',
      JSON.stringify({ taskId }),
    )).toEqual({
      action: 'cancel_current_task',
      taskId,
    });
    expect(parseDirectPhoneTask({
      action: 'cancel_current_task',
      taskId,
    })).toEqual({
      action: 'cancel_current_task',
      taskId,
    });
    expect(() => parseDirectPhoneTask({
      action: 'cancel_current_task',
      taskId: 'task_wrong',
    })).toThrow('taskId must identify the current local phone task');
  });

  it('allows only read-only cart and search operations through the direct canary bridge', () => {
    expect(parseDirectPhoneTask({ action: 'inspect_cart' }))
      .toEqual({ action: 'inspect_cart' });
    expect(parseDirectPhoneTask({
      action: 'search_products',
      request: 'Lays',
    })).toEqual({
      action: 'search_products',
      request: 'Lays',
    });
  });

  it('proves the Realtime surface uses only canonical V2 names', () => {
    const realtimeNames = realtimePhoneToolDefinitions('broader')
      .map(({ name }) => name);
    expect(realtimeNames.every((name) =>
      canonicalPhoneCommandsV2.includes(
        name as (typeof canonicalPhoneCommandsV2)[number],
      ))).toBe(true);
  });
});
