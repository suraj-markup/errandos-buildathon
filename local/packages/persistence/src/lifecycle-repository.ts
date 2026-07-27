import type { LifecycleEventV1 } from '@errandos/contracts';
import type { Database } from './postgres.js';
export class PostgresLifecycleRepository {
 constructor(private readonly db:Database){}
 async append(principalId:string,event:LifecycleEventV1):Promise<void>{await this.db.query(`INSERT INTO lifecycle_events(event_id,operation_id,principal_id,sequence,kind,phase,terminal,retryable,display,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[event.eventId,event.operationId,principalId,event.sequence,event.kind,event.phase,event.terminal,event.retryable,event.display,event.occurredAt]);}
 async list(principalId:string,operationId:string):Promise<LifecycleEventV1[]>{const r=await this.db.query('SELECT * FROM lifecycle_events WHERE principal_id=$1 AND operation_id=$2 ORDER BY sequence',[principalId,operationId]);return r.rows.map((x:Record<string,unknown>)=>({version:1,eventId:x['event_id'],operationId:x['operation_id'],sequence:x['sequence'],kind:x['kind'],phase:x['phase'],terminal:x['terminal'],retryable:x['retryable'],display:x['display'],occurredAt:(x['occurred_at'] as Date).toISOString()} as LifecycleEventV1));}
}
