import { describe, expect, it } from 'vitest';
import { compileCapabilitiesV2 } from './capability-compiler';
import type {
  CapabilityCompilerInputV2,
  PhoneCapabilityV2,
} from './types';

const adapterCapabilities: PhoneCapabilityV2[] = [
  'activate',
  'add_cart_item',
  'ask_user',
  'back',
  'cancel_task',
  'confirm_order',
  'inspect_cart',
  'observe',
  'patch_plan',
  'prepare_checkout',
  'reconcile_operation',
  'remove_cart_item',
  'search_products',
  'select_payment_method',
  'select_product',
  'set_cart_item_quantity',
  'wait_for_change',
];

function input(
  override: Partial<CapabilityCompilerInputV2>,
): CapabilityCompilerInputV2 {
  return {
    adapterCapabilities,
    adapterId: 'blinkit',
    explicitProductChange: false,
    taskStatus: 'active',
    turnIntent: 'general',
    ...override,
  };
}

function names(
  value: ReturnType<typeof compileCapabilitiesV2>,
): PhoneCapabilityV2[] {
  return value.map((capability) => capability.capability);
}

describe('V2 capability compiler', () => {
  it('allows an explicit product add through the desired-state capability', () => {
    const result = names(compileCapabilitiesV2(input({
      explicitProductChange: true,
      turnIntent: 'add_product',
    })));

    expect(result).toContain('add_cart_item');
    expect(result).toContain('search_products');
  });

  it('does not expose completed cart mutations during a checkout-only turn', () => {
    const result = names(compileCapabilitiesV2(input({
      turnIntent: 'checkout',
    })));

    expect(result).toContain('inspect_cart');
    expect(result).toContain('prepare_checkout');
    expect(result).not.toContain('add_cart_item');
    expect(result).not.toContain('search_products');
  });

  it('allows read-only product discovery during an observe turn', () => {
    const result = names(compileCapabilitiesV2(input({
      turnIntent: 'observe',
    })));

    expect(result).toContain('search_products');
    expect(result).not.toContain('add_cart_item');
  });

  it('allows an explicit new product to patch a checkout continuation', () => {
    const result = names(compileCapabilitiesV2(input({
      explicitProductChange: true,
      turnIntent: 'checkout',
    })));

    expect(result).toContain('patch_plan');
    expect(result).toContain('search_products');
    expect(result).not.toContain('add_cart_item');
  });

  it('makes one product choice the only product-selection capability', () => {
    const result = names(compileCapabilitiesV2(input({
      pendingInteraction: 'product_choice',
      turnIntent: 'product_choice',
    })));

    expect(result).toContain('select_product');
    expect(result).not.toContain('search_products');
    expect(result).not.toContain('add_cart_item');
  });

  it('forces read-only reconciliation while a mutation is unresolved', () => {
    const result = names(compileCapabilitiesV2(input({
      turnIntent: 'add_product',
      unresolvedMutation: {
        operationId: 'operation-a',
        outcome: 'mutation_unverified',
      },
    })));

    expect(result).toContain('reconcile_operation');
    expect(result).toContain('inspect_cart');
    expect(result).not.toContain('add_cart_item');
    expect(result).not.toContain('search_products');
  });
});
