import { describe, expect, it, vi } from 'vitest';
import {
  MalformedRealtimeEventError,
  RealtimeAuthenticationError,
  RealtimeTransportAbortedError,
  RealtimeTransportClosedError,
  RealtimeWebSocketTransport,
  type RealtimeSocketFactoryInput,
  type RealtimeWebSocketLike,
} from './websocket-transport';

const taskId = 'task_12345678-1234-1234-1234-123456789abc';
const realtimeSessionId = 'realtime_12345678-1234-1234-1234-123456789abc';
const requestId = 'request-12345678';
const clientId = 'pixel-overlay';

type SocketEventType = 'close' | 'error' | 'message' | 'open';
type SocketListener = (event: unknown) => void;

class FakeSocket implements RealtimeWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  addEventListener(type: SocketEventType, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    this.readyState = 3;
    this.emit('close', { code: code ?? 1000 });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  fail(code = 1011): void {
    this.readyState = 3;
    this.emit('close', { code });
  }

  message(value: unknown): void {
    this.emit('message', { data: value });
  }

  listenerCount(): number {
    return [...this.listeners.values()]
      .reduce((count, listeners) => count + listeners.size, 0);
  }

  private emit(type: SocketEventType, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function createHarness(input?: {
  maxReconnectAttempts?: number;
  signal?: AbortSignal;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}) {
  const sockets: FakeSocket[] = [];
  const factoryInputs: RealtimeSocketFactoryInput[] = [];
  const createSocket = vi.fn((factoryInput: RealtimeSocketFactoryInput) => {
    factoryInputs.push(factoryInput);
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const transport = new RealtimeWebSocketTransport({
    auth: {
      apiKey: 'server-secret-key',
      organization: 'org_test',
      project: 'proj_test',
      safetyIdentifier: 'hashed-user',
    },
    correlation: {
      clarificationId: 'clarification_12345678',
      clientId,
      itemId: 'task_item_12345678',
      observationId: 'observation_12345678',
      operationId: 'operation_12345678',
      realtimeSessionId,
      requestId,
      selectionId: 'selection_12345678',
      taskId,
    },
    createSocket,
    maxReconnectAttempts: input?.maxReconnectAttempts ?? 2,
    now: () => 42,
    reconnectDelayMs: (attempt) => attempt * 10,
    ...(input?.signal ? { signal: input.signal } : {}),
    ...(input?.wait ? { wait: input.wait } : {}),
  });
  return { createSocket, factoryInputs, sockets, transport };
}

const config = {
  type: 'realtime',
  model: 'gpt-realtime-2.1',
  instructions: 'Control only through validated tools.',
  output_modalities: ['text'],
  tool_choice: 'none',
  tools: [],
};

async function connectHarness(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  const connected = harness.transport.connect(config);
  await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
  harness.sockets[0]!.open();
  await connected;
}

function sentEvents(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((event) => JSON.parse(event) as Record<string, unknown>);
}

describe('RealtimeWebSocketTransport', () => {
  it('authenticates on the server and sends a text-only session update first', async () => {
    const harness = createHarness();
    await connectHarness(harness);

    expect(harness.factoryInputs[0]).toMatchObject({
      headers: {
        Authorization: 'Bearer server-secret-key',
        'OpenAI-Organization': 'org_test',
        'OpenAI-Project': 'proj_test',
        'OpenAI-Safety-Identifier': 'hashed-user',
      },
    });
    expect(harness.factoryInputs[0]!.url).toBe(
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    );
    expect(sentEvents(harness.sockets[0]!)[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        instructions: 'Control only through validated tools.',
        output_modalities: ['text'],
        tool_choice: 'none',
        tools: [],
      },
    });
    expect(harness.transport.state).toBe('ready');
  });

  it('fails closed on authentication failure without exposing credentials', async () => {
    const harness = createHarness();
    const connected = harness.transport.connect(config);
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    harness.sockets[0]!.fail(4401);

    const error = await connected.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RealtimeAuthenticationError);
    expect(String(error)).not.toContain('server-secret-key');
    expect(harness.transport.state).toBe('failed');
    expect(harness.createSocket).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent client events in call order and forces text output', async () => {
    const harness = createHarness();
    await connectHarness(harness);

    const first = harness.transport.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'add milk' }],
      },
    });
    const second = harness.transport.send({
      type: 'response.create',
      response: { metadata: { turn: 'one' } },
    });
    const third = harness.transport.cancelResponse();
    await Promise.all([first, second, third]);

    expect(sentEvents(harness.sockets[0]!).slice(1)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'add milk' }],
        },
      },
      {
        type: 'response.create',
        response: {
          metadata: { turn: 'one' },
          output_modalities: ['text'],
        },
      },
      { type: 'response.cancel' },
    ]);
  });

  it('reconnects with deterministic backoff and holds queued sends until ready', async () => {
    const delays: number[] = [];
    const harness = createHarness({
      wait: async (delay) => {
        delays.push(delay);
      },
    });
    await connectHarness(harness);
    harness.sockets[0]!.fail();

    const queued = harness.transport.send({
      type: 'response.create',
      response: {},
    });
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(2));
    expect(harness.transport.state).toBe('reconnecting');
    harness.sockets[1]!.open();
    await queued;

    expect(delays).toEqual([10]);
    expect(sentEvents(harness.sockets[1]!)).toEqual([
      {
        type: 'session.update',
        session: expect.objectContaining({ output_modalities: ['text'] }),
      },
      {
        type: 'response.create',
        response: { output_modalities: ['text'] },
      },
    ]);
    expect(harness.transport.state).toBe('ready');
  });

  it('drops malformed events, reports them, and preserves correlation', async () => {
    const harness = createHarness();
    const events = vi.fn();
    const errors = vi.fn();
    harness.transport.subscribe(events);
    harness.transport.subscribeErrors(errors);
    await connectHarness(harness);

    harness.sockets[0]!.message('{not-json');
    harness.sockets[0]!.message(JSON.stringify({ nope: true }));
    harness.sockets[0]!.message(JSON.stringify({
      type: 'response.output_audio.delta',
      delta: 'forbidden',
    }));
    harness.sockets[0]!.message(JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'Working',
    }));

    expect(errors).toHaveBeenCalledTimes(3);
    expect(errors.mock.calls[0]![0]).toBeInstanceOf(
      MalformedRealtimeEventError,
    );
    expect(events).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledWith(
      {
        type: 'response.output_text.delta',
        delta: 'Working',
      },
      {
        clarificationId: 'clarification_12345678',
        clientId,
        connectionAttempt: 0,
        itemId: 'task_item_12345678',
        observationId: 'observation_12345678',
        operationId: 'operation_12345678',
        realtimeSessionId,
        receivedAtMs: 42,
        requestId,
        selectionId: 'selection_12345678',
        sequence: 1,
        taskId,
      },
    );
    expect(harness.transport.state).toBe('ready');
  });

  it('rejects audio and externally-owned session updates', async () => {
    const harness = createHarness();
    await connectHarness(harness);

    await expect(harness.transport.send({
      type: 'input_audio_buffer.append',
      audio: 'base64',
    })).rejects.toThrow(/Audio events are disabled/);
    await expect(harness.transport.send({
      type: 'session.update',
      session: { instructions: 'replace transport policy' },
    })).rejects.toThrow(/owned by the Realtime transport/);
    expect(harness.sockets[0]!.sent).toHaveLength(1);
  });

  it('aborts, closes the socket, removes listeners, and rejects later sends', async () => {
    const controller = new AbortController();
    const harness = createHarness({ signal: controller.signal });
    await connectHarness(harness);
    const socket = harness.sockets[0]!;
    expect(socket.listenerCount()).toBe(4);

    controller.abort();

    expect(harness.transport.state).toBe('closed');
    expect(socket.closeCalls).toEqual([{
      code: 1000,
      reason: 'transport aborted',
    }]);
    expect(socket.listenerCount()).toBe(0);
    await expect(harness.transport.send({
      type: 'response.cancel',
    })).rejects.toBeInstanceOf(RealtimeTransportAbortedError);
    await expect(harness.transport.connect(config))
      .rejects.toBeInstanceOf(RealtimeTransportClosedError);
  });

  it('aborts a connection that has not opened without leaving a pending promise', async () => {
    const controller = new AbortController();
    const harness = createHarness({ signal: controller.signal });
    const connected = harness.transport.connect(config);
    await vi.waitFor(() => expect(harness.sockets).toHaveLength(1));
    const socket = harness.sockets[0]!;

    controller.abort();

    await expect(connected).rejects.toBeInstanceOf(
      RealtimeTransportAbortedError,
    );
    expect(socket.closeCalls).toEqual([{
      code: 1000,
      reason: 'connection stopped',
    }]);
    expect(socket.listenerCount()).toBe(0);
    expect(harness.transport.state).toBe('closed');
  });
});
