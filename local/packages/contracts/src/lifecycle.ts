import { z } from 'zod';
import { TransactionProviderSchema } from './proposals.js';

const OpaqueId = z.string().min(1).max(200);
export const LifecyclePhaseSchema = z.enum(['search', 'login', 'preparation', 'approval', 'commit', 'reconciliation']);
export const LifecycleEventKindSchema = z.enum([
  'search_started', 'search_completed', 'search_failed', 'login_required', 'login_started', 'login_challenge', 'login_completed', 'login_failed',
  'preparation_started', 'proposal_prepared', 'preparation_failed', 'approval_required', 'approval_granted', 'approval_rejected', 'approval_expired',
  'commit_started', 'commit_succeeded', 'commit_ambiguous', 'commit_failed', 'reconciliation_started', 'reconciliation_pending', 'reconciliation_succeeded', 'reconciliation_failed',
]);
export const RedactedDisplayPayloadSchemaV1 = z.object({
  title: z.string().trim().min(1).max(120), message: z.string().trim().min(1).max(500), provider: TransactionProviderSchema.optional(),
  proposalId: OpaqueId.optional(), status: z.string().trim().min(1).max(80).optional(),
}).strict();
const EventEnvelopeSchema = z.object({
  version: z.literal(1), operationId: OpaqueId, eventId: OpaqueId, sequence: z.number().int().nonnegative(), occurredAt: z.string().datetime(),
  kind: LifecycleEventKindSchema, phase: LifecyclePhaseSchema, terminal: z.boolean(), retryable: z.boolean(), display: RedactedDisplayPayloadSchemaV1,
}).strict();
type EventKind = z.infer<typeof LifecycleEventKindSchema>;
type Phase = z.infer<typeof LifecyclePhaseSchema>;
const EVENT_SHAPES: Record<EventKind, readonly [Phase, boolean, boolean]> = {
  search_started: ['search', false, false], search_completed: ['search', true, false], search_failed: ['search', true, true],
  login_required: ['login', false, true], login_started: ['login', false, false], login_challenge: ['login', false, true], login_completed: ['login', true, false], login_failed: ['login', true, true],
  preparation_started: ['preparation', false, false], proposal_prepared: ['preparation', false, false], preparation_failed: ['preparation', true, true],
  approval_required: ['approval', false, false], approval_granted: ['approval', true, false], approval_rejected: ['approval', true, false], approval_expired: ['approval', true, false],
  commit_started: ['commit', false, false], commit_succeeded: ['commit', true, false], commit_ambiguous: ['commit', true, true], commit_failed: ['commit', true, true],
  reconciliation_started: ['reconciliation', false, false], reconciliation_pending: ['reconciliation', false, true], reconciliation_succeeded: ['reconciliation', true, false], reconciliation_failed: ['reconciliation', true, true],
};
export const LifecycleEventSchemaV1 = EventEnvelopeSchema.superRefine((event, context) => {
  const [phase, terminal, retryable] = EVENT_SHAPES[event.kind];
  if (event.phase !== phase) context.addIssue({ code: 'custom', path: ['phase'], message: `phase must be ${phase} for ${event.kind}` });
  if (event.terminal !== terminal) context.addIssue({ code: 'custom', path: ['terminal'], message: `terminal must be ${terminal} for ${event.kind}` });
  if (event.retryable !== retryable) context.addIssue({ code: 'custom', path: ['retryable'], message: `retryable must be ${retryable} for ${event.kind}` });
});
export type LifecyclePhase = z.infer<typeof LifecyclePhaseSchema>;
export type LifecycleEventV1 = z.infer<typeof LifecycleEventSchemaV1>;
export type RedactedDisplayPayloadV1 = z.infer<typeof RedactedDisplayPayloadSchemaV1>;
