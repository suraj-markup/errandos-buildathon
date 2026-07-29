import { describe, expect, it } from 'vitest';
import { OverlayPresentationSchemaV1 } from '@errandos/contracts';
import { parseLocalIdentifier } from '../../workflow/identifiers';
import { buildFinalCartSummaryEventV2 } from './final-cart-summary';
import { RetainedTaskEventStreamV2 } from './retained-task-event-stream';

const taskId = parseLocalIdentifier(
  'task',
  'task_12345678-1234-1234-1234-123456789abc',
);
const operationId = parseLocalIdentifier(
  'operation',
  'operation_12345678-1234-1234-1234-123456789abc',
);

describe('final cart summary retained event v2', () => {
  it('builds one terminal event from the fresh voice inspect-cart result', () => {
    const stream = new RetainedTaskEventStreamV2({
      newEventId: () => 'event_final_cart',
      now: () => 200,
    });
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        status: 'cart_status',
        cart: {
          lines: [
            {
              productId: 'cart_paneer',
              product: 'Amul Fresh Malai Paneer',
              spokenLabel: 'Amul paneer, 200 grams',
              packSize: '200 g',
              quantity: 1,
              price: '₹105',
            },
            {
              productId: 'cart_rice',
              product: 'Anand Boiled Rice',
              quantity: 2,
              price: '₹619',
            },
          ],
          subtotal: '₹1,343',
        },
      },
      operationId,
      taskId,
      taskRevision: 8,
    });
    const first = stream.publish(draft);
    const duplicate = stream.publish(buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        status: 'cart_status',
        cart: {
          lines: [],
          subtotal: '₹1,343',
        },
      },
      operationId,
      taskId,
      taskRevision: 8,
    }));

    expect(duplicate).toEqual(first);
    expect(stream.readAfter({ taskId }).events).toHaveLength(1);
    expect(first).toMatchObject({
      operationId,
      kind: 'completed',
      terminal: true,
      title: 'Your cart is ready',
      finalCartSummary: {
        status: 'ready',
        subtotal: '₹1,343',
        inspectedAt: 190,
        lines: [
          {
            productId: 'cart_paneer',
            title: 'Amul Fresh Malai Paneer',
            spokenLabel: 'Amul paneer, 200 grams',
            packSize: '200 g',
            quantity: 1,
            price: '₹105',
          },
          {
            productId: 'cart_rice',
            title: 'Anand Boiled Rice',
            quantity: 2,
            price: '₹619',
          },
        ],
      },
      announcement: {
        channel: 'speech_and_visual',
        text:
          'All 3 items are in your cart. The subtotal is ₹1,343. '
          + 'No order has been placed.',
      },
      safePresentation: {
        primarySurface: 'overlay_card',
        card: { type: 'compact_status', tone: 'success' },
      },
    });
    expect(first.interaction).toBeUndefined();
    expect(first.announcement?.text).not.toMatch(/place order/i);
    expect(draft.dedupeKey).toBe(
      `${operationId}:terminal:completed`,
    );
  });

  it('truthfully reports a fresh empty-cart inspection', () => {
    expect(buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: { status: 'cart_empty' },
      taskId,
      taskRevision: 8,
    })).toMatchObject({
      kind: 'completed',
      terminal: true,
      finalCartSummary: {
        status: 'empty',
        lines: [],
        inspectedAt: 190,
      },
      announcement: {
        text: 'Your cart is empty. No order has been placed.',
      },
    });
    expect(buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: { status: 'cart_empty' },
      taskId,
      taskRevision: 8,
    }).interaction).toBeUndefined();
  });

  it('maps a proof-gated voice cart into the strict verified-not-ordered card', () => {
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        status: 'cart_status',
        cart: {
          addressLabel: 'Home',
          verified: true,
          ordered: false,
          lines: [{
            productId: 'paneer_200g',
            product: 'Amul Fresh Malai Paneer',
            spokenLabel: 'Amul paneer',
            packSize: '200 g',
            quantity: 2,
            price: '₹105',
          }],
          subtotal: '₹210',
        },
      },
      taskId,
      taskRevision: 8,
    });

    expect(OverlayPresentationSchemaV1.safeParse(draft.safePresentation))
      .toMatchObject({ success: true });
    expect(draft.safePresentation).toMatchObject({
      behavior: {
        autoCollapse: false,
        keepVisibleWhileSpeaking: true,
      },
      card: {
        type: 'cart_summary',
        ordered: false,
        cart: {
          verified: true,
          addressLabel: 'Home',
          lines: [{
            productId: 'paneer_200g',
            name: 'Amul Fresh Malai Paneer',
            spokenLabel: 'Amul paneer',
            packSize: '200 g',
            quantity: 2,
            unitPrice: { amount: 105, currency: 'INR' },
            lineTotal: { amount: 210, currency: 'INR' },
          }],
          subtotal: { amount: 210, currency: 'INR' },
        },
      },
    });
    expect(draft.interaction).toBeUndefined();
    expect(JSON.stringify(draft.safePresentation)).not.toMatch(
      /place order|order_now|confirm_order/i,
    );
  });

  it.each([
    {
      proof: {},
      label: 'missing proof',
    },
    {
      proof: { verified: false, ordered: false },
      label: 'negative verification',
    },
    {
      proof: { verified: true, ordered: true },
      label: 'ordered evidence',
    },
  ])('downgrades $label instead of presenting an authoritative cart', ({
    proof,
  }) => {
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        status: 'cart_status',
        cart: {
          addressLabel: 'Home',
          ...proof,
          lines: [{
            productId: 'paneer_200g',
            product: 'Amul Fresh Malai Paneer',
            quantity: 2,
            price: '₹105',
          }],
          subtotal: '₹210',
        },
      },
      taskId,
      taskRevision: 8,
    });

    expect(draft.safePresentation).toMatchObject({
      card: { type: 'compact_status' },
    });
    expect(draft.interaction).toBeUndefined();
  });

  it('passes through only an exact repository-derived interaction binding', () => {
    const persistedInteraction = {
      version: 2 as const,
      interactionId: 'interaction_12345678',
      taskId,
      taskRevision: 8,
      expiresAt: 900,
      choices: [
        { choiceId: 'review_cart' as const, enabled: true, label: 'Review cart' },
        { choiceId: 'add_more' as const, enabled: true, label: 'Keep shopping' },
        { choiceId: 'stop' as const, enabled: true, label: 'Stop' },
      ],
    };
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: { status: 'cart_empty' },
      persistedInteraction,
      taskId,
      taskRevision: 8,
    });

    expect(draft).toMatchObject({
      kind: 'waiting_for_user',
      interaction: persistedInteraction,
    });
    expect(draft.terminal).toBeUndefined();
    expect(() => buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: { status: 'cart_empty' },
      persistedInteraction: {
        ...persistedInteraction,
        taskRevision: 7,
      },
      taskId,
      taskRevision: 8,
    })).toThrow(/must match/);
  });

  it('maps Android cart evidence into the strict verified-not-ordered card', () => {
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        lines: [{
          productId: 'paneer_200g',
          name: 'Amul Fresh Malai Paneer',
          quantity: 2,
          unitPrice: { amount: 105, currency: 'INR' },
          lineTotal: { amount: 210, currency: 'INR' },
        }],
        unavailableItems: [],
        subtotal: { amount: 210, currency: 'INR' },
        addressReference: 'address_home',
        addressLabel: 'Home',
        paymentMode: 'unselected',
        providerFingerprint: 'a'.repeat(64),
      },
      taskId,
      taskRevision: 8,
    });

    expect(OverlayPresentationSchemaV1.safeParse(draft.safePresentation))
      .toMatchObject({ success: true });
    expect(draft.safePresentation).toMatchObject({
      card: {
        type: 'cart_summary',
        ordered: false,
        cart: {
          verified: true,
          addressLabel: 'Home',
          lines: [{
            productId: 'paneer_200g',
            quantity: 2,
          }],
          subtotal: { amount: 210, currency: 'INR' },
        },
      },
    });
  });

  it('downgrades conflicting cart evidence to non-terminal ambiguity', () => {
    const draft = buildFinalCartSummaryEventV2({
      inspectedAt: 190,
      inspection: {
        status: 'cart_status',
        cart: {
          lines: [{
            product: 'Amul Fresh Malai Paneer',
            packSize: '250 g',
            quantity: 1,
            price: '₹120',
            conflicts: [
              {
                field: 'pack_size',
                expected: '200 g',
                observed: '250 g',
              },
              {
                field: 'price',
                expected: '₹105',
                observed: '₹120',
              },
            ],
          }],
          subtotal: '₹120',
        },
      },
      operationId,
      taskId,
      taskRevision: 8,
    });

    expect(draft).toMatchObject({
      kind: 'ambiguous',
      title: 'Cart details need review',
      finalCartSummary: {
        status: 'ambiguous',
        lines: [{
          packSize: '250 g',
          conflicts: [
            { field: 'pack_size', expected: '200 g', observed: '250 g' },
            { field: 'price', expected: '₹105', observed: '₹120' },
          ],
        }],
      },
      safePresentation: {
        mode: 'ambiguous',
        card: { type: 'ambiguous' },
      },
    });
    expect(draft.interaction).toBeUndefined();
    expect(draft.terminal).toBeUndefined();
    expect(draft.dedupeKey).toBe(
      `${operationId}:cart-summary:ambiguous`,
    );
  });
});
