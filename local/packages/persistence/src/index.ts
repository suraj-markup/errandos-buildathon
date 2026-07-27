import type { PrincipalId, ProviderId, ProviderSession } from '@errandos/contracts';
export interface ProviderSessionRepository {
  find(principalId: PrincipalId, provider: ProviderId, accountKey: string): Promise<ProviderSession | undefined>;
  get(id: string): Promise<ProviderSession | undefined>;
  save(session: ProviderSession): Promise<void>;
}
export interface Repository<T extends { readonly id: string }> { get(id: string): Promise<T | undefined>; save(value: T): Promise<void>; }
const providerKey=(p:ProviderId): string=>`${p.kind}:${p.value}`;
export class InMemoryProviderSessionRepository implements ProviderSessionRepository {
  private readonly records=new Map<string,ProviderSession>();
  async get(id:string): Promise<ProviderSession | undefined>{ return this.records.get(id); }
  async find(principalId:PrincipalId,provider:ProviderId,accountKey:string): Promise<ProviderSession | undefined>{ return [...this.records.values()].find(s=>s.principalId===principalId&&providerKey(s.provider)===providerKey(provider)&&s.accountKey===accountKey); }
  async save(value:ProviderSession): Promise<void>{ const clash=[...this.records.values()].find(s=>s.id!==value.id&&s.principalId===value.principalId&&providerKey(s.provider)===providerKey(value.provider)&&s.accountKey===value.accountKey); if(clash) throw new Error('duplicate principal/provider/account'); this.records.set(value.id,structuredClone(value)); }
}

export * from './postgres.js';
export * from './proposal-repository.js';
export * from './approval-repository.js';
export * from './transaction-repository.js';
export * from './outbox-repository.js';
export * from './lifecycle-repository.js';
export * from './audit-repository.js';
