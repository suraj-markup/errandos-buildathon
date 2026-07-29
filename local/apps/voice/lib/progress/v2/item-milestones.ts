import type {
  SemanticTaskEventDraftV2,
  TaskEventItemV2,
} from './contracts';
import type { LocalIdentifier } from '../../workflow/identifiers';

export type ItemCompletionNextStepV2 =
  | { kind: 'search'; label: string; stepId?: string }
  | { kind: 'review_cart'; label?: string; stepId?: string }
  | { kind: 'wait_for_user'; label?: string; stepId?: string };

function label(value: string, field: string): string {
  const result = value.trim();
  if (!result || result.length > 100) {
    throw new Error(`${field} must contain 1 to 100 characters.`);
  }
  return result;
}

export function buildVerifiedItemCompletionEventsV2(input: {
  itemLabel: string;
  itemPosition?: { current: number; total: number };
  item?: Partial<
    Pick<
      TaskEventItemV2,
      'packSize' | 'price' | 'quantity' | 'requestedLabel'
    >
  >;
  next?: ItemCompletionNextStepV2;
  operationId: LocalIdentifier<'operation'>;
  stepId?: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
}): SemanticTaskEventDraftV2[] {
  const itemLabel = label(input.itemLabel, 'itemLabel');
  const item = input.itemPosition
    ? {
        title: itemLabel,
        requestedLabel: label(
          input.item?.requestedLabel ?? itemLabel,
          'item.requestedLabel',
        ),
        ...(input.item?.packSize
          ? { packSize: label(input.item.packSize, 'item.packSize') }
          : {}),
        ...(input.item?.quantity === undefined
          ? {}
          : { quantity: input.item.quantity }),
        ...(input.item?.price
          ? { price: label(input.item.price, 'item.price') }
          : {}),
        index: input.itemPosition.current,
        total: input.itemPosition.total,
      }
    : undefined;
  const nextLabel = input.next?.label
    ? label(input.next.label, 'next.label')
    : undefined;
  const announcementText = input.next?.kind === 'search' && nextLabel
    ? `${itemLabel} added to cart. Now looking for ${nextLabel}.`
    : input.next?.kind === 'review_cart'
      ? `${itemLabel} added to cart. Now reviewing your cart.`
      : input.next?.kind === 'wait_for_user'
        ? `${itemLabel} added to cart. What would you like to do next?`
        : `${itemLabel} added to cart.`;
  const verified: SemanticTaskEventDraftV2 = {
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    operationId: input.operationId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    kind: 'mutation_verified',
    title: `${itemLabel} added to cart`,
    detail: 'The requested cart state was verified.',
    ...(input.itemPosition ? { itemPosition: input.itemPosition } : {}),
    ...(item ? { item } : {}),
    ...(input.itemPosition
      ? {
          progress: {
            completed: input.itemPosition.current,
            total: input.itemPosition.total,
            ...(nextLabel ? { nextLabel } : {}),
          },
        }
      : {}),
    announcement: {
      channel: 'speech_and_visual',
      text: announcementText,
    },
    dedupeKey: `${input.operationId}:mutation_verified`,
  };
  return [verified];
}
