import {
  RapidoAndroidRideReviewSchemaV1,
  RapidoExpectedRideSchemaV1,
  RapidoReadinessOutputSchemaV1,
  RapidoRecentTripsOutputSchemaV1,
  RapidoRideOptionSchemaV1,
  RideProposalSnapshotSchemaV1,
  type RapidoAndroidRideReviewV1,
  type RapidoExpectedRideV1,
  type RapidoProposalChangeV1,
  type RapidoQuoteRidesOutputV1,
  type RapidoReadinessOutputV1,
  type RapidoRecentTripsOutputV1,
  type PrepareRapidoInput,
  type PrincipalId,
} from '@errandos/contracts';
import type {
  CommitDispatchContext,
  CommitResult,
  PreparedProviderState,
  TransactionProviderPort,
} from '@errandos/application';
import { AndroidWorkerOperationError, type RapidoAndroidWorkerPort } from '../android/worker-client.js';
import type { DurableProviderState } from '../runtime/provider-state.js';

interface StoredRapidoRide {
  version: 1;
  accountKey: string;
  preparedAt: string;
  expiresAt: string;
  ride: RapidoAndroidRideReviewV1;
  expected?: RapidoExpectedRideV1;
}

export interface AndroidRapidoAdapterOptions {
  actionsEnabled?: boolean;
  commitEnabled?: boolean;
  now?: () => Date;
  quoteTtlMs?: number;
}

export class AndroidRapidoAdapter implements TransactionProviderPort {
  private readonly now: () => Date;
  private readonly quoteTtlMs: number;

  public constructor(
    private readonly worker: RapidoAndroidWorkerPort,
    private readonly state: DurableProviderState,
    private readonly options: AndroidRapidoAdapterOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.quoteTtlMs = options.quoteTtlMs ?? 5 * 60_000;
  }

  public async readiness(accountKey: string): Promise<RapidoReadinessOutputV1> {
    const unavailable = (): RapidoReadinessOutputV1 => RapidoReadinessOutputSchemaV1.parse({
      version: 1,
      accountKey,
      status: 'unavailable',
      checks: [
        { component: 'control_plane', status: 'ready' },
        { component: 'worker', status: 'unavailable', reason: 'worker_unreachable' },
        { component: 'appium', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'emulator', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'rapido_app', status: 'unknown', reason: 'dependency_unavailable' },
        { component: 'authentication', status: 'unknown', reason: 'dependency_unavailable' },
      ],
    });
    try {
      const response = await this.worker.executeRapido({ version: 1, operation: 'rapido_readiness', accountKey });
      if (response.operation !== 'rapido_readiness' || response.status !== 'completed') return unavailable();
      const dependencies = response.dependencies;
      const checks: RapidoReadinessOutputV1['checks'] = [
        { component: 'control_plane', status: 'ready' },
        { component: 'worker', status: 'ready' },
        dependencies.appium === 'ready'
          ? { component: 'appium', status: 'ready' }
          : { component: 'appium', status: 'unavailable', reason: 'appium_unavailable' },
        dependencies.emulator === 'ready'
          ? { component: 'emulator', status: 'ready' }
          : dependencies.emulator === 'unavailable'
            ? { component: 'emulator', status: 'unavailable', reason: 'emulator_unavailable' }
            : { component: 'emulator', status: 'unknown', reason: 'dependency_unavailable' },
        dependencies.rapidoApp === 'ready'
          ? { component: 'rapido_app', status: 'ready' }
          : dependencies.rapidoApp === 'unavailable'
            ? { component: 'rapido_app', status: 'unavailable', reason: 'rapido_app_unavailable' }
            : { component: 'rapido_app', status: 'unknown', reason: 'dependency_unavailable' },
        dependencies.authentication === 'active'
          ? { component: 'authentication', status: 'ready' }
          : dependencies.authentication === 'login_required'
            ? { component: 'authentication', status: 'action_required', reason: 'login_required' }
            : dependencies.authentication === 'challenge_required'
              ? { component: 'authentication', status: 'action_required', reason: 'challenge_required' }
              : dependencies.authentication === 'device_verification_failed'
                ? { component: 'authentication', status: 'unavailable', reason: 'device_verification_failed' }
                : { component: 'authentication', status: 'unknown', reason: 'unexpected_provider_screen' },
      ];
      const status = checks.some((check) => check.status === 'unavailable' || check.status === 'unknown')
        ? 'unavailable'
        : checks.some((check) => check.status === 'action_required')
          ? 'action_required'
          : 'ready';
      return RapidoReadinessOutputSchemaV1.parse({ version: 1, accountKey, status, checks });
    } catch {
      return unavailable();
    }
  }

  public async quoteRides(
    accountKey: string,
    pickup: { query: string },
    dropoff: { query: string },
    limit: number,
  ): Promise<RapidoQuoteRidesOutputV1> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_quote_rides',
      accountKey,
      pickup,
      dropoff,
      limit,
    });
    if (response.status === 'error') throw workerError(response.stage);
    if (response.operation !== 'rapido_quote_rides' || response.status !== 'completed') throw new Error('Android Rapido quote failed');
    return {
      version: 1,
      status: response.options.length > 0 ? 'completed' : 'no_rides',
      pickupSummary: response.pickupSummary,
      dropoffSummary: response.dropoffSummary,
      options: response.options.map((option) => RapidoRideOptionSchemaV1.parse(option)),
    };
  }

  public async prepareRide(owner: PrincipalId, input: PrepareRapidoInput): Promise<PreparedProviderState> {
    if (!this.options.actionsEnabled) throw new Error('live Android actions are disabled');
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_prepare_ride',
      accountKey: input.accountKey,
      pickup: input.pickup,
      dropoff: input.dropoff,
      ...(input.rideOptionId ? { rideOptionId: input.rideOptionId } : {}),
      ...(input.rideType ? { rideType: input.rideType } : {}),
      paymentMode: input.paymentMode,
    });
    if (response.status === 'error') throw workerError(response.stage);
    if (response.operation !== 'rapido_prepare_ride' || response.status !== 'prepared') throw new Error('Android Rapido preparation failed');
    return this.createPreparedState(owner, input.accountKey, response.ride);
  }

  private async createPreparedState(
    owner: PrincipalId,
    accountKey: string,
    value: RapidoAndroidRideReviewV1,
  ): Promise<PreparedProviderState> {
    const ride = RapidoAndroidRideReviewSchemaV1.parse(value);
    const preparedAt = this.now();
    const expiresAt = new Date(preparedAt.getTime() + this.quoteTtlMs);
    const snapshot = RideProposalSnapshotSchemaV1.parse({
      version: 1,
      kind: 'ride',
      provider: 'rapido',
      principalId: owner,
      accountReference: accountKey,
      revision: 1,
      route: {
        pickupReference: ride.pickupReference,
        pickupSummary: ride.pickupSummary,
        dropoffReference: ride.dropoffReference,
        dropoffSummary: ride.dropoffSummary,
      },
      rideOption: ride.rideOption,
      fare: { minimum: ride.fareMinimum, maximum: ride.fareMaximum, fees: ride.fees },
      paymentMode: ride.paymentMode,
      ...(ride.pickupEtaMinutes !== undefined ? { etaMinutes: ride.pickupEtaMinutes } : {}),
      ...(ride.durationMinutes !== undefined ? { durationMinutes: ride.durationMinutes } : {}),
      providerFingerprint: ride.providerFingerprint,
      preparedAt: preparedAt.toISOString(),
      quoteExpiresAt: expiresAt.toISOString(),
    });
    const stored: StoredRapidoRide = {
      version: 1,
      accountKey,
      preparedAt: preparedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ride,
    };
    return { snapshot, providerStateRef: await this.state.put(owner, stored) };
  }

  public async compareRide(owner: PrincipalId, providerStateRef: string): Promise<{
    matches: boolean;
    changes: RapidoProposalChangeV1[];
    currentProviderFingerprint?: string;
  }> {
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_review_ride',
      accountKey: stored.accountKey,
      expected: stored.ride,
    });
    if (response.status === 'error') throw workerError(response.stage);
    if (response.operation !== 'rapido_review_ride' || response.status !== 'completed') {
      throw new Error('Android Rapido ride review failed');
    }
    return {
      matches: response.comparison.matches,
      changes: response.comparison.changes,
      ...(response.comparison.currentProviderFingerprint
        ? { currentProviderFingerprint: response.comparison.currentProviderFingerprint }
        : {}),
    };
  }

  public async commit(
    owner: PrincipalId,
    providerStateRef: string,
    context: CommitDispatchContext,
  ): Promise<CommitResult> {
    if (!this.options.actionsEnabled || !this.options.commitEnabled) throw new Error('live Android commit is disabled');
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    if (!context.providerFingerprint || context.providerFingerprint !== stored.ride.providerFingerprint) return { outcome: 'stale' };
    const expected = RapidoExpectedRideSchemaV1.parse({
      proposalId: context.proposalId,
      proposalHash: context.proposalHash,
      idempotencyKey: context.idempotencyKey,
      preparedAt: stored.preparedAt,
      expiresAt: stored.expiresAt,
      ride: stored.ride,
    });
    await this.state.replace(owner, providerStateRef, { ...stored, expected });
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_commit_once',
      accountKey: stored.accountKey,
      expected,
    });
    if (response.operation !== 'rapido_commit_once' || response.status === 'error') throw new Error('Android Rapido commit failed');
    return response.status === 'committed'
      ? { outcome: 'committed', providerReference: response.providerReference }
      : { outcome: response.status };
  }

  public async reconcile(owner: PrincipalId, providerStateRef: string): Promise<CommitResult | { outcome: 'pending' }> {
    const stored = parseStored(await this.state.get(owner, providerStateRef));
    if (!stored.expected) return { outcome: 'pending' };
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_reconcile',
      accountKey: stored.accountKey,
      expected: stored.expected,
    });
    if (response.operation !== 'rapido_reconcile' || response.status === 'error') return { outcome: 'pending' };
    return response.status === 'committed'
      ? { outcome: 'committed', providerReference: response.providerReference }
      : { outcome: 'pending' };
  }

  public async recentTrips(accountKey: string, limit: number): Promise<RapidoRecentTripsOutputV1> {
    const response = await this.worker.executeRapido({
      version: 1,
      operation: 'rapido_recent_trips',
      accountKey,
      limit,
    });
    if (response.status === 'error') throw workerError(response.stage);
    if (response.operation !== 'rapido_recent_trips' || response.status !== 'completed') throw new Error('Android Rapido recent trips failed');
    return RapidoRecentTripsOutputSchemaV1.parse({
      version: 1,
      status: response.trips.length > 0 ? 'completed' : 'empty',
      trips: response.trips,
    });
  }
}

function parseStored(value: unknown): StoredRapidoRide {
  if (typeof value !== 'object' || value === null) throw new Error('Android Rapido state invalid');
  const state = value as Partial<StoredRapidoRide>;
  if (
    state.version !== 1
    || typeof state.accountKey !== 'string'
    || typeof state.preparedAt !== 'string'
    || typeof state.expiresAt !== 'string'
    || !state.ride
  ) throw new Error('Android Rapido state invalid');
  return {
    version: 1,
    accountKey: state.accountKey,
    preparedAt: state.preparedAt,
    expiresAt: state.expiresAt,
    ride: RapidoAndroidRideReviewSchemaV1.parse(state.ride),
    ...(state.expected ? { expected: RapidoExpectedRideSchemaV1.parse(state.expected) } : {}),
  };
}

function workerError(stage: string): AndroidWorkerOperationError {
  return new AndroidWorkerOperationError(stage);
}
