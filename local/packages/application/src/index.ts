export * from './transactions.js';
export * from './proposals/canonicalize.js';
export * from './proposals/project-summary.js';
export * from './approvals/approval-service.js';
export * from './blinkit-operations.js';

import { ProductSearchInputSchemaV1, ProductSearchOutputSchemaV1, type AuthMethod, type ChallengeType, type PrincipalId, type ProductSearchInput, type ProductSearchOutput, type ProviderAuthStatusOutput, type ProviderId, type ProviderSession } from '@errandos/contracts';
import type { OperationName } from '@errandos/contracts';
export interface ConfirmationPolicy { requiresConfirmation(operation: OperationName): boolean }
export class SafeDefaultPolicy implements ConfirmationPolicy { public requiresConfirmation(): boolean { return true; } }

export interface ProviderSessionRepository {
  find(principalId: PrincipalId, provider: ProviderId, accountKey: string): Promise<ProviderSession | undefined>;
  get(id: string): Promise<ProviderSession | undefined>;
  save(session: ProviderSession): Promise<void>;
}
export interface ProfileStorePort { create(principalId: PrincipalId, provider: ProviderId): Promise<string>; }
export interface LoginCoordinatorPort { begin(input: { principalId: PrincipalId; sessionId: string; profileReference: string }): Promise<{ supervisedLoginUrl: string; tokenReference: string }>; }
export class OwnershipError extends Error { constructor() { super('provider session not found'); this.name='OwnershipError'; } }
export class InvalidTransitionError extends Error { constructor(from: string, to: string) { super(`invalid session transition: ${from} -> ${to}`); } }
const allowed: Record<string, readonly string[]> = { login_required:['authenticating','revoked'], authenticating:['challenge_required','active','error','revoked'], challenge_required:['authenticating','active','error','revoked'], active:['expired','revoked','error'], expired:['authenticating','revoked'], error:['authenticating','revoked'], revoked:[] };
export class ProviderAuthService {
  private sequence=0;
  constructor(private readonly sessions: ProviderSessionRepository, private readonly profiles: ProfileStorePort, private readonly coordinator: LoginCoordinatorPort, private readonly now:()=>Date=()=>new Date()) {}
  async getAuthStatus(principalId: PrincipalId, provider: ProviderId, accountKey: string): Promise<ProviderAuthStatusOutput> {
    const found=await this.sessions.find(principalId,provider,accountKey);
    if (!found) return { version:1,provider,accountKey,status:'missing' };
    let session=found;
    if (session.status==='active' && session.expiresAt && new Date(session.expiresAt)<=this.now()) { session={...session,status:'expired',updatedAt:this.now().toISOString()}; await this.sessions.save(session); }
    return { version:1,provider,accountKey,status:session.status, ...(session.accountDisplay ? { accountDisplay:session.accountDisplay }:{}), ...(session.expiresAt ? { expiresAt:session.expiresAt }:{}) };
  }
  async beginSupervisedLogin(principalId: PrincipalId, provider: ProviderId, accountKey: string, authMethod: AuthMethod): Promise<{ version: 1; sessionId: ProviderSession['id']; status: 'authenticating'; supervisedLoginUrl: string; tokenReference: string }> {
    const existing=await this.sessions.find(principalId,provider,accountKey); const now=this.now().toISOString();
    if (existing && !['login_required','expired','error'].includes(existing.status)) throw new InvalidTransitionError(existing.status,'authenticating');
    const id=(existing?.id ?? `ps_${++this.sequence}`) as ProviderSession['id'];
    const profileReference=(existing?.profileReference ?? await this.profiles.create(principalId,provider)) as NonNullable<ProviderSession['profileReference']>;
    const session: ProviderSession={version:1,id,principalId,provider,accountKey,status:'authenticating',authMethod,profileReference,createdAt:existing?.createdAt??now,updatedAt:now}; await this.sessions.save(session);
    const launch=await this.coordinator.begin({principalId,sessionId:id,profileReference}); return {version:1 as const,sessionId:id,status:'authenticating' as const,...launch};
  }
  async reportChallenge(principalId: PrincipalId, sessionId:string, type:ChallengeType): Promise<void> { void type; await this.transitionOwned(principalId,sessionId,'challenge_required'); }
  async completeLogin(principalId: PrincipalId, sessionId:string, expiresAt?:string, accountDisplay?:ProviderSession['accountDisplay']): Promise<void> { await this.transitionOwned(principalId,sessionId,'active',{expiresAt,accountDisplay}); }
  async revokeSession(principalId: PrincipalId, sessionId:string): Promise<void> { await this.transitionOwned(principalId,sessionId,'revoked',{revokedAt:this.now().toISOString()}); }
  private async transitionOwned(principalId:PrincipalId,id:string,status:ProviderSession['status'],extra:Partial<ProviderSession>={}):Promise<void>{ const s=await this.sessions.get(id); if(!s||s.principalId!==principalId) throw new OwnershipError(); if(!(allowed[s.status]??[]).includes(status)) throw new InvalidTransitionError(s.status,status); await this.sessions.save({...s,...extra,status,updatedAt:this.now().toISOString()}); }
}

export interface ProductSearchPort { search(input: ProductSearchInput): Promise<ProductSearchOutput>; }
export class ProductSearchService {
  public constructor(private readonly port: ProductSearchPort) {}
  public async search(input: unknown): Promise<ProductSearchOutput> {
    const validated = ProductSearchInputSchemaV1.parse(input);
    return ProductSearchOutputSchemaV1.parse(await this.port.search(validated));
  }
}
