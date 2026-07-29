import { describe, expect, it } from 'vitest';
import { presentToolResult, presentToolResults } from './voice-presentation';

describe('voice result presentation', () => {
  it('uses concise labels instead of canonical product titles', () => {
    expect(presentToolResult({
      status: 'added',
      product: "Lay's India's Magic Masala Potato Chips",
      spokenLabel: "India's Magic Masala",
      size: '58 g',
      quantity: 1,
    })).toBe("Added India's Magic Masala, 58 g.");
  });

  it('mentions quantity only when it is meaningful', () => {
    expect(presentToolResult({
      status: 'added',
      spokenLabel: 'Classic Salted',
      size: '52 g',
      quantity: 2,
    })).toBe('Added 2 of Classic Salted, 52 g.');
  });

  it('briefly confirms cart quantity changes and removals', () => {
    expect(presentToolResult({
      status: 'quantity_updated',
      spokenLabel: 'Classic Salted',
      quantity: 3,
    })).toBe('Updated Classic Salted to quantity 3.');
    expect(presentToolResult({
      status: 'removed',
      spokenLabel: 'Classic Salted',
    })).toBe('Removed Classic Salted from your cart.');
  });

  it('limits spoken choices while acknowledging more visible results', () => {
    expect(presentToolResult({
      status: 'needs_clarification',
      options: [
        { spokenLabel: 'Magic Masala', size: '58 g' },
        { spokenLabel: 'Classic Salted', size: '52 g' },
        { spokenLabel: 'American Style', size: '48 g' },
        { spokenLabel: 'Chile Limón', size: '48 g' },
      ],
    })).toBe(
      'I found Magic Masala 58 g, Classic Salted 52 g, or American Style 48 g. '
      + 'Which one do you want? I found 1 more option.',
    );
  });

  it('speaks price only when the search request asks for it', () => {
    const result = {
      status: 'search_results',
      options: [{ spokenLabel: 'Taaza Toned', size: '500 ml', price: '₹29' }],
    };
    expect(presentToolResult(result)).toBe('I found Taaza Toned 500 ml.');
    expect(presentToolResult({ ...result, speakPrice: true }))
      .toBe('I found Taaza Toned 500 ml. It is ₹29.');
  });

  it('keeps a read-only selection separate from explicit cart mutation', () => {
    expect(presentToolResult({
      product: "Lay's Classic Salted Potato Chips",
      size: '52 g',
      spokenLabel: 'Classic Salted',
      status: 'add_confirmation_required',
    })).toBe(
      'You chose Classic Salted, 52 g. Say “add it” to change the cart.',
    );
  });

  it('briefly acknowledges a skipped product', () => {
    expect(presentToolResult({
      message: 'Skipped milk. The product list is complete.',
      status: 'product_skipped',
    })).toBe('Skipped milk. The product list is complete.');
  });

  it.each([
    ['device', 'The connected phone is unavailable. Unlock it and try again.'],
    ['matching', 'That exact product is no longer available. Search again.'],
    ['mutation', 'The cart did not update. Try again.'],
    ['verification', 'I could not verify the cart change. Check the current cart.'],
  ])('presents a factual %s execution failure', (stage, expected) => {
    expect(presentToolResult({
      failure: {
        operation: 'add_cart_item',
        reason: `${stage}_failed`,
        recoverable: true,
        stage,
      },
      ok: false,
      status: 'execution_failed',
    })).toBe(expected);
  });

  it('combines multiple tool outcomes without another model response', () => {
    expect(presentToolResults([
      { status: 'added', spokenLabel: 'Taaza Toned', size: '500 ml', quantity: 1 },
      { status: 'not_found' },
    ])).toBe('Added Taaza Toned, 500 ml. I could not find that. Try another product name.');
  });

  it('explains an uncertain mutation without asking for an unsafe retry', () => {
    expect(presentToolResult({
      product: 'Amul Taaza Toned Milk',
      size: '500 ml',
      status: 'reconciliation_required',
      verification: {
        mutationAttempted: true,
        outcome: 'ambiguous',
        reconciliation: 'inspection_failed',
      },
    })).toBe(
      'The cart change for Amul Taaza Toned Milk, 500 ml may have completed, '
      + 'but I could not verify it. I stopped before the next item to avoid a duplicate.',
    );
  });

  it('references only the screen left visible by the final sequential action', () => {
    expect(presentToolResults([
      {
        screenEvidence: {
          observedAfterAction: true,
          screen: { kind: 'cart', searchAction: 'recoverable' },
        },
        spokenLabel: 'Taaza Toned',
        status: 'added',
      },
      {
        options: [{ spokenLabel: 'Whole Wheat' }, { spokenLabel: 'Multigrain' }],
        screenEvidence: {
          observedAfterAction: true,
          screen: { kind: 'search_results', searchAction: 'available' },
        },
        status: 'needs_clarification',
      },
    ])).toBe(
      'Added Taaza Toned. I found Whole Wheat or Multigrain. '
      + 'Which one do you want? Check the options on the current screen.',
    );
  });

  it('summarizes a verified cart without reading complete provider titles', () => {
    expect(presentToolResult({
      status: 'cart_status',
      cart: {
        lines: [
          {
            product: 'Amul Taaza Toned Milk',
            spokenLabel: 'Amul Taaza Toned',
            quantity: 2,
          },
          {
            product: "Lay's Classic Salted Potato Chips",
            spokenLabel: 'Classic Salted',
            quantity: 1,
          },
        ],
        subtotal: '₹114',
      },
    })).toBe(
      'Your cart has 2 Amul Taaza Toned and Classic Salted. Subtotal is ₹114.',
    );
    expect(presentToolResult({ status: 'cart_empty' })).toBe('Your cart is empty.');
  });

  it('directs the user to a freshly verified relevant cart screen', () => {
    expect(presentToolResult({
      status: 'cart_status',
      cart: {
        lines: [{ spokenLabel: 'Taaza Toned', quantity: 1 }],
        subtotal: '₹56',
      },
      screenEvidence: {
        observedAfterAction: true,
        screen: {
          kind: 'cart',
          searchAction: 'recoverable',
        },
      },
    })).toBe(
      'Your cart has Taaza Toned. Subtotal is ₹56. '
      + 'Check the cart on the current screen.',
    );
  });

  it('does not mention the current screen when the verified screen is irrelevant', () => {
    expect(presentToolResult({
      status: 'cart_status',
      cart: {
        lines: [{ spokenLabel: 'Taaza Toned', quantity: 1 }],
      },
      screenEvidence: {
        observedAfterAction: true,
        screen: {
          kind: 'search_results',
          searchAction: 'available',
        },
      },
    })).toBe('Your cart has Taaza Toned.');
  });

  it('preserves the not-ordered checkout boundary on a relevant screen', () => {
    expect(presentToolResult({
      status: 'confirmation_required',
      checkout: {
        addressLabel: 'Home',
        total: 56,
      },
      confirmationPhrase: 'Confirm COD order',
      screenEvidence: {
        observedAfterAction: true,
        screen: {
          kind: 'checkout',
          searchAction: 'recoverable',
        },
      },
    })).toBe(
      'Your Cash on Delivery total is ₹56 for Home Say “Confirm COD order” to place it. '
      + 'Nothing has been ordered. Check the checkout summary on the current screen.',
    );
  });
});
