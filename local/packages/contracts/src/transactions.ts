import { z } from 'zod';
import { MoneySchema, TransactionProviderSchema } from './proposals.js';

const OpaqueId = z.string().min(1).max(200);
export const GroceryItemSchema = z.object({
  query: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(20),
  offerId: OpaqueId.optional(),
}).strict();
export const PrepareGroceryInputSchemaV1 = z.object({ version:z.literal(1).default(1), provider:z.literal('blinkit'), accountKey:OpaqueId, items:z.array(GroceryItemSchema).min(1).max(30), deliveryAddressRef:OpaqueId, deliveryAddressLabel:z.string().trim().min(1).max(240).optional(), paymentMode:z.enum(['cod','provider_saved']).default('cod') }).strict();
export const PrepareExistingGroceryInputSchemaV1 = z.object({ version:z.literal(1).default(1), provider:z.literal('blinkit'), accountKey:OpaqueId, paymentMode:z.literal('cod').default('cod') }).strict();
const RideLocationSchema = z.object({ query:z.string().trim().min(2).max(240) }).strict();
export const PrepareRapidoInputSchemaV1 = z.object({ version:z.literal(1).default(1), accountKey:OpaqueId, pickup:RideLocationSchema, dropoff:RideLocationSchema, rideOptionId:OpaqueId.optional(), rideType:z.string().trim().min(1).max(120).optional(), paymentMode:z.enum(['cash','provider_saved']).default('cash') }).strict().superRefine((value,context)=>{if((value.rideOptionId===undefined)===(value.rideType===undefined))context.addIssue({code:'custom',path:['rideOptionId'],message:'provide exactly one of rideOptionId or rideType'});});
export const ProposalStatusSchema = z.enum(['prepared','approval_required','stale','committing','committed','ambiguous','failed']);
export const ProposalSummarySchemaV1 = z.object({ kind:z.enum(['grocery','ride']), description:z.string().min(1), items:z.array(z.object({ name:z.string().min(1), quantity:z.number().int().positive(), unitPrice:MoneySchema.optional(), lineTotal:MoneySchema.optional() }).strict()).max(30).optional(), unavailableItems:z.array(z.object({query:z.string().min(1),reason:z.enum(['out_of_stock','not_found','ambiguous'])}).strict()).max(30).optional(), fees:z.array(z.object({kind:z.string().min(1),label:z.string().min(1),amount:MoneySchema}).strict()).max(30).optional(), total:MoneySchema.optional(), fareMin:MoneySchema.optional(), fareMax:MoneySchema.optional(), etaMinutes:z.number().int().nonnegative().optional(), paymentMode:z.string().min(1), addressSummary:z.string().min(1), pickupSummary:z.string().min(1).optional(), dropoffSummary:z.string().min(1).optional(), rideType:z.string().min(1).optional() }).strict();
export const ProposalOutputSchemaV1 = z.object({ version:z.literal(1), proposalId:OpaqueId, provider:TransactionProviderSchema, status:ProposalStatusSchema, proposalHash:z.string().regex(/^[a-f0-9]{64}$/), summary:ProposalSummarySchemaV1, expiresAt:z.string().datetime(), requiresExternalApproval:z.boolean() }).strict();
export const ProposalRefInputSchemaV1 = z.object({ version:z.literal(1).default(1), proposalId:OpaqueId }).strict();
export const PlaceCodOrderInputSchemaV1 = ProposalRefInputSchemaV1.extend({ idempotencyKey:z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/) }).strict();
export const CommitInputSchemaV1 = ProposalRefInputSchemaV1.extend({ approvalCapability:z.string().min(20).max(4096), idempotencyKey:z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/) }).strict();
export const CommitOutputObjectSchemaV1 = z.object({ version:z.literal(1), proposalId:OpaqueId, status:z.enum(['committed','ambiguous','approval_required','stale']), receiptId:OpaqueId.optional(), providerReference:OpaqueId.optional(), reconciliationRequired:z.boolean() }).strict();
export const CommitOutputSchemaV1 = CommitOutputObjectSchemaV1.superRefine((value,context)=>{if(value.status==='committed'&&!value.providerReference)context.addIssue({code:z.ZodIssueCode.custom,path:['providerReference'],message:'committed status requires a verified provider reference'});});
export type PrepareGroceryInput=z.infer<typeof PrepareGroceryInputSchemaV1>;
export type PrepareExistingGroceryInput=z.infer<typeof PrepareExistingGroceryInputSchemaV1>;
export type PrepareRapidoInput=z.infer<typeof PrepareRapidoInputSchemaV1>;
export type ProposalOutput=z.infer<typeof ProposalOutputSchemaV1>;
export type PlaceCodOrderInput=z.infer<typeof PlaceCodOrderInputSchemaV1>;
export type CommitInput=z.infer<typeof CommitInputSchemaV1>;
export type CommitOutput=z.infer<typeof CommitOutputSchemaV1>;
