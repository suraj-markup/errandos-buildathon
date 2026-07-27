export * from './runtime/provider-state.js';
export * from './blinkit/product-match.js';
export * from './blinkit/review.js';
export * from './blinkit/commit.js';
export * from './blinkit/orders.js';
export * from './blinkit/android-stage.js';
export * from './blinkit/android-screen.js';
export * from './blinkit/android-constraints.js';
export * from './blinkit/android-driver.js';
export * from './blinkit/android-review.js';
export * from './blinkit/android-safe-reads.js';
export * from './blinkit/android-commit.js';
export * from './blinkit/android-adapter.js';
export * from './android/appium-client.js';
export * from './android/worker-client.js';
export * from './android/screen-recovery.js';
export * from './rapido/android-driver.js';
export * from './rapido/android-auth.js';
export * from './rapido/android-commit.js';
export * from './rapido/android-adapter.js';

import type { Capability, OperationName, ProductSearchInput, ProductSearchOutput } from '@errandos/contracts';
import { z } from 'zod';

export interface ProviderDescriptor { readonly id: string; readonly capability: Capability; readonly operations: readonly OperationName[] }
export const providerConnectors: readonly ProviderDescriptor[] = [];

const UpstreamProduct = z.object({ title:z.string().min(1), platform:z.string().min(1), price:z.number().nullish(), delivery:z.string().nullish(), url:z.string().url().nullish(), image:z.string().url().nullish(), recommendationReason:z.string().nullish() }).passthrough();
const UpstreamResponse = z.object({ products:z.array(UpstreamProduct), platformResults:z.array(z.object({}).passthrough()).default([]), failedPlatforms:z.array(z.object({}).passthrough()).default([]) }).passthrough();
export type FetchLike = (input:string|URL, init?:RequestInit)=>Promise<Response>;
export class ProductSearchConnectorError extends Error {
  public constructor(public readonly code:'timeout'|'http_error'|'invalid_response'|'network_error', message:string, options?:ErrorOptions) { super(message,options); this.name='ProductSearchConnectorError'; }
}
export interface BrowserAutomationProductSearchOptions { readonly baseUrl:string; readonly timeoutMs?:number; readonly fetch?:FetchLike; }
export class BrowserAutomationProductSearchConnector {
  private readonly endpoint:URL; private readonly timeoutMs:number; private readonly fetcher:FetchLike;
  public constructor(options:BrowserAutomationProductSearchOptions) {
    this.endpoint=new URL('/recommendations',new URL(options.baseUrl)); this.timeoutMs=options.timeoutMs??40_000; this.fetcher=options.fetch??fetch;
    if(!Number.isInteger(this.timeoutMs)||this.timeoutMs<100||this.timeoutMs>120_000) throw new RangeError('timeoutMs must be between 100 and 120000');
  }
  public async search(input:ProductSearchInput):Promise<ProductSearchOutput> {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    try {
      const body={request:input.request,deliveryPincode:input.deliveryPincode,...(input.neededBy?{neededBy:input.neededBy}:{}),...(input.budgetMax?{constraints:{budgetMax:input.budgetMax}}:{}),options:{limitPerPlatform:input.limit}};
      const response=await this.fetcher(this.endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body),signal:controller.signal});
      if(!response.ok) throw new ProductSearchConnectorError('http_error',`product search upstream returned HTTP ${response.status}`);
      let raw:unknown; try { raw=await response.json(); } catch(error) { throw new ProductSearchConnectorError('invalid_response','product search upstream returned invalid JSON',{cause:error}); }
      const parsed=UpstreamResponse.safeParse(raw); if(!parsed.success) throw new ProductSearchConnectorError('invalid_response','product search upstream response did not match its contract',{cause:parsed.error});
      const offers=parsed.data.products.slice(0,input.limit).map((p)=>({title:p.title,platform:p.platform,...(p.price!=null?{price:p.price}:{}),...(p.delivery?{delivery:p.delivery}:{}),...(p.url?{url:p.url}:{}),...(p.image?{image:p.image}:{}),...(p.recommendationReason?{reason:p.recommendationReason}:{})}));
      return {version:1,status:offers.length?'completed':'no_results',offers,searchedPlatforms:parsed.data.platformResults.length,failedPlatforms:parsed.data.failedPlatforms.length};
    } catch(error) {
      if(error instanceof ProductSearchConnectorError) throw error;
      if(controller.signal.aborted) throw new ProductSearchConnectorError('timeout',`product search timed out after ${this.timeoutMs}ms`,{cause:error});
      throw new ProductSearchConnectorError('network_error','product search upstream request failed',{cause:error});
    } finally { clearTimeout(timer); }
  }
}
