import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AndroidCheckoutReviewV1, AndroidExpectedCheckoutV1 } from '@errandos/contracts';

export type AndroidCommitState = 'dispatching' | 'committed' | 'ambiguous';

export interface AndroidCommitRecord {
  idempotencyKeyHash: string;
  proposalHash: string;
  providerFingerprint: string;
  state: AndroidCommitState;
  dispatchedAt: string;
  providerReference?: string;
}

export interface AndroidCommitStore {
  get(idempotencyKey: string): Promise<AndroidCommitRecord | undefined>;
  recordDispatch(record: AndroidCommitRecord): Promise<{ created: boolean; record: AndroidCommitRecord }>;
  recordOutcome(idempotencyKey: string, state: 'committed' | 'ambiguous', providerReference?: string): Promise<void>;
}

export type AndroidCommitResult =
  | { outcome: 'committed'; providerReference: string }
  | { outcome: 'stale' }
  | { outcome: 'ambiguous' };

export interface AndroidCommitDependencies {
  store: AndroidCommitStore;
  readCheckout(): Promise<AndroidCheckoutReviewV1>;
  clickFinal(): Promise<void>;
  readConfirmation(): Promise<{ status: 'committed'; providerReference: string } | { status: 'unverified' }>;
  now?: () => Date;
}

export interface AndroidOrderCandidate {
  providerReference: string;
  orderedAt: string;
  checkout: AndroidCheckoutReviewV1;
}

export interface AndroidReconcileDependencies {
  readOrders(): Promise<readonly AndroidOrderCandidate[]>;
}

export class FileAndroidCommitStore implements AndroidCommitStore {
  public constructor(private readonly root: string) {}

  public async get(idempotencyKey: string): Promise<AndroidCommitRecord | undefined> {
    return this.readByHash(hashIdempotencyKey(idempotencyKey));
  }

  public async recordDispatch(record: AndroidCommitRecord): Promise<{ created: boolean; record: AndroidCommitRecord }> {
    await this.ensureRoot();
    const path = this.path(record.idempotencyKeyHash);
    try {
      await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { created: true, record };
    } catch (error) {
      if (!isAlreadyExists(error)) throw new Error('Android commit_store_write failed');
      const existing = await this.readByHash(record.idempotencyKeyHash);
      if (!existing) throw new Error('Android commit_store_read failed');
      return { created: false, record: existing };
    }
  }

  public async recordOutcome(idempotencyKey: string, state: 'committed' | 'ambiguous', providerReference?: string): Promise<void> {
    const keyHash = hashIdempotencyKey(idempotencyKey);
    const existing = await this.readByHash(keyHash);
    if (!existing) throw new Error('Android commit_store_read failed');
    if (existing.state === 'committed' || existing.state === 'ambiguous') return;
    const next: AndroidCommitRecord = { ...existing, state, ...(providerReference ? { providerReference } : {}) };
    const temporary = join(this.root, `.${keyHash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path(keyHash));
    } catch {
      throw new Error('Android commit_store_write failed');
    }
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await chmod(this.root, 0o700);
    } catch {
      throw new Error('Android commit_store_init failed');
    }
  }

  private path(keyHash: string): string { return join(this.root, `${keyHash}.json`); }

  private async readByHash(keyHash: string): Promise<AndroidCommitRecord | undefined> {
    try {
      return parseRecord(JSON.parse(await readFile(this.path(keyHash), 'utf8')));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new Error('Android commit_store_read failed');
    }
  }
}

export async function commitOnce(expected: AndroidExpectedCheckoutV1, dependencies: AndroidCommitDependencies): Promise<AndroidCommitResult> {
  const existing = await dependencies.store.get(expected.idempotencyKey);
  if (existing) return resultFromRecord(existing);

  const now = (dependencies.now ?? ((): Date => new Date()))();
  const live = await dependencies.readCheckout();
  if (now.getTime() > Date.parse(expected.expiresAt) || !sameCheckout(live, expected.checkout)) {
    return { outcome: 'stale' };
  }

  const dispatch: AndroidCommitRecord = {
    idempotencyKeyHash: hashIdempotencyKey(expected.idempotencyKey),
    proposalHash: expected.proposalHash,
    providerFingerprint: expected.checkout.providerFingerprint,
    state: 'dispatching',
    dispatchedAt: now.toISOString(),
  };
  const reservation = await dependencies.store.recordDispatch(dispatch);
  if (!reservation.created) return resultFromRecord(reservation.record);

  try {
    await dependencies.clickFinal();
    const confirmation = await dependencies.readConfirmation();
    if (confirmation.status !== 'committed') {
      await dependencies.store.recordOutcome(expected.idempotencyKey, 'ambiguous');
      return { outcome: 'ambiguous' };
    }
    await dependencies.store.recordOutcome(expected.idempotencyKey, 'committed', confirmation.providerReference);
    return { outcome: 'committed', providerReference: confirmation.providerReference };
  } catch {
    await dependencies.store.recordOutcome(expected.idempotencyKey, 'ambiguous').catch(() => undefined);
    return { outcome: 'ambiguous' };
  }
}

export async function reconcileFromOrderHistory(
  expected: AndroidExpectedCheckoutV1,
  dependencies: AndroidReconcileDependencies,
): Promise<{ outcome: 'committed'; providerReference: string } | { outcome: 'pending' }> {
  const start = Date.parse(expected.preparedAt);
  const end = Date.parse(expected.expiresAt);
  const matches = (await dependencies.readOrders()).filter((order) => {
    const orderedAt = Date.parse(order.orderedAt);
    return Number.isFinite(orderedAt) && orderedAt >= start && orderedAt <= end && sameCheckout(order.checkout, expected.checkout);
  });
  if (matches.length !== 1) return { outcome: 'pending' };
  return { outcome: 'committed', providerReference: matches[0]!.providerReference };
}

function resultFromRecord(record: AndroidCommitRecord): AndroidCommitResult {
  if (record.state === 'committed' && record.providerReference) return { outcome: 'committed', providerReference: record.providerReference };
  return { outcome: 'ambiguous' };
}

function sameCheckout(left: AndroidCheckoutReviewV1, right: AndroidCheckoutReviewV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRecord(value: unknown): AndroidCommitRecord {
  if (typeof value !== 'object' || value === null) throw new Error('invalid record');
  const record = value as Record<string, unknown>;
  if (typeof record['idempotencyKeyHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['idempotencyKeyHash'])) throw new Error('invalid record');
  if (typeof record['proposalHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['proposalHash'])) throw new Error('invalid record');
  if (typeof record['providerFingerprint'] !== 'string' || !/^[a-f0-9]{64}$/.test(record['providerFingerprint'])) throw new Error('invalid record');
  if (record['state'] !== 'dispatching' && record['state'] !== 'committed' && record['state'] !== 'ambiguous') throw new Error('invalid record');
  if (typeof record['dispatchedAt'] !== 'string' || !Number.isFinite(Date.parse(record['dispatchedAt']))) throw new Error('invalid record');
  if (record['providerReference'] !== undefined && typeof record['providerReference'] !== 'string') throw new Error('invalid record');
  return {
    idempotencyKeyHash: record['idempotencyKeyHash'],
    proposalHash: record['proposalHash'],
    providerFingerprint: record['providerFingerprint'],
    state: record['state'],
    dispatchedAt: record['dispatchedAt'],
    ...(typeof record['providerReference'] === 'string' ? { providerReference: record['providerReference'] } : {}),
  };
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST';
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
