import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ApprovalReferenceV1, ApprovalRequestStatus } from '@errandos/contracts';

export interface ApprovalBinding {
  principalId: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
}
export interface ApprovalRequestRecord extends ApprovalBinding {
  id: string;
  status: ApprovalRequestStatus;
  requestTokenHash: string;
  expiresAt: Date;
  decidedAt?: Date;
}
export interface ApprovalRepository {
  create(record: ApprovalRequestRecord): Promise<void>;
  get(principalId: string, id: string): Promise<ApprovalRequestRecord | undefined>;
  /** Atomically changes only a pending request whose complete binding matches. */
  transitionPending(binding: ApprovalBinding, id: string, status: Exclude<ApprovalRequestStatus, 'pending'>, at: Date): Promise<ApprovalRequestRecord | undefined>;
  /** Expires stale requests and revokes/invalidates stale authorizations atomically. */
  invalidateStale(current: ApprovalBinding, at: Date): Promise<void>;
}
export class ApprovalStateError extends Error {
  constructor() { super('approval request is unavailable or not pending'); this.name='ApprovalStateError'; }
}
export interface CreateApprovalRequest extends ApprovalBinding { expiresAt: Date }
export interface DecideApprovalRequest extends ApprovalBinding {
  approvalRequestId: string;
  requestToken: string;
  decision: 'approved' | 'rejected';
}
const digest=(token:string):Buffer=>createHash('sha256').update(token,'utf8').digest();
const exact=(record:ApprovalRequestRecord,binding:ApprovalBinding):boolean=>record.principalId===binding.principalId&&record.proposalId===binding.proposalId&&record.proposalRevision===binding.proposalRevision&&record.proposalHash===binding.proposalHash;
const reference=(record:ApprovalRequestRecord):ApprovalReferenceV1=>({version:1,approvalRequestId:record.id,principalId:record.principalId,proposalId:record.proposalId,proposalRevision:record.proposalRevision,proposalHash:record.proposalHash,status:record.status,expiresAt:record.expiresAt.toISOString()});

export class ApprovalService {
  constructor(private readonly repository:ApprovalRepository,private readonly now:()=>Date=()=>new Date()) {}
  async create(input:CreateApprovalRequest):Promise<{request:ApprovalReferenceV1;requestToken:string}> {
    const now=this.now();
    if(input.expiresAt<=now) throw new ApprovalStateError();
    const requestToken=randomBytes(32).toString('base64url');
    const record:ApprovalRequestRecord={...input,id:randomUUID(),status:'pending',requestTokenHash:digest(requestToken).toString('hex')};
    await this.repository.create(record);
    return {request:reference(record),requestToken};
  }
  async get(binding:ApprovalBinding,id:string):Promise<ApprovalReferenceV1> {
    let record=await this.repository.get(binding.principalId,id);
    if(!record||!exact(record,binding)) throw new ApprovalStateError();
    if(record.status==='pending'&&record.expiresAt<=this.now()) {
      const now=this.now();
      record=await this.repository.transitionPending(binding,id,'expired',now)??await this.repository.get(binding.principalId,id)??record;
    }
    return reference(record);
  }
  async decide(input:DecideApprovalRequest):Promise<ApprovalReferenceV1> {
    const record=await this.repository.get(input.principalId,input.approvalRequestId);
    if(!record||!exact(record,input)||record.status!=='pending') throw new ApprovalStateError();
    const expected=Buffer.from(record.requestTokenHash,'hex');
    const presented=digest(input.requestToken);
    if(expected.length!==presented.length||!timingSafeEqual(expected,presented)) throw new ApprovalStateError();
    const now=this.now();
    if(record.expiresAt<=now) { await this.repository.transitionPending(input,input.approvalRequestId,'expired',now); throw new ApprovalStateError(); }
    const changed=await this.repository.transitionPending(input,input.approvalRequestId,input.decision,now);
    if(!changed) throw new ApprovalStateError();
    return reference(changed);
  }
  async invalidateStale(current:ApprovalBinding):Promise<void> { await this.repository.invalidateStale(current,this.now()); }
}
