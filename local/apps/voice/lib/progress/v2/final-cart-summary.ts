import type {
  AndroidCartReviewV1,
  OverlayPresentationV1,
} from '@errandos/contracts';
import {
  buildOverlayPresentation,
} from '../../overlay-presentation-builder';
import type { PresentableToolResult } from '../../voice-presentation';
import type { LocalIdentifier } from '../../workflow/identifiers';
import type {
  FinalCartSummaryLineV2,
  CompletionChoicePromptV2,
  SemanticTaskEventDraftV2,
  TaskItemConflictEvidenceV2,
} from './contracts';

export type VoiceCartInspectionResultV2 =
  | {
      status: 'cart_empty';
    }
  | {
      status: 'cart_status';
      cart: {
        addressLabel?: string;
        ordered?: boolean;
        verified?: boolean;
        lines: Array<{
          productId?: string;
          product?: string;
          spokenLabel?: string;
          packSize?: string;
          quantity?: number;
          price?: string;
          conflicts?: TaskItemConflictEvidenceV2[];
        }>;
        subtotal?: string;
      };
    };

export type FinalCartInspectionV2 =
  | AndroidCartReviewV1
  | VoiceCartInspectionResultV2;

function isVoiceResult(
  inspection: FinalCartInspectionV2,
): inspection is VoiceCartInspectionResultV2 {
  return 'status' in inspection;
}

function bounded(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function voiceLines(
  inspection: Extract<VoiceCartInspectionResultV2, { status: 'cart_status' }>,
): FinalCartSummaryLineV2[] {
  return inspection.cart.lines.map((line, index) => {
    const product = bounded(line.product, 300);
    const spokenLabel = bounded(line.spokenLabel, 300);
    return {
      ...(bounded(line.productId, 200)
        ? { productId: bounded(line.productId, 200) }
        : {}),
      title: product ?? spokenLabel ?? `Cart item ${index + 1}`,
      ...(spokenLabel ? { spokenLabel } : {}),
      ...(bounded(line.packSize, 100)
        ? { packSize: bounded(line.packSize, 100) }
        : {}),
      ...(Number.isSafeInteger(line.quantity) && Number(line.quantity) > 0
        ? { quantity: Number(line.quantity) }
        : {}),
      ...(bounded(line.price, 80) ? { price: bounded(line.price, 80) } : {}),
      ...(line.conflicts
        ? { conflicts: structuredClone(line.conflicts) }
        : {}),
    };
  });
}

function androidLines(
  inspection: AndroidCartReviewV1,
): FinalCartSummaryLineV2[] {
  return inspection.lines.map((line) => ({
    productId: line.productId,
    title: line.name,
    quantity: line.quantity,
    price: new Intl.NumberFormat('en-IN', {
      currency: line.unitPrice.currency,
      maximumFractionDigits: 2,
      style: 'currency',
    }).format(line.unitPrice.amount),
  }));
}

function compactPresentation(
  speech: string,
  empty: boolean,
): OverlayPresentationV1 {
  return {
    version: 1,
    mode: empty ? 'reading' : 'success',
    primarySurface: 'overlay_card',
    card: {
      type: 'compact_status',
      tone: empty ? 'neutral' : 'success',
    },
    spoken: {
      languageCode: 'en-IN',
      text: speech,
    },
    behavior: {
      autoCollapse: false,
      keepVisibleWhileSpeaking: true,
    },
  };
}

function ambiguousPresentation(speech: string): OverlayPresentationV1 {
  return {
    version: 1,
    mode: 'ambiguous',
    primarySurface: 'overlay_card',
    card: {
      type: 'ambiguous',
    },
    spoken: {
      languageCode: 'en-IN',
      text: speech,
    },
    behavior: {
      autoCollapse: false,
      keepVisibleWhileSpeaking: true,
    },
  };
}

function voicePresentation(
  inspection: VoiceCartInspectionResultV2,
  speech: string,
  empty: boolean,
): OverlayPresentationV1 {
  const presentation = buildOverlayPresentation({
    languageCode: 'en-IN',
    result: inspection as PresentableToolResult,
    spokenText: speech,
  });
  if (presentation.card.type !== 'cart_summary') {
    return compactPresentation(speech, empty);
  }
  return {
    ...presentation,
    behavior: {
      autoCollapse: false,
      keepVisibleWhileSpeaking: true,
    },
  };
}

export function buildFinalCartSummaryEventV2(input: {
  inspectedAt?: number;
  inspection: FinalCartInspectionV2;
  persistedInteraction?: CompletionChoicePromptV2;
  operationId?: LocalIdentifier<'operation'>;
  stepId?: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): SemanticTaskEventDraftV2 {
  const inspectedAt = input.inspectedAt ?? Date.now();
  if (!Number.isSafeInteger(inspectedAt) || inspectedAt < 0) {
    throw new Error('inspectedAt must be a non-negative integer timestamp.');
  }
  if (
    input.persistedInteraction
    && (
      input.persistedInteraction.taskId !== input.taskId
      || input.persistedInteraction.taskRevision !== input.taskRevision
    )
  ) {
    throw new Error(
      'persistedInteraction must match the event task and revision.',
    );
  }
  let androidInspection: AndroidCartReviewV1 | undefined;
  let voiceInspection: VoiceCartInspectionResultV2 | undefined;
  let empty = false;
  let lines: FinalCartSummaryLineV2[];
  let subtotal: string | undefined;
  if (isVoiceResult(input.inspection)) {
    voiceInspection = input.inspection;
    if (input.inspection.status === 'cart_empty') {
      empty = true;
      lines = [];
      subtotal = undefined;
    } else {
      lines = voiceLines(input.inspection);
      subtotal = bounded(input.inspection.cart.subtotal, 80);
    }
  } else {
    androidInspection = input.inspection;
    lines = androidLines(androidInspection);
    subtotal = new Intl.NumberFormat('en-IN', {
      currency: androidInspection.subtotal.currency,
      maximumFractionDigits: 2,
      style: 'currency',
    }).format(androidInspection.subtotal.amount);
  }
  const itemCount = lines.reduce(
    (sum, line) => sum + (line.quantity ?? 1),
    0,
  );
  const ambiguous = lines.some((line) => (line.conflicts?.length ?? 0) > 0);
  const awaitingChoice = input.persistedInteraction !== undefined;
  const speech = ambiguous
    ? 'I found conflicting cart details. Please review your cart or stop.'
    : empty
      ? 'Your cart is empty. No order has been placed.'
      : [
          `All ${itemCount} ${itemCount === 1 ? 'item is' : 'items are'} in your cart.`,
          subtotal ? `The subtotal is ${subtotal}.` : undefined,
          awaitingChoice
            ? 'Would you like to review your cart, keep shopping, review checkout, or stop?'
            : 'No order has been placed.',
        ].filter(Boolean).join(' ');
  const safePresentation = ambiguous
    ? ambiguousPresentation(speech)
    : androidInspection
      ? {
          version: 1 as const,
          mode: 'success' as const,
          primarySurface: 'overlay_card' as const,
          card: {
            type: 'cart_summary' as const,
            ordered: false as const,
            cart: {
              verified: true as const,
              lines: androidInspection.lines,
              subtotal: androidInspection.subtotal,
              addressLabel: androidInspection.addressLabel,
            },
          },
          spoken: {
            languageCode: 'en-IN',
            text: speech,
          },
          behavior: {
            autoCollapse: false,
            keepVisibleWhileSpeaking: true,
          },
        }
      : voiceInspection
        ? voicePresentation(voiceInspection, speech, empty)
        : compactPresentation(speech, empty);

  return {
    dedupeKey: input.operationId
      ? ambiguous
        ? `${input.operationId}:cart-summary:ambiguous`
        : awaitingChoice
          ? `${input.operationId}:cart-summary:${input.persistedInteraction?.interactionId}`
          : `${input.operationId}:terminal:completed`
      : `final-cart-summary:${input.taskRevision}`,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}),
    kind: ambiguous
      ? 'ambiguous'
      : awaitingChoice
        ? 'waiting_for_user'
        : 'completed',
    ...(!ambiguous && !awaitingChoice ? { terminal: true } : {}),
    title: ambiguous
      ? 'Cart details need review'
      : empty
        ? 'Your cart is empty'
        : 'Your cart is ready',
    detail: ambiguous
      ? 'Pack-size or price evidence conflicts with the requested cart.'
      : empty
        ? 'A fresh read-only cart inspection found no items.'
        : `${lines.length} cart line${lines.length === 1 ? '' : 's'} verified`
          + `${subtotal ? ` · Subtotal ${subtotal}` : ''}.`,
    finalCartSummary: {
      status: ambiguous ? 'ambiguous' : empty ? 'empty' : 'ready',
      lines,
      ...(subtotal ? { subtotal } : {}),
      inspectedAt,
    },
    announcement: {
      channel: 'speech_and_visual',
      text: speech,
    },
    ...(input.persistedInteraction
      ? { interaction: structuredClone(input.persistedInteraction) }
      : {}),
    safePresentation,
  };
}
