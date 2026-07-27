/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { BlinkitAccountInputSchemaV1,BlinkitAddCartItemInputSchemaV1,BlinkitBeginLoginInputSchemaV1,BlinkitCartStatusOutputSchemaV1,BlinkitCheckoutBlockedOutputSchemaV1,BlinkitCheckoutBlockedReasonSchemaV1,BlinkitClearCartInputSchemaV1,BlinkitCompareProposalInputSchemaV1,BlinkitCompareProposalOutputObjectSchemaV1,BlinkitCurrentScreenOutputSchemaV1,BlinkitImportSharedCartInputSchemaV1,BlinkitImportSharedCartOutputSchemaV1,BlinkitListSavedAddressesInputSchemaV1,BlinkitListSavedAddressesOutputSchemaV1,BlinkitOperationFailureReasonSchemaV1,BlinkitOperationStatusInputSchemaV1,BlinkitOperationStatusOutputObjectSchemaV1,BlinkitPrepareCodOrderInputSchemaV1,BlinkitPrepareCodOrderOutputObjectSchemaV1,BlinkitPrepareCodOrderOutputSchemaV1,BlinkitPrepareExistingCartCodOrderInputSchemaV1,BlinkitReadinessOutputSchemaV1,BlinkitRecentOperationsInputSchemaV1,BlinkitRecentOperationsOutputSchemaV1,BlinkitRecentOrdersInputSchemaV1,BlinkitRecentOrdersOutputSchemaV1,BlinkitRemoveCartItemInputSchemaV1,BlinkitSearchProductsInputSchemaV1,BlinkitSearchProductsOutputSchemaV1,BlinkitSelectSavedAddressInputSchemaV1,BlinkitSelectSavedAddressOutputObjectSchemaV1,BlinkitSetCartItemQuantityInputSchemaV1,BlinkitShareCartOutputSchemaV1,BlinkitStartPrepareCodOrderInputSchemaV1,BlinkitStartPrepareCodOrderOutputSchemaV1,BlinkitSubmitOtpInputSchemaV1,BlinkitToolFailureOutputSchemaV1,HealthInputSchema,HealthOutputSchema,ProductSearchInputSchemaV1,ProductSearchOutputSchemaV1,ProviderAuthStatusInputSchemaV1,ProviderAuthStatusOutputSchemaV1,ProviderBeginLoginInputSchemaV1,ProviderBeginLoginOutputSchemaV1,ProviderSubmitOtpInputSchemaV1,ProviderSubmitOtpOutputSchemaV1,PrepareExistingGroceryInputSchemaV1,PrepareGroceryInputSchemaV1,ProposalRefInputSchemaV1,ProposalOutputSchemaV1,CommitInputSchemaV1,CommitOutputObjectSchemaV1,CommitOutputSchemaV1,PlaceCodOrderInputSchemaV1,type BlinkitCartStatusOutputV1,type BlinkitCheckoutBlockedOutputV1,type BlinkitCompareProposalOutputV1,type BlinkitCurrentScreenOutputV1,type BlinkitImportSharedCartOutputV1,type BlinkitListSavedAddressesOutputV1,type BlinkitOperationFailureReasonV1,type BlinkitOperationStatusOutputV1,type BlinkitPrepareCodOrderOutputV1,type BlinkitReadinessOutputV1,type BlinkitRecentOperationsOutputV1,type BlinkitRecentOrdersOutputV1,type BlinkitSearchProductsOutputV1,type BlinkitSelectSavedAddressOutputV1,type BlinkitShareCartOutputV1,type BlinkitStartPrepareCodOrderOutputV1,type BlinkitToolFailureOutputV1,type HealthOutput,type PrincipalId,type ProductSearchOutput,type ProviderAuthStatusOutput,type ProviderBeginLoginOutput,type ProviderSubmitOtpOutput,type ProposalOutput,type CommitOutput } from '@errandos/contracts';
import {
  RapidoAccountInputSchemaV1,
  RapidoBeginLoginInputSchemaV1,
  RapidoCompareProposalInputSchemaV1,
  RapidoCompareProposalOutputObjectSchemaV1,
  RapidoFailureReasonSchemaV1,
  RapidoPrepareRideInputSchemaV1,
  RapidoPrepareRideInputObjectSchemaV1,
  RapidoQuoteRidesInputSchemaV1,
  RapidoQuoteRidesOutputSchemaV1,
  RapidoReadinessOutputSchemaV1,
  RapidoRecentTripsInputSchemaV1,
  RapidoRecentTripsOutputSchemaV1,
  RapidoRequestRideInputSchemaV1,
  RapidoResendOtpInputSchemaV1,
  RapidoRideStatusInputSchemaV1,
  RapidoSubmitOtpInputSchemaV1,
  RapidoToolFailureOutputSchemaV1,
  type RapidoCompareProposalOutputV1,
  type RapidoFailureReasonV1,
  type RapidoQuoteRidesOutputV1,
  type RapidoReadinessOutputV1,
  type RapidoRecentTripsOutputV1,
  type RapidoToolFailureOutputV1,
} from '@errandos/contracts';
import { AndroidBlinkitAdapter, AndroidBlinkitAuthCoordinator, AndroidRapidoAdapter, AndroidRapidoAuthCoordinator, AndroidWorkerClientError, AndroidWorkerOperationError, BrowserAutomationProductSearchConnector, FileProviderState, SshAndroidWorkerClient } from '@errandos/provider-connectors';
import { BlinkitOperationService, FileBlinkitOperationRepository, FileProposalRepository, HmacApprovalStore, TransactionService } from '@errandos/application';
import type { TransactionProviderPort } from '@errandos/application';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ZodRawShape } from 'zod';
import { z } from 'zod';
import { openProductionDatabase, type PostgresDatabase } from '@errandos/persistence';
import { PostgresHmacApprovalVerifier, PostgresRuntimeProposalRepository } from './postgres-transactions.js';
import { validateDeploymentEnvironment } from './deployment.js';

export const ERRAND_MCP_TOOLS=[
{name:'errand_health',description:'Read-only readiness status.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'provider_auth_status',description:'Read-only redacted provider authentication status.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'provider_begin_login',description:'Begin agent-driven login: submit the user-provided phone number; triggers an OTP. Returns otp_sent.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'search_products',description:'Read-only marketplace product search.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'prepare_grocery',description:'Prepare a Blinkit cart and immutable approval proposal. Never orders.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'transaction_status',description:'Read proposal or reconciliation status.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'commit_transaction',description:'Commit using an externally signed, single-use approval capability and idempotency key.',annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},
{name:'reconcile_transaction',description:'Reconcile an ambiguous provider outcome; never retries a commit.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'provider_submit_otp',description:'Submit the user-provided OTP to complete provider login and persist the session.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'place_cod_order',description:'Place an existing Blinkit COD proposal in trusted personal mode. Requires an idempotency key.',annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_auth_status',description:'Read the sanitized authentication state for the persistent Blinkit Android account.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_begin_login',description:'Enter the owner-provided phone number in the Blinkit Android app and request an OTP.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'blinkit_submit_otp',description:'Enter the owner-provided OTP in the active Blinkit Android login challenge.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'blinkit_search_products',description:'Search the live Blinkit Android catalog and return selectable opaque offer IDs.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_prepare_cod_order',description:'Build an exact Blinkit Android cart, select COD, and return an immutable proposal. Never places the order.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'blinkit_place_cod_order',description:'Place one prepared Blinkit COD proposal with a stable idempotency key.',annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_order_status',description:'Read the durable status of a Blinkit order proposal.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_reconcile_order',description:'Read Blinkit order history to reconcile an uncertain final action without retrying it.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_cart_status',description:'Read the exact current Blinkit Android cart without changing its items or placing an order.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_prepare_existing_cart_cod_order',description:'Select COD for the existing Blinkit Android cart and return an immutable proposal. Never places the order.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'blinkit_readiness',description:'Read sanitized Blinkit worker, Appium, emulator, app, and authentication readiness without exposing device internals.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_set_cart_item_quantity',description:'Set one exact existing Blinkit cart line to a requested quantity and return the refreshed cart.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_remove_cart_item',description:'Remove one exact existing Blinkit cart line and return the refreshed cart.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_clear_cart',description:'Remove every item from the existing Blinkit cart and return the verified empty cart state.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_add_cart_item',description:'Set one exact searched Blinkit offer to a final quantity while preserving every other cart line, then return the refreshed cart.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_list_saved_addresses',description:'Read saved Blinkit address labels with opaque references. Never returns full address text or device data.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_recent_orders',description:'Read sanitized recent Blinkit order references, items, totals, timestamps, and provider statuses.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_start_prepare_cod_order',description:'Start durable asynchronous Blinkit Android cart preparation. Returns immediately and never places the order.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_operation_status',description:'Read the durable status or completed proposal for one asynchronous Blinkit operation.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_current_screen',description:'Read the sanitized semantic Blinkit screen type and safe product/cart context. Never returns screenshots or device internals.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_share_cart',description:'Create and return the official Blinkit share link for the verified existing cart. Never prepares or places an order.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'blinkit_compare_proposal',description:'Re-read exact live checkout terms and compare them with one immutable Blinkit proposal. Never places an order.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_recent_operations',description:'List recent durable Blinkit preparation operations for recovery after an agent restart.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'blinkit_select_saved_address',description:'Select one exact saved Blinkit address by opaque reference. Follow with cart status to verify store-dependent cart changes.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'blinkit_import_shared_cart',description:'Open one official Blinkit share link in the owner Android app and return the complete verified resulting cart. Never prepares or places an order.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'rapido_auth_status',description:'Read the sanitized authentication state for the persistent Rapido Android account.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'rapido_begin_login',description:'Enter the owner-provided phone number in the Rapido Android app and request an OTP.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'rapido_submit_otp',description:'Enter the owner-provided OTP in the active Rapido Android login challenge.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'rapido_readiness',description:'Read sanitized Rapido worker, Appium, emulator, app, and authentication readiness.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'rapido_quote_rides',description:'Read live Rapido ride options, fares, and pickup ETAs for an exact route. Never requests a ride.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'rapido_prepare_ride',description:'Select a Rapido ride and return an immutable exact-term proposal. Never requests the ride.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
{name:'rapido_compare_proposal',description:'Re-read live Rapido ride terms and compare them with an immutable proposal. Never requests a ride.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'rapido_request_ride',description:'Request one externally approved Rapido ride proposal with an idempotency key.',annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},
{name:'rapido_ride_status',description:'Read the durable status of a Rapido ride proposal.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
{name:'rapido_reconcile_ride',description:'Read Rapido trip history to reconcile an uncertain request without retrying the final action.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'rapido_recent_trips',description:'Read sanitized recent Rapido trip references, routes, fares, timestamps, and statuses.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
{name:'rapido_resend_otp',description:'Request a fresh OTP from the active Rapido Android login challenge without exposing device controls.',annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
] as const;
export const CANONICAL_ERRAND_MCP_TOOL_NAMES = new Set<string>([
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
export interface McpServerOptions { canonicalOnly?: boolean }
export interface McpAuthHandlers{status(p:PrincipalId,i:unknown):Promise<ProviderAuthStatusOutput>;begin(p:PrincipalId,i:unknown):Promise<ProviderBeginLoginOutput>;submitOtp(p:PrincipalId,i:unknown):Promise<ProviderSubmitOtpOutput>;resendOtp?(p:PrincipalId,i:unknown):Promise<ProviderBeginLoginOutput>}
export interface McpProductSearchHandler{search(i:unknown):Promise<ProductSearchOutput>}
export interface McpBlinkitSearchHandler{search(i:unknown):Promise<BlinkitSearchProductsOutputV1>}
export interface McpBlinkitOperationHandlers{startPrepare(p:PrincipalId,i:unknown):Promise<BlinkitStartPrepareCodOrderOutputV1>;status(p:PrincipalId,i:unknown):Promise<BlinkitOperationStatusOutputV1>;recent(p:PrincipalId,i:unknown):Promise<BlinkitRecentOperationsOutputV1>}
export interface McpTransactionHandlers{prepareGrocery(p:PrincipalId,i:unknown):Promise<ProposalOutput>;prepareExistingGrocery?(p:PrincipalId,i:unknown):Promise<ProposalOutput>;prepareRapido?(p:PrincipalId,i:unknown):Promise<ProposalOutput>;quoteRapido?(p:PrincipalId,i:unknown):Promise<RapidoQuoteRidesOutputV1>;compareRapidoProposal?(p:PrincipalId,i:unknown):Promise<RapidoCompareProposalOutputV1>;rapidoReadiness?(p:PrincipalId,i:unknown):Promise<RapidoReadinessOutputV1>;listRapidoRecentTrips?(p:PrincipalId,i:unknown):Promise<RapidoRecentTripsOutputV1>;requestRapidoRide?(p:PrincipalId,i:unknown):Promise<CommitOutput>;inspectBlinkitCart?(p:PrincipalId,i:unknown):Promise<BlinkitCartStatusOutputV1>;currentBlinkitScreen?(p:PrincipalId,i:unknown):Promise<BlinkitCurrentScreenOutputV1>;shareBlinkitCart?(p:PrincipalId,i:unknown):Promise<BlinkitShareCartOutputV1>;importBlinkitSharedCart?(p:PrincipalId,i:unknown):Promise<BlinkitImportSharedCartOutputV1>;compareBlinkitProposal?(p:PrincipalId,i:unknown):Promise<BlinkitCompareProposalOutputV1>;blinkitReadiness?(p:PrincipalId,i:unknown):Promise<BlinkitReadinessOutputV1>;addBlinkitCartItem?(p:PrincipalId,i:unknown):Promise<BlinkitCartStatusOutputV1>;setBlinkitCartItemQuantity?(p:PrincipalId,i:unknown):Promise<BlinkitCartStatusOutputV1>;removeBlinkitCartItem?(p:PrincipalId,i:unknown):Promise<BlinkitCartStatusOutputV1>;clearBlinkitCart?(p:PrincipalId,i:unknown):Promise<BlinkitCartStatusOutputV1>;listBlinkitSavedAddresses?(p:PrincipalId,i:unknown):Promise<BlinkitListSavedAddressesOutputV1>;selectBlinkitSavedAddress?(p:PrincipalId,i:unknown):Promise<BlinkitSelectSavedAddressOutputV1>;listBlinkitRecentOrders?(p:PrincipalId,i:unknown):Promise<BlinkitRecentOrdersOutputV1>;status(p:PrincipalId,i:unknown):Promise<ProposalOutput>;commit(p:PrincipalId,i:unknown):Promise<CommitOutput>;reconcile(p:PrincipalId,i:unknown):Promise<CommitOutput>;placeCodOrder(p:PrincipalId,i:unknown):Promise<CommitOutput>}
const unavailable:McpAuthHandlers={status:async(_p,i)=>{const v=ProviderAuthStatusInputSchemaV1.parse(i);return{version:1,provider:v.provider,accountKey:v.accountKey,status:'missing'}},begin:async()=>{throw new Error('login coordinator not configured')},submitOtp:async()=>{throw new Error('login coordinator not configured')}};
const unavailableSearch:McpProductSearchHandler={search:async()=>{throw new Error('product search connector not configured')}};
const unavailableBlinkitSearch:McpBlinkitSearchHandler={search:async()=>{throw new Error('Android Blinkit search not configured')}};
const unavailableBlinkitOperations:McpBlinkitOperationHandlers={startPrepare:async()=>{throw new Error('Android Blinkit operations not configured')},status:async()=>{throw new Error('Android Blinkit operations not configured')},recent:async()=>{throw new Error('Android Blinkit operations not configured')}};
const unavailableTx:McpTransactionHandlers={prepareGrocery:async()=>{throw new Error('transaction service not configured')},prepareExistingGrocery:async()=>{throw new Error('transaction service not configured')},inspectBlinkitCart:async()=>{throw new Error('transaction service not configured')},currentBlinkitScreen:async()=>{throw new Error('transaction service not configured')},shareBlinkitCart:async()=>{throw new Error('transaction service not configured')},importBlinkitSharedCart:async()=>{throw new Error('transaction service not configured')},compareBlinkitProposal:async()=>{throw new Error('transaction service not configured')},blinkitReadiness:async(_p,i)=>unavailableReadiness(BlinkitAccountInputSchemaV1.parse(i).accountKey),addBlinkitCartItem:async()=>{throw new Error('transaction service not configured')},setBlinkitCartItemQuantity:async()=>{throw new Error('transaction service not configured')},removeBlinkitCartItem:async()=>{throw new Error('transaction service not configured')},clearBlinkitCart:async()=>{throw new Error('transaction service not configured')},listBlinkitSavedAddresses:async()=>{throw new Error('transaction service not configured')},selectBlinkitSavedAddress:async()=>{throw new Error('transaction service not configured')},listBlinkitRecentOrders:async()=>{throw new Error('transaction service not configured')},status:async()=>{throw new Error('transaction service not configured')},commit:async()=>{throw new Error('transaction service not configured')},reconcile:async()=>{throw new Error('transaction service not configured')},placeCodOrder:async()=>{throw new Error('trusted autonomous COD is disabled')}};
export function createMcpServer(auth:McpAuthHandlers=unavailable,principalId='local-hermes' as PrincipalId,search:McpProductSearchHandler=unavailableSearch,tx:McpTransactionHandlers=unavailableTx,ready:()=>Promise<boolean>=async()=>true,blinkitSearch:McpBlinkitSearchHandler=unavailableBlinkitSearch,blinkitOperations:McpBlinkitOperationHandlers=unavailableBlinkitOperations,options:McpServerOptions={}){
 const server=new McpServer({name:'errandos',version:'0.4.0'});const result=<T extends object>(structuredContent:T)=>({content:[{type:'text' as const,text:JSON.stringify(structuredContent)}],structuredContent});
 const prepareBlinkit=async(action:()=>Promise<ProposalOutput>):Promise<BlinkitPrepareCodOrderOutputV1>=>{try{return BlinkitPrepareCodOrderOutputSchemaV1.parse(await action());}catch(error){const blocked=classifyBlinkitBlockedResult(error);if(blocked)return blocked;throw error;}};
 const reg=(idx:number,inputSchema:ZodRawShape,outputSchema:ZodRawShape,fn:(i:unknown)=>Promise<object>)=>{const t=ERRAND_MCP_TOOLS[idx]!;if(options.canonicalOnly&&!CANONICAL_ERRAND_MCP_TOOL_NAMES.has(t.name))return;
 const blinkitTool=t.name.startsWith('blinkit_');const rapidoTool=t.name.startsWith('rapido_');const registeredOutput=blinkitTool?blinkitToolOutputShape(outputSchema):rapidoTool?rapidoToolOutputShape(outputSchema):outputSchema;
 // The dynamic wrapper keeps every registered schema concrete while avoiding duplicated tool boilerplate.
 server.registerTool(t.name,{description:t.description,annotations:t.annotations,inputSchema,outputSchema:registeredOutput},async i=>{try{return result(z.object(outputSchema).parse(await fn(i)));}catch(error){if(blinkitTool)return result(classifyBlinkitToolFailure(error));if(rapidoTool)return result(classifyRapidoToolFailure(error));const code=error instanceof AndroidWorkerOperationError?error.stage:error instanceof AndroidWorkerClientError?error.code:'operation_failed';throw new Error(`JaldiAI operation failed: ${code}`);}})};
 reg(0,HealthInputSchema.shape,HealthOutputSchema.shape,async()=>{if(!await ready())throw new Error('PostgreSQL readiness failed');return({service:'errandos-control-plane',status:'ok'} satisfies HealthOutput)});
 reg(1,ProviderAuthStatusInputSchemaV1.shape,ProviderAuthStatusOutputSchemaV1.shape,i=>auth.status(principalId,i));reg(2,ProviderBeginLoginInputSchemaV1.shape,ProviderBeginLoginOutputSchemaV1.shape,i=>auth.begin(principalId,i));reg(3,ProductSearchInputSchemaV1.shape,ProductSearchOutputSchemaV1.shape,i=>search.search(i));
 reg(4,PrepareGroceryInputSchemaV1.shape,ProposalOutputSchemaV1.shape,i=>tx.prepareGrocery(principalId,i));reg(5,ProposalRefInputSchemaV1.shape,ProposalOutputSchemaV1.shape,i=>tx.status(principalId,i));reg(6,CommitInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>CommitOutputSchemaV1.parse(await tx.commit(principalId,i)));reg(7,ProposalRefInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>CommitOutputSchemaV1.parse(await tx.reconcile(principalId,i)));reg(8,ProviderSubmitOtpInputSchemaV1.shape,ProviderSubmitOtpOutputSchemaV1.shape,i=>auth.submitOtp(principalId,i));reg(9,PlaceCodOrderInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>CommitOutputSchemaV1.parse(await tx.placeCodOrder(principalId,i)));
 const blinkitProvider={kind:'known' as const,value:'blinkit' as const};const blinkitInput=(i:unknown)=>({...BlinkitAccountInputSchemaV1.parse(i),provider:blinkitProvider});
 reg(10,BlinkitAccountInputSchemaV1.shape,ProviderAuthStatusOutputSchemaV1.shape,i=>auth.status(principalId,blinkitInput(i)));
 reg(11,BlinkitBeginLoginInputSchemaV1.shape,ProviderBeginLoginOutputSchemaV1.shape,i=>{const value=BlinkitBeginLoginInputSchemaV1.parse(i);return auth.begin(principalId,{...value,provider:blinkitProvider});});
 reg(12,BlinkitSubmitOtpInputSchemaV1.shape,ProviderSubmitOtpOutputSchemaV1.shape,i=>{const value=BlinkitSubmitOtpInputSchemaV1.parse(i);return auth.submitOtp(principalId,{...value,provider:blinkitProvider});});
 reg(13,BlinkitSearchProductsInputSchemaV1.shape,BlinkitSearchProductsOutputSchemaV1.shape,i=>blinkitSearch.search(BlinkitSearchProductsInputSchemaV1.parse(i)));
 reg(14,BlinkitPrepareCodOrderInputSchemaV1.shape,BlinkitPrepareCodOrderOutputObjectSchemaV1.shape,i=>{const value=BlinkitPrepareCodOrderInputSchemaV1.parse(i);return prepareBlinkit(()=>tx.prepareGrocery(principalId,{...value,provider:'blinkit',paymentMode:'cod'}));});
 reg(15,PlaceCodOrderInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>CommitOutputSchemaV1.parse(await tx.placeCodOrder(principalId,i)));
 reg(16,ProposalRefInputSchemaV1.shape,ProposalOutputSchemaV1.shape,i=>tx.status(principalId,i));
 reg(17,ProposalRefInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>CommitOutputSchemaV1.parse(await tx.reconcile(principalId,i)));
 reg(18,BlinkitAccountInputSchemaV1.shape,BlinkitCartStatusOutputSchemaV1.shape,i=>{if(!tx.inspectBlinkitCart)throw new Error('transaction service not configured');return tx.inspectBlinkitCart(principalId,BlinkitAccountInputSchemaV1.parse(i));});
 reg(19,BlinkitPrepareExistingCartCodOrderInputSchemaV1.shape,BlinkitPrepareCodOrderOutputObjectSchemaV1.shape,i=>{if(!tx.prepareExistingGrocery)throw new Error('transaction service not configured');const value=BlinkitPrepareExistingCartCodOrderInputSchemaV1.parse(i);return prepareBlinkit(()=>tx.prepareExistingGrocery!(principalId,{...value,provider:'blinkit',paymentMode:'cod'}));});
 reg(20,BlinkitAccountInputSchemaV1.shape,BlinkitReadinessOutputSchemaV1.shape,async i=>{const value=BlinkitAccountInputSchemaV1.parse(i);return tx.blinkitReadiness?tx.blinkitReadiness(principalId,value):unavailableReadiness(value.accountKey);});
 reg(21,BlinkitSetCartItemQuantityInputSchemaV1.shape,BlinkitCartStatusOutputSchemaV1.shape,i=>{if(!tx.setBlinkitCartItemQuantity)throw new Error('transaction service not configured');return tx.setBlinkitCartItemQuantity(principalId,BlinkitSetCartItemQuantityInputSchemaV1.parse(i));});
 reg(22,BlinkitRemoveCartItemInputSchemaV1.shape,BlinkitCartStatusOutputSchemaV1.shape,i=>{if(!tx.removeBlinkitCartItem)throw new Error('transaction service not configured');return tx.removeBlinkitCartItem(principalId,BlinkitRemoveCartItemInputSchemaV1.parse(i));});
 reg(23,BlinkitClearCartInputSchemaV1.shape,BlinkitCartStatusOutputSchemaV1.shape,i=>{if(!tx.clearBlinkitCart)throw new Error('transaction service not configured');return tx.clearBlinkitCart(principalId,BlinkitClearCartInputSchemaV1.parse(i));});
 reg(24,BlinkitAddCartItemInputSchemaV1.shape,BlinkitCartStatusOutputSchemaV1.shape,i=>{if(!tx.addBlinkitCartItem)throw new Error('transaction service not configured');return tx.addBlinkitCartItem(principalId,BlinkitAddCartItemInputSchemaV1.parse(i));});
 reg(25,BlinkitListSavedAddressesInputSchemaV1.shape,BlinkitListSavedAddressesOutputSchemaV1.shape,i=>{if(!tx.listBlinkitSavedAddresses)throw new Error('transaction service not configured');return tx.listBlinkitSavedAddresses(principalId,BlinkitListSavedAddressesInputSchemaV1.parse(i));});
 reg(26,BlinkitRecentOrdersInputSchemaV1.shape,BlinkitRecentOrdersOutputSchemaV1.shape,i=>{if(!tx.listBlinkitRecentOrders)throw new Error('transaction service not configured');return tx.listBlinkitRecentOrders(principalId,BlinkitRecentOrdersInputSchemaV1.parse(i));});
 reg(27,BlinkitStartPrepareCodOrderInputSchemaV1.shape,BlinkitStartPrepareCodOrderOutputSchemaV1.shape,i=>blinkitOperations.startPrepare(principalId,BlinkitStartPrepareCodOrderInputSchemaV1.parse(i)));
 reg(28,BlinkitOperationStatusInputSchemaV1.shape,BlinkitOperationStatusOutputObjectSchemaV1.shape,i=>blinkitOperations.status(principalId,BlinkitOperationStatusInputSchemaV1.parse(i)));
 reg(29,BlinkitAccountInputSchemaV1.shape,BlinkitCurrentScreenOutputSchemaV1.shape,i=>{if(!tx.currentBlinkitScreen)throw new Error('transaction service not configured');return tx.currentBlinkitScreen(principalId,BlinkitAccountInputSchemaV1.parse(i));});
 reg(30,BlinkitAccountInputSchemaV1.shape,BlinkitShareCartOutputSchemaV1.shape,i=>{if(!tx.shareBlinkitCart)throw new Error('transaction service not configured');return tx.shareBlinkitCart(principalId,BlinkitAccountInputSchemaV1.parse(i));});
 reg(31,BlinkitCompareProposalInputSchemaV1.shape,BlinkitCompareProposalOutputObjectSchemaV1.shape,i=>{if(!tx.compareBlinkitProposal)throw new Error('transaction service not configured');return tx.compareBlinkitProposal(principalId,BlinkitCompareProposalInputSchemaV1.parse(i));});
 reg(32,BlinkitRecentOperationsInputSchemaV1.shape,BlinkitRecentOperationsOutputSchemaV1.shape,i=>blinkitOperations.recent(principalId,BlinkitRecentOperationsInputSchemaV1.parse(i)));
 reg(33,BlinkitSelectSavedAddressInputSchemaV1.shape,BlinkitSelectSavedAddressOutputObjectSchemaV1.shape,i=>{if(!tx.selectBlinkitSavedAddress)throw new Error('transaction service not configured');return tx.selectBlinkitSavedAddress(principalId,BlinkitSelectSavedAddressInputSchemaV1.parse(i));});
 reg(34,BlinkitImportSharedCartInputSchemaV1.shape,BlinkitImportSharedCartOutputSchemaV1.shape,i=>{if(!tx.importBlinkitSharedCart)throw new Error('transaction service not configured');return tx.importBlinkitSharedCart(principalId,BlinkitImportSharedCartInputSchemaV1.parse(i));});
 const rapidoProvider={kind:'known' as const,value:'rapido' as const};const rapidoInput=(i:unknown)=>({...RapidoAccountInputSchemaV1.parse(i),provider:rapidoProvider});
 reg(35,RapidoAccountInputSchemaV1.shape,ProviderAuthStatusOutputSchemaV1.shape,i=>auth.status(principalId,rapidoInput(i)));
 reg(36,RapidoBeginLoginInputSchemaV1.shape,ProviderBeginLoginOutputSchemaV1.shape,i=>{const value=RapidoBeginLoginInputSchemaV1.parse(i);return auth.begin(principalId,{...value,provider:rapidoProvider});});
 reg(37,RapidoSubmitOtpInputSchemaV1.shape,ProviderSubmitOtpOutputSchemaV1.shape,i=>{const value=RapidoSubmitOtpInputSchemaV1.parse(i);return auth.submitOtp(principalId,{...value,provider:rapidoProvider});});
 reg(38,RapidoAccountInputSchemaV1.shape,RapidoReadinessOutputSchemaV1.shape,i=>{if(!tx.rapidoReadiness)throw new Error('transaction service not configured');return tx.rapidoReadiness(principalId,RapidoAccountInputSchemaV1.parse(i));});
 reg(39,RapidoQuoteRidesInputSchemaV1.shape,RapidoQuoteRidesOutputSchemaV1.shape,i=>{if(!tx.quoteRapido)throw new Error('transaction service not configured');return tx.quoteRapido(principalId,RapidoQuoteRidesInputSchemaV1.parse(i));});
 reg(40,RapidoPrepareRideInputObjectSchemaV1.shape,ProposalOutputSchemaV1.shape,i=>{if(!tx.prepareRapido)throw new Error('transaction service not configured');return tx.prepareRapido(principalId,RapidoPrepareRideInputSchemaV1.parse(i));});
 reg(41,RapidoCompareProposalInputSchemaV1.shape,RapidoCompareProposalOutputObjectSchemaV1.shape,i=>{if(!tx.compareRapidoProposal)throw new Error('transaction service not configured');return tx.compareRapidoProposal(principalId,RapidoCompareProposalInputSchemaV1.parse(i));});
 reg(42,RapidoRequestRideInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>{if(!tx.requestRapidoRide)throw new Error('transaction service not configured');return CommitOutputSchemaV1.parse(await tx.requestRapidoRide(principalId,RapidoRequestRideInputSchemaV1.parse(i)));});
 reg(43,RapidoRideStatusInputSchemaV1.shape,ProposalOutputSchemaV1.shape,async i=>{const value=RapidoRideStatusInputSchemaV1.parse(i);const proposal=await tx.status(principalId,value);if(proposal.provider!=='rapido')throw new Error('Rapido proposal is required');return proposal;});
 reg(44,RapidoRideStatusInputSchemaV1.shape,CommitOutputObjectSchemaV1.shape,async i=>{const value=RapidoRideStatusInputSchemaV1.parse(i);const proposal=await tx.status(principalId,value);if(proposal.provider!=='rapido')throw new Error('Rapido proposal is required');return CommitOutputSchemaV1.parse(await tx.reconcile(principalId,value));});
 reg(45,RapidoRecentTripsInputSchemaV1.shape,RapidoRecentTripsOutputSchemaV1.shape,i=>{if(!tx.listRapidoRecentTrips)throw new Error('transaction service not configured');return tx.listRapidoRecentTrips(principalId,RapidoRecentTripsInputSchemaV1.parse(i));});
 reg(46,RapidoResendOtpInputSchemaV1.shape,ProviderBeginLoginOutputSchemaV1.shape,i=>{if(!auth.resendOtp)throw new Error('Android Rapido OTP resend is not configured');return auth.resendOtp(principalId,rapidoInput(i));});
 return server;
}
function blinkitToolOutputShape(success:ZodRawShape):ZodRawShape{
 const shape:ZodRawShape={};
 for(const[key,schema]of Object.entries(success)){
  shape[key]=key==='version'||key==='status'?schema:schema.optional();
 }
 const successStatus=success['status']??z.string();
 shape['status']=z.union([successStatus,z.literal('failed')]);
 shape['reason']=BlinkitToolFailureOutputSchemaV1.shape.reason.optional();
 shape['retryable']=BlinkitToolFailureOutputSchemaV1.shape.retryable.optional();
 shape['suggestedAction']=BlinkitToolFailureOutputSchemaV1.shape.suggestedAction.optional();
 shape['stage']=BlinkitToolFailureOutputSchemaV1.shape.stage;
 return shape;
}
function rapidoToolOutputShape(success:ZodRawShape):ZodRawShape{
 const shape:ZodRawShape={};
 for(const[key,schema]of Object.entries(success))shape[key]=key==='version'||key==='status'?schema:schema.optional();
 const successStatus=success['status']??z.string();
 shape['status']=z.union([successStatus,z.literal('failed')]);
 shape['reason']=RapidoToolFailureOutputSchemaV1.shape.reason.optional();
 shape['retryable']=RapidoToolFailureOutputSchemaV1.shape.retryable.optional();
 shape['suggestedAction']=RapidoToolFailureOutputSchemaV1.shape.suggestedAction.optional();
 return shape;
}
export interface McpStartupDependencies { environment?:NodeJS.ProcessEnv; openDatabase?:()=>Promise<PostgresDatabase>; transport?:()=>StdioServerTransport }
export async function runMcpServer(dependencies:McpStartupDependencies={}):Promise<void>{
 let database:PostgresDatabase|undefined;let server:ReturnType<typeof createMcpServer>|undefined;let runtime:ReturnType<typeof createTransactionRuntime>;let started=false;
 const environment=dependencies.environment??process.env;const mode=environment['ERRANDOS_PERSISTENCE_MODE'];
 const close=async()=>{await runtime?.close().catch(()=>undefined);await server?.close().catch(()=>undefined);await database?.close().catch(()=>undefined);};
 const onSignal=(code:number)=>()=>{void close().finally(()=>process.exit(code));};const onSigint=onSignal(130);const onSigterm=onSignal(143);
 try {
  validateDeploymentEnvironment(environment);
  if(mode!=='filesystem')database=await (dependencies.openDatabase??openProductionDatabase)();
  const baseUrl=environment['PRODUCT_SEARCH_BASE_URL'];const search=baseUrl?new BrowserAutomationProductSearchConnector({baseUrl,timeoutMs:parseTimeout(environment['PRODUCT_SEARCH_TIMEOUT_MS'])}):unavailableSearch;
  const principal=(environment['ERRANDOS_PRINCIPAL_ID']??'local-hermes') as PrincipalId;
  runtime=createTransactionRuntime(database,environment);
  server=createMcpServer(runtime?.auth??unavailable,principal,search,runtime?.tx??unavailableTx,database?()=>database!.ready():async()=>true,runtime?.blinkitSearch??unavailableBlinkitSearch,runtime?.blinkitOperations??unavailableBlinkitOperations,{canonicalOnly:environment['ERRANDOS_MCP_LEGACY_TOOLS']!=='true'});
  process.once('SIGINT',onSigint);process.once('SIGTERM',onSigterm);
  await server.connect((dependencies.transport??(()=>new StdioServerTransport()))());started=true;
 } finally {
  if(!started){process.removeListener('SIGINT',onSigint);process.removeListener('SIGTERM',onSigterm);await close();}
 }
}
export function createTransactionRuntime(database?:PostgresDatabase,environment:NodeJS.ProcessEnv=process.env):{auth:McpAuthHandlers;tx:McpTransactionHandlers;blinkitSearch:McpBlinkitSearchHandler;blinkitOperations:McpBlinkitOperationHandlers;close():Promise<void>}|undefined{
 const mode=environment['ERRANDOS_PERSISTENCE_MODE'];
 validateDeploymentEnvironment(environment);
 if(mode!=='filesystem'&&!database)return undefined;
 if(mode!=='filesystem'&&environment['ERRANDOS_LIVE_COMMIT']==='true')throw new Error('live commit is unavailable with PostgreSQL until the outbox worker is implemented');
 const root=environment['ERRANDOS_DATA_ROOT'];const approvalSecret=environment['ERRANDOS_APPROVAL_HMAC_SECRET'];const trustedCod=environment['ERRANDOS_TRUSTED_AUTONOMOUS_COD']==='true';
 if(!root&&!approvalSecret)return undefined;
 if(!root||!approvalSecret)throw new Error('ERRANDOS_DATA_ROOT and ERRANDOS_APPROVAL_HMAC_SECRET must be configured together');
 const state=new FileProviderState(`${root}/provider-state`);
 const browserActions=environment['ERRANDOS_LIVE_BROWSER_ACTIONS']==='true';const liveCommit=environment['ERRANDOS_LIVE_COMMIT']==='true';const rapidoLiveCommit=environment['ERRANDOS_RAPIDO_LIVE_COMMIT']==='true';
 const unavailableProvider:TransactionProviderPort={commit:async()=>{throw new Error('provider runtime unavailable')},reconcile:async()=>({outcome:'pending'})};
 let login:AndroidBlinkitAuthCoordinator|undefined;let rapidoLogin:AndroidRapidoAuthCoordinator|undefined;let androidBlinkit:AndroidBlinkitAdapter|undefined;let androidRapido:AndroidRapidoAdapter|undefined;let androidWorker:SshAndroidWorkerClient|undefined;let blinkit:TransactionProviderPort=unavailableProvider;
 if(environment['ERRANDOS_BLINKIT_EXECUTION']==='android'){
  androidWorker=new SshAndroidWorkerClient({host:environment['ERRANDOS_ANDROID_WORKER_SSH_HOST']!,user:environment['ERRANDOS_ANDROID_WORKER_SSH_USER']!,identityFile:environment['ERRANDOS_ANDROID_WORKER_IDENTITY_FILE']!,knownHostsFile:environment['ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE']!,leaseFile:`${root}/android-worker.lease`,operationTimeoutMs:parseAndroidOperationTimeout(environment['ERRANDOS_ANDROID_OPERATION_TIMEOUT_MS'])});
  androidBlinkit=new AndroidBlinkitAdapter(androidWorker,state,{actionsEnabled:browserActions,commitEnabled:liveCommit});blinkit=androidBlinkit;login=new AndroidBlinkitAuthCoordinator(androidWorker);
 }
 if(environment['ERRANDOS_RAPIDO_EXECUTION']==='android'){
 androidWorker??=new SshAndroidWorkerClient({host:environment['ERRANDOS_ANDROID_WORKER_SSH_HOST']!,user:environment['ERRANDOS_ANDROID_WORKER_SSH_USER']!,identityFile:environment['ERRANDOS_ANDROID_WORKER_IDENTITY_FILE']!,knownHostsFile:environment['ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE']!,leaseFile:`${root}/android-worker.lease`,operationTimeoutMs:parseAndroidOperationTimeout(environment['ERRANDOS_ANDROID_OPERATION_TIMEOUT_MS'])});
  rapidoLogin=new AndroidRapidoAuthCoordinator(androidWorker);
  androidRapido=new AndroidRapidoAdapter(androidWorker,state,{actionsEnabled:browserActions,commitEnabled:liveCommit&&rapidoLiveCommit});
 }
 const adapters={blinkit,...(androidRapido?{rapido:androidRapido}:{})};
 const repository=mode==='filesystem'?new FileProposalRepository(`${root}/transactions`):new PostgresRuntimeProposalRepository(database!);
 const approvals=mode==='filesystem'?new HmacApprovalStore(`${root}/approvals`,approvalSecret):new PostgresHmacApprovalVerifier(database!,approvalSecret);
 const issuer=trustedCod&&approvals instanceof HmacApprovalStore?approvals:undefined;
 const service=new TransactionService(repository,adapters,approvals,mode==='filesystem'&&liveCommit,undefined,trustedCod?'owner_autonomous':'external',issuer);
 const blinkitOperationService=new BlinkitOperationService(new FileBlinkitOperationRepository(`${root}/operations/blinkit`),async(p,i)=>service.prepareGrocery(p,{...i,provider:'blinkit',paymentMode:'cod'}),{failureReason:classifyBlinkitOperationFailure,blockedResult:classifyBlinkitBlockedResult});
 const tx:McpTransactionHandlers={
  prepareGrocery:async(p,i)=>service.prepareGrocery(p,PrepareGroceryInputSchemaV1.parse(i)),
  prepareExistingGrocery:async(p,i)=>service.prepareExistingGrocery(p,PrepareExistingGroceryInputSchemaV1.parse(i)),
  prepareRapido:async(p,i)=>service.prepareRapido(p,RapidoPrepareRideInputSchemaV1.parse(i)),
  quoteRapido:async(_p,i)=>{if(!androidRapido)throw new Error('Android Rapido quotes not configured');const value=RapidoQuoteRidesInputSchemaV1.parse(i);return androidRapido.quoteRides(value.accountKey,value.pickup,value.dropoff,value.limit);},
  compareRapidoProposal:async(p,i)=>{const value=RapidoCompareProposalInputSchemaV1.parse(i);return service.compareRapidoProposal(p,value.proposalId,value.accountKey);},
  rapidoReadiness:async(_p,i)=>{const value=RapidoAccountInputSchemaV1.parse(i);return androidRapido?androidRapido.readiness(value.accountKey):unavailableRapidoReadiness(value.accountKey);},
  listRapidoRecentTrips:async(_p,i)=>{if(!androidRapido)throw new Error('Android Rapido recent trips not configured');const value=RapidoRecentTripsInputSchemaV1.parse(i);return androidRapido.recentTrips(value.accountKey,value.limit);},
  requestRapidoRide:async(p,i)=>{const value=RapidoRequestRideInputSchemaV1.parse(i);const proposal=await service.get(p,value.proposalId);if(proposal.provider!=='rapido')throw new Error('Rapido proposal is required');return service.commitApproved(p,value);},
  inspectBlinkitCart:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart inspection not configured');return androidBlinkit.inspectCurrentCart(BlinkitAccountInputSchemaV1.parse(i).accountKey);},
  currentBlinkitScreen:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit current screen not configured');return androidBlinkit.currentScreen(BlinkitAccountInputSchemaV1.parse(i).accountKey);},
  shareBlinkitCart:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart share not configured');return androidBlinkit.shareCart(BlinkitAccountInputSchemaV1.parse(i).accountKey);},
  importBlinkitSharedCart:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit shared cart import not configured');const value=BlinkitImportSharedCartInputSchemaV1.parse(i);return androidBlinkit.importSharedCart(value.accountKey,value.shareUrl);},
  compareBlinkitProposal:async(p,i)=>{const value=BlinkitCompareProposalInputSchemaV1.parse(i);return service.compareBlinkitProposal(p,value.proposalId,value.accountKey);},
  blinkitReadiness:async(_p,i)=>{const value=BlinkitAccountInputSchemaV1.parse(i);return androidBlinkit?androidBlinkit.readiness(value.accountKey):unavailableReadiness(value.accountKey);},
  addBlinkitCartItem:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart editing not configured');const value=BlinkitAddCartItemInputSchemaV1.parse(i);return androidBlinkit.addCartItem(value.accountKey,value.query,value.offerId,value.quantity);},
  setBlinkitCartItemQuantity:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart editing not configured');const value=BlinkitSetCartItemQuantityInputSchemaV1.parse(i);return androidBlinkit.setCartItemQuantity(value.accountKey,value.productId,value.quantity);},
  removeBlinkitCartItem:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart editing not configured');const value=BlinkitRemoveCartItemInputSchemaV1.parse(i);return androidBlinkit.removeCartItem(value.accountKey,value.productId);},
  clearBlinkitCart:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit cart editing not configured');const value=BlinkitClearCartInputSchemaV1.parse(i);return androidBlinkit.clearCart(value.accountKey);},
  listBlinkitSavedAddresses:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit address list not configured');const value=BlinkitListSavedAddressesInputSchemaV1.parse(i);return androidBlinkit.listSavedAddresses(value.accountKey,value.requestedLabel);},
  selectBlinkitSavedAddress:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit address selection not configured');const value=BlinkitSelectSavedAddressInputSchemaV1.parse(i);return androidBlinkit.selectSavedAddress(value.accountKey,value.addressReference);},
  listBlinkitRecentOrders:async(_p,i)=>{if(!androidBlinkit)throw new Error('Android Blinkit recent orders not configured');const value=BlinkitRecentOrdersInputSchemaV1.parse(i);return androidBlinkit.recentOrders(value.accountKey,value.limit);},
  status:async(p,i)=>service.get(p,ProposalRefInputSchemaV1.parse(i).proposalId),
  commit:async(p,i)=>service.commit(p,CommitInputSchemaV1.parse(i)),
  reconcile:async(p,i)=>service.reconcile(p,ProposalRefInputSchemaV1.parse(i).proposalId),
  placeCodOrder:async(p,i)=>{if(!trustedCod)throw new Error('trusted autonomous COD is disabled');return service.commitAutonomousCod(p,PlaceCodOrderInputSchemaV1.parse(i));},
 };
 const authCoordinator=(provider:string)=>provider==='blinkit'?login:provider==='rapido'?rapidoLogin:undefined;
 const auth:McpAuthHandlers={status:async(p,i)=>{const value=ProviderAuthStatusInputSchemaV1.parse(i);const coordinator=value.provider.kind==='known'?authCoordinator(value.provider.value):undefined;if(!coordinator)return{version:1,provider:value.provider,accountKey:value.accountKey,status:'missing'};const result=await coordinator.status(p,value.accountKey);return ProviderAuthStatusOutputSchemaV1.parse({version:1,provider:value.provider,accountKey:value.accountKey,status:result.status});},begin:async(p,i)=>{const value=ProviderBeginLoginInputSchemaV1.parse(i);const coordinator=value.provider.kind==='known'?authCoordinator(value.provider.value):undefined;if(!coordinator)throw new Error('Android provider login is not configured');const result=await coordinator.begin(p,value.accountKey,value.phone);return ProviderBeginLoginOutputSchemaV1.parse({version:1,sessionId:result.sessionId,provider:value.provider,accountKey:value.accountKey,status:result.status});},submitOtp:async(p,i)=>{const value=ProviderSubmitOtpInputSchemaV1.parse(i);const coordinator=value.provider.kind==='known'?authCoordinator(value.provider.value):undefined;if(!coordinator)throw new Error('Android provider login is not configured');const result=await coordinator.submitOtp(p,value.accountKey,value.otp);return ProviderSubmitOtpOutputSchemaV1.parse({version:1,sessionId:result.sessionId,provider:value.provider,accountKey:value.accountKey,status:result.status});},resendOtp:async(p,i)=>{const value=ProviderAuthStatusInputSchemaV1.parse(i);if(value.provider.kind!=='known'||value.provider.value!=='rapido'||!rapidoLogin)throw new Error('Android Rapido OTP resend is not configured');const result=await rapidoLogin.resendOtp(p,value.accountKey);return ProviderBeginLoginOutputSchemaV1.parse({version:1,sessionId:result.sessionId,provider:value.provider,accountKey:value.accountKey,status:result.status});}};
 const blinkitSearch:McpBlinkitSearchHandler={search:async i=>{if(!androidBlinkit)throw new Error('Android Blinkit search not configured');return androidBlinkit.searchProducts(BlinkitSearchProductsInputSchemaV1.parse(i));}};
 const blinkitOperations:McpBlinkitOperationHandlers={startPrepare:async(p,i)=>blinkitOperationService.startPrepareCodOrder(p,BlinkitStartPrepareCodOrderInputSchemaV1.parse(i)),status:async(p,i)=>blinkitOperationService.getStatus(p,BlinkitOperationStatusInputSchemaV1.parse(i)),recent:async(p,i)=>blinkitOperationService.listRecent(p,BlinkitRecentOperationsInputSchemaV1.parse(i))};
 return{auth,tx,blinkitSearch,blinkitOperations,close:async()=>{await login?.closeAll();await rapidoLogin?.closeAll();}};
}
function parseTimeout(v:string|undefined){if(v===undefined)return 40_000;const n=Number(v);if(!Number.isInteger(n))throw new Error('PRODUCT_SEARCH_TIMEOUT_MS must be an integer');return n}
function parseAndroidOperationTimeout(v:string|undefined){if(v===undefined)return 120_000;const n=Number(v);if(!Number.isInteger(n)||n<1_000)throw new Error('ERRANDOS_ANDROID_OPERATION_TIMEOUT_MS must be an integer of at least 1000');return n}
function unavailableReadiness(accountKey:string):BlinkitReadinessOutputV1{return{version:1,accountKey,status:'unavailable',checks:[{component:'control_plane',status:'ready'},{component:'worker',status:'unavailable',reason:'worker_unreachable'},{component:'appium',status:'unknown',reason:'dependency_unavailable'},{component:'emulator',status:'unknown',reason:'dependency_unavailable'},{component:'blinkit_app',status:'unknown',reason:'dependency_unavailable'},{component:'authentication',status:'unknown',reason:'dependency_unavailable'}]}}
function unavailableRapidoReadiness(accountKey:string):RapidoReadinessOutputV1{return{version:1,accountKey,status:'unavailable',checks:[{component:'control_plane',status:'ready'},{component:'worker',status:'unavailable',reason:'worker_unreachable'},{component:'appium',status:'unknown',reason:'dependency_unavailable'},{component:'emulator',status:'unknown',reason:'dependency_unavailable'},{component:'rapido_app',status:'unknown',reason:'dependency_unavailable'},{component:'authentication',status:'unknown',reason:'dependency_unavailable'}]}}
function classifyBlinkitOperationFailure(error:unknown):BlinkitOperationFailureReasonV1{
 if(error instanceof AndroidWorkerClientError)return error.code;
 if(error instanceof AndroidWorkerOperationError){
  const direct=BlinkitOperationFailureReasonSchemaV1.safeParse(error.stage);if(direct.success)return direct.data;
  if(/login|auth|otp/.test(error.stage))return'login_required';
  if(/payment|cod/.test(error.stage))return'cod_unavailable';
  if(/price/.test(error.stage))return'price_changed';
  if(/quantity/.test(error.stage))return'quantity_unavailable';
  if(/product|offer/.test(error.stage))return'product_unavailable';
  if(/checkout|terms|review|subtotal|total/.test(error.stage))return'checkout_terms_unreadable';
  if(/timeout/.test(error.stage))return'provider_timeout';
  return'screen_blocked';
 }
 if(error instanceof Error){
  if(error.name==='ProposalNotFoundError')return'proposal_not_found';
  if(/not comparable/i.test(error.message))return'proposal_not_comparable';
  if(/live Android actions are disabled/i.test(error.message))return'live_actions_disabled';
 }
 return'operation_failed';
}
function classifyBlinkitToolFailure(error:unknown):BlinkitToolFailureOutputV1{
 const reason=classifyBlinkitOperationFailure(error);
 const stage=error instanceof AndroidWorkerOperationError?error.stage:undefined;
 const recovery:Record<BlinkitOperationFailureReasonV1,{retryable:boolean;suggestedAction:BlinkitToolFailureOutputV1['suggestedAction']}>={
  worker_unreachable:{retryable:true,suggestedAction:'check_readiness'},
  worker_execution_failed:{retryable:true,suggestedAction:'check_readiness'},
  worker_response_invalid:{retryable:true,suggestedAction:'check_readiness'},
  emulator_unavailable:{retryable:true,suggestedAction:'check_readiness'},
  login_required:{retryable:false,suggestedAction:'login'},
  screen_blocked:{retryable:true,suggestedAction:'inspect_screen'},
  cod_minimum_not_met:{retryable:false,suggestedAction:'choose_product'},
  product_unavailable:{retryable:false,suggestedAction:'choose_product'},
  quantity_unavailable:{retryable:false,suggestedAction:'choose_product'},
  address_unserviceable:{retryable:false,suggestedAction:'choose_address'},
  cod_unavailable:{retryable:false,suggestedAction:'stop'},
  price_changed:{retryable:false,suggestedAction:'prepare_fresh_proposal'},
  checkout_terms_unreadable:{retryable:false,suggestedAction:'stop'},
  provider_timeout:{retryable:true,suggestedAction:'check_readiness'},
  proposal_not_found:{retryable:false,suggestedAction:'stop'},
  proposal_not_comparable:{retryable:false,suggestedAction:'prepare_fresh_proposal'},
  address_not_found:{retryable:false,suggestedAction:'choose_address'},
  live_actions_disabled:{retryable:false,suggestedAction:'stop'},
  operation_failed:{retryable:false,suggestedAction:'stop'},
 };
 return BlinkitToolFailureOutputSchemaV1.parse({version:1,status:'failed',reason,...recovery[reason],...(stage?{stage}:{})});
}
function classifyRapidoFailure(error:unknown):RapidoFailureReasonV1{
 if(error instanceof AndroidWorkerClientError)return error.code==='provider_timeout'?'provider_timeout':'worker_unreachable';
 if(error instanceof AndroidWorkerOperationError){
  const direct=RapidoFailureReasonSchemaV1.safeParse(error.stage);if(direct.success)return direct.data;
  if(/login|auth/.test(error.stage))return'login_required';
  if(/otp|challenge/.test(error.stage))return'challenge_required';
  if(/location|route/.test(error.stage))return'location_invalid';
  if(/no_rides/.test(error.stage))return'no_rides_available';
  if(/ride_option/.test(error.stage))return'ride_option_unavailable';
  if(/fare|price/.test(error.stage))return'fare_changed';
  if(/payment/.test(error.stage))return'payment_unavailable';
  if(/timeout/.test(error.stage))return'provider_timeout';
  return'unexpected_provider_screen';
 }
 if(error instanceof Error){
  if(error.name==='ProposalNotFoundError')return'proposal_not_found';
  if(error.name==='ApprovalRequiredError')return'approval_required';
  if(error.name==='LiveCommitDisabledError')return'live_commit_disabled';
  if(/not comparable/i.test(error.message))return'proposal_not_comparable';
  if(/live Android actions are disabled/i.test(error.message))return'live_actions_disabled';
  if(/live Android commit is disabled/i.test(error.message))return'live_commit_disabled';
 }
 return'operation_failed';
}
function classifyRapidoToolFailure(error:unknown):RapidoToolFailureOutputV1{
 const reason=classifyRapidoFailure(error);
 const recovery:Record<RapidoFailureReasonV1,{retryable:boolean;suggestedAction:RapidoToolFailureOutputV1['suggestedAction']}> = {
  worker_unreachable:{retryable:true,suggestedAction:'check_readiness'},
  appium_unavailable:{retryable:true,suggestedAction:'check_readiness'},
  emulator_unavailable:{retryable:true,suggestedAction:'check_readiness'},
  rapido_app_unavailable:{retryable:true,suggestedAction:'check_readiness'},
  login_required:{retryable:false,suggestedAction:'connect_account'},
  challenge_required:{retryable:false,suggestedAction:'connect_account'},
  unexpected_provider_screen:{retryable:true,suggestedAction:'check_readiness'},
  device_verification_failed:{retryable:false,suggestedAction:'stop'},
  location_invalid:{retryable:false,suggestedAction:'choose_location'},
  no_rides_available:{retryable:false,suggestedAction:'choose_location'},
  ride_option_unavailable:{retryable:false,suggestedAction:'choose_ride'},
  quote_expired:{retryable:false,suggestedAction:'prepare_fresh_proposal'},
  fare_changed:{retryable:false,suggestedAction:'prepare_fresh_proposal'},
  payment_unavailable:{retryable:false,suggestedAction:'choose_ride'},
  provider_timeout:{retryable:true,suggestedAction:'check_readiness'},
  proposal_not_found:{retryable:false,suggestedAction:'stop'},
  proposal_not_comparable:{retryable:false,suggestedAction:'prepare_fresh_proposal'},
  approval_required:{retryable:false,suggestedAction:'use_trusted_approval'},
  live_actions_disabled:{retryable:false,suggestedAction:'stop'},
  live_commit_disabled:{retryable:false,suggestedAction:'stop'},
  operation_failed:{retryable:false,suggestedAction:'stop'},
 };
 return RapidoToolFailureOutputSchemaV1.parse({version:1,status:'failed',reason,...recovery[reason]});
}
function classifyBlinkitBlockedResult(error:unknown):BlinkitCheckoutBlockedOutputV1|undefined{
 if(!(error instanceof AndroidWorkerOperationError))return undefined;
 const reason=BlinkitCheckoutBlockedReasonSchemaV1.safeParse(classifyBlinkitOperationFailure(error));
 if(!reason.success)return undefined;
 return BlinkitCheckoutBlockedOutputSchemaV1.parse({
  version:1,
  provider:'blinkit',
  status:'blocked',
  reason:reason.data,
  ...(reason.data==='cod_minimum_not_met'&&error.details?error.details:{}),
 });
}
