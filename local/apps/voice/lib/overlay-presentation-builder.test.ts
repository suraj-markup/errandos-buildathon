import { describe, expect, it } from 'vitest';
import {
  buildOverlayPresentation,
  legacyAssistantStateFor,
  withAuthoritativeCartPresentationProof,
} from './overlay-presentation-builder';
import { OverlayPresentationSchemaV1 } from '@errandos/contracts';

describe('buildOverlayPresentation', () => {
  it('builds choices and uses a verified search screen', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        options: [{
          offerId: 'offer-1',
          product: 'Amul Taaza Toned Milk',
          size: '500 ml',
          spokenLabel: 'Taaza Toned',
        }],
        screenEvidence: {
          observedAfterAction: true,
          screen: { kind: 'search_results', searchAction: 'available' },
        },
        status: 'search_results',
      },
      spokenText: 'I found Taaza Toned. Check the options on the current screen.',
    });

    expect(presentation).toMatchObject({
      attentionCue: { subject: 'options' },
      card: { type: 'product_choices' },
      currentScreen: { kind: 'search_results', verified: true },
      mode: 'waiting_for_user',
      primarySurface: 'provider_screen',
    });
  });

  it('includes a provided atomic-selection binding on product choices', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      productSelection: {
        clientId: 'pixel-overlay',
        expiresAt: '2026-07-27T15:00:00.000Z',
        interactionId: 'interaction_12345678',
        selectionId: 'selection_12345678',
        taskId: 'task_12345678',
        taskRevision: 4,
        version: 2,
      },
      result: {
        options: [{
          offerId: 'offer-1',
          product: 'Amul Taaza Toned Milk',
          spokenLabel: 'Taaza Toned',
        }],
        status: 'search_results',
      },
      spokenText: 'Choose one.',
    });

    expect(presentation.card).toMatchObject({
      selection: {
        interactionId: 'interaction_12345678',
        taskRevision: 4,
      },
      type: 'product_choices',
    });
  });

  it('falls back to the overlay for an unverified cart result', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        cart: { lines: [{ spokenLabel: 'Taaza Toned', quantity: 1 }] },
        status: 'cart_status',
      },
      spokenText: 'Your cart has Taaza Toned.',
    });

    expect(presentation.primarySurface).toBe('overlay_card');
    expect(presentation).not.toHaveProperty('attentionCue');
  });

  it('downgrades a complete cart when authoritative proof is false', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        cart: {
          addressLabel: 'Home',
          verified: false,
          ordered: false,
          lines: [{
            productId: 'milk-500',
            product: 'Amul Taaza Toned Milk',
            quantity: 2,
            price: '₹28',
          }],
          subtotal: '₹56',
        },
        status: 'cart_status',
      },
      spokenText: 'Your cart has two milk packs. Subtotal is ₹56.',
    });

    expect(presentation.card).toEqual({
      tone: 'success',
      type: 'compact_status',
    });
  });

  it('downgrades a complete cart that claims it was ordered', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        cart: {
          addressLabel: 'Home',
          verified: true,
          ordered: true,
          lines: [{
            productId: 'milk-500',
            product: 'Amul Taaza Toned Milk',
            quantity: 2,
            price: '₹28',
          }],
          subtotal: '₹56',
        },
        status: 'cart_status',
      },
      spokenText: 'I could not safely present this as a cart summary.',
    });

    expect(presentation.card.type).toBe('compact_status');
  });

  it('builds an exact strict cart summary only after direct-inspection proof', () => {
    const result = withAuthoritativeCartPresentationProof({
      cart: {
        addressLabel: 'Home',
        lines: [{
          productId: 'milk-500',
          product: 'Amul Taaza Toned Milk',
          spokenLabel: 'Taaza Toned',
          size: '500 ml',
          quantity: 2,
          price: '₹28',
        }],
        subtotal: '₹56',
      },
      status: 'cart_status',
    });
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result,
      spokenText: 'Your cart has two Taaza Toned milk packs. Subtotal is ₹56.',
    });

    expect(presentation.card).toEqual({
      type: 'cart_summary',
      ordered: false,
      cart: {
        verified: true,
        addressLabel: 'Home',
        lines: [{
          productId: 'milk-500',
          name: 'Amul Taaza Toned Milk',
          spokenLabel: 'Taaza Toned',
          packSize: '500 ml',
          quantity: 2,
          unitPrice: { amount: 28, currency: 'INR' },
          lineTotal: { amount: 56, currency: 'INR' },
        }],
        subtotal: { amount: 56, currency: 'INR' },
      },
    });
    expect(OverlayPresentationSchemaV1.safeParse(presentation).success).toBe(true);
    expect(JSON.stringify(presentation.card)).not.toMatch(/place|order_now|confirm/i);
  });

  it('downgrades an attested cart with incomplete exact line terms', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: withAuthoritativeCartPresentationProof({
        cart: {
          addressLabel: 'Home',
          lines: [{
            productId: 'milk-500',
            product: 'Amul Taaza Toned Milk',
            quantity: 2,
          }],
          subtotal: '₹56',
        },
        status: 'cart_status',
      }),
      spokenText: 'I could not present exact cart terms.',
    });

    expect(presentation.card.type).toBe('compact_status');
  });

  it('keeps checkout visible and marked as not ordered', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        checkout: { addressLabel: 'Home', total: 56 },
        screenEvidence: {
          observedAfterAction: true,
          screen: { kind: 'checkout', searchAction: 'recoverable' },
        },
        status: 'confirmation_required',
      },
      spokenText: 'Nothing has been ordered. Check the checkout summary on the current screen.',
    });

    expect(presentation.behavior.autoCollapse).toBe(false);
    expect(presentation.primarySurface).toBe('provider_screen');
    expect(presentation.spoken.text).toContain('Nothing has been ordered');
  });

  it('keeps a read-only product selection waiting for explicit add intent', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        spokenLabel: 'Classic Salted',
        status: 'add_confirmation_required',
      },
      spokenText: 'You chose Classic Salted. Say “add it” to change the cart.',
    });

    expect(presentation.mode).toBe('waiting_for_user');
    expect(presentation.behavior.autoCollapse).toBe(false);
  });

  it('uses a receipt only with a provider reference', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        providerReference: 'BLINKIT-123',
        status: 'ordered',
      },
      spokenText: 'Your order is confirmed.',
    });

    expect(presentation.card).toEqual({
      providerReference: 'BLINKIT-123',
      type: 'receipt',
    });
    expect(legacyAssistantStateFor(presentation)).toBe('success');
  });

  it('renders failures as provider constraints', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        message: 'Cash on Delivery is unavailable.',
        ok: false,
        status: 'cod_unavailable',
      },
      spokenText: 'Cash on Delivery is unavailable.',
    });

    expect(presentation).toMatchObject({
      card: { type: 'provider_constraint' },
      mode: 'error',
      primarySurface: 'overlay_card',
    });
  });

  it('never renders an ambiguous final action as success', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: {
        ok: false,
        status: 'order_status_ambiguous',
      },
      spokenText: 'I cannot yet verify whether the order was placed.',
    });

    expect(presentation.card.type).toBe('ambiguous');
    expect(presentation.mode).toBe('ambiguous');
    expect(presentation.behavior.autoCollapse).toBe(false);
    expect(legacyAssistantStateFor(presentation)).toBe('error');
  });

  it('normalizes an unsupported language code for compatibility', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'unknown',
      result: { status: 'ready' },
      spokenText: 'Ready.',
    });

    expect(presentation.spoken.languageCode).toBe('en-IN');
  });

  it('carries observed semantic progress and retains a terminal result', () => {
    const presentation = buildOverlayPresentation({
      languageCode: 'en-IN',
      result: { status: 'added' },
      spokenText: 'Milk is in your cart.',
      taskProgress: {
        version: 1,
        taskId: 'task_12345678',
        itemId: 'task_item_12345678',
        operationId: 'operation_12345678',
        title: 'Add grocery item',
        step: 'Completed',
        stage: 'completed',
        sequence: 7,
        position: { current: 1, total: 3 },
        cancellation: {
          available: false,
          policy: 'not_cancellable',
        },
        terminal: true,
      },
    });

    expect(presentation.task).toMatchObject({
      operationId: 'operation_12345678',
      position: { current: 1, total: 3 },
      stage: 'completed',
    });
    expect(presentation.behavior.autoCollapse).toBe(false);
  });
});
