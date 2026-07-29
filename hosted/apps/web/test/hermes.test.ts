import { describe, expect, it, vi } from 'vitest';
import { HermesClient } from '../lib/hermes';

describe('HermesClient', () => {
  it('uses a stable Hermes session and requests fact markers', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Nothing ordered. [[fact:₹148]]' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const client = new HermesClient({ apiKey: 'hermes-secret', fetchImpl });

    const response = await client.chat('Find milk', 'kn-IN', 'session-123');

    expect(response).toBe('Nothing ordered. [[fact:₹148]]');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8642/v1/chat/completions');
    expect(new Headers(init?.headers).get('x-hermes-session-id')).toBe('session-123');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer hermes-secret');
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toContain('Kannada');
    expect(body.messages[0]?.content).toContain('[[fact:...]]');
  });

  it('constrains the public agent to reversible share-cart handoff', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Cart ready. [[fact:https://blinkit.com/s/abc]]' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const client = new HermesClient({
      apiKey: 'hermes-secret',
      fetchImpl,
      publicCartHandoff: true,
    });

    await client.chat('Add two packets of milk', 'hi-IN', 'public-session');

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const instructions = body.messages[0]?.content ?? '';
    expect(instructions).toContain('clear the cart first');
    expect(instructions).toContain('official Blinkit share link');
    expect(instructions).toContain('call blinkit_search_products for each unresolved product phrase');
    expect(instructions).toContain('Do not clear or modify the cart during this discovery step');
    expect(instructions).toContain('choice-based follow-up');
    expect(instructions).toContain('Never invent an example product');
    expect(instructions).toContain('A follow-up such as "Hocco ice cream"');
    expect(instructions).toContain('Never prepare checkout');
    expect(instructions).toContain('Never access or discuss login');
    expect(instructions).toContain("Suraj's shared provider account");
    expect(instructions).toContain('I can only search, build, and share a cart link');
    expect(instructions).toContain('https://sk9261712674.com');
  });
});
