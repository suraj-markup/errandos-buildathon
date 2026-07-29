import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OverlayPresentationSchemaV1 as PackageOverlayPresentationSchemaV1,
} from '@errandos/contracts';
import { OverlayPresentationSchemaV1 } from '../src/overlay-presentation.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(
  fileURLToPath(new URL(
    `../../../apps/android-overlay/fixtures/${name}`,
    import.meta.url,
  )),
  'utf8',
));

const checkout = {
  addressLabel: 'Home',
  addressReference: 'address-home',
  fees: [],
  lines: [{
    lineTotal: { amount: 56, currency: 'INR' },
    name: 'Amul Taaza Toned Milk',
    productId: 'milk-1l',
    quantity: 1,
    unitPrice: { amount: 56, currency: 'INR' },
  }],
  paymentMode: 'cod',
  providerFingerprint: 'a'.repeat(64),
  total: { amount: 56, currency: 'INR' },
  unavailableItems: [],
} as const;

const providerScreenPresentation = {
  attentionCue: {
    instruction: 'check_current_screen',
    subject: 'checkout',
  },
  behavior: {
    autoCollapse: false,
    keepVisibleWhileSpeaking: true,
  },
  card: {
    checkout,
    ordered: false,
    type: 'checkout_review',
  },
  currentScreen: {
    kind: 'checkout',
    relevance: 'checkout_summary',
    searchAction: 'available',
    verified: true,
  },
  mode: 'waiting_for_user',
  primarySurface: 'provider_screen',
  spoken: {
    languageCode: 'en-IN',
    text: 'The checkout summary is visible on the current screen. Nothing has been ordered.',
  },
  version: 1,
} as const;

const AcceptedSelectionProjectionFixtureSchema = z.object({
  offerId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  packSize: z.string().trim().min(1).max(100),
  price: z.object({
    currency: z.literal('INR'),
    amount: z.number().nonnegative(),
  }).strict(),
  visualState: z.literal('selected'),
  nextPhase: z.literal('adding'),
  equivalentInputSources: z.tuple([
    z.literal('tap'),
    z.literal('voice'),
  ]),
}).strict();

const verifiedCartPresentation = {
  behavior: {
    autoCollapse: false,
    keepVisibleWhileSpeaking: true,
  },
  card: {
    cart: {
      addressLabel: 'Home',
      lines: [{
        lineTotal: { amount: 112, currency: 'INR' },
        name: 'Amul Taaza Toned Milk',
        packSize: '500 ml',
        productId: 'milk-500',
        quantity: 2,
        spokenLabel: 'two packs of Amul Taaza milk',
        unitPrice: { amount: 56, currency: 'INR' },
      }],
      subtotal: { amount: 112, currency: 'INR' },
      verified: true,
    },
    ordered: false,
    type: 'cart_summary',
  },
  mode: 'success',
  primarySurface: 'overlay_card',
  spoken: {
    languageCode: 'en-IN',
    text: 'Your verified cart has two milk packs. Nothing has been ordered.',
  },
  version: 1,
} as const;

describe('OverlayPresentationSchemaV1', () => {
  it('accepts a verified checkout presentation', () => {
    expect(OverlayPresentationSchemaV1.parse(providerScreenPresentation))
      .toEqual(providerScreenPresentation);
  });

  it('rejects a provider-screen claim without fresh screen evidence or an attention cue', () => {
    const { attentionCue: _cue, currentScreen: _screen, ...unverified } =
      providerScreenPresentation;

    expect(OverlayPresentationSchemaV1.safeParse(unverified).success).toBe(false);
  });

  it('rejects an unknown screen even when marked verified', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      currentScreen: {
        ...providerScreenPresentation.currentScreen,
        kind: 'unknown',
      },
    }).success).toBe(false);
  });

  it('rejects raw device-control and secret fields', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      screenshot: 'base64-data',
    }).success).toBe(false);

    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      currentScreen: {
        ...providerScreenPresentation.currentScreen,
        otp: '123456',
      },
    }).success).toBe(false);
  });

  it('requires a provider reference for a receipt', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      card: { type: 'receipt' },
      currentScreen: {
        ...providerScreenPresentation.currentScreen,
        kind: 'order_confirmation',
        relevance: 'order_confirmation',
      },
      mode: 'success',
    }).success).toBe(false);
  });

  it('keeps an ambiguous outcome visually distinct from success', () => {
    const parsed = OverlayPresentationSchemaV1.parse({
      behavior: {
        autoCollapse: false,
        keepVisibleWhileSpeaking: true,
      },
      card: {
        reconciliationId: 'reconcile-1',
        type: 'ambiguous',
      },
      mode: 'ambiguous',
      primarySurface: 'overlay_card',
      spoken: {
        languageCode: 'en-IN',
        text: 'I cannot yet verify whether the order was placed.',
      },
      version: 1,
    });

    expect(parsed.mode).toBe('ambiguous');
    expect(parsed.card.type).toBe('ambiguous');
  });

  it('accepts a product card with an exact atomic-selection binding', () => {
    const parsed = OverlayPresentationSchemaV1.parse({
      behavior: {
        autoCollapse: false,
        keepVisibleWhileSpeaking: true,
      },
      card: {
        options: [{
          offerId: 'offer-1',
          spokenLabel: 'Taaza Toned',
          title: 'Amul Taaza Toned Milk',
        }],
        selection: {
          clientId: 'pixel-overlay',
          expiresAt: '2026-07-27T15:00:00.000Z',
          interactionId: 'interaction_12345678',
          selectionId: 'selection_12345678',
          taskId: 'task_12345678',
          taskRevision: 3,
          version: 2,
        },
        type: 'product_choices',
      },
      mode: 'waiting_for_user',
      primarySurface: 'overlay_card',
      spoken: {
        languageCode: 'en-IN',
        text: 'Choose one.',
      },
      version: 1,
    });

    expect(parsed.card).toMatchObject({
      selection: {
        interactionId: 'interaction_12345678',
        taskRevision: 3,
      },
      type: 'product_choices',
    });
  });

  it('accepts the strict rich-choice fixture presentation', () => {
    const richChoice = fixture(
      'ux-regression-rich-product-choices.json',
    ) as Record<string, unknown>;
    const {
      acceptedSelectionProjection: fixtureExpectation,
      ...presentation
    } = richChoice;

    expect(Object.keys(richChoice).sort()).toEqual([
      'acceptedSelectionProjection',
      'behavior',
      'card',
      'mode',
      'primarySurface',
      'spoken',
      'task',
      'version',
    ]);
    expect(
      AcceptedSelectionProjectionFixtureSchema.parse(fixtureExpectation),
    ).toEqual(fixtureExpectation);
    expect(OverlayPresentationSchemaV1.parse(presentation)).toEqual(
      presentation,
    );
  });

  it('accepts a verified formal cart with exact retained line terms', () => {
    expect(OverlayPresentationSchemaV1.parse(verifiedCartPresentation))
      .toEqual(verifiedCartPresentation);
  });

  it('keeps the package-root runtime schema aligned with strict source proof', () => {
    expect(PackageOverlayPresentationSchemaV1.parse(
      verifiedCartPresentation,
    )).toEqual(verifiedCartPresentation);

    const legacyUnprovedCart = structuredClone(verifiedCartPresentation) as {
      card: {
        cart: {
          verified?: boolean;
          addressReference?: string;
          paymentMode?: string;
          providerFingerprint?: string;
          unavailableItems?: unknown[];
        };
        ordered?: boolean;
      };
    };
    delete legacyUnprovedCart.card.ordered;
    delete legacyUnprovedCart.card.cart.verified;
    Object.assign(legacyUnprovedCart.card.cart, {
      addressReference: 'address-home',
      paymentMode: 'unselected',
      providerFingerprint: 'a'.repeat(64),
      unavailableItems: [],
    });

    expect(PackageOverlayPresentationSchemaV1.safeParse(
      legacyUnprovedCart,
    ).success).toBe(false);
  });

  it('accepts the verified-cart regression fixture presentation', () => {
    const retainedEvent = fixture(
      'ux-regression-verified-cart-summary.json',
    ) as Record<string, unknown>;

    expect(OverlayPresentationSchemaV1.parse(retainedEvent.safePresentation))
      .toEqual(retainedEvent.safePresentation);
  });

  it('rejects a formal cart without authoritative proof or a non-order flag', () => {
    const missingProof = structuredClone(verifiedCartPresentation) as {
      card: {
        cart: { verified?: boolean };
        ordered?: boolean;
      };
    };
    delete missingProof.card.cart.verified;
    expect(OverlayPresentationSchemaV1.safeParse(missingProof).success)
      .toBe(false);

    expect(OverlayPresentationSchemaV1.safeParse({
      ...verifiedCartPresentation,
      card: {
        ...verifiedCartPresentation.card,
        cart: {
          ...verifiedCartPresentation.card.cart,
          verified: false,
        },
      },
    }).success).toBe(false);

    const missingOrdered = structuredClone(verifiedCartPresentation) as {
      card: { ordered?: boolean };
    };
    delete missingOrdered.card.ordered;
    expect(OverlayPresentationSchemaV1.safeParse(missingOrdered).success)
      .toBe(false);

    expect(OverlayPresentationSchemaV1.safeParse({
      ...verifiedCartPresentation,
      card: {
        ...verifiedCartPresentation.card,
        ordered: true,
      },
    }).success).toBe(false);
  });

  it('rejects cart arithmetic that does not match the retained exact terms', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      ...verifiedCartPresentation,
      card: {
        ...verifiedCartPresentation.card,
        cart: {
          ...verifiedCartPresentation.card.cart,
          subtotal: { amount: 111, currency: 'INR' },
        },
      },
    }).success).toBe(false);

    expect(OverlayPresentationSchemaV1.safeParse({
      ...verifiedCartPresentation,
      card: {
        ...verifiedCartPresentation.card,
        cart: {
          ...verifiedCartPresentation.card.cart,
          lines: [{
            ...verifiedCartPresentation.card.cart.lines[0],
            lineTotal: { amount: 56, currency: 'INR' },
          }],
          subtotal: { amount: 56, currency: 'INR' },
        },
      },
    }).success).toBe(false);
  });

  it('rejects malformed product-card selection identifiers', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      behavior: {
        autoCollapse: false,
        keepVisibleWhileSpeaking: true,
      },
      card: {
        options: [{
          offerId: 'offer-1',
          spokenLabel: 'Taaza Toned',
          title: 'Amul Taaza Toned Milk',
        }],
        selection: {
          clientId: 'pixel-overlay',
          expiresAt: '2026-07-27T15:00:00.000Z',
          interactionId: 'interaction_12345678',
          selectionId: 'wrong-kind_12345678',
          taskId: 'task_12345678',
          taskRevision: 3,
          version: 2,
        },
        type: 'product_choices',
      },
      mode: 'waiting_for_user',
      primarySurface: 'overlay_card',
      spoken: {
        languageCode: 'en-IN',
        text: 'Choose one.',
      },
      version: 1,
    }).success).toBe(false);
  });

  it('accepts versioned semantic progress with a known queue position', () => {
    const parsed = OverlayPresentationSchemaV1.parse({
      ...providerScreenPresentation,
      task: {
        version: 1,
        taskId: 'task_12345678',
        itemId: 'task_item_12345678',
        operationId: 'operation_12345678',
        title: 'Add grocery item',
        step: 'Verifying cart update',
        stage: 'verifying',
        sequence: 4,
        position: {
          current: 1,
          total: 3,
        },
        cancellation: {
          available: false,
          policy: 'reconcile_only',
        },
        terminal: false,
      },
    });

    expect(parsed.task).toMatchObject({
      position: { current: 1, total: 3 },
      stage: 'verifying',
      terminal: false,
    });
  });

  it('accepts semantic progress when the total is unknown', () => {
    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      task: {
        version: 1,
        taskId: 'task_12345678',
        operationId: 'operation_12345678',
        title: 'Phone task',
        step: 'Waiting for phone',
        stage: 'queued',
        sequence: 0,
        position: { current: 1 },
        cancellation: {
          available: true,
          policy: 'cancel_now',
        },
        terminal: false,
      },
    }).success).toBe(true);
  });

  it('rejects dishonest terminal and cancellation progress', () => {
    const task = {
      version: 1,
      taskId: 'task_12345678',
      operationId: 'operation_12345678',
      title: 'Phone task',
      step: 'Completed',
      stage: 'completed',
      sequence: 5,
      cancellation: {
        available: true,
        policy: 'not_cancellable',
      },
      terminal: false,
    } as const;

    expect(OverlayPresentationSchemaV1.safeParse({
      ...providerScreenPresentation,
      task,
    }).success).toBe(false);
  });
});
