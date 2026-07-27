import type { Database } from './postgres.js';
export interface AuditEventRecord { id:string;principalId:string;action:string;subjectType:string;subjectId:string;metadata:unknown;occurredAt?:Date }
export class PostgresAuditRepository {
 constructor(private readonly db:Database){}
 async append(v:AuditEventRecord):Promise<void>{await this.db.query(`INSERT INTO audit_events(id,principal_id,action,subject_type,subject_id,metadata,occurred_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,now()))`,[v.id,v.principalId,v.action,v.subjectType,v.subjectId,v.metadata,v.occurredAt]);}
 async list(principalId:string):Promise<AuditEventRecord[]>{const r=await this.db.query('SELECT * FROM audit_events WHERE principal_id=$1 ORDER BY occurred_at,id',[principalId]);return r.rows.map((x:Record<string,unknown>)=>({id:x['id'] as string,principalId:x['principal_id'] as string,action:x['action'] as string,subjectType:x['subject_type'] as string,subjectId:x['subject_id'] as string,metadata:x['metadata'],occurredAt:x['occurred_at'] as Date}));}
}
