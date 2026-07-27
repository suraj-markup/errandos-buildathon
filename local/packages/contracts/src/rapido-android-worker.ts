import { z } from 'zod';
import { MoneySchema } from './proposals.js';
import { RapidoProposalChangeSchemaV1, RapidoRideOptionSchemaV1 } from './rapido-tools.js';

const Id = z.string().trim().min(1).max(240);
const Location = z.object({ query: z.string().trim().min(2).max(240) }).strict();
const SecretPhone = z.string().regex(/^\d{10}$/);
const SecretOtp = z.string().regex(/^\d{4,8}$/);
const Authentication = z.enum(['active', 'login_required', 'challenge_required']);
const Fee = z.object({
  kind: z.enum(['booking', 'surge', 'tax', 'discount', 'other']),
  label: z.string().trim().min(1).max(120),
  amount: MoneySchema,
}).strict();

export const RapidoAndroidRideReviewSchemaV1 = z.object({
  pickupReference: Id,
  pickupSummary: z.string().trim().min(1).max(240),
  dropoffReference: Id,
  dropoffSummary: z.string().trim().min(1).max(240),
  rideOption: z.object({ id: Id, name: z.string().trim().min(1).max(120) }).strict(),
  fareMinimum: MoneySchema,
  fareMaximum: MoneySchema,
  fees: z.array(Fee).max(30),
  pickupEtaMinutes: z.number().int().nonnegative().max(24 * 60).optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  paymentMode: z.enum(['cash', 'provider_saved']),
  providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const RapidoExpectedRideSchemaV1 = z.object({
  proposalId: Id,
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/),
  preparedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ride: RapidoAndroidRideReviewSchemaV1,
}).strict();
export const RapidoAndroidTripSchemaV1 = z.object({
  tripReference: Id,
  pickupSummary: z.string().trim().min(1).max(240),
  dropoffSummary: z.string().trim().min(1).max(240),
  rideType: z.string().trim().min(1).max(120),
  fare: MoneySchema.optional(),
  requestedAt: z.string().datetime(),
  providerStatus: z.string().trim().min(1).max(120),
}).strict();

const Operation = z.enum([
  'rapido_readiness',
  'rapido_auth_status',
  'rapido_begin_login',
  'rapido_submit_otp',
  'rapido_resend_otp',
  'rapido_quote_rides',
  'rapido_prepare_ride',
  'rapido_review_ride',
  'rapido_commit_once',
  'rapido_reconcile',
  'rapido_recent_trips',
]);

export const RapidoAndroidWorkerRequestSchemaV1 = z.union([
  z.object({ version: z.literal(1), operation: z.literal('rapido_readiness'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_auth_status'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_begin_login'), accountKey: Id, phone: SecretPhone }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_submit_otp'), accountKey: Id, otp: SecretOtp }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_resend_otp'), accountKey: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_quote_rides'), accountKey: Id, pickup: Location, dropoff: Location, limit: z.number().int().min(1).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_prepare_ride'), accountKey: Id, pickup: Location, dropoff: Location, rideOptionId: Id.optional(), rideType: z.string().trim().min(1).max(120).optional(), paymentMode: z.enum(['cash', 'provider_saved']) }).strict().superRefine((value, context) => {
    if ((value.rideOptionId === undefined) === (value.rideType === undefined)) context.addIssue({ code: 'custom', path: ['rideOptionId'], message: 'provide exactly one ride selector' });
  }),
  z.object({ version: z.literal(1), operation: z.literal('rapido_review_ride'), accountKey: Id, expected: RapidoAndroidRideReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_commit_once'), accountKey: Id, expected: RapidoExpectedRideSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_reconcile'), accountKey: Id, expected: RapidoExpectedRideSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_recent_trips'), accountKey: Id, limit: z.number().int().min(1).max(10) }).strict(),
]);

const ErrorResponse = z.object({
  version: z.literal(1),
  operation: Operation,
  status: z.literal('error'),
  stage: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
}).strict();
export const RapidoAndroidWorkerResponseSchemaV1 = z.union([
  z.object({ version: z.literal(1), operation: z.literal('rapido_readiness'), status: z.literal('completed'), dependencies: z.object({ appium: z.enum(['ready', 'unavailable']), emulator: z.enum(['ready', 'unavailable', 'unknown']), rapidoApp: z.enum(['ready', 'unavailable', 'unknown']), authentication: Authentication.or(z.enum(['unknown', 'device_verification_failed'])) }).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_auth_status'), status: Authentication }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_begin_login'), status: z.enum(['otp_sent', 'active']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_submit_otp'), status: z.enum(['active', 'challenge_required']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_resend_otp'), status: z.enum(['otp_sent', 'active']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_quote_rides'), status: z.literal('completed'), pickupSummary: z.string().trim().min(1).max(240), dropoffSummary: z.string().trim().min(1).max(240), options: z.array(RapidoRideOptionSchemaV1).max(10) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_prepare_ride'), status: z.literal('prepared'), ride: RapidoAndroidRideReviewSchemaV1 }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_review_ride'), status: z.literal('completed'), comparison: z.object({ matches: z.boolean(), changes: z.array(RapidoProposalChangeSchemaV1.exclude(['quote_expiry'])), currentProviderFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_commit_once'), status: z.literal('committed'), providerReference: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_commit_once'), status: z.enum(['stale', 'ambiguous']) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_reconcile'), status: z.literal('committed'), providerReference: Id }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_reconcile'), status: z.literal('pending') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('rapido_recent_trips'), status: z.literal('completed'), trips: z.array(RapidoAndroidTripSchemaV1).max(10) }).strict(),
  ErrorResponse,
]);

export type RapidoAndroidRideReviewV1 = z.infer<typeof RapidoAndroidRideReviewSchemaV1>;
export type RapidoExpectedRideV1 = z.infer<typeof RapidoExpectedRideSchemaV1>;
export type RapidoAndroidTripV1 = z.infer<typeof RapidoAndroidTripSchemaV1>;
export type RapidoAndroidWorkerRequestV1 = z.infer<typeof RapidoAndroidWorkerRequestSchemaV1>;
export type RapidoAndroidWorkerResponseV1 = z.infer<typeof RapidoAndroidWorkerResponseSchemaV1>;
