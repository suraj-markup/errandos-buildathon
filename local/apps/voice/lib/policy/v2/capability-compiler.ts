import { capabilityCatalogV2 } from './capability-catalog';
import type {
  CapabilityCompilerInputV2,
  CapabilityDescriptorV2,
  PhoneCapabilityV2,
} from './types';

const alwaysAvailable = new Set<PhoneCapabilityV2>([
  'ask_user',
  'cancel_task',
  'observe',
  'patch_plan',
]);

const readOnlyRecovery = new Set<PhoneCapabilityV2>([
  'ask_user',
  'cancel_task',
  'inspect_cart',
  'observe',
  'reconcile_operation',
  'wait_for_change',
]);

const checkoutCapabilities = new Set<PhoneCapabilityV2>([
  'ask_user',
  'back',
  'cancel_task',
  'inspect_cart',
  'observe',
  'patch_plan',
  'prepare_checkout',
  'select_payment_method',
  'wait_for_change',
]);

const cartModificationCapabilities = new Set<PhoneCapabilityV2>([
  'ask_user',
  'cancel_task',
  'inspect_cart',
  'observe',
  'patch_plan',
  'remove_cart_item',
  'set_cart_item_quantity',
  'wait_for_change',
]);

const generalCapabilities = new Set<PhoneCapabilityV2>([
  ...alwaysAvailable,
  'activate',
  'back',
  'clear_text',
  'home',
  'launch_app',
  'scroll',
  'set_text',
  'wait_for_change',
]);

function desiredCapabilities(
  input: CapabilityCompilerInputV2,
): Set<PhoneCapabilityV2> {
  if (input.unresolvedMutation) return readOnlyRecovery;

  if (input.pendingInteraction === 'product_choice') {
    return new Set([
      'ask_user',
      'cancel_task',
      'observe',
      'patch_plan',
      'select_product',
    ]);
  }
  if (input.pendingInteraction === 'checkout_confirmation') {
    return new Set([
      'ask_user',
      'cancel_task',
      'confirm_order',
      'inspect_cart',
      'observe',
      'patch_plan',
    ]);
  }
  if (input.pendingInteraction === 'payment_choice') {
    return new Set([
      'ask_user',
      'cancel_task',
      'inspect_cart',
      'observe',
      'patch_plan',
      'select_payment_method',
    ]);
  }

  switch (input.turnIntent) {
    case 'add_product':
      return new Set([
        ...alwaysAvailable,
        'add_cart_item',
        'inspect_cart',
        'search_products',
      ]);
    case 'modify_cart':
      return cartModificationCapabilities;
    case 'checkout':
      return input.explicitProductChange
        ? new Set([...checkoutCapabilities, 'search_products'])
        : checkoutCapabilities;
    case 'confirm_order':
      return new Set([
        'ask_user',
        'cancel_task',
        'inspect_cart',
        'observe',
      ]);
    case 'product_choice':
      return new Set([...alwaysAvailable, 'select_product']);
    case 'cancel':
      return new Set(['ask_user', 'cancel_task']);
    case 'observe':
      return new Set([
        'ask_user',
        'observe',
        'search_products',
        'wait_for_change',
      ]);
    case 'general':
      return generalCapabilities;
  }
}

export function compileCapabilitiesV2(
  input: CapabilityCompilerInputV2,
): CapabilityDescriptorV2[] {
  if (['cancelled', 'completed'].includes(input.taskStatus)) {
    const terminalCapabilities: readonly PhoneCapabilityV2[] = [
      'ask_user',
      'observe',
      'patch_plan',
    ];
    return terminalCapabilities
      .filter((capability) => input.adapterCapabilities.includes(capability))
      .map((capability) => capabilityCatalogV2[capability]);
  }

  const desired = desiredCapabilities(input);
  return input.adapterCapabilities
    .filter((capability) => desired.has(capability))
    .map((capability) => capabilityCatalogV2[capability]);
}
