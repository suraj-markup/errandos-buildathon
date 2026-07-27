/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  BlinkitSearchProductsOutputV1,
  CommitOutput,
  ProviderAuthStatusOutput,
  ProviderBeginLoginOutput,
  ProviderSubmitOtpOutput,
} from '@errandos/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer,runMcpServer } from '../src/mcp.js';
import { AndroidWorkerClientError, AndroidWorkerOperationError } from '@errandos/provider-connectors';
import { ProposalNotFoundError } from '@errandos/application';

let server: ReturnType<typeof createMcpServer>;
let client: Client;

beforeEach(async () => {
  server = createMcpServer();
  client = new Client({ name: 'errandos-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

describe('MCP protocol surface', () => {
  it('closes an opened PostgreSQL pool when later runtime configuration rejects live commit', async () => {
    let closes=0;
    const database={close:async()=>{closes++;},ready:async()=>true} as never;
    const before=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
    await expect(runMcpServer({environment:{ERRANDOS_LIVE_COMMIT:'true'},openDatabase:async()=>database})).rejects.toThrow('outbox worker');
    expect(closes).toBe(1);
    expect([process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')]).toEqual(before);
  });
  it('discovers the schema-backed health tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(({ name }) => name)).toEqual([
      'errand_health', 'provider_auth_status', 'provider_begin_login', 'search_products', 'prepare_grocery',
      'transaction_status', 'commit_transaction', 'reconcile_transaction', 'provider_submit_otp', 'place_cod_order',
      'blinkit_auth_status', 'blinkit_begin_login', 'blinkit_submit_otp', 'blinkit_search_products',
      'blinkit_prepare_cod_order', 'blinkit_place_cod_order', 'blinkit_order_status', 'blinkit_reconcile_order',
      'blinkit_cart_status', 'blinkit_prepare_existing_cart_cod_order',
      'blinkit_readiness',
      'blinkit_set_cart_item_quantity', 'blinkit_remove_cart_item', 'blinkit_clear_cart', 'blinkit_add_cart_item',
      'blinkit_list_saved_addresses', 'blinkit_recent_orders',
      'blinkit_start_prepare_cod_order', 'blinkit_operation_status', 'blinkit_current_screen',
      'blinkit_share_cart',
      'blinkit_compare_proposal', 'blinkit_recent_operations', 'blinkit_select_saved_address',
      'blinkit_import_shared_cart',
      'rapido_auth_status', 'rapido_begin_login', 'rapido_submit_otp',
      'rapido_readiness', 'rapido_quote_rides', 'rapido_prepare_ride', 'rapido_compare_proposal',
      'rapido_request_ride', 'rapido_ride_status', 'rapido_reconcile_ride', 'rapido_recent_trips',
      'rapido_resend_otp',
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object', properties: { includeService: expect.any(Object) } });
    expect(tools[0]?.outputSchema).toMatchObject({ type: 'object' });
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('advertises only the focused provider surface in canonical mode', async () => {
    const canonicalServer = createMcpServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { canonicalOnly: true },
    );
    const canonicalClient = new Client({ name: 'canonical-surface-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([canonicalServer.connect(st), canonicalClient.connect(ct)]);
    try {
      const { tools } = await canonicalClient.listTools();
      expect(tools.map(({ name }) => name)).toEqual([
        'blinkit_auth_status',
        'blinkit_begin_login',
        'blinkit_submit_otp',
        'blinkit_search_products',
        'blinkit_place_cod_order',
        'blinkit_order_status',
        'blinkit_reconcile_order',
        'blinkit_cart_status',
        'blinkit_prepare_existing_cart_cod_order',
        'blinkit_readiness',
        'blinkit_set_cart_item_quantity',
        'blinkit_remove_cart_item',
        'blinkit_clear_cart',
        'blinkit_add_cart_item',
        'blinkit_list_saved_addresses',
        'blinkit_recent_orders',
        'blinkit_start_prepare_cod_order',
        'blinkit_operation_status',
        'blinkit_current_screen',
        'blinkit_share_cart',
        'blinkit_compare_proposal',
        'blinkit_recent_operations',
        'blinkit_select_saved_address',
        'blinkit_import_shared_cart',
        'rapido_auth_status',
        'rapido_begin_login',
        'rapido_submit_otp',
        'rapido_readiness',
        'rapido_quote_rides',
        'rapido_prepare_ride',
        'rapido_compare_proposal',
        'rapido_request_ride',
        'rapido_ride_status',
        'rapido_reconcile_ride',
        'rapido_recent_trips',
        'rapido_resend_otp',
      ]);
      expect(tools).toHaveLength(36);
      expect(tools.map(({ name }) => name)).not.toEqual(expect.arrayContaining([
        'prepare_grocery',
        'blinkit_prepare_cod_order',
        'provider_begin_login',
        'commit_transaction',
      ]));
    } finally {
      await canonicalClient.close();
      await canonicalServer.close();
    }
  });

  it('invokes health and returns structured content', async () => {
    const result = await client.callTool({ name: 'errand_health', arguments: {} });
    expect(result.structuredContent).toEqual({ service: 'errandos-control-plane', status: 'ok' });
    expect(result.isError).not.toBe(true);
  });

  it('invokes provider tools through MCP without credentials', async () => {
    const known = (input: unknown): { kind: 'known'; value: 'blinkit' } => (input as { provider: { kind: 'known'; value: 'blinkit' } }).provider;
    const localServer = createMcpServer({
      status: async (_principal, input) => ({ version: 1, provider: known(input), accountKey: 'main', status: 'missing' }),
      begin: async (_principal, input) => ({ version: 1, sessionId: 'ps_mcp' as never, provider: known(input), accountKey: 'main', status: 'otp_sent' }),
      submitOtp: async (_principal, input) => ({ version: 1, sessionId: 'ps_mcp' as never, provider: known(input), accountKey: 'main', status: 'active' }),
    });
    const localClient = new Client({ name: 'auth-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const input = { version: 1, provider: { kind: 'known', value: 'blinkit' }, accountKey: 'main' };
      expect((await localClient.callTool({ name: 'provider_auth_status', arguments: input })).structuredContent).toMatchObject({ status: 'missing' });
      const began = await localClient.callTool({ name: 'provider_begin_login', arguments: { ...input, phone: '9876543210' } });
      expect(began.structuredContent).toMatchObject({ status: 'otp_sent', provider: { value: 'blinkit' } });
      const verified = await localClient.callTool({ name: 'provider_submit_otp', arguments: { ...input, otp: '123456' } });
      expect(verified.structuredContent).toMatchObject({ status: 'active' });
      expect(JSON.stringify(verified)).not.toMatch(/123456/); // the OTP value must never be echoed back
      expect(JSON.stringify(began)).not.toMatch(/cookie|password/i);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('passes Rapido phone and OTP once through provider-specific tools without returning them', async () => {
    const seen: unknown[] = [];
    const provider = { kind: 'known' as const, value: 'rapido' as const };
    const localServer = createMcpServer({
      status: async (_principal, input) => {
        seen.push(input);
        return { version: 1, provider, accountKey: 'main', status: 'login_required' };
      },
      begin: async (_principal, input) => {
        seen.push(input);
        return { version: 1, sessionId: 'rapido-session' as never, provider, accountKey: 'main', status: 'otp_sent' };
      },
      submitOtp: async (_principal, input) => {
        seen.push(input);
        return { version: 1, sessionId: 'rapido-session' as never, provider, accountKey: 'main', status: 'active' };
      },
      resendOtp: async (_principal, input) => {
        seen.push(input);
        return { version: 1, sessionId: 'rapido-session' as never, provider, accountKey: 'main', status: 'otp_sent' };
      },
    });
    const localClient = new Client({ name: 'rapido-auth-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const status = await localClient.callTool({
        name: 'rapido_auth_status',
        arguments: { accountKey: 'main' },
      });
      const began = await localClient.callTool({
        name: 'rapido_begin_login',
        arguments: { accountKey: 'main', phone: '9000000000' },
      });
      const completed = await localClient.callTool({
        name: 'rapido_submit_otp',
        arguments: { accountKey: 'main', otp: '1234' },
      });
      const resent = await localClient.callTool({
        name: 'rapido_resend_otp',
        arguments: { accountKey: 'main' },
      });
      expect(status.structuredContent).toMatchObject({ status: 'login_required', provider: { value: 'rapido' } });
      expect(began.structuredContent).toMatchObject({ status: 'otp_sent', provider: { value: 'rapido' } });
      expect(completed.structuredContent).toMatchObject({ status: 'active', provider: { value: 'rapido' } });
      expect(resent.structuredContent).toMatchObject({ status: 'otp_sent', provider: { value: 'rapido' } });
      expect(JSON.stringify([status, began, completed, resent])).not.toMatch(/9000000000|1234/);
      expect(seen).toHaveLength(4);
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it('exposes typed Rapido readiness, quote, and immutable preparation tools', async () => {
    const proposal = {
      version: 1 as const,
      proposalId: 'proposal_rapido_1',
      provider: 'rapido' as const,
      status: 'approval_required' as const,
      proposalHash: 'a'.repeat(64),
      summary: {
        kind: 'ride' as const,
        description: 'Prime Sedan from Indiranagar to Kempegowda Airport',
        fees: [],
        fareMin: { currency: 'INR' as const, amount: 850 },
        fareMax: { currency: 'INR' as const, amount: 920 },
        etaMinutes: 6,
        paymentMode: 'cash',
        addressSummary: 'Indiranagar → Kempegowda Airport',
        pickupSummary: 'Indiranagar',
        dropoffSummary: 'Kempegowda Airport',
        rideType: 'Prime Sedan',
      },
      expiresAt: '2026-07-26T10:05:00.000Z',
      requiresExternalApproval: true,
    };
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new Error('unused'); },
      prepareRapido: async () => proposal,
      quoteRapido: async () => ({
        version: 1 as const,
        status: 'completed' as const,
        pickupSummary: 'Indiranagar',
        dropoffSummary: 'Kempegowda Airport',
        options: [{
          rideOptionId: 'option_prime',
          name: 'Prime Sedan',
          fareMinimum: { currency: 'INR' as const, amount: 850 },
          fareMaximum: { currency: 'INR' as const, amount: 920 },
          fees: [],
          pickupEtaMinutes: 6,
          available: true,
        }],
      }),
      rapidoReadiness: async () => ({
        version: 1 as const,
        accountKey: 'main',
        status: 'ready' as const,
        checks: [
          { component: 'control_plane' as const, status: 'ready' as const },
          { component: 'worker' as const, status: 'ready' as const },
          { component: 'appium' as const, status: 'ready' as const },
          { component: 'emulator' as const, status: 'ready' as const },
          { component: 'rapido_app' as const, status: 'ready' as const },
          { component: 'authentication' as const, status: 'ready' as const },
        ],
      }),
      status: async () => proposal,
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'rapido-rides-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      await expect(localClient.callTool({
        name: 'rapido_readiness',
        arguments: { accountKey: 'main' },
      })).resolves.toMatchObject({ structuredContent: { status: 'ready' } });
      await expect(localClient.callTool({
        name: 'rapido_quote_rides',
        arguments: {
          accountKey: 'main',
          pickup: { query: 'Indiranagar' },
          dropoff: { query: 'Kempegowda Airport' },
        },
      })).resolves.toMatchObject({
        structuredContent: { status: 'completed', options: [{ name: 'Prime Sedan' }] },
      });
      await expect(localClient.callTool({
        name: 'rapido_prepare_ride',
        arguments: {
          accountKey: 'main',
          pickup: { query: 'Indiranagar' },
          dropoff: { query: 'Kempegowda Airport' },
          rideOptionId: 'option_prime',
          paymentMode: 'cash',
        },
      })).resolves.toMatchObject({
        structuredContent: { provider: 'rapido', status: 'approval_required', requiresExternalApproval: true },
      });
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it('rejects invalid input through the protocol', async () => {
    const result = await client.callTool({ name: 'errand_health', arguments: { includeService: false } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text' })]));
  });

  it('redacts provider failures and rejects committed output without a provider reference', async () => {
    const proposalId = 'proposal_redaction';
    const base = { version: 1 as const, proposalId, status: 'ambiguous' as const, reconciliationRequired: true as const };
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new Error('locator("#secret-selector") failed near <input value="otp">'); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<typeof base> => base,
      reconcile: async (): Promise<typeof base> => base,
      placeCodOrder: async (): Promise<{ version: 1; proposalId: string; status: 'committed'; reconciliationRequired: false }> => ({ version: 1, proposalId, status: 'committed', reconciliationRequired: false }),
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'redaction-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({ name: 'prepare_grocery', arguments: { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'milk', quantity: 1 }], deliveryAddressRef: 'home', paymentMode: 'cod' } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toMatch(/secret-selector|input value|otp/i);
      const invalidCommit = await localClient.callTool({ name: 'place_cod_order', arguments: { version: 1, proposalId, idempotencyKey: 'telegram-redaction-1' } });
      expect(invalidCommit.isError).toBe(true);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('returns only whitelisted worker failure categories to agents', async () => {
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new AndroidWorkerClientError('worker_unreachable'); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'safe-failure-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({ name: 'prepare_grocery', arguments: { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'milk', quantity: 1 }], deliveryAddressRef: 'home', paymentMode: 'cod' } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain('worker_unreachable');
      expect(JSON.stringify(failed)).not.toMatch(/secret|host|identity|known.?hosts/i);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('returns ordinary canonical Blinkit failures as typed successful tool results', async () => {
    const localServer = createMcpServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { search: async (): Promise<never> => { throw new AndroidWorkerClientError('worker_unreachable'); } },
    );
    const localClient = new Client({ name: 'typed-blinkit-failure-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({ name: 'blinkit_search_products', arguments: { query: 'milk' } });
      expect(failed.isError).not.toBe(true);
      expect(failed.structuredContent).toEqual({
        version: 1,
        status: 'failed',
        reason: 'worker_unreachable',
        retryable: true,
        suggestedAction: 'check_readiness',
      });
      expect(JSON.stringify(failed)).not.toMatch(/host|identity|known.?hosts|selector|xml|appium/i);
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it('classifies a missing proposal without exposing it as an MCP failure', async () => {
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new Error('unused'); },
      compareBlinkitProposal: async (): Promise<never> => { throw new ProposalNotFoundError(); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'missing-proposal-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({
        name: 'blinkit_compare_proposal',
        arguments: { accountKey: 'main', proposalId: 'proposal_missing' },
      });
      expect(failed.isError).not.toBe(true);
      expect(failed.structuredContent).toEqual({
        version: 1,
        status: 'failed',
        reason: 'proposal_not_found',
        retryable: false,
        suggestedAction: 'stop',
      });
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it('classifies address-screen navigation failures separately from provider serviceability', async () => {
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new Error('unused'); },
      listBlinkitSavedAddresses: async (): Promise<never> => { throw new AndroidWorkerOperationError('address_list'); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'address-screen-failure-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({ name: 'blinkit_list_saved_addresses', arguments: { accountKey: 'main' } });
      expect(failed.structuredContent).toEqual({
        version: 1,
        status: 'failed',
        reason: 'screen_blocked',
        retryable: true,
        suggestedAction: 'inspect_screen',
        stage: 'address_list',
      });
    } finally {
      await localClient.close();
      await localServer.close();
    }
  });

  it('returns a sanitized provider operation stage to agents', async () => {
    const tx = {
      prepareGrocery: async (): Promise<never> => { throw new AndroidWorkerOperationError('payment_unavailable'); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'provider-stage-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const failed = await localClient.callTool({ name: 'prepare_grocery', arguments: { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'milk', quantity: 1 }], deliveryAddressRef: 'home', paymentMode: 'cod' } });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain('payment_unavailable');
      expect(JSON.stringify(failed)).not.toMatch(/12:00|6:00|selector|xml|appium/i);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('returns provider checkout restrictions as structured Blinkit blocked results', async () => {
    const tx = {
      prepareGrocery: async (): Promise<never> => {
        throw new AndroidWorkerOperationError('cod_minimum_not_met', { itemSubtotal: 25, requiredSubtotal: 50 });
      },
      prepareExistingGrocery: async (): Promise<never> => { throw new AndroidWorkerOperationError('product_unavailable'); },
      status: async (): Promise<never> => { throw new Error('unused'); },
      commit: async (): Promise<never> => { throw new Error('unused'); },
      reconcile: async (): Promise<never> => { throw new Error('unused'); },
      placeCodOrder: async (): Promise<never> => { throw new Error('unused'); },
    };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'blocked-checkout-test', version: '0.1.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const blocked = await localClient.callTool({ name: 'blinkit_prepare_cod_order', arguments: {
        items: [{ query: 'chips', offerId: 'offer_chips', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home',
      } });
      expect(blocked.isError).not.toBe(true);
      expect(blocked.structuredContent).toEqual({
        version: 1, provider: 'blinkit', status: 'blocked', reason: 'cod_minimum_not_met', itemSubtotal: 25, requiredSubtotal: 50,
      });
      const existing = await localClient.callTool({ name: 'blinkit_prepare_existing_cart_cod_order', arguments: {} });
      expect(existing.structuredContent).toEqual({ version: 1, provider: 'blinkit', status: 'blocked', reason: 'product_unavailable' });
      expect(JSON.stringify({ blocked, existing })).not.toMatch(/selector|coordinate|screenshot|xml|appium/i);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('invokes read-only product search and returns structured content', async () => {
    const localServer=createMcpServer(undefined,undefined,{search:async()=>({version:1,status:'completed',offers:[{title:'Earbuds',platform:'amazon',price:2999}],searchedPlatforms:2,failedPlatforms:0})});
    const localClient=new Client({name:'search-test',version:'0.1.0'}); const [ct,st]=InMemoryTransport.createLinkedPair(); await Promise.all([localServer.connect(st),localClient.connect(ct)]);
    try { const tools=await localClient.listTools(); const tool=tools.tools.find(({name})=>name==='search_products'); expect(tool?.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}); const result=await localClient.callTool({name:'search_products',arguments:{version:1,request:'wireless earbuds',deliveryPincode:'560103',budgetMax:5000}}); expect(result.structuredContent).toMatchObject({status:'completed',offers:[{title:'Earbuds',price:2999}]}); }
    finally { await localClient.close(); await localServer.close(); }
  });

  it('exposes agent-portable Blinkit aliases without provider or device details', async () => {
    const provider = { kind: 'known' as const, value: 'blinkit' as const };
    const proposal = { version: 1 as const, proposalId: 'proposal_blinkit', provider: 'blinkit' as const, status: 'prepared' as const, proposalHash: 'a'.repeat(64), summary: { kind: 'grocery' as const, description: 'Brown Bread x1', items: [{ name: 'Brown Bread', quantity: 1 }], total: { currency: 'INR' as const, amount: 45 }, paymentMode: 'cod', addressSummary: 'Home' }, expiresAt: '2026-07-19T12:00:00.000Z', requiresExternalApproval: false as const };
    const auth = {
      status: async (_principal: unknown, input: unknown): Promise<ProviderAuthStatusOutput> => ({ version: 1, provider, accountKey: (input as { accountKey: string }).accountKey, status: 'active' }),
      begin: async (): Promise<ProviderBeginLoginOutput> => ({ version: 1, sessionId: 'session-1' as never, provider, accountKey: 'main', status: 'otp_sent' }),
      submitOtp: async (): Promise<ProviderSubmitOtpOutput> => ({ version: 1, sessionId: 'session-1' as never, provider, accountKey: 'main', status: 'active' }),
    };
    const tx = {
      blinkitReadiness: async (): Promise<import('@errandos/contracts').BlinkitReadinessOutputV1> => ({
        version: 1,
        accountKey: 'main',
        status: 'ready',
        checks: [
          { component: 'control_plane', status: 'ready' },
          { component: 'worker', status: 'ready' },
          { component: 'appium', status: 'ready' },
          { component: 'emulator', status: 'ready' },
          { component: 'blinkit_app', status: 'ready' },
          { component: 'authentication', status: 'ready' },
        ],
      }),
      currentBlinkitScreen: async (): Promise<import('@errandos/contracts').BlinkitCurrentScreenOutputV1> => ({
        version: 1,
        status: 'completed',
        screen: {
          kind: 'product_detail',
          searchAction: 'available',
          cartItemCount: 3,
          product: {
            name: "Lay's Magic Masala Chips",
            packSize: '58 g',
            price: { currency: 'INR', amount: 25 },
          },
        },
      }),
      shareBlinkitCart: async (): Promise<import('@errandos/contracts').BlinkitShareCartOutputV1> => ({
        version: 1,
        status: 'completed',
        shareUrl: 'https://blinkit.com/cart/share/example',
        cartFingerprint: 'b'.repeat(64),
      }),
      importBlinkitSharedCart: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitImportSharedCartOutputV1> => {
        expect(input).toMatchObject({
          accountKey: 'main',
          shareUrl: 'https://blinkit.com/cart/share/example',
        });
        return {
          version: 1,
          status: 'completed',
          importBehavior: 'unchanged',
          previousCartFingerprint: 'b'.repeat(64),
          cart: {
            lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 1, unitPrice: { currency: 'INR', amount: 45 }, lineTotal: { currency: 'INR', amount: 45 } }],
            unavailableItems: [],
            subtotal: { currency: 'INR', amount: 45 },
            addressReference: 'saved:home',
            addressLabel: 'Home',
            paymentMode: 'unselected',
            providerFingerprint: 'b'.repeat(64),
          },
        };
      },
      compareBlinkitProposal: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitCompareProposalOutputV1> => {
        expect(input).toMatchObject({ accountKey: 'main', proposalId: proposal.proposalId });
        return {
          version: 1,
          proposalId: proposal.proposalId,
          proposalHash: proposal.proposalHash,
          proposalStatus: 'prepared',
          status: 'unchanged',
          changes: [],
          currentProviderFingerprint: 'b'.repeat(64),
        };
      },
      prepareGrocery: async (_principal: unknown, input: unknown): Promise<typeof proposal> => { expect(input).toMatchObject({ provider: 'blinkit', paymentMode: 'cod', items: [{ offerId: 'offer_abc' }] }); return proposal; },
      prepareExistingGrocery: async (_principal: unknown, input: unknown): Promise<typeof proposal> => { expect(input).toMatchObject({ provider: 'blinkit', accountKey: 'main', paymentMode: 'cod' }); return proposal; },
      inspectBlinkitCart: async (): Promise<import('@errandos/contracts').BlinkitCartStatusOutputV1> => ({ version: 1, status: 'completed', cart: { lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 1, unitPrice: { currency: 'INR', amount: 45 }, lineTotal: { currency: 'INR', amount: 45 } }], unavailableItems: [], subtotal: { currency: 'INR', amount: 45 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected', providerFingerprint: 'b'.repeat(64) } }),
      addBlinkitCartItem: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitCartStatusOutputV1> => { expect(input).toMatchObject({ query: 'brown bread', offerId: 'offer_abc', quantity: 2 }); return { version: 1, status: 'completed', cart: { lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 2, unitPrice: { currency: 'INR', amount: 45 }, lineTotal: { currency: 'INR', amount: 90 } }], unavailableItems: [], subtotal: { currency: 'INR', amount: 90 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected', providerFingerprint: 'c'.repeat(64) } }; },
      setBlinkitCartItemQuantity: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitCartStatusOutputV1> => { expect(input).toMatchObject({ productId: 'cart_abc', quantity: 2 }); return { version: 1, status: 'completed', cart: { lines: [{ productId: 'cart_abc', name: 'Brown Bread', quantity: 2, unitPrice: { currency: 'INR', amount: 45 }, lineTotal: { currency: 'INR', amount: 90 } }], unavailableItems: [], subtotal: { currency: 'INR', amount: 90 }, addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected', providerFingerprint: 'c'.repeat(64) } }; },
      removeBlinkitCartItem: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitCartStatusOutputV1> => { expect(input).toMatchObject({ productId: 'cart_abc' }); return { version: 1, status: 'empty' }; },
      clearBlinkitCart: async (): Promise<import('@errandos/contracts').BlinkitCartStatusOutputV1> => ({ version: 1, status: 'empty' }),
      listBlinkitSavedAddresses: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitListSavedAddressesOutputV1> => {
        expect(input).toMatchObject({ requestedLabel: 'Work' });
        return { version: 1, status: 'completed', addresses: [{ addressReference: `address_${'a'.repeat(32)}`, label: 'Home' }] };
      },
      selectBlinkitSavedAddress: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitSelectSavedAddressOutputV1> => {
        expect(input).toMatchObject({ addressReference: `address_${'a'.repeat(32)}` });
        return {
          version: 1,
          status: 'completed',
          selectedAddress: { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' },
          cartStatus: 'unverified',
        };
      },
      listBlinkitRecentOrders: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitRecentOrdersOutputV1> => { expect(input).toMatchObject({ accountKey: 'main', limit: 5 }); return { version: 1, status: 'completed', orders: [{ orderReference: 'BLK123456', items: [{ name: 'Brown Bread', quantity: 1 }], total: { currency: 'INR', amount: 65 }, orderedAt: '2026-07-23T10:00:00.000Z', providerStatus: 'delivered' }] }; },
      status: async (): Promise<typeof proposal> => proposal,
      commit: async (): Promise<CommitOutput> => ({ version: 1, proposalId: proposal.proposalId, status: 'ambiguous', reconciliationRequired: true }),
      reconcile: async (): Promise<CommitOutput> => ({ version: 1, proposalId: proposal.proposalId, status: 'ambiguous', reconciliationRequired: true }),
      placeCodOrder: async (): Promise<CommitOutput> => ({ version: 1, proposalId: proposal.proposalId, status: 'committed', providerReference: 'order-1', reconciliationRequired: false }),
    };
    const blinkitSearch = { search: async (): Promise<BlinkitSearchProductsOutputV1> => ({ version: 1, status: 'completed', offers: [{ offerId: 'offer_abc', title: 'Brown Bread', packSize: '400 g', price: { currency: 'INR', amount: 45 }, available: true, imageUrl: 'https://cdn.grofers.com/products/bread.png' }] }) };
    const operationId = 'operation_123e4567-e89b-12d3-a456-426614174000';
    const operationTimes = { startedAt: '2026-07-23T10:00:00.000Z', updatedAt: '2026-07-23T10:00:01.000Z', expiresAt: '2026-07-23T10:03:00.000Z' };
    const blinkitOperations = {
      startPrepare: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitStartPrepareCodOrderOutputV1> => {
        expect(input).toMatchObject({ accountKey: 'main', idempotencyKey: 'telegram-message-123', items: [{ offerId: 'offer_abc' }] });
        return { version: 1, operationId, status: 'running', ...operationTimes };
      },
      status: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitOperationStatusOutputV1> => {
        expect(input).toMatchObject({ accountKey: 'main', operationId });
        return { version: 1, operationId, status: 'completed', ...operationTimes, proposal };
      },
      recent: async (_principal: unknown, input: unknown): Promise<import('@errandos/contracts').BlinkitRecentOperationsOutputV1> => {
        expect(input).toMatchObject({ accountKey: 'main', limit: 5 });
        return {
          version: 1,
          status: 'completed',
          operations: [{ operationId, status: 'completed', ...operationTimes, proposalId: proposal.proposalId }],
        };
      },
    };
    const localServer = createMcpServer(auth, 'owner' as never, undefined, tx, undefined, blinkitSearch, blinkitOperations);
    const localClient = new Client({ name: 'blinkit-alias-test', version: '0.1.0' }); const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      expect((await localClient.callTool({ name: 'blinkit_auth_status', arguments: {} })).structuredContent).toMatchObject({ status: 'active', provider: { value: 'blinkit' } });
      expect((await localClient.callTool({ name: 'blinkit_readiness', arguments: {} })).structuredContent).toMatchObject({ status: 'ready', checks: expect.arrayContaining([{ component: 'worker', status: 'ready' }]) });
      const currentScreen = await localClient.callTool({ name: 'blinkit_current_screen', arguments: {} });
      expect(currentScreen.structuredContent).toMatchObject({
        status: 'completed',
        screen: { kind: 'product_detail', searchAction: 'available', cartItemCount: 3 },
      });
      expect(JSON.stringify(currentScreen)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
      const sharedCart = await localClient.callTool({ name: 'blinkit_share_cart', arguments: {} });
      expect(sharedCart.structuredContent).toMatchObject({
        status: 'completed',
        shareUrl: 'https://blinkit.com/cart/share/example',
        cartFingerprint: 'b'.repeat(64),
      });
      expect(JSON.stringify(sharedCart)).not.toMatch(/clipboard|intent|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
      const importedCart = await localClient.callTool({
        name: 'blinkit_import_shared_cart',
        arguments: { shareUrl: 'https://blinkit.com/cart/share/example' },
      });
      expect(importedCart.structuredContent).toMatchObject({
        status: 'completed',
        importBehavior: 'unchanged',
        cart: { lines: [{ name: 'Brown Bread' }] },
      });
      expect(JSON.stringify(importedCart)).not.toMatch(/shareUrl|intent|selector|coordinate|resource.?id|screenshot|xml|path|host|emulator/i);
      const searched = await localClient.callTool({ name: 'blinkit_search_products', arguments: { query: 'brown bread' } });
      expect(searched.structuredContent).toMatchObject({ offers: [{ offerId: 'offer_abc', imageUrl: expect.stringContaining('grofers.com') }] });
      expect(JSON.stringify(searched)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml/i);
      expect((await localClient.callTool({ name: 'blinkit_prepare_cod_order', arguments: { items: [{ query: 'brown bread', offerId: 'offer_abc', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home' } })).structuredContent).toMatchObject({ status: 'prepared' });
      expect((await localClient.callTool({ name: 'blinkit_cart_status', arguments: {} })).structuredContent).toMatchObject({ status: 'completed', cart: { lines: [{ name: 'Brown Bread' }] } });
      expect((await localClient.callTool({ name: 'blinkit_add_cart_item', arguments: { query: 'brown bread', offerId: 'offer_abc', quantity: 2 } })).structuredContent).toMatchObject({ cart: { lines: [{ quantity: 2 }] } });
      expect((await localClient.callTool({ name: 'blinkit_set_cart_item_quantity', arguments: { productId: 'cart_abc', quantity: 2 } })).structuredContent).toMatchObject({ cart: { lines: [{ quantity: 2 }] } });
      expect((await localClient.callTool({ name: 'blinkit_remove_cart_item', arguments: { productId: 'cart_abc' } })).structuredContent).toEqual({ version: 1, status: 'empty' });
      expect((await localClient.callTool({ name: 'blinkit_clear_cart', arguments: {} })).structuredContent).toEqual({ version: 1, status: 'empty' });
      const addresses = await localClient.callTool({ name: 'blinkit_list_saved_addresses', arguments: { requestedLabel: 'Work' } });
      expect(addresses.structuredContent).toMatchObject({ addresses: [{ label: 'Home' }] });
      const orders = await localClient.callTool({ name: 'blinkit_recent_orders', arguments: {} });
      expect(orders.structuredContent).toMatchObject({ orders: [{ orderReference: 'BLK123456', providerStatus: 'delivered' }] });
      expect(JSON.stringify({ addresses, orders })).not.toMatch(/rawAddress|selector|coordinate|resource.?id|screenshot|xml|emulator/i);
      expect((await localClient.callTool({
        name: 'blinkit_select_saved_address',
        arguments: { addressReference: `address_${'a'.repeat(32)}` },
      })).structuredContent).toMatchObject({ selectedAddress: { label: 'Home' }, cartStatus: 'unverified' });
      expect((await localClient.callTool({ name: 'blinkit_prepare_existing_cart_cod_order', arguments: {} })).structuredContent).toMatchObject({ status: 'prepared' });
      const started = await localClient.callTool({ name: 'blinkit_start_prepare_cod_order', arguments: { idempotencyKey: 'telegram-message-123', items: [{ query: 'brown bread', offerId: 'offer_abc', quantity: 1 }], deliveryAddressRef: 'home', deliveryAddressLabel: 'Home' } });
      expect(started.structuredContent).toMatchObject({ operationId, status: 'running' });
      const operation = await localClient.callTool({ name: 'blinkit_operation_status', arguments: { operationId } });
      expect(operation.structuredContent).toMatchObject({ operationId, status: 'completed', proposal: { proposalId: 'proposal_blinkit' } });
      const recentOperations = await localClient.callTool({ name: 'blinkit_recent_operations', arguments: {} });
      expect(recentOperations.structuredContent).toMatchObject({ operations: [{ operationId, proposalId: proposal.proposalId }] });
      const comparison = await localClient.callTool({ name: 'blinkit_compare_proposal', arguments: { proposalId: proposal.proposalId } });
      expect(comparison.structuredContent).toMatchObject({ status: 'unchanged', changes: [] });
      expect(JSON.stringify({ started, operation, recentOperations, comparison })).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml|emulator/i);
    } finally { await localClient.close(); await localServer.close(); }
  });

  it('calls transaction handlers, validates inputs, annotates commit, and redacts state', async () => {
    const proposal = { version: 1 as const, proposalId: 'proposal_test', provider: 'blinkit' as const, status: 'approval_required' as const, proposalHash: 'a'.repeat(64), summary: { kind: 'grocery' as const, description: 'Milk x1', items: [{ name: 'milk', quantity: 1 }], total: { currency: 'INR' as const, amount: 75 }, paymentMode: 'cod', addressSummary: 'Home' }, expiresAt: '2026-07-11T12:00:00.000Z', requiresExternalApproval: true as const };
    let calls = 0;
    const tx = { prepareGrocery: async (): Promise<typeof proposal> => { calls++; return proposal; }, status: async (): Promise<typeof proposal> => proposal, commit: async (): Promise<{ version: 1; proposalId: string; status: 'ambiguous'; reconciliationRequired: true }> => ({ version: 1, proposalId: proposal.proposalId, status: 'ambiguous', reconciliationRequired: true }), reconcile: async (): Promise<{ version: 1; proposalId: string; status: 'ambiguous'; reconciliationRequired: true }> => ({ version: 1, proposalId: proposal.proposalId, status: 'ambiguous', reconciliationRequired: true }), placeCodOrder: async (): Promise<{ version: 1; proposalId: string; status: 'committed'; providerReference: string; reconciliationRequired: false }> => ({ version: 1, proposalId: proposal.proposalId, status: 'committed', providerReference: 'BLK123456', reconciliationRequired: false }) };
    const localServer = createMcpServer(undefined, undefined, undefined, tx);
    const localClient = new Client({ name: 'transaction-test', version: '0.1.0' }); const [ct, st] = InMemoryTransport.createLinkedPair(); await Promise.all([localServer.connect(st), localClient.connect(ct)]);
    try {
      const tools = await localClient.listTools(); expect(tools.tools.find(({ name }) => name === 'commit_transaction')?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
      const result = await localClient.callTool({ name: 'prepare_grocery', arguments: { version: 1, provider: 'blinkit', accountKey: 'main', items: [{ query: 'milk', quantity: 1 }], deliveryAddressRef: 'home', paymentMode: 'cod' } });
      expect(calls).toBe(1); expect(result.structuredContent).toMatchObject({ proposalId: 'proposal_test', status: 'approval_required' }); expect(JSON.stringify(result)).not.toMatch(/providerStateRef|cookie|profilePath|selector/i);
      expect((await localClient.callTool({ name: 'prepare_grocery', arguments: { version: 1, provider: 'blinkit', accountKey: 'main', items: [], deliveryAddressRef: 'home' } })).isError).toBe(true);
      const placed = await localClient.callTool({ name: 'place_cod_order', arguments: { version: 1, proposalId: proposal.proposalId, idempotencyKey: 'telegram-update-123' } });
      expect(placed.structuredContent).toMatchObject({ status: 'committed', providerReference: 'BLK123456' });
      expect((await localClient.callTool({ name: 'place_cod_order', arguments: { version: 1, proposalId: proposal.proposalId } })).isError).toBe(true);
    } finally { await localClient.close(); await localServer.close(); }
  });
});
