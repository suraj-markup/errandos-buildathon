import { describe, expect, it, vi } from 'vitest';
import { BrowserAutomationProductSearchConnector } from '../src/index.js';

describe('BrowserAutomationProductSearchConnector',()=>{
  it('maps request and recommendation response',async()=>{
    const fetcher=vi.fn(async(input:string|URL,init?:RequestInit):Promise<Response>=>{ void input; void init; return new Response(JSON.stringify({products:[{title:'OnePlus Buds',platform:'amazon',price:3999,delivery:'Tomorrow',url:'https://example.test/p',recommendationReason:'Within budget'}],platformResults:[{}],failedPlatforms:[]}),{status:200}); });
    const connector=new BrowserAutomationProductSearchConnector({baseUrl:'http://localhost:8080/base',fetch:fetcher});
    const output=await connector.search({version:1,request:'earbuds',deliveryPincode:'560103',budgetMax:5000,limit:3});
    expect(fetcher).toHaveBeenCalledWith(new URL('http://localhost:8080/recommendations'),expect.objectContaining({method:'POST'}));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({constraints:{budgetMax:5000},options:{limitPerPlatform:3}});
    expect(output.offers[0]).toEqual({title:'OnePlus Buds',platform:'amazon',price:3999,delivery:'Tomorrow',url:'https://example.test/p',reason:'Within budget'});
  });
  it('classifies upstream errors',async()=>{
    const http=new BrowserAutomationProductSearchConnector({baseUrl:'http://localhost:8080',fetch:async():Promise<Response>=>new Response('',{status:503})});
    await expect(http.search({version:1,request:'earbuds',deliveryPincode:'560103',limit:3})).rejects.toMatchObject({code:'http_error'});
    const malformed=new BrowserAutomationProductSearchConnector({baseUrl:'http://localhost:8080',fetch:async():Promise<Response>=>new Response('{}',{status:200})});
    await expect(malformed.search({version:1,request:'earbuds',deliveryPincode:'560103',limit:3})).rejects.toMatchObject({code:'invalid_response'});
  });
  it('enforces timeout',async()=>{
    const connector=new BrowserAutomationProductSearchConnector({baseUrl:'http://localhost:8080',timeoutMs:100,fetch:async(url,init):Promise<Response>=>{void url; return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));}});
    await expect(connector.search({version:1,request:'earbuds',deliveryPincode:'560103',limit:3})).rejects.toMatchObject({code:'timeout'});
  });
});
