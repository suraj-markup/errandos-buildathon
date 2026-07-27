import { z } from 'zod';

const OpaqueId = z.string().min(1).max(200);
export const ApprovalRequestStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export const ApprovalReferenceSchemaV1 = z.object({
  version: z.literal(1),
  approvalRequestId: OpaqueId,
  principalId: OpaqueId,
  proposalId: OpaqueId,
  proposalRevision: z.number().int().positive(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: ApprovalRequestStatusSchema,
  expiresAt: z.string().datetime(),
}).strict();
export type ApprovalReferenceV1 = z.infer<typeof ApprovalReferenceSchemaV1>;
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

export const ApprovalBindingSchemaV1 = z.object({
  principalId: OpaqueId,
  proposalId: OpaqueId,
  proposalRevision: z.number().int().positive(),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
/** A one-time portal secret. It must never be persisted or logged in raw form. */
export const ApprovalPortalTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const ApprovalRequestCreatedSchemaV1 = z.object({
  version: z.literal(1),
  request: ApprovalReferenceSchemaV1,
  requestToken: ApprovalPortalTokenSchema,
}).strict();
export type ApprovalBindingV1 = z.infer<typeof ApprovalBindingSchemaV1>;
export type ApprovalRequestCreatedV1 = z.infer<typeof ApprovalRequestCreatedSchemaV1>;
