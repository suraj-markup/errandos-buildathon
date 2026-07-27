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
});
