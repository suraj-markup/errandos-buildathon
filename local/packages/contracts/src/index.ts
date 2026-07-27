import { z } from 'zod';

export const ErrandIdSchema = z.string().min(1).brand('ErrandId');
export const HealthSchema = z.object({ status: z.literal('ok') });
export const HealthInputSchema = z.object({ includeService: z.literal(true).optional() }).strict();
export const HealthOutputSchema = z.object({ service: z.literal('errandos-control-plane'), status: z.literal('ok') }).strict();
export const OperationNameSchema = z.enum(['read-health', 'search-products']);
export type OperationName = z.infer<typeof OperationNameSchema>;
export const CapabilitySchema = z.discriminatedUnion('status', [z.object({ status: z.literal('available') }), z.object({ status: z.literal('unavailable'), reason: z.enum(['not-configured', 'out-of-scope']) })]);

const OpaqueId = z.string().min(1).max(200);
export const PrincipalIdSchema = OpaqueId.brand('PrincipalId');
export const ProviderSessionIdSchema = OpaqueId.brand('ProviderSessionId');
export const ProfileReferenceSchema = OpaqueId.brand('ProfileReference');
export const ProviderIdSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('known'), value: z.enum(['blinkit', 'rapido']) }).strict(),
  z.object({ kind: z.literal('custom'), value: z.string().regex(/^[a-z][a-z0-9_-]{1,62}$/) }).strict(),
]);
export const SessionStatusSchema = z.enum(['missing', 'login_required', 'authenticating', 'active', 'challenge_required', 'expired', 'revoked', 'error']);
export const AuthMethodSchema = z.enum(['password', 'magic_link', 'oauth', 'device_code', 'provider_managed']);
export const ChallengeTypeSchema = z.enum(['otp', 'captcha', 'approval', 'security_question', 'provider_managed']);
export const AccountDisplaySchema = z.object({ label: z.string().min(1).max(100), hint: z.string().max(100).optional() }).strict();
export const ProviderSessionSchemaV1 = z.object({
  version: z.literal(1), id: ProviderSessionIdSchema, principalId: PrincipalIdSchema, provider: ProviderIdSchema,
  accountKey: z.string().min(1).max(200), status: SessionStatusSchema, authMethod: AuthMethodSchema.optional(),
  profileReference: ProfileReferenceSchema.optional(), accountDisplay: AccountDisplaySchema.optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(),
}).strict();
export const ProviderAuthStatusInputSchemaV1 = z.object({ version: z.literal(1).default(1), provider: ProviderIdSchema, accountKey: z.string().min(1).max(200) }).strict();
export const ProviderAuthStatusOutputSchemaV1 = z.object({ version: z.literal(1), provider: ProviderIdSchema, accountKey: z.string(), status: SessionStatusSchema, accountDisplay: AccountDisplaySchema.optional(), expiresAt: z.string().datetime().optional() }).strict();
export const ProviderBeginLoginInputSchemaV1 = ProviderAuthStatusInputSchemaV1.extend({ phone: z.string().regex(/^\d{10}$/) }).strict();
export const ProviderBeginLoginOutputSchemaV1 = z.object({ version: z.literal(1), sessionId: ProviderSessionIdSchema, provider: ProviderIdSchema, accountKey: z.string(), status: z.enum(['otp_sent', 'active']) }).strict();
export const ProviderSubmitOtpInputSchemaV1 = ProviderAuthStatusInputSchemaV1.extend({ otp: z.string().regex(/^\d{4,8}$/) }).strict();
export const ProviderSubmitOtpOutputSchemaV1 = z.object({ version: z.literal(1), sessionId: ProviderSessionIdSchema, provider: ProviderIdSchema, accountKey: z.string(), status: SessionStatusSchema }).strict();
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export type ProviderSession = z.infer<typeof ProviderSessionSchemaV1>;
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type AuthMethod = z.infer<typeof AuthMethodSchema>;
export type ChallengeType = z.infer<typeof ChallengeTypeSchema>;
export type ProviderAuthStatusInput = z.infer<typeof ProviderAuthStatusInputSchemaV1>;
export type ProviderAuthStatusOutput = z.infer<typeof ProviderAuthStatusOutputSchemaV1>;
export type ProviderBeginLoginInput = z.infer<typeof ProviderBeginLoginInputSchemaV1>;
export type ProviderBeginLoginOutput = z.infer<typeof ProviderBeginLoginOutputSchemaV1>;
export type ProviderSubmitOtpInput = z.infer<typeof ProviderSubmitOtpInputSchemaV1>;
export type ProviderSubmitOtpOutput = z.infer<typeof ProviderSubmitOtpOutputSchemaV1>;
export type Capability = z.infer<typeof CapabilitySchema>; export type ErrandId = z.infer<typeof ErrandIdSchema>; export type Health = z.infer<typeof HealthSchema>; export type HealthOutput = z.infer<typeof HealthOutputSchema>;

export const ProductSearchInputSchemaV1 = z.object({ version:z.literal(1).default(1), request:z.string().trim().min(2).max(1_000), deliveryPincode:z.string().regex(/^\d{6}$/), budgetMax:z.number().positive().finite().optional(), neededBy:z.string().trim().min(1).max(100).optional(), limit:z.number().int().min(1).max(10).default(3) }).strict();
export const ProductOfferSchemaV1 = z.object({ title:z.string().min(1), platform:z.string().min(1), price:z.number().nonnegative().finite().optional(), delivery:z.string().min(1).optional(), url:z.string().url().optional(), image:z.string().url().optional(), reason:z.string().min(1).optional() }).strict();
export const ProductSearchOutputSchemaV1 = z.object({ version:z.literal(1), status:z.enum(['completed','no_results']), offers:z.array(ProductOfferSchemaV1).max(10), searchedPlatforms:z.number().int().nonnegative(), failedPlatforms:z.number().int().nonnegative() }).strict();
export type ProductSearchInput = z.infer<typeof ProductSearchInputSchemaV1>;
export type ProductSearchOutput = z.infer<typeof ProductSearchOutputSchemaV1>;
export type ProductOffer = z.infer<typeof ProductOfferSchemaV1>;

// Focused transaction modules preserve the package's existing root exports.
export * from './proposals.js';
export * from './approvals.js';
export * from './lifecycle.js';
export * from './transactions.js';
export * from './android-worker.js';
export * from './blinkit-tools.js';
export * from './rapido-android-worker.js';
export * from './rapido-tools.js';

export const AuthChallengeOutputSchemaV1 = z.object({ version:z.literal(1), sessionId:ProviderSessionIdSchema, status:SessionStatusSchema, challenge:ChallengeTypeSchema.optional(), message:z.string().min(1).max(300) }).strict();
