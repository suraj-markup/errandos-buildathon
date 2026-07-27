import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GroceryProposalSnapshotV1, PrincipalId, ProposalOutput } from '@errandos/contracts';
import { hashProposalSnapshot } from '@errandos/application';
import { PostgresDatabase } from '@errandos/persistence';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createTransactionRuntime } from '../src/mcp.js';
import { PostgresRuntimeProposalRepository } from '../src/postgres-transactions.js';

const url=process.env['TEST_DATABASE_URL']??'postgresql:///errandos_test?host=/var/run/postgresql';
const db=new PostgresDatabase(url);
const migration=resolve(dirname(fileURLToPath(import.meta.url)),'../../../packages/persistence/migrations/003_transaction_authorization.sql');
const owner='production-owner' as PrincipalId;
const snapshot:GroceryProposalSnapshotV1={version:1,kind:'grocery',provider:'blinkit',principalId:owner,accountReference:'main',revision:1,lines:[{productId:'milk',name:'Milk',quantity:1,unitPrice:{currency:'INR',amount:75},lineTotal:{currency:'INR',amount:75}}],fees:[],total:{currency:'INR',amount:75},deliveryAddress:{reference:'home',summary:'Home'},paymentMode:'cod',preparedAt:'2099-01-01T00:00:00.000Z',quoteExpiresAt:'2099-01-01T00:05:00.000Z'};

describe('PostgreSQL MCP transaction runtime',()=>{
  beforeAll(async()=>expect(await db.ready()).toBe(true));
  beforeEach(async()=>{await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await db.pool.query(await readFile(migration,'utf8'));});
  afterAll(async()=>db.close());
  it('configures transaction tools in production and reads durable proposals after reconstruction',async()=>{
    const output:ProposalOutput={version:1,proposalId:'proposal_durable',provider:'blinkit',status:'approval_required',proposalHash:hashProposalSnapshot(snapshot),summary:{kind:'grocery',description:'Milk x1',items:[{name:'Milk',quantity:1}],total:{currency:'INR',amount:75},paymentMode:'cod',addressSummary:'Home'},expiresAt:snapshot.quoteExpiresAt,requiresExternalApproval:true};
    const first=new PostgresRuntimeProposalRepository(db);await first.save(output.proposalId,{owner,output,snapshot,providerStateRef:'encrypted-profile-state'});
    const runtime=createTransactionRuntime(db,{NODE_ENV:'production',ERRANDOS_PERSISTENCE_MODE:'postgres',ERRANDOS_DATA_ROOT:'/tmp/errandos-postgres-runtime-test',ERRANDOS_APPROVAL_HMAC_SECRET:'a'.repeat(32),ERRANDOS_PROFILE_REF_SECRET:'b'.repeat(32)});
    expect(runtime).toBeDefined();expect(await runtime!.tx.status(owner,{version:1,proposalId:output.proposalId})).toMatchObject({proposalId:output.proposalId,status:'approval_required'});
    expect((await new PostgresRuntimeProposalRepository(db).get(output.proposalId))?.providerStateRef).toBe('encrypted-profile-state');
  });
  it('requires an explicit personal profile for production filesystem persistence',()=>{
    expect(()=>createTransactionRuntime(undefined,{NODE_ENV:'production',ERRANDOS_PERSISTENCE_MODE:'filesystem'})).toThrow('ERRANDOS_DEPLOYMENT_PROFILE=personal');
  });
  it('hard rejects live provider commit in PostgreSQL mode',()=>{
    expect(()=>createTransactionRuntime(db,{NODE_ENV:'production',ERRANDOS_PERSISTENCE_MODE:'postgres',ERRANDOS_LIVE_COMMIT:'true',ERRANDOS_DATA_ROOT:'/tmp/errandos-pg-live-reject',ERRANDOS_APPROVAL_HMAC_SECRET:'a'.repeat(32),ERRANDOS_PROFILE_REF_SECRET:'b'.repeat(32)})).toThrow(/outbox worker/);
  });
});
