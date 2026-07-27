import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BlinkitCheckoutBlockedOutputSchemaV1,
  BlinkitOperationFailureReasonSchemaV1,
  BlinkitOperationStatusInputSchemaV1,
  BlinkitOperationStatusOutputSchemaV1,
  BlinkitRecentOperationsInputSchemaV1,
  BlinkitRecentOperationsOutputSchemaV1,
  BlinkitStartPrepareCodOrderInputSchemaV1,
  BlinkitStartPrepareCodOrderOutputSchemaV1,
  type BlinkitCheckoutBlockedOutputV1,
  type BlinkitOperationFailureReasonV1,
  type BlinkitOperationStatusInputV1,
  type BlinkitOperationStatusOutputV1,
  type BlinkitPrepareCodOrderInputV1,
  type BlinkitRecentOperationsInputV1,
  type BlinkitRecentOperationsOutputV1,
  type BlinkitStartPrepareCodOrderInputV1,
  type BlinkitStartPrepareCodOrderOutputV1,
  type PrincipalId,
  type ProposalOutput,
} from '@errandos/contracts';

type BlinkitOperationState = 'running' | 'completed' | 'blocked' | 'failed' | 'expired';

export interface BlinkitOperationRecord {
  version: 1;
  operationId: string;
  owner: PrincipalId;
  accountKey: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: BlinkitOperationState;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
  proposal?: ProposalOutput;
  reason?: BlinkitOperationFailureReasonV1;
  itemSubtotal?: number;
  requiredSubtotal?: number;
}

export interface BlinkitOperationRepository {
  createOrGet(record: BlinkitOperationRecord): Promise<{ created: boolean; record: BlinkitOperationRecord }>;
  get(operationId: string): Promise<BlinkitOperationRecord | undefined>;
  update(operationId: string, change: (record: BlinkitOperationRecord) => BlinkitOperationRecord): Promise<BlinkitOperationRecord>;
  list(owner: PrincipalId, accountKey: string, limit: number): Promise<BlinkitOperationRecord[]>;
}

export class BlinkitOperationNotFoundError extends Error {
  public constructor() { super('Blinkit operation not found'); this.name = 'BlinkitOperationNotFoundError'; }
}

export class BlinkitOperationIdempotencyConflictError extends Error {
  public constructor() { super('Blinkit operation idempotency key was reused for different terms'); this.name = 'BlinkitOperationIdempotencyConflictError'; }
}

export class InMemoryBlinkitOperationRepository implements BlinkitOperationRepository {
  private readonly records = new Map<string, BlinkitOperationRecord>();
  private readonly keys = new Map<string, string>();

  public async createOrGet(record: BlinkitOperationRecord): Promise<{ created: boolean; record: BlinkitOperationRecord }> {
    const key = operationKey(record.owner, record.accountKey, record.idempotencyKey);
    const existingId = this.keys.get(key);
    if (existingId) return { created: false, record: structuredClone(this.records.get(existingId)!) };
    this.records.set(record.operationId, structuredClone(record));
    this.keys.set(key, record.operationId);
    return { created: true, record: structuredClone(record) };
  }

  public async get(operationId: string): Promise<BlinkitOperationRecord | undefined> {
    const record = this.records.get(operationId);
    return record ? structuredClone(record) : undefined;
  }

  public async update(operationId: string, change: (record: BlinkitOperationRecord) => BlinkitOperationRecord): Promise<BlinkitOperationRecord> {
    const existing = this.records.get(operationId);
    if (!existing) throw new BlinkitOperationNotFoundError();
    const updated = change(structuredClone(existing));
    this.records.set(operationId, structuredClone(updated));
    return structuredClone(updated);
  }

  public async list(owner: PrincipalId, accountKey: string, limit: number): Promise<BlinkitOperationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.owner === owner && record.accountKey === accountKey)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
}

interface OperationIndex { operationId: string }

export class FileBlinkitOperationRepository implements BlinkitOperationRepository {
  private readonly root: string;

  public constructor(root: string) { this.root = resolve(root); }

  public async createOrGet(record: BlinkitOperationRecord): Promise<{ created: boolean; record: BlinkitOperationRecord }> {
    const indexPath = this.index(record.owner, record.accountKey, record.idempotencyKey);
    return this.withLock(`${indexPath}.lock`, async () => {
      const index = await readJson<OperationIndex>(indexPath);
      if (index) {
        const existing = await this.get(index.operationId);
        if (!existing) throw new BlinkitOperationNotFoundError();
        return { created: false, record: existing };
      }
      await secureWrite(this.record(record.operationId), record);
      await secureWrite(indexPath, { operationId: record.operationId } satisfies OperationIndex);
      return { created: true, record: structuredClone(record) };
    });
  }

  public async get(operationId: string): Promise<BlinkitOperationRecord | undefined> {
    return readJson(this.record(operationId));
  }

  public async update(operationId: string, change: (record: BlinkitOperationRecord) => BlinkitOperationRecord): Promise<BlinkitOperationRecord> {
    const path = this.record(operationId);
    return this.withLock(`${path}.lock`, async () => {
      const existing = await readJson<BlinkitOperationRecord>(path);
      if (!existing) throw new BlinkitOperationNotFoundError();
      const updated = change(existing);
      await secureWrite(path, updated);
      return structuredClone(updated);
    });
  }

  public async list(owner: PrincipalId, accountKey: string, limit: number): Promise<BlinkitOperationRecord[]> {
    const directory = join(this.root, 'records');
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const records = await Promise.all(names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => readJson<BlinkitOperationRecord>(join(directory, name))));
    return records
      .filter((record): record is BlinkitOperationRecord => Boolean(record && record.owner === owner && record.accountKey === accountKey))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }

  private record(operationId: string): string { return join(this.root, 'records', `${hash(operationId)}.json`); }
  private index(owner: PrincipalId, accountKey: string, idempotencyKey: string): string {
    return join(this.root, 'idempotency', `${hash(operationKey(owner, accountKey, idempotencyKey))}.json`);
  }

  private async withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = await open(path, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const details = await stat(path).catch(() => undefined);
        if (details && Date.now() - details.mtimeMs > 10_000) await unlink(path).catch(() => undefined);
        await new Promise((done) => setTimeout(done, 10));
      }
    }
    if (!handle) throw new Error('Blinkit operation repository busy');
    try { return await action(); } finally { await handle.close(); await unlink(path).catch(() => undefined); }
  }
}

export interface BlinkitOperationServiceOptions {
  now?: () => Date;
  ttlMs?: number;
  failureReason?: (error: unknown) => BlinkitOperationFailureReasonV1;
  blockedResult?: (error: unknown) => BlinkitCheckoutBlockedOutputV1 | undefined;
}

export class BlinkitOperationService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly failureReason: (error: unknown) => BlinkitOperationFailureReasonV1;
  private readonly blockedResult: (error: unknown) => BlinkitCheckoutBlockedOutputV1 | undefined;
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly repository: BlinkitOperationRepository,
    private readonly prepare: (owner: PrincipalId, input: BlinkitPrepareCodOrderInputV1) => Promise<ProposalOutput>,
    options: BlinkitOperationServiceOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
    this.ttlMs = options.ttlMs ?? 3 * 60_000;
    this.failureReason = options.failureReason ?? ((): BlinkitOperationFailureReasonV1 => 'operation_failed');
    this.blockedResult = options.blockedResult ?? ((): undefined => undefined);
  }

  public async startPrepareCodOrder(owner: PrincipalId, raw: BlinkitStartPrepareCodOrderInputV1): Promise<BlinkitStartPrepareCodOrderOutputV1> {
    const input = BlinkitStartPrepareCodOrderInputSchemaV1.parse(raw);
    const startedAt = this.now();
    const record: BlinkitOperationRecord = {
      version: 1,
      operationId: `operation_${randomUUID()}`,
      owner,
      accountKey: input.accountKey,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: requestFingerprint(input),
      status: 'running',
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + this.ttlMs).toISOString(),
    };
    const selected = await this.repository.createOrGet(record);
    if (selected.record.requestFingerprint !== record.requestFingerprint) throw new BlinkitOperationIdempotencyConflictError();
    if (selected.created) this.enqueue(selected.record, input);
    return BlinkitStartPrepareCodOrderOutputSchemaV1.parse({
      version: 1,
      operationId: selected.record.operationId,
      status: 'running',
      startedAt: selected.record.startedAt,
      updatedAt: selected.record.updatedAt,
      expiresAt: selected.record.expiresAt,
    });
  }

  public async getStatus(owner: PrincipalId, raw: BlinkitOperationStatusInputV1): Promise<BlinkitOperationStatusOutputV1> {
    const input = BlinkitOperationStatusInputSchemaV1.parse(raw);
    let record = await this.owned(owner, input.accountKey, input.operationId);
    if (record.status === 'running' && Date.parse(record.expiresAt) <= this.now().getTime()) {
      record = await this.repository.update(record.operationId, (current) => current.status === 'running'
        ? { ...current, status: 'expired', updatedAt: this.now().toISOString() }
        : current);
    }
    return render(record);
  }

  public async listRecent(owner: PrincipalId, raw: BlinkitRecentOperationsInputV1): Promise<BlinkitRecentOperationsOutputV1> {
    const input = BlinkitRecentOperationsInputSchemaV1.parse(raw);
    const records = await this.repository.list(owner, input.accountKey, input.limit);
    const now = this.now();
    const operations = await Promise.all(records.map(async (record) => {
      const current = record.status === 'running' && Date.parse(record.expiresAt) <= now.getTime()
        ? await this.repository.update(record.operationId, (value) => value.status === 'running'
          ? { ...value, status: 'expired', updatedAt: now.toISOString() }
          : value)
        : record;
      return {
        operationId: current.operationId,
        status: current.status,
        startedAt: current.startedAt,
        updatedAt: current.updatedAt,
        expiresAt: current.expiresAt,
        ...(current.proposal ? { proposalId: current.proposal.proposalId } : {}),
        ...(current.reason ? { reason: current.reason } : {}),
      };
    }));
    return BlinkitRecentOperationsOutputSchemaV1.parse({
      version: 1,
      status: operations.length > 0 ? 'completed' : 'empty',
      operations,
    });
  }

  private enqueue(record: BlinkitOperationRecord, input: BlinkitStartPrepareCodOrderInputV1): void {
    const prior = this.queue.catch(() => undefined);
    const current = prior.then(() => this.run(record, input));
    this.queue = current.catch(() => undefined);
  }

  private async run(record: BlinkitOperationRecord, input: BlinkitStartPrepareCodOrderInputV1): Promise<void> {
    const prepareInput: BlinkitPrepareCodOrderInputV1 = {
      version: input.version,
      accountKey: input.accountKey,
      items: input.items,
      deliveryAddressRef: input.deliveryAddressRef,
      deliveryAddressLabel: input.deliveryAddressLabel,
    };
    try {
      const proposal = await this.prepare(record.owner, prepareInput);
      await this.repository.update(record.operationId, (current) => {
        if (current.status !== 'running') return current;
        const now = this.now();
        return Date.parse(current.expiresAt) <= now.getTime()
          ? { ...current, status: 'expired', updatedAt: now.toISOString() }
          : { ...current, status: 'completed', proposal, updatedAt: now.toISOString() };
      });
    } catch (error) {
      const blocked = BlinkitCheckoutBlockedOutputSchemaV1.safeParse(this.blockedResult(error));
      if (blocked.success) {
        await this.repository.update(record.operationId, (current) => current.status === 'running'
          ? {
              ...current,
              status: 'blocked',
              reason: blocked.data.reason,
              ...(blocked.data.itemSubtotal !== undefined ? { itemSubtotal: blocked.data.itemSubtotal } : {}),
              ...(blocked.data.requiredSubtotal !== undefined ? { requiredSubtotal: blocked.data.requiredSubtotal } : {}),
              updatedAt: this.now().toISOString(),
            }
          : current);
        return;
      }
      const parsedReason = BlinkitOperationFailureReasonSchemaV1.safeParse(this.failureReason(error));
      await this.repository.update(record.operationId, (current) => current.status === 'running'
        ? { ...current, status: 'failed', reason: parsedReason.success ? parsedReason.data : 'operation_failed', updatedAt: this.now().toISOString() }
        : current);
    }
  }

  private async owned(owner: PrincipalId, accountKey: string, operationId: string): Promise<BlinkitOperationRecord> {
    const record = await this.repository.get(operationId);
    if (!record || record.owner !== owner || record.accountKey !== accountKey) throw new BlinkitOperationNotFoundError();
    return record;
  }
}

function render(record: BlinkitOperationRecord): BlinkitOperationStatusOutputV1 {
  const common = {
    version: 1 as const,
    operationId: record.operationId,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
  if (record.status === 'completed') return BlinkitOperationStatusOutputSchemaV1.parse({ ...common, proposal: record.proposal });
  if (record.status === 'blocked') return BlinkitOperationStatusOutputSchemaV1.parse({
    ...common,
    reason: record.reason,
    ...(record.itemSubtotal !== undefined ? { itemSubtotal: record.itemSubtotal } : {}),
    ...(record.requiredSubtotal !== undefined ? { requiredSubtotal: record.requiredSubtotal } : {}),
  });
  if (record.status === 'failed') return BlinkitOperationStatusOutputSchemaV1.parse({ ...common, reason: record.reason ?? 'operation_failed' });
  return BlinkitOperationStatusOutputSchemaV1.parse(common);
}

async function secureWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function operationKey(owner: PrincipalId, accountKey: string, idempotencyKey: string): string {
  return `${owner}:${accountKey}:${idempotencyKey}`;
}

function requestFingerprint(input: BlinkitStartPrepareCodOrderInputV1): string {
  const terms: BlinkitPrepareCodOrderInputV1 = {
    version: input.version,
    accountKey: input.accountKey,
    items: input.items,
    deliveryAddressRef: input.deliveryAddressRef,
    deliveryAddressLabel: input.deliveryAddressLabel,
  };
  return hash(JSON.stringify(terms));
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
