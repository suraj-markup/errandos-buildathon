import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  BlinkitCompareProposalOutputSchemaV1,
  RapidoCompareProposalOutputSchemaV1,
  ProposalSnapshotSchemaV1,
  type AndroidCheckoutComparisonV1,
  type BlinkitCompareProposalOutputV1,
  type CommitInput,
  type CommitOutput,
  type RapidoCompareProposalOutputV1,
  type RapidoProposalChangeV1,
  type PlaceCodOrderInput,
  type PrepareExistingGroceryInput,
  type PrepareGroceryInput,
  type PrepareRapidoInput,
  type PrincipalId,
  type ProposalOutput,
  type ProposalSnapshotV1,
  type TransactionProvider,
} from '@errandos/contracts';
import { hashProposalSnapshot } from './proposals/canonicalize.js';
import { projectProposalSummary } from './proposals/project-summary.js';

export interface PreparedProviderState { snapshot: ProposalSnapshotV1; providerStateRef: string }
export type CommitResult = { outcome: 'committed'; providerReference: string } | { outcome: 'ambiguous' | 'stale'; providerReference?: never };
export type TransactionAuthorizationMode = 'external' | 'owner_autonomous';
export interface CommitDispatchContext { proposalId: string; proposalHash: string; providerFingerprint?: string; idempotencyKey: string }
export interface TransactionProviderPort {
  prepareGrocery?(principalId: PrincipalId, input: PrepareGroceryInput): Promise<PreparedProviderState>;
  prepareExistingGrocery?(principalId: PrincipalId, input: PrepareExistingGroceryInput): Promise<PreparedProviderState>;
  prepareRide?(principalId: PrincipalId, input: PrepareRapidoInput): Promise<PreparedProviderState>;
  commit(principalId: PrincipalId, providerStateRef: string, context: CommitDispatchContext): Promise<CommitResult>;
  reconcile(principalId: PrincipalId, providerStateRef: string): Promise<CommitResult | { outcome: 'pending' }>;
  compareGrocery?(principalId: PrincipalId, providerStateRef: string): Promise<AndroidCheckoutComparisonV1>;
  compareRide?(principalId: PrincipalId, providerStateRef: string): Promise<{
    matches: boolean;
    changes: RapidoProposalChangeV1[];
    currentProviderFingerprint?: string;
  }>;
}
export interface ApprovalClaims { principalId: PrincipalId; proposalId: string; proposalHash: string }
/** consume must reject replay and persist consumption before returning true. */
export interface ApprovalVerifierPort {
  consume(capability: string, claims: ApprovalClaims): Promise<boolean>;
  /** Trusted server-side approval lookup. No capability crosses MCP or chat. */
  consumeApproved?(claims: ApprovalClaims): Promise<boolean>;
}
export interface ApprovalIssuerPort { issue(claims: ApprovalClaims): string }
export interface ProposalRecord { owner: PrincipalId; output: ProposalOutput; snapshot: ProposalSnapshotV1; providerStateRef: string; receipt?: CommitOutput; approvalConsumed?: string }
export interface IdempotencyRecord { proposalId: string; requestFingerprint: string; result: CommitOutput }
export interface ProposalRepository {
  get(id: string): Promise<ProposalRecord | undefined>;
  save(id: string, value: ProposalRecord): Promise<void>;
  findIdempotency(owner: PrincipalId, key: string): Promise<IdempotencyRecord | undefined>;
  saveIdempotency(owner: PrincipalId, key: string, value: IdempotencyRecord): Promise<void>;
}
export class InMemoryProposalRepository implements ProposalRepository {
  private readonly records = new Map<string, ProposalRecord>();
  private readonly keys = new Map<string, IdempotencyRecord>();
  public async get(id: string): Promise<ProposalRecord | undefined> { return this.records.get(id); }
  public async save(id: string, value: ProposalRecord): Promise<void> { this.records.set(id, value); }
  public async findIdempotency(owner: PrincipalId, key: string): Promise<IdempotencyRecord | undefined> { return this.keys.get(`${owner}:${key}`); }
  public async saveIdempotency(owner: PrincipalId, key: string, value: IdempotencyRecord): Promise<void> { this.keys.set(`${owner}:${key}`, value); }
}

const safeName = (value: string): string => createHash('sha256').update(value).digest('hex');
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
/** Durable local repository. IDs and principals are hashed into filenames; records still enforce owner checks in the service. */
export class FileProposalRepository implements ProposalRepository {
  private readonly root: string;
  public constructor(root: string) { this.root = resolve(root); }
  private proposal(id: string): string { return join(this.root, 'proposals', `${safeName(id)}.json`); }
  private key(owner: PrincipalId, key: string): string { return join(this.root, 'idempotency', `${safeName(`${owner}:${key}`)}.json`); }
  public async get(id: string): Promise<ProposalRecord | undefined> { return readJson(this.proposal(id)); }
  public async save(id: string, value: ProposalRecord): Promise<void> { await secureWrite(this.proposal(id), value); }
  public async findIdempotency(owner: PrincipalId, key: string): Promise<IdempotencyRecord | undefined> { return readJson(this.key(owner, key)); }
  public async saveIdempotency(owner: PrincipalId, key: string, value: IdempotencyRecord): Promise<void> { await secureWrite(this.key(owner, key), value); }
}

interface SignedApproval { v: 1; principalId: string; proposalId: string; proposalHash: string; nonce: string; exp: number }
const b64 = (value: string): string => Buffer.from(value).toString('base64url');
/** Local control-plane approval implementation. issue() is deliberately not used by or exposed through MCP. */
export class HmacApprovalStore implements ApprovalVerifierPort {
  private readonly root: string;
  public constructor(root: string, private readonly secret: string, private readonly now: () => Date = () => new Date()) {
    if (Buffer.byteLength(secret) < 32) throw new Error('approval HMAC secret must contain at least 32 bytes');
    this.root = resolve(root);
  }
  public issue(claims: ApprovalClaims, ttlSeconds = 300): string {
    const payload: SignedApproval = { v: 1, ...claims, nonce: randomBytes(24).toString('base64url'), exp: Math.floor(this.now().getTime() / 1000) + ttlSeconds };
    const encoded = b64(JSON.stringify(payload));
    return `${encoded}.${createHmac('sha256', this.secret).update(encoded).digest('base64url')}`;
  }
  public async consume(capability: string, expected: ApprovalClaims): Promise<boolean> {
    try {
      const [encoded, signature, extra] = capability.split('.');
      if (!encoded || !signature || extra) return false;
      const actual = Buffer.from(signature, 'base64url');
      const wanted = createHmac('sha256', this.secret).update(encoded).digest();
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
      const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedApproval;
      if (claims.v !== 1 || claims.principalId !== expected.principalId || claims.proposalId !== expected.proposalId || claims.proposalHash !== expected.proposalHash || claims.exp < Math.floor(this.now().getTime() / 1000) || !/^[A-Za-z0-9_-]{20,}$/.test(claims.nonce)) return false;
      const consumed = join(this.root, 'consumed', `${safeName(claims.nonce)}.json`);
      await mkdir(dirname(consumed), { recursive: true, mode: 0o700 }); await chmod(dirname(consumed), 0o700);
      const handle = await open(consumed, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ consumedAt: this.now().toISOString(), proposalId: claims.proposalId })); await handle.close();
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; return false; }
  }
}

export class ProposalNotFoundError extends Error {
  public constructor() {
    super('proposal not found');
    this.name = 'ProposalNotFoundError';
  }
}
export class ApprovalRequiredError extends Error { public constructor() { super('valid external approval capability required'); } }
export class LiveCommitDisabledError extends Error { public constructor() { super('live provider commit is disabled'); } }
export class IdempotencyConflictError extends Error { public constructor() { super('idempotency key was already used for a different request'); } }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TransactionService {
  private readonly activeCommits = new Map<string, { proposalId: string; promise: Promise<CommitOutput> }>();
  private readonly activeProposals = new Map<string, Promise<CommitOutput>>();
  public constructor(private readonly repo: ProposalRepository, private readonly providers: Partial<Record<TransactionProvider, TransactionProviderPort>>, private readonly approvals: ApprovalVerifierPort, private readonly liveCommitEnabled = false, private readonly now: () => Date = () => new Date(), private readonly authorizationMode: TransactionAuthorizationMode = 'external', private readonly approvalIssuer?: ApprovalIssuerPort) {}
  public async prepareGrocery(owner: PrincipalId, input: PrepareGroceryInput): Promise<ProposalOutput> { const port = this.provider(input.provider); if (!port.prepareGrocery) throw new Error('provider does not support grocery'); const state = await port.prepareGrocery(owner, input); return this.store(owner, input.provider, state); }
  public async prepareExistingGrocery(owner: PrincipalId, input: PrepareExistingGroceryInput): Promise<ProposalOutput> { const port = this.provider(input.provider); if (!port.prepareExistingGrocery) throw new Error('provider does not support existing grocery carts'); const state = await port.prepareExistingGrocery(owner, input); return this.store(owner, input.provider, state); }
  public async prepareRapido(owner: PrincipalId, input: PrepareRapidoInput): Promise<ProposalOutput> {
    const port = this.provider('rapido');
    if (!port.prepareRide) throw new Error('provider does not support rides');
    return this.store(owner, 'rapido', await port.prepareRide(owner, input));
  }
  public async get(owner: PrincipalId, id: string): Promise<ProposalOutput> { const record = await this.owned(owner, id); record.output = { ...record.output, summary: projectProposalSummary(record.snapshot), expiresAt: record.snapshot.quoteExpiresAt }; if (new Date(record.snapshot.quoteExpiresAt) <= this.now()) { if (record.output.status === 'committing') { record.output = { ...record.output, status: 'ambiguous' }; record.receipt = { version: 1, proposalId: id, status: 'ambiguous', reconciliationRequired: true }; } else if (!['committed', 'ambiguous'].includes(record.output.status)) record.output = { ...record.output, status: 'stale' }; } await this.repo.save(id, record); return record.output; }
  public async compareBlinkitProposal(owner: PrincipalId, id: string, accountKey: string): Promise<BlinkitCompareProposalOutputV1> {
    const record = await this.owned(owner, id);
    if (record.snapshot.kind !== 'grocery' || record.snapshot.provider !== 'blinkit' || record.snapshot.accountReference !== accountKey) {
      throw new Error('Blinkit proposal is not comparable');
    }
    const proposal = await this.get(owner, id);
    if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
      return BlinkitCompareProposalOutputSchemaV1.parse({
        version: 1,
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        proposalStatus: proposal.status,
        status: 'expired',
        changes: [],
      });
    }
    const port = this.provider('blinkit');
    if (!port.compareGrocery || !record.snapshot.providerFingerprint) throw new Error('Blinkit proposal is not comparable');
    const comparison = await port.compareGrocery(owner, record.providerStateRef);
    return BlinkitCompareProposalOutputSchemaV1.parse({
      version: 1,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      proposalStatus: proposal.status,
      status: comparison.matches ? 'unchanged' : 'changed',
      changes: comparison.changes,
      ...(comparison.currentProviderFingerprint ? { currentProviderFingerprint: comparison.currentProviderFingerprint } : {}),
    });
  }
  public async compareRapidoProposal(owner: PrincipalId, id: string, accountKey: string): Promise<RapidoCompareProposalOutputV1> {
    const record = await this.owned(owner, id);
    if (record.snapshot.kind !== 'ride' || record.snapshot.provider !== 'rapido' || record.snapshot.accountReference !== accountKey) {
      throw new Error('Rapido proposal is not comparable');
    }
    const proposal = await this.get(owner, id);
    if (Date.parse(proposal.expiresAt) <= this.now().getTime()) {
      return RapidoCompareProposalOutputSchemaV1.parse({
        version: 1,
        proposalId: proposal.proposalId,
        proposalHash: proposal.proposalHash,
        proposalStatus: proposal.status,
        status: 'expired',
        changes: ['quote_expiry'],
      });
    }
    const port = this.provider('rapido');
    if (!port.compareRide) throw new Error('Rapido proposal is not comparable');
    const comparison = await port.compareRide(owner, record.providerStateRef);
    return RapidoCompareProposalOutputSchemaV1.parse({
      version: 1,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      proposalStatus: proposal.status,
      status: comparison.matches ? 'unchanged' : 'changed',
      changes: comparison.changes,
      ...(comparison.currentProviderFingerprint ? { currentProviderFingerprint: comparison.currentProviderFingerprint } : {}),
    });
  }
  public async commit(owner: PrincipalId, input: CommitInput): Promise<CommitOutput> {
    return this.commitAuthorized(owner, input, async (record, current) => {
      if (record.approvalConsumed || !await this.approvals.consume(input.approvalCapability, { principalId: owner, proposalId: input.proposalId, proposalHash: current.proposalHash })) throw new ApprovalRequiredError();
      record.approvalConsumed = hash(input.approvalCapability);
    });
  }
  public async commitApproved(owner: PrincipalId, input: PlaceCodOrderInput): Promise<CommitOutput> {
    return this.commitAuthorized(owner, input, async (record, current) => {
      if (
        record.approvalConsumed
        || !this.approvals.consumeApproved
        || !await this.approvals.consumeApproved({
          principalId: owner,
          proposalId: input.proposalId,
          proposalHash: current.proposalHash,
        })
      ) throw new ApprovalRequiredError();
      record.approvalConsumed = hash(`server-approved:${input.proposalId}:${current.proposalHash}`);
    });
  }
  public async commitAutonomousCod(owner: PrincipalId, input: PlaceCodOrderInput): Promise<CommitOutput> {
    if (this.authorizationMode !== 'owner_autonomous') throw new ApprovalRequiredError();
    const record = await this.owned(owner, input.proposalId);
    if (record.snapshot.kind !== 'grocery' || record.snapshot.provider !== 'blinkit') throw new Error('owner-autonomous commit supports Blinkit grocery only');
    if (record.snapshot.paymentMode !== 'cod') throw new Error('owner-autonomous commit supports COD only');
    if (!this.approvalIssuer) throw new ApprovalRequiredError();
    const approvalCapability = this.approvalIssuer.issue({ principalId: owner, proposalId: input.proposalId, proposalHash: record.output.proposalHash });
    return this.commit(owner, { ...input, approvalCapability });
  }
  private commitAuthorized(owner: PrincipalId, input: PlaceCodOrderInput, authorize?: (record: ProposalRecord, current: ProposalOutput) => Promise<void>): Promise<CommitOutput> {
    const activeKey = `${owner}:${input.idempotencyKey}`;
    const activeProposalKey = `${owner}:${input.proposalId}`;
    const active = this.activeCommits.get(activeKey);
    if (active) {
      if (active.proposalId !== input.proposalId) return Promise.reject(new IdempotencyConflictError());
      return active.promise;
    }
    const activeProposal = this.activeProposals.get(activeProposalKey);
    if (activeProposal) return activeProposal;
    const promise = this.commitAuthorizedOnce(owner, input, authorize);
    this.activeCommits.set(activeKey, { proposalId: input.proposalId, promise });
    this.activeProposals.set(activeProposalKey, promise);
    const cleanup = (): void => {
      if (this.activeCommits.get(activeKey)?.promise === promise) this.activeCommits.delete(activeKey);
      if (this.activeProposals.get(activeProposalKey) === promise) this.activeProposals.delete(activeProposalKey);
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }
  private async commitAuthorizedOnce(owner: PrincipalId, input: PlaceCodOrderInput, authorize?: (record: ProposalRecord, current: ProposalOutput) => Promise<void>): Promise<CommitOutput> {
    const requestFingerprint = hash({ version: input.version, proposalId: input.proposalId });
    const previous = await this.repo.findIdempotency(owner, input.idempotencyKey);
    if (previous) {
      if (previous.proposalId !== input.proposalId || previous.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();
      return previous.result;
    }
    const record = await this.owned(owner, input.proposalId); const current = await this.get(owner, input.proposalId);
    if (current.status === 'stale') return { version: 1, proposalId: input.proposalId, status: 'stale', reconciliationRequired: false };
    if (current.status === 'committing' || current.status === 'ambiguous') {
      const receipt = record.receipt ?? { version: 1 as const, proposalId: input.proposalId, status: 'ambiguous' as const, reconciliationRequired: true };
      await this.repo.saveIdempotency(owner, input.idempotencyKey, { proposalId: input.proposalId, requestFingerprint, result: receipt });
      return receipt;
    }
    if (current.status === 'committed') {
      const receipt = record.receipt ?? { version: 1 as const, proposalId: input.proposalId, status: 'ambiguous' as const, reconciliationRequired: true };
      await this.repo.saveIdempotency(owner, input.idempotencyKey, { proposalId: input.proposalId, requestFingerprint, result: receipt });
      return receipt;
    }
    if (!this.liveCommitEnabled) throw new LiveCommitDisabledError();
    // Persisted bytes, not merely the independently persisted hash, are the commit authority.
    if (hashProposalSnapshot(record.snapshot) !== record.output.proposalHash) { record.output = { ...record.output, status: 'stale', summary: projectProposalSummary(record.snapshot), expiresAt: record.snapshot.quoteExpiresAt }; await this.repo.save(input.proposalId, record); return { version: 1, proposalId: input.proposalId, status: 'stale', reconciliationRequired: false }; }
    await authorize?.(record, current);
    record.output = { ...record.output, status: 'committing' }; await this.repo.save(input.proposalId, record);
    let receipt: CommitOutput;
    try {
      const result = await this.provider(record.output.provider).commit(owner, record.providerStateRef, {
        proposalId: input.proposalId,
        proposalHash: current.proposalHash,
        ...('providerFingerprint' in record.snapshot && record.snapshot.providerFingerprint
          ? { providerFingerprint: record.snapshot.providerFingerprint }
          : {}),
        idempotencyKey: input.idempotencyKey,
      });
      receipt = result.outcome === 'committed'
        ? { version: 1, proposalId: input.proposalId, status: 'committed', receiptId: `receipt_${randomUUID()}`, providerReference: result.providerReference, reconciliationRequired: false }
        : { version: 1, proposalId: input.proposalId, status: result.outcome, reconciliationRequired: result.outcome === 'ambiguous' };
    }
    catch { receipt = { version: 1, proposalId: input.proposalId, status: 'ambiguous', reconciliationRequired: true }; }
    record.output = { ...record.output, status: receipt.status };
    record.receipt = receipt;
    await this.repo.save(input.proposalId, record);
    await this.repo.saveIdempotency(owner, input.idempotencyKey, { proposalId: input.proposalId, requestFingerprint, result: receipt });
    return receipt;
  }
  public async reconcile(owner: PrincipalId, id: string): Promise<CommitOutput> { const record = await this.owned(owner, id); if (record.receipt?.status === 'committed') return record.receipt; const result = await this.provider(record.output.provider).reconcile(owner, record.providerStateRef); if (result.outcome === 'pending') return { version: 1, proposalId: id, status: 'ambiguous', reconciliationRequired: true }; const receipt: CommitOutput = { version: 1, proposalId: id, status: result.outcome, ...(result.outcome === 'committed' ? { receiptId: record.receipt?.receiptId ?? `receipt_${randomUUID()}` } : {}), ...(result.providerReference ? { providerReference: result.providerReference } : {}), reconciliationRequired: result.outcome === 'ambiguous' }; record.receipt = receipt; record.output = { ...record.output, status: receipt.status }; await this.repo.save(id, record); return receipt; }
  public async markMaterialChange(owner: PrincipalId, id: string, next: PreparedProviderState): Promise<ProposalOutput> { const record = await this.owned(owner, id); const snapshot = this.validateSnapshot(owner, record.output.provider, next.snapshot); if (snapshot.revision <= record.snapshot.revision) throw new Error('replacement snapshot revision must increase'); const autonomous = this.isAutonomousCod(snapshot); record.providerStateRef = next.providerStateRef; record.snapshot = snapshot; record.output = { ...record.output, summary: projectProposalSummary(snapshot), expiresAt: snapshot.quoteExpiresAt, proposalHash: hashProposalSnapshot(snapshot), status: autonomous ? 'prepared' : 'approval_required', requiresExternalApproval: !autonomous }; delete record.approvalConsumed; await this.repo.save(id, record); return record.output; }
  private async store(owner: PrincipalId, provider: TransactionProvider, state: PreparedProviderState): Promise<ProposalOutput> { const snapshot = this.validateSnapshot(owner, provider, state.snapshot); const proposalId = `proposal_${randomUUID()}`; const autonomous = this.isAutonomousCod(snapshot); const output: ProposalOutput = { version: 1, proposalId, provider, status: autonomous ? 'prepared' : 'approval_required', proposalHash: hashProposalSnapshot(snapshot), summary: projectProposalSummary(snapshot), expiresAt: snapshot.quoteExpiresAt, requiresExternalApproval: !autonomous }; await this.repo.save(proposalId, { owner, output, snapshot, providerStateRef: state.providerStateRef }); return output; }
  private isAutonomousCod(snapshot: ProposalSnapshotV1): boolean { return this.authorizationMode === 'owner_autonomous' && snapshot.kind === 'grocery' && snapshot.provider === 'blinkit' && snapshot.paymentMode === 'cod'; }
  private validateSnapshot(owner: PrincipalId, provider: TransactionProvider, value: ProposalSnapshotV1): ProposalSnapshotV1 {
    const snapshot = ProposalSnapshotSchemaV1.parse(value);
    if (snapshot.principalId !== owner || snapshot.provider !== provider) throw new Error('provider snapshot identity mismatch');
    if (Date.parse(snapshot.quoteExpiresAt) <= this.now().getTime()) throw new Error('provider snapshot is already expired');
    return snapshot;
  }
  private provider(name: TransactionProvider): TransactionProviderPort {
    const provider = this.providers[name];
    if (!provider) throw new Error(`${name} provider runtime unavailable`);
    return provider;
  }
  private async owned(owner: PrincipalId, id: string): Promise<ProposalRecord> { const record = await this.repo.get(id); if (!record || record.owner !== owner) throw new ProposalNotFoundError(); return record; }
}
