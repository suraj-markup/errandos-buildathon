import { z } from 'zod';
import { MoneySchema } from './proposals.js';
import { PlaceCodOrderInputSchemaV1, ProposalRefInputSchemaV1, ProposalStatusSchema } from './transactions.js';

const AccountKey = z.string().trim().min(1).max(200);
const Location = z.object({ query: z.string().trim().min(2).max(240) }).strict();
const Fee = z.object({
  kind: z.enum(['booking', 'surge', 'tax', 'discount', 'other']),
  label: z.string().trim().min(1).max(120),
  amount: MoneySchema,
}).strict();

export const RapidoAccountInputSchemaV1 = z.object({
  version: z.literal(1).default(1),
  accountKey: AccountKey,
}).strict();
export const RapidoBeginLoginInputSchemaV1 = RapidoAccountInputSchemaV1.extend({
  phone: z.string().regex(/^\d{10}$/),
}).strict();
export const RapidoSubmitOtpInputSchemaV1 = RapidoAccountInputSchemaV1.extend({
  otp: z.string().regex(/^\d{4,8}$/),
}).strict();
export const RapidoResendOtpInputSchemaV1 = RapidoAccountInputSchemaV1;

export const RapidoRideOptionSchemaV1 = z.object({
  rideOptionId: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  fareMinimum: MoneySchema,
  fareMaximum: MoneySchema,
  fees: z.array(Fee).max(30),
  pickupEtaMinutes: z.number().int().nonnegative().max(24 * 60).optional(),
  durationMinutes: z.number().int().positive().max(24 * 60).optional(),
  available: z.boolean(),
}).strict();
export const RapidoQuoteRidesInputSchemaV1 = RapidoAccountInputSchemaV1.extend({
  pickup: Location,
  dropoff: Location,
  limit: z.number().int().min(1).max(10).default(5),
}).strict();
export const RapidoQuoteRidesOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'no_rides']),
  pickupSummary: z.string().trim().min(1).max(240),
  dropoffSummary: z.string().trim().min(1).max(240),
  options: z.array(RapidoRideOptionSchemaV1).max(10),
}).strict();
export const RapidoPrepareRideInputObjectSchemaV1 = RapidoQuoteRidesInputSchemaV1.omit({ limit: true }).extend({
  rideOptionId: z.string().min(1).max(200).optional(),
  rideType: z.string().trim().min(1).max(120).optional(),
  paymentMode: z.enum(['cash', 'provider_saved']).default('cash'),
}).strict();
export const RapidoPrepareRideInputSchemaV1 = RapidoPrepareRideInputObjectSchemaV1.superRefine((value, context) => {
  if ((value.rideOptionId === undefined) === (value.rideType === undefined)) {
    context.addIssue({ code: 'custom', path: ['rideOptionId'], message: 'provide exactly one of rideOptionId or rideType' });
  }
});
export const RapidoCompareProposalInputSchemaV1 = RapidoAccountInputSchemaV1.extend({
  proposalId: z.string().min(1).max(200),
}).strict();
export const RapidoProposalChangeSchemaV1 = z.enum([
  'route',
  'ride_option',
  'fare',
  'fees',
  'pickup_eta',
  'duration',
  'payment_mode',
  'provider_fingerprint',
  'quote_expiry',
]);
export const RapidoCompareProposalOutputObjectSchemaV1 = z.object({
  version: z.literal(1),
  proposalId: z.string().min(1).max(200),
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  proposalStatus: ProposalStatusSchema,
  status: z.enum(['unchanged', 'changed', 'expired']),
  changes: z.array(RapidoProposalChangeSchemaV1),
  currentProviderFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const RapidoCompareProposalOutputSchemaV1 = RapidoCompareProposalOutputObjectSchemaV1;
export const RapidoRequestRideInputSchemaV1 = PlaceCodOrderInputSchemaV1;
export const RapidoRideStatusInputSchemaV1 = ProposalRefInputSchemaV1;
export const RapidoRecentTripsInputSchemaV1 = RapidoAccountInputSchemaV1.extend({
  limit: z.number().int().min(1).max(10).default(5),
}).strict();
export const RapidoRecentTripsOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.enum(['completed', 'empty']),
  trips: z.array(z.object({
    tripReference: z.string().min(1).max(200),
    pickupSummary: z.string().trim().min(1).max(240),
    dropoffSummary: z.string().trim().min(1).max(240),
    rideType: z.string().trim().min(1).max(120),
    fare: MoneySchema.optional(),
    requestedAt: z.string().datetime(),
    providerStatus: z.string().trim().min(1).max(120),
  }).strict()).max(10),
}).strict();

export const RapidoFailureReasonSchemaV1 = z.enum([
  'worker_unreachable',
  'appium_unavailable',
  'emulator_unavailable',
  'rapido_app_unavailable',
  'login_required',
  'challenge_required',
  'unexpected_provider_screen',
  'device_verification_failed',
  'location_invalid',
  'no_rides_available',
  'ride_option_unavailable',
  'quote_expired',
  'fare_changed',
  'payment_unavailable',
  'provider_timeout',
  'proposal_not_found',
  'proposal_not_comparable',
  'approval_required',
  'live_actions_disabled',
  'live_commit_disabled',
  'operation_failed',
]);
export const RapidoToolFailureOutputSchemaV1 = z.object({
  version: z.literal(1),
  status: z.literal('failed'),
  reason: RapidoFailureReasonSchemaV1,
  retryable: z.boolean(),
  suggestedAction: z.enum([
    'check_readiness',
    'connect_account',
    'choose_location',
    'choose_ride',
    'prepare_fresh_proposal',
    'use_trusted_approval',
    'stop',
  ]),
}).strict();
export const RapidoReadinessOutputSchemaV1 = z.object({
  version: z.literal(1),
  accountKey: AccountKey,
  status: z.enum(['ready', 'action_required', 'unavailable']),
  checks: z.array(z.object({
    component: z.enum(['control_plane', 'worker', 'appium', 'emulator', 'rapido_app', 'authentication']),
    status: z.enum(['ready', 'action_required', 'unavailable', 'unknown']),
    reason: z.enum([
      'worker_unreachable',
      'appium_unavailable',
      'emulator_unavailable',
      'rapido_app_unavailable',
      'login_required',
      'challenge_required',
      'dependency_unavailable',
      'unexpected_provider_screen',
      'device_verification_failed',
    ]).optional(),
  }).strict()).length(6),
}).strict();

export type RapidoAccountInputV1 = z.infer<typeof RapidoAccountInputSchemaV1>;
export type RapidoBeginLoginInputV1 = z.infer<typeof RapidoBeginLoginInputSchemaV1>;
export type RapidoSubmitOtpInputV1 = z.infer<typeof RapidoSubmitOtpInputSchemaV1>;
export type RapidoResendOtpInputV1 = z.infer<typeof RapidoResendOtpInputSchemaV1>;
export type RapidoRideOptionV1 = z.infer<typeof RapidoRideOptionSchemaV1>;
export type RapidoQuoteRidesInputV1 = z.infer<typeof RapidoQuoteRidesInputSchemaV1>;
export type RapidoQuoteRidesOutputV1 = z.infer<typeof RapidoQuoteRidesOutputSchemaV1>;
export type RapidoPrepareRideInputV1 = z.infer<typeof RapidoPrepareRideInputSchemaV1>;
export type RapidoCompareProposalOutputV1 = z.infer<typeof RapidoCompareProposalOutputSchemaV1>;
export type RapidoProposalChangeV1 = z.infer<typeof RapidoProposalChangeSchemaV1>;
export type RapidoRecentTripsOutputV1 = z.infer<typeof RapidoRecentTripsOutputSchemaV1>;
export type RapidoFailureReasonV1 = z.infer<typeof RapidoFailureReasonSchemaV1>;
export type RapidoToolFailureOutputV1 = z.infer<typeof RapidoToolFailureOutputSchemaV1>;
export type RapidoReadinessOutputV1 = z.infer<typeof RapidoReadinessOutputSchemaV1>;
