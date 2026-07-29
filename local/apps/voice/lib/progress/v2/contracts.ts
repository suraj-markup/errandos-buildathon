import type { OverlayPresentationV1 } from '@errandos/contracts';
import type { LocalIdentifier } from '../../workflow/identifiers';
import type { CompanionIssueV2 } from './companion-issue';

export const taskEventKindsV2 = [
  'task_started',
  'step_started',
  'searching',
  'options_ready',
  'selection_accepted',
  'mutation_started',
  'mutation_verified',
  'moving_to_next_step',
  'reviewing_cart',
  'checkout_ready',
  'waiting_for_user',
  'blocked',
  'ambiguous',
  'completed',
  'cancelled',
] as const;

export type TaskEventKindV2 = (typeof taskEventKindsV2)[number];

/**
 * `completed` is the canonical v2 wire value. `task_completed` is accepted
 * only at the producer boundary for compatibility with the UX plan vocabulary.
 */
export const taskEventKindAliasesV2 = {
  task_completed: 'completed',
} as const;

export type TaskEventKindInputV2 =
  | TaskEventKindV2
  | keyof typeof taskEventKindAliasesV2;

export function canonicalTaskEventKindV2(
  kind: TaskEventKindInputV2,
): TaskEventKindV2 {
  return kind === 'task_completed' ? 'completed' : kind;
}

export type ItemPositionV2 = {
  current: number;
  total: number;
};

export const completionChoiceIdsV2 = [
  'review_cart',
  'add_more',
  'review_checkout',
  'use_current_payment',
  'use_cod',
  'stop',
] as const;

export type CompletionChoiceIdV2 =
  (typeof completionChoiceIdsV2)[number];

export type CompletionChoiceV2 = {
  choiceId: CompletionChoiceIdV2;
  enabled: boolean;
  label: string;
  disabledReason?: string;
};

export type CompletionChoicePromptV2 = {
  version: 2;
  interactionId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  expiresAt: number;
  currentPaymentLabel?: string;
  choices: CompletionChoiceV2[];
};

export type TaskEventAnnouncementV2 = {
  channel: 'speech_and_visual' | 'visual_only';
  text: string;
};

export type TaskEventItemV2 = {
  title: string;
  requestedLabel: string;
  packSize?: string;
  quantity?: number;
  price?: string;
  conflicts?: TaskItemConflictEvidenceV2[];
  index: number;
  total: number;
};

export type TaskItemConflictEvidenceV2 = {
  field: 'pack_size' | 'price';
  expected: string;
  observed: string;
};

export type TaskEventProgressV2 = {
  completed: number;
  total: number;
  nextLabel?: string;
};

export const queueItemCapabilityIdsV2 = [
  'refine',
  'remove',
  'skip',
  'move_up',
  'move_down',
] as const;

export type QueueItemCapabilityIdV2 =
  (typeof queueItemCapabilityIdsV2)[number];

export const queueTaskCapabilityIdsV2 = [
  'pause',
  'resume',
  'cancel',
] as const;

export type QueueTaskCapabilityIdV2 =
  (typeof queueTaskCapabilityIdsV2)[number];

export type AuthoritativeQueueStepProjectionV2 = {
  stepId: string;
  kind: string;
  status: string;
  capabilities: QueueItemCapabilityIdV2[];
};

/**
 * A bounded, presentation-safe projection of repository truth. It contains
 * only identifiers that the queue endpoint will accept; the device must never
 * derive a queue mutation identifier from checklist position or copy.
 */
export type AuthoritativeTaskQueueProjectionV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  revision: number;
  status: string;
  activeStepId?: string;
  inFlight: boolean;
  capabilities: QueueTaskCapabilityIdV2[];
  steps: AuthoritativeQueueStepProjectionV2[];
};

export type RecoveryInteractionV2 = {
  version: 2;
  interactionId: string;
  operationId: LocalIdentifier<'operation'>;
  stepId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  expiresAt: number;
};

export type FinalCartSummaryLineV2 = {
  productId?: string;
  title: string;
  spokenLabel?: string;
  packSize?: string;
  quantity?: number;
  price?: string;
  conflicts?: TaskItemConflictEvidenceV2[];
};

export type FinalCartSummaryV2 = {
  status: 'ready' | 'empty' | 'ambiguous';
  lines: FinalCartSummaryLineV2[];
  subtotal?: string;
  inspectedAt: number;
};

export type SemanticTaskEventV2 = {
  version: 2;
  eventId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  operationId?: LocalIdentifier<'operation'>;
  stepId?: string;
  sequence: number;
  kind: TaskEventKindV2;
  title: string;
  detail?: string;
  itemPosition?: ItemPositionV2;
  item?: TaskEventItemV2;
  progress?: TaskEventProgressV2;
  finalCartSummary?: FinalCartSummaryV2;
  terminal?: boolean;
  occurredAt: number;
  announcement?: TaskEventAnnouncementV2;
  interaction?: CompletionChoicePromptV2;
  issue?: CompanionIssueV2;
  recoveryInteraction?: RecoveryInteractionV2;
  safePresentation?: OverlayPresentationV1;
};

export type SemanticTaskEventDraftV2 = Omit<
  SemanticTaskEventV2,
  'eventId' | 'kind' | 'occurredAt' | 'sequence' | 'version'
> & {
  dedupeKey?: string;
  kind: TaskEventKindInputV2;
};

export type TaskEventStreamSnapshotV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  afterSequence: number;
  earliestSequence: number;
  latestSequence: number;
  resetRequired: boolean;
  events: SemanticTaskEventV2[];
  task?: AuthoritativeTaskQueueProjectionV2;
  snapshot?: TaskProjectionSnapshotV2;
  heartbeat?: TaskHeartbeatProjectionV2;
};

export type TaskProjectionSnapshotV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  latestSequence: number;
  latestEvent: SemanticTaskEventV2;
  items: TaskEventItemV2[];
  activeItem?: TaskEventItemV2;
  progress?: TaskEventProgressV2;
  finalCartSummary?: FinalCartSummaryV2;
  safePresentation?: OverlayPresentationV1;
  terminal: boolean;
  cancelled: boolean;
  updatedAt: number;
};

export type TaskHeartbeatProjectionV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  sourceSequence: number;
  elapsedMs: number;
  title: string;
  detail: string;
  announcement: {
    channel: 'visual_only';
    text: string;
  };
};

export type RetainedTaskEventStreamStateV2 = {
  version: 2;
  tasks: Array<{
    taskId: LocalIdentifier<'task'>;
    events: SemanticTaskEventV2[];
    dedupeEntries: Array<[string, number]>;
    latestSequence: number;
    latestRevision: number;
    terminalRevision?: number;
    items: TaskEventItemV2[];
    activeItem?: TaskEventItemV2;
    progress?: TaskEventProgressV2;
    finalCartSummary?: FinalCartSummaryV2;
    safePresentation?: OverlayPresentationV1;
    updatedAt: number;
  }>;
};

export type TaskEventCursorCheckpointV2 = {
  version: 2;
  taskId: LocalIdentifier<'task'>;
  afterSequence: number;
  latestRevision?: number;
  terminalRevision?: number;
};

export type OperationAcceptedV2 = {
  version: 2;
  status: 'accepted';
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  operationId: LocalIdentifier<'operation'>;
  acceptedAt: number;
  events: {
    afterSequence: number;
    taskId: LocalIdentifier<'task'>;
  };
  compatibility: {
    mode: 'bounded_synchronous';
    deadlineMs: number;
  };
};
