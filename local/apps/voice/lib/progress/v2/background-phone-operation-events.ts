import type {
  RecoveryInteractionV2,
  SemanticTaskEventV2,
} from './contracts';
import type { RetainedTaskEventStreamV2 } from './retained-task-event-stream';
import type {
  BackgroundPhoneOperationRecordV2,
} from '../../workflow/v2/background-phone-operation/contracts';
import {
  companionIssueForBackgroundOperationV2,
} from './companion-issue';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function completedAddDetails(
  operation: BackgroundPhoneOperationRecordV2,
): {
  label: string;
  packSize?: string;
  price?: string;
  quantity?: number;
  requestedLabel: string;
} | undefined {
  if (
    operation.status !== 'completed'
    || operation.operationKind !== 'add_cart_item'
  ) {
    return undefined;
  }
  const payload = record(operation.requestPayload);
  const action = record(payload?.['action']);
  const selectedOffer = record(action?.['selectedOffer']);
  const title = selectedOffer?.['title'];
  const requestedLabel = action?.['request'];
  if (
    payload?.['version'] !== 1
    || action?.['action'] !== 'add_cart_item'
    || typeof title !== 'string'
  ) {
    return undefined;
  }
  const exact = title.trim();
  if (!exact || exact.length > 160) return undefined;
  const packSize = selectedOffer?.['packSize'];
  const priceAmount = selectedOffer?.['priceAmount'];
  const quantity = action?.['quantity'];
  return {
    label: exact,
    requestedLabel:
      typeof requestedLabel === 'string' && requestedLabel.trim()
        ? requestedLabel.trim().slice(0, 100)
        : exact.slice(0, 100),
    ...(typeof packSize === 'string' && packSize.trim()
      ? { packSize: packSize.trim().slice(0, 100) }
      : {}),
    ...(typeof priceAmount === 'number' && Number.isFinite(priceAmount)
      ? {
          price: new Intl.NumberFormat('en-IN', {
            currency: 'INR',
            maximumFractionDigits: 2,
            style: 'currency',
          }).format(priceAmount),
        }
      : {}),
    ...(Number.isSafeInteger(quantity) && Number(quantity) > 0
      ? { quantity: Number(quantity) }
      : {}),
  };
}

function addedTitle(label: string): string {
  const suffix = ' added to cart';
  if (label.length + suffix.length <= 120) return `${label}${suffix}`;
  return `${label.slice(0, 120 - suffix.length - 1).trimEnd()}…${suffix}`;
}

export function publishBackgroundPhoneOperationTerminalEventV2(input: {
  operation: BackgroundPhoneOperationRecordV2;
  recoveryInteraction?: RecoveryInteractionV2;
  stream: RetainedTaskEventStreamV2;
}): SemanticTaskEventV2 {
  const { operation } = input;
  if (
    operation.status !== 'completed'
    && operation.status !== 'failed'
    && operation.status !== 'ambiguous'
  ) {
    throw new Error('A terminal operation is required.');
  }
  const failed = operation.status === 'failed';
  const ambiguous = operation.status === 'ambiguous';
  const issue = companionIssueForBackgroundOperationV2({
    operationKind: operation.operationKind,
    status: operation.status,
  });
  const added = completedAddDetails(operation);
  if (added) {
    return input.stream.publish({
      dedupeKey: `${operation.operationId}:mutation_verified`,
      taskId: operation.taskId,
      taskRevision: operation.taskRevision,
      operationId: operation.operationId,
      stepId: operation.stepId,
      kind: 'mutation_verified',
      title: addedTitle(added.label),
      detail: 'The requested cart state was verified.',
      announcement: {
        channel: 'speech_and_visual',
        text: `${added.label} added to cart.`,
      },
    });
  }
  return input.stream.publish({
    dedupeKey: input.recoveryInteraction
      ? `${operation.operationId}:recovery:${input.recoveryInteraction.interactionId}`
      : `${operation.operationId}:terminal:${operation.status}`,
    taskId: operation.taskId,
    taskRevision: operation.taskRevision,
    operationId: operation.operationId,
    stepId: operation.stepId,
    kind: operation.status === 'failed' ? 'blocked' : operation.status,
    title: issue?.title ?? (
      failed
        ? 'Phone operation failed'
        : ambiguous
          ? 'Phone operation needs reconciliation'
          : 'Phone operation completed'
    ),
    detail: issue?.detail ?? (
      failed
        ? 'The operation stopped without completing.'
        : ambiguous
          ? 'The result could not be verified safely.'
          : 'The operation completed successfully.'
    ),
    ...(issue ? { issue } : {}),
    ...(input.recoveryInteraction
      ? { recoveryInteraction: input.recoveryInteraction }
      : {}),
    announcement: {
      channel: 'speech_and_visual',
      text: issue
        ? `${issue.title}. ${issue.detail}`
        : failed
          ? 'The phone operation failed.'
          : ambiguous
            ? 'The phone operation needs verification.'
            : 'The phone operation is complete.',
    },
  });
}
