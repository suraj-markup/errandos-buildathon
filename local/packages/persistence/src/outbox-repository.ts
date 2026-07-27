import type { Database } from './postgres.js';
export interface OutboxMessage {id:string;principalId:string;aggregateType:string;aggregateId:string;eventType:string;payload:unknown;leaseOwner?:string|undefined;leaseExpiresAt?:Date|undefined}
const map=(x:Record<string,unknown>):OutboxMessage=>({id:x['id'] as string,principalId:x['principal_id'] as string,aggregateType:x['aggregate_type'] as string,aggregateId:x['aggregate_id'] as string,eventType:x['event_type'] as string,payload:x['payload'],leaseOwner:x['lease_owner'] as string|undefined,leaseExpiresAt:x['lease_expires_at'] as Date|undefined});
export class PostgresOutboxRepository {
 constructor(private readonly db:Database){}
 async claimPending(principalId:string,workerId:string,limit=10,leaseSeconds=30):Promise<OutboxMessage[]>{const r=await this.db.query(`UPDATE transaction_outbox o SET lease_owner=$2,lease_expires_at=now()+($4 * interval '1 second'),delivery_count=delivery_count+1 FROM (SELECT id FROM transaction_outbox WHERE principal_id=$1 AND delivered_at IS NULL AND available_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now()) ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $3) pending WHERE o.principal_id=$1 AND o.id=pending.id RETURNING o.*`,[principalId,workerId,limit,leaseSeconds]);return r.rows.map(x=>map(x as Record<string,unknown>));}
 async release(principalId:string,id:string,workerId:string,availableAt=new Date()):Promise<boolean>{const r=await this.db.query('UPDATE transaction_outbox SET lease_owner=NULL,lease_expires_at=NULL,available_at=$4 WHERE principal_id=$1 AND id=$2 AND lease_owner=$3 AND delivered_at IS NULL RETURNING id',[principalId,id,workerId,availableAt]);return r.rowCount===1;}
 async markDelivered(principalId:string,id:string,workerId:string):Promise<boolean>{
  const r=await this.db.query(`UPDATE transaction_outbox SET delivered_at=COALESCE(delivered_at,now()),lease_owner=NULL,lease_expires_at=NULL
    WHERE principal_id=$1 AND id=$2 AND ((lease_owner=$3 AND lease_expires_at>now()) OR delivered_at IS NOT NULL) RETURNING id`,[principalId,id,workerId]);
  return r.rowCount===1;
 }
 async get(principalId:string,id:string):Promise<{deliveredAt:Date|null;deliveryCount:number}|undefined>{const r=await this.db.query('SELECT delivered_at,delivery_count FROM transaction_outbox WHERE principal_id=$1 AND id=$2',[principalId,id]);const row=r.rows[0] as {delivered_at:Date|null;delivery_count:number}|undefined;return row?{deliveredAt:row.delivered_at,deliveryCount:row.delivery_count}:undefined;}
}
