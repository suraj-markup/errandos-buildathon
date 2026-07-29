import { describe, expect, it } from 'vitest';
import type { PresentableToolResult } from '../../../../lib/voice-presentation';
import { presentationResultForDeviceTask } from './route';

const cartResult = (): PresentableToolResult => ({
  cart: {
    addressLabel: 'Home',
    lines: [{
      productId: 'milk-500',
      product: 'Amul Taaza Toned Milk',
      quantity: 2,
      price: '₹28',
    }],
    subtotal: '₹56',
  },
  status: 'cart_status',
});

describe('device task presentation proof boundary', () => {
  it('attests only a direct inspect_cart result', () => {
    expect(presentationResultForDeviceTask(
      'inspect_cart',
      cartResult(),
    ).cart).toMatchObject({
      ordered: false,
      verified: true,
    });

    expect(presentationResultForDeviceTask(
      'add_cart_item',
      cartResult(),
    ).cart).not.toHaveProperty('verified');
  });

  it('does not override explicit negative cart proof', () => {
    const result = cartResult();
    result.cart = {
      ...result.cart,
      verified: false,
    };

    expect(presentationResultForDeviceTask(
      'inspect_cart',
      result,
    ).cart).toMatchObject({
      verified: false,
    });
    expect(presentationResultForDeviceTask(
      'inspect_cart',
      result,
    ).cart).not.toHaveProperty('ordered');
  });
});
