import { describe, expect, it, vi } from 'vitest';
import {
  createFlaggedRealtimeControlSession,
  createRealtimeControlConfig,
  createRealtimeControlTurnEvents,
  RealtimeControlSession,
  type RealtimeEventTransport,
} from './control-session';

function fakeTransport(): RealtimeEventTransport {
  return {
    connect: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('Realtime text/image control session', () => {
  it('uses text-only output and the current model default', () => {
    expect(createRealtimeControlConfig({ instructions: 'Control the phone safely.' }))
      .toMatchObject({
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        output_modalities: ['text'],
        reasoning: { effort: 'low' },
        tool_choice: 'none',
        truncation: {
          type: 'retention_ratio',
          retention_ratio: 0.8,
          token_limits: { post_instructions: 8000 },
        },
      });
  });

  it('creates a Sarvam transcript turn with an optional screenshot', () => {
    const events = createRealtimeControlTurnEvents({
      transcript: 'दूध जोड़ो',
      imageDataUrl: 'data:image/png;base64,AAAA',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'conversation.item.create',
      item: {
        content: [
          { type: 'input_text', text: 'दूध जोड़ो' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      type: 'response.create',
      response: { output_modalities: ['text'] },
    });
  });

  it('rejects empty transcripts and unsafe image schemes', () => {
    expect(() => createRealtimeControlTurnEvents({ transcript: ' ' })).toThrow();
    expect(() => createRealtimeControlTurnEvents({
      transcript: 'inspect',
      imageDataUrl: 'https://example.com/private.png',
    })).toThrow();
  });

  it('connects, submits ordered events, completes, and closes', async () => {
    const transport = fakeTransport();
    const session = new RealtimeControlSession(transport, {
      instructions: 'Use only validated tools.',
    });

    await session.connect();
    expect(session.state).toBe('ready');
    await session.submitTurn({ transcript: 'add milk' });
    expect(session.state).toBe('responding');
    expect(transport.send).toHaveBeenCalledTimes(2);
    session.receive({ type: 'response.output_text.delta', delta: 'Working' });
    session.receive({ type: 'response.done', response: {} });
    expect(session.state).toBe('ready');
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('supports response cancellation without task cancellation semantics', async () => {
    const transport = fakeTransport();
    const session = new RealtimeControlSession(transport, {
      instructions: 'Use only validated tools.',
    });
    await session.connect();
    await session.submitTurn({ transcript: 'inspect cart' });

    await expect(session.cancelResponse()).resolves.toBe(true);
    expect(transport.send).toHaveBeenLastCalledWith({ type: 'response.cancel' });
    expect(session.state).toBe('ready');
  });

  it('reconnects and rejects malformed or out-of-order events', async () => {
    const transport = fakeTransport();
    const session = new RealtimeControlSession(transport, {
      instructions: 'Use only validated tools.',
    });
    await session.connect();
    await session.reconnect();
    expect(transport.connect).toHaveBeenCalledTimes(2);
    expect(() => session.receive({ type: 'response.done' })).toThrow(
      /Out-of-order/,
    );
    expect(session.state).toBe('failed');
  });

  it('fails closed on authentication or connection errors', async () => {
    const transport = fakeTransport();
    vi.mocked(transport.connect).mockRejectedValueOnce(new Error('unauthorized'));
    const session = new RealtimeControlSession(transport, {
      instructions: 'Use only validated tools.',
    });

    await expect(session.connect()).rejects.toThrow('unauthorized');
    expect(session.state).toBe('failed');
  });

  it('returns null while the control flag is off', () => {
    expect(createFlaggedRealtimeControlSession({
      enabled: false,
      transport: fakeTransport(),
      config: { instructions: 'Safe control.' },
    })).toBeNull();
  });

  it('expires once at the app-owned session lifetime without cancelling the task', async () => {
    vi.useFakeTimers();
    try {
      const transport = fakeTransport();
      const session = new RealtimeControlSession(
        transport,
        { instructions: 'Use only validated tools.' },
        { maxSessionDurationMs: 1_000 },
      );
      await session.connect();
      await session.submitTurn({ transcript: 'inspect cart' });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(transport.send).toHaveBeenLastCalledWith({ type: 'response.cancel' });
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(session.state).toBe('expired');
      await expect(session.reconnect()).rejects.toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
  });
});
