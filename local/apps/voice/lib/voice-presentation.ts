import type { AndroidCurrentScreenV1 } from '@errandos/contracts';
import { selectPrimarySurface } from './screen-presentation';
import {
  companionIssueForToolResultV2,
} from './progress/v2/companion-issue';

export type CurrentScreenEvidence = {
  observedAfterAction: true;
  screen: AndroidCurrentScreenV1;
};

type PresentableGroceryOption = {
  offerId?: string;
  price?: string;
  product?: string;
  size?: string;
  spokenLabel?: string;
};

type PresentableMoney = {
  amount: number;
  currency: 'INR';
};

export type PresentableToolResult = {
  cart?: {
    addressLabel?: string;
    ordered?: boolean;
    verified?: boolean;
    lines?: Array<{
      lineTotal?: PresentableMoney;
      name?: string;
      packSize?: string;
      price?: string;
      product?: string;
      productId?: string;
      quantity?: number;
      size?: string;
      spokenLabel?: string;
      unitPrice?: PresentableMoney;
    }>;
    subtotal?: PresentableMoney | string;
  };
  checkout?: {
    addressLabel?: string;
    total?: number;
  };
  confirmationPhrase?: string;
  failure?: {
    operation?: string;
    reason?: string;
    recoverable?: boolean;
    stage?: string;
  };
  message?: string;
  ok?: boolean;
  options?: PresentableGroceryOption[];
  price?: string;
  product?: string;
  providerReference?: string;
  quantity?: number | string;
  screenEvidence?: CurrentScreenEvidence;
  size?: string;
  speakPrice?: boolean;
  spokenLabel?: string;
  status?: string;
  verification?: {
    mutationAttempted?: boolean;
    outcome?: string;
    reconciliation?: string;
  };
};

const naturalList = (values: readonly string[]): string => {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} or ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
};

const naturalAndList = (values: readonly string[]): string => {
  if (values.length <= 1) return values[0] ?? '';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
};

const quantityNumber = (quantity: number | string | undefined): number | undefined => {
  if (typeof quantity === 'number' && Number.isInteger(quantity)) return quantity;
  if (typeof quantity !== 'string') return undefined;
  const parsed = Number(/\d+/.exec(quantity)?.[0]);
  return Number.isInteger(parsed) ? parsed : undefined;
};

const withSize = (option: PresentableGroceryOption): string => {
  const label = option.spokenLabel || option.product || 'that product';
  if (!option.size || label.toLocaleLowerCase('en-IN').includes(option.size.toLocaleLowerCase('en-IN'))) {
    return label;
  }
  return `${label}, ${option.size}`;
};

const choiceWithSize = (option: PresentableGroceryOption): string => {
  const label = option.spokenLabel || option.product || 'that product';
  if (!option.size || label.toLocaleLowerCase('en-IN').includes(option.size.toLocaleLowerCase('en-IN'))) {
    return label;
  }
  return `${label} ${option.size}`;
};

function productResultLabel(result: PresentableToolResult): string {
  return withSize({
    product: result.product,
    size: result.size,
    spokenLabel: result.spokenLabel,
  });
}

function currentScreenInstruction(result: PresentableToolResult): string | undefined {
  const decision = selectPrimarySurface({
    currentScreen: result.screenEvidence,
    result,
  });
  if (decision.primarySurface !== 'provider_screen') return undefined;

  switch (decision.currentScreen?.relevance) {
    case 'product_options':
      return 'Check the options on the current screen.';
    case 'product_detail':
      return 'You can see the product details on the current screen.';
    case 'cart_summary':
      return 'Check the cart on the current screen.';
    case 'checkout_summary':
      return 'Check the checkout summary on the current screen.';
    case 'payment_selection':
      return 'You can see the payment selection on the current screen.';
    case 'address_choices':
      return 'Check the saved address choices on the current screen.';
    case 'order_confirmation':
      return 'You can see Blinkit’s confirmation on the current screen.';
    case 'order_history':
      return 'Check the matching order in recent orders on the current screen.';
    case 'authentication':
      return 'Blinkit needs your attention on the current screen.';
    default:
      return undefined;
  }
}

function presentToolResultBase(result: PresentableToolResult | undefined): string {
  if (!result) return 'I could not complete that request.';
  const companionIssue = companionIssueForToolResultV2(result);

  if (
    ['needs_clarification', 'search_results'].includes(result.status ?? '')
      && result.options?.length
  ) {
    const labels = result.options.slice(0, 3).map(choiceWithSize);
    const remaining = result.options.length - labels.length;
    const suffix = remaining > 0
      ? ` I found ${remaining} more option${remaining === 1 ? '' : 's'}.`
      : '';
    if (result.status === 'search_results' && result.options.length === 1) {
      return `I found ${labels[0]}.${result.speakPrice && result.options[0]?.price ? ` It is ${result.options[0].price}.` : ''}`;
    }
    return `I found ${naturalList(labels)}. Which one do you want?${suffix}`;
  }

  if (result.status === 'add_confirmation_required') {
    return `You chose ${productResultLabel(result)}. Say “add it” to change the cart.`;
  }

  if (result.status === 'product_skipped') {
    return result.message?.trim() || 'Skipped that product.';
  }

  if (result.status === 'added') {
    const quantity = quantityNumber(result.quantity) ?? 1;
    const label = productResultLabel(result);
    return quantity > 1
      ? `Added ${quantity} of ${label}.`
      : `Added ${label}.`;
  }

  if (result.status === 'already_in_cart') {
    const quantity = quantityNumber(result.quantity) ?? 1;
    const label = productResultLabel(result);
    return quantity > 1
      ? `${label} is already in your cart at quantity ${quantity}.`
      : `${label} is already in your cart.`;
  }

  if (result.status === 'quantity_updated') {
    const quantity = quantityNumber(result.quantity) ?? 1;
    return `Updated ${productResultLabel(result)} to quantity ${quantity}.`;
  }

  if (result.status === 'removed') {
    return `Removed ${productResultLabel(result)} from your cart.`;
  }

  if (result.status === 'not_found') {
    return 'I could not find that. Try another product name.';
  }

  if (
    ['mutation_outcome_ambiguous', 'reconciliation_required'].includes(
      result.status ?? '',
    )
    || (
      result.status === 'execution_failed'
      && result.verification?.mutationAttempted === true
      && result.verification.outcome === 'ambiguous'
    )
  ) {
    const label = productResultLabel(result);
    return [
      `The cart change for ${label} may have completed, but I could not verify it.`,
      'I stopped before the next item to avoid a duplicate.',
    ].join(' ');
  }

  if (result.status === 'execution_failed' && result.failure) {
    switch (result.failure.stage) {
      case 'input':
        return result.failure.reason === 'invalid_quantity'
          ? 'Use a whole-number quantity between 1 and 20.'
          : 'Tell me one valid product.';
      case 'device':
        return 'The connected phone is unavailable. Unlock it and try again.';
      case 'recovery':
        return 'I could not restore the phone session. Try again.';
      case 'inspection':
        return 'I could not verify the current cart. Try again.';
      case 'search':
        return 'Blinkit search failed. Try again.';
      case 'matching':
        return 'That exact product is no longer available. Search again.';
      case 'mutation':
        return 'The cart did not update. Try again.';
      case 'verification':
        return 'I could not verify the cart change. Check the current cart.';
      default:
        return 'I could not complete that phone action. Try again.';
    }
  }

  if (result.status === 'cart_empty') {
    return 'Your cart is empty.';
  }

  if (result.status === 'cart_status' && result.cart?.lines?.length) {
    const visibleLines = result.cart.lines.slice(0, 3).map((line) => {
      const label = line.spokenLabel || line.product || 'an item';
      return line.quantity && line.quantity > 1
        ? `${line.quantity} ${label}`
        : label;
    });
    const remaining = result.cart.lines.length - visibleLines.length;
    return [
      `Your cart has ${naturalAndList(visibleLines)}.`,
      remaining > 0 ? `There are ${remaining} more items.` : undefined,
      result.cart.subtotal
        ? `Subtotal is ${
            typeof result.cart.subtotal === 'string'
              ? result.cart.subtotal
              : new Intl.NumberFormat('en-IN', {
                  currency: result.cart.subtotal.currency,
                  maximumFractionDigits: 2,
                  style: 'currency',
                }).format(result.cart.subtotal.amount)
          }.`
        : undefined,
    ].filter(Boolean).join(' ');
  }

  if (result.status === 'confirmation_required' && result.checkout) {
    const total = result.checkout.total;
    const address = result.checkout.addressLabel;
    const phrase = result.confirmationPhrase ?? 'Confirm COD order';
    return [
      `Your Cash on Delivery total is ${total === undefined ? 'not available' : `₹${total}`}`,
      address ? `for ${address}` : undefined,
      `Say “${phrase}” to place it.`,
      'Nothing has been ordered.',
    ].filter(Boolean).join(' ');
  }

  if (result.status === 'ordered') {
    return result.providerReference
      ? `Your order is confirmed. Reference ${result.providerReference}.`
      : 'Your order is confirmed.';
  }

  if (companionIssue) {
    return `${companionIssue.title}. ${companionIssue.detail}`;
  }

  return result.message?.trim() || 'I could not complete that request.';
}

export function presentToolResult(result: PresentableToolResult | undefined): string {
  const base = presentToolResultBase(result);
  if (!result) return base;
  const instruction = currentScreenInstruction(result);
  return instruction ? `${base} ${instruction}` : base;
}

export function presentToolResults(results: readonly PresentableToolResult[]): string {
  if (results.length === 0) return '';
  if (results.length === 1) return presentToolResult(results[0]);
  return results.map((result, index) =>
    index === results.length - 1
      ? presentToolResult(result)
      : presentToolResultBase(result)).join(' ');
}
