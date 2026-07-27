import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApprovalClaims, ApprovalVerifierPort, IdempotencyRecord, ProposalRecord, ProposalRepository } from '@errandos/application';
import type { PrincipalId } from '@errandos/contracts';
import { PostgresProposalRepository, PostgresTransactionRepository, type PostgresDatabase } from '@errandos/persistence';

/** Application-port adapters. Browser state remains separate; every transaction authority is in PostgreSQL. */
export class PostgresRuntimeProposalRepository implements ProposalRepository {
  private readonly transactions: PostgresTransactionRepository;
  public constructor(private readonly database: PostgresDatabase) { this.transactions = new PostgresTransactionRepository(database); }
  async get(id: string): Promise<ProposalRecord | undefined> {
    const result = await this.database.pool.query('SELECT record FROM transaction_runtime_proposals WHERE proposal_id=$1', [id]);
    return (result.rows[0] as { record: ProposalRecord } | undefined)?.record;
  }
  async save(id: string, value: ProposalRecord): Promise<void> {
    await this.database.transaction(async client => {
      const existing = await client.query('SELECT 1 FROM proposal_revisions WHERE proposal_id=$1 AND revision=$2', [id, value.snapshot.revision]);
      if (existing.rowCount === 0) await new PostgresProposalRepository(client).append({ proposalId:id, revision:value.snapshot.revision, principalId:value.owner, idempotencyKey:`runtime:${id}:${value.snapshot.revision}`, proposalHash:value.output.proposalHash, snapshot:value.snapshot });
      await client.query(`INSERT INTO transaction_runtime_proposals(proposal_id,principal_id,record) VALUES($1,$2,$3)
        ON CONFLICT(proposal_id) DO UPDATE SET record=EXCLUDED.record,updated_at=now() WHERE transaction_runtime_proposals.principal_id=EXCLUDED.principal_id`, [id,value.owner,value]);
    });
    if (value.receipt) {
      const attempt = await this.database.pool.query('SELECT id FROM commit_attempts WHERE principal_id=$1 AND proposal_id=$2 ORDER BY reserved_at DESC LIMIT 1', [value.owner,id]);
      const row = attempt.rows[0] as { id:string } | undefined;
      if (row) {
        const status = value.receipt.status === 'committed' ? 'committed' : 'ambiguous';
        await this.transactions.transitionAttempt(value.owner,row.id,['reserved','dispatching','ambiguous'],status);
        if (value.receipt.receiptId) await this.database.pool.query(`INSERT INTO transaction_receipts(id,commit_attempt_id,principal_id,provider_reference,status,receipt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(commit_attempt_id) DO NOTHING`, [value.receipt.receiptId,row.id,value.owner,value.receipt.providerReference,value.receipt.status,value.receipt]);
      }
    }
  }
  async findIdempotency(owner: PrincipalId, key: string): Promise<IdempotencyRecord | undefined> {
    const result=await this.database.pool.query('SELECT value FROM transaction_runtime_idempotency WHERE principal_id=$1 AND idempotency_key=$2',[owner,key]);
    return (result.rows[0] as {value:IdempotencyRecord}|undefined)?.value;
  }
  async saveIdempotency(owner: PrincipalId, key: string, value: IdempotencyRecord): Promise<void> {
    await this.database.pool.query('INSERT INTO transaction_runtime_idempotency(principal_id,idempotency_key,value) VALUES($1,$2,$3) ON CONFLICT(principal_id,idempotency_key) DO NOTHING',[owner,key,value]);
  }
}

interface SignedApproval { v:1; principalId:string; proposalId:string; proposalHash:string; nonce:string; exp:number }
export class PostgresHmacApprovalVerifier implements ApprovalVerifierPort {
  private readonly transactions: PostgresTransactionRepository;
  public constructor(private readonly database: PostgresDatabase, private readonly secret:string, private readonly now:()=>Date=()=>new Date()) {
    if (Buffer.byteLength(secret)<32) throw new Error('approval HMAC secret must contain at least 32 bytes');
    this.transactions=new PostgresTransactionRepository(database);
  }
  async consume(capability:string, expected:ApprovalClaims):Promise<boolean> {
    try {
      const [encoded,signature,extra]=capability.split('.'); if(!encoded||!signature||extra)return false;
      const actual=Buffer.from(signature,'base64url');const wanted=createHmac('sha256',this.secret).update(encoded).digest();
      if(actual.length!==wanted.length||!timingSafeEqual(actual,wanted))return false;
      const claims=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')) as SignedApproval;
      if(claims.v!==1||claims.principalId!==expected.principalId||claims.proposalId!==expected.proposalId||claims.proposalHash!==expected.proposalHash||claims.exp<Math.floor(this.now().getTime()/1000))return false;
      const revision=await this.database.pool.query('SELECT revision FROM proposal_revisions WHERE principal_id=$1 AND proposal_id=$2 AND proposal_hash=$3 ORDER BY revision DESC LIMIT 1',[expected.principalId,expected.proposalId,expected.proposalHash]);
      const row=revision.rows[0] as {revision:number}|undefined;if(!row)return false;
      return this.transactions.reserveAuthorizedDispatch({attemptId:`attempt_${randomUUID()}`,outboxId:`outbox_${randomUUID()}`,principalId:expected.principalId,proposalId:expected.proposalId,proposalRevision:row.revision,proposalHash:expected.proposalHash,capabilityJti:claims.nonce,action:'commit',outboxPayload:{proposalId:expected.proposalId,proposalHash:expected.proposalHash}});
    } catch { return false; }
  }
  async consumeApproved(expected:ApprovalClaims):Promise<boolean> {
    const candidate=await this.database.pool.query(`SELECT c.jti,p.revision
      FROM authorization_capabilities c
      JOIN proposal_revisions p ON p.principal_id=c.principal_id AND p.proposal_id=c.proposal_id AND p.revision=c.proposal_revision AND p.proposal_hash=c.proposal_hash
      WHERE c.principal_id=$1 AND c.proposal_id=$2 AND c.proposal_hash=$3 AND c.action='commit'
        AND c.consumed_at IS NULL AND c.issued_at<=now() AND c.expires_at>now()
      ORDER BY c.issued_at DESC LIMIT 1`,[expected.principalId,expected.proposalId,expected.proposalHash]);
    const row=candidate.rows[0] as {jti:string;revision:number}|undefined;
    if(!row)return false;
    return this.transactions.reserveAuthorizedDispatch({attemptId:`attempt_${randomUUID()}`,outboxId:`outbox_${randomUUID()}`,principalId:expected.principalId,proposalId:expected.proposalId,proposalRevision:row.revision,proposalHash:expected.proposalHash,capabilityJti:row.jti,action:'commit',outboxPayload:{proposalId:expected.proposalId,proposalHash:expected.proposalHash}});
  }
}
