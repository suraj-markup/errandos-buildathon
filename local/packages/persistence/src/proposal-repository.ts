import type { ProposalSnapshotV1 } from '@errandos/contracts';
import type { Database } from './postgres.js';

export interface ProposalRevisionRecord { proposalId: string; revision: number; principalId: string; idempotencyKey: string; proposalHash: string; snapshot: ProposalSnapshotV1; createdAt?: Date }
export class PostgresProposalRepository {
  constructor(private readonly db: Database) {}
  async append(value: ProposalRevisionRecord): Promise<void> {
    await this.db.query(`INSERT INTO proposal_revisions(proposal_id,revision,principal_id,idempotency_key,proposal_hash,snapshot)
      VALUES($1,$2,$3,$4,$5,$6)`, [value.proposalId,value.revision,value.principalId,value.idempotencyKey,value.proposalHash,value.snapshot]);
  }
  async get(principalId: string, proposalId: string, revision: number): Promise<ProposalRevisionRecord | undefined> {
    const result=await this.db.query(`SELECT proposal_id,revision,principal_id,idempotency_key,proposal_hash,snapshot,created_at FROM proposal_revisions WHERE principal_id=$1 AND proposal_id=$2 AND revision=$3`,[principalId,proposalId,revision]);
    const row=result.rows[0] as Record<string, unknown>|undefined;
    return row ? {proposalId:row['proposal_id'] as string,revision:row['revision'] as number,principalId:row['principal_id'] as string,idempotencyKey:row['idempotency_key'] as string,proposalHash:row['proposal_hash'] as string,snapshot:row['snapshot'] as ProposalSnapshotV1,createdAt:row['created_at'] as Date}:undefined;
  }
}
