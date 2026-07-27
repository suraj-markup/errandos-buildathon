/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest';
import type {
  RapidoAndroidWorkerRequestV1,
  RapidoAndroidWorkerResponseV1,
  PrincipalId,
} from '@errandos/contracts';
import {
  AndroidRapidoAdapter,
  commitRapidoRideOnce,
  parseRapidoRideOptions,
  reconcileRapidoRide,
  type AndroidCommitRecord,
  type AndroidCommitStore,
  type DurableProviderState,
  type RapidoAndroidWorkerPort,
} from '../src/index.js';

const owner = 'owner' as PrincipalId;
const ride = {
  pickupReference: 'pickup_indiranagar',
  pickupSummary: 'Indiranagar',
  dropoffReference: 'dropoff_airport',
  dropoffSummary: 'Kempegowda Airport',
  rideOption: { id: 'option_prime', name: 'Prime Sedan' },
  fareMinimum: { currency: 'INR' as const, amount: 850 },
  fareMaximum: { currency: 'INR' as const, amount: 920 },
  fees: [],
  pickupEtaMinutes: 6,
  paymentMode: 'cash' as const,
  providerFingerprint: 'a'.repeat(64),
};

class State implements DurableProviderState {
  public value?: unknown;
  public async put(_owner: PrincipalId, value: unknown): Promise<string> { this.value = value; return 'state-1'; }
  public async get(): Promise<unknown> { return this.value; }
  public async replace(_owner: PrincipalId, _reference: string, value: unknown): Promise<void> { this.value = value; }
}

class Worker implements RapidoAndroidWorkerPort {
  public readonly requests: RapidoAndroidWorkerRequestV1[] = [];
  public constructor(private readonly respond: (request: RapidoAndroidWorkerRequestV1) => RapidoAndroidWorkerResponseV1) {}
  public async executeRapido(request: RapidoAndroidWorkerRequestV1): Promise<RapidoAndroidWorkerResponseV1> {
    this.requests.push(request);
    return this.respond(request);
  }
}

class CommitStore implements AndroidCommitStore {
  public record?: AndroidCommitRecord;
  public async get(): Promise<AndroidCommitRecord | undefined> { return this.record; }
  public async recordDispatch(record: AndroidCommitRecord): Promise<{ created: boolean; record: AndroidCommitRecord }> {
    if (this.record) return { created: false, record: this.record };
    this.record = record;
    return { created: true, record };
  }
  public async recordOutcome(_key: string, state: 'committed' | 'ambiguous', providerReference?: string): Promise<void> {
    this.record = { ...this.record!, state, ...(providerReference ? { providerReference } : {}) };
  }
}

describe('Rapido Android rides', () => {
  it('parses semantic ride choices without exposing raw UI data', () => {
    const options = parseRapidoRideOptions([
      '<node text="Prime Sedan"/>',
      '<node text="6 mins"/>',
      '<node content-desc="₹850 - ₹920"/>',
      '<node text="Auto"/>',
      '<node text="3 min"/>',
      '<node text="₹240"/>',
    ].join(''));
    expect(options).toMatchObject([
      { name: 'Prime Sedan', fareMinimum: { amount: 850 }, fareMaximum: { amount: 920 }, pickupEtaMinutes: 6 },
      { name: 'Auto', fareMinimum: { amount: 240 }, fareMaximum: { amount: 240 }, pickupEtaMinutes: 3 },
    ]);
    expect(JSON.stringify(options)).not.toMatch(/selector|coordinate|screenshot|xml|hierarchy/i);
  });

  it('gates app mutation and stores an immutable exact-term ride proposal', async () => {
    const worker = new Worker(() => ({ version: 1, operation: 'rapido_prepare_ride', status: 'prepared', ride }));
    const state = new State();
    const input = {
      version: 1 as const,
      accountKey: 'main',
      pickup: { query: 'Indiranagar' },
      dropoff: { query: 'Kempegowda Airport' },
      rideOptionId: 'option_prime',
      paymentMode: 'cash' as const,
    };
    await expect(new AndroidRapidoAdapter(worker, state).prepareRide(owner, input))
      .rejects.toThrow('live Android actions are disabled');
    const adapter = new AndroidRapidoAdapter(worker, state, {
      actionsEnabled: true,
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const prepared = await adapter.prepareRide(owner, input);
    expect(prepared.snapshot).toMatchObject({
      kind: 'ride',
      provider: 'rapido',
      principalId: owner,
      route: { pickupSummary: 'Indiranagar', dropoffSummary: 'Kempegowda Airport' },
      fare: { minimum: { amount: 850 }, maximum: { amount: 920 } },
      paymentMode: 'cash',
      quoteExpiresAt: '2026-07-26T10:05:00.000Z',
    });
    expect(worker.requests).toHaveLength(1);
  });

  it('reserves the final action once and treats an unverified result as permanently ambiguous', async () => {
    const expected = {
      proposalId: 'proposal_rapido',
      proposalHash: 'b'.repeat(64),
      idempotencyKey: 'rapido-request-123',
      preparedAt: '2026-07-26T10:00:00.000Z',
      expiresAt: '2026-07-26T10:05:00.000Z',
      ride,
    };
    const store = new CommitStore();
    let clicks = 0;
    const dependencies = {
      store,
      readRide: async () => ride,
      clickFinal: async () => { clicks += 1; },
      readConfirmation: async () => ({ status: 'unverified' as const }),
      now: () => new Date('2026-07-26T10:01:00.000Z'),
    };
    await expect(commitRapidoRideOnce(expected, dependencies)).resolves.toEqual({ outcome: 'ambiguous' });
    await expect(commitRapidoRideOnce(expected, dependencies)).resolves.toEqual({ outcome: 'ambiguous' });
    expect(clicks).toBe(1);
  });

  it('reconciles only one exact route/type candidate', () => {
    const expected = {
      proposalId: 'proposal_rapido',
      proposalHash: 'b'.repeat(64),
      idempotencyKey: 'rapido-request-123',
      preparedAt: '2026-07-26T10:00:00.000Z',
      expiresAt: '2026-07-26T10:05:00.000Z',
      ride,
    };
    const trip = {
      tripReference: 'RAPIDO12345',
      pickupSummary: 'Indiranagar',
      dropoffSummary: 'Kempegowda Airport',
      rideType: 'Prime Sedan',
      requestedAt: '2026-07-26T10:02:00.000Z',
      providerStatus: 'confirmed',
    };
    expect(reconcileRapidoRide(expected, [trip])).toEqual({ outcome: 'committed', providerReference: 'RAPIDO12345' });
    expect(reconcileRapidoRide(expected, [trip, { ...trip, tripReference: 'RAPIDO67890' }])).toEqual({ outcome: 'pending' });
  });
});
