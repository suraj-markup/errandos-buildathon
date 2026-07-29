import { describe, expect, it, vi } from 'vitest';
import {
  OpenAIRealtimeControlAdapter,
  RealtimeImageDetailRoutingError,
} from './provider-adapter';
import type {
  RealtimeSocketFactoryInput,
  RealtimeWebSocketLike,
} from './websocket-transport';
import type {
  PhoneActionArguments,
  PhoneActionExecutionContext,
} from '../phone-tool';

type EventType = 'close' | 'error' | 'message' | 'open';
type Listener = (event: unknown) => void;

class FakeSocket implements RealtimeWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<EventType, Set<Listener>>();

  addEventListener(type: EventType, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: EventType, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  message(event: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(event) });
  }

  private emit(type: EventType, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function harness(options?: ConstructorParameters<
  typeof OpenAIRealtimeControlAdapter
>[0]['safeTools']) {
  const sockets: FakeSocket[] = [];
  const createSocket = vi.fn((_input: RealtimeSocketFactoryInput) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return {
    adapter: new OpenAIRealtimeControlAdapter({
      apiKey: 'secret',
      createSocket,
      ...(options ? { safeTools: options } : {}),
    }),
    createSocket,
    sockets,
  };
}

const context = {
  clientId: 'pixel-overlay',
  requestId: 'request-shadow',
  taskId: 'task_12345678-1234-1234-1234-123456789abc',
  version: 1 as const,
};

describe('OpenAI Realtime control adapter', () => {
  it('routes configured low-detail screenshots to the Responses boundary', async () => {
    const { adapter, createSocket } = harness();
    await expect(adapter.createResponse({
      instructions: 'Inspect the approved screenshot.',
      input: 'Which option is visible?',
    }, {
      ...context,
      imageDataUrl: 'data:image/png;base64,AAAA',
    })).rejects.toBeInstanceOf(RealtimeImageDetailRoutingError);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('rejects arbitrary tool schemas without the shared safe adapter', async () => {
    const { adapter, createSocket } = harness();
    await expect(adapter.createResponse({
      instructions: 'Use the supplied tool.',
      input: 'Do something.',
      tools: [{
        type: 'function',
        name: 'confirm_checkout',
        description: 'Unsafe final dispatch.',
        parameters: { type: 'object' },
      }],
    }, context)).rejects.toThrow(/shared safe phone adapter/);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('runs a server-only text turn with no Realtime audio', async () => {
    const { adapter, createSocket, sockets } = harness();
    const result = adapter.createResponse({
      instructions: 'Return one short answer.',
      input: 'Say hello without using the phone.',
      model: 'gpt-realtime-2.1',
    }, context);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await vi.waitFor(() => expect(sockets[0]!.sent.length).toBeGreaterThan(2));
    sockets[0]!.message({
      type: 'response.output_text.delta',
      delta: 'Hello.',
    });
    sockets[0]!.message({
      type: 'response.done',
      response: {
        id: 'resp_realtime_1',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello.' }],
        }],
      },
    });

    await expect(result).resolves.toMatchObject({
      response: { id: 'resp_realtime_1', output_text: 'Hello.' },
      version: 1,
    });
    expect(createSocket.mock.calls[0]![0].headers.Authorization)
      .toBe('Bearer secret');
    expect(sockets[0]!.sent.join('\n')).not.toMatch(/audio/i);
  });

  it('uses the GA output-text completion when deltas are coalesced', async () => {
    const { adapter, sockets } = harness();
    const result = adapter.createResponse({
      instructions: 'Return one JSON object.',
      input: 'Classify this sanitized fixture.',
      model: 'gpt-realtime-2.1',
    }, context);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await vi.waitFor(() => expect(sockets[0]!.sent.length).toBeGreaterThan(2));
    sockets[0]!.message({
      type: 'response.output_text.done',
      text: '{"version":1}',
    });
    sockets[0]!.message({
      type: 'response.done',
      response: {
        id: 'resp_coalesced',
        output: [{ type: 'message', content: [] }],
      },
    });

    await expect(result).resolves.toMatchObject({
      response: {
        id: 'resp_coalesced',
        output_text: '{"version":1}',
      },
    });
  });

  it('routes function calls through the safe adapter before model follow-up', async () => {
    const execute = vi.fn(
      async (
        _action: PhoneActionArguments,
        _context: PhoneActionExecutionContext,
      ) => ({
        ok: true,
        status: 'search_results',
        options: [{ product: 'milk' }],
      }),
    );
    const { adapter, sockets } = harness({
      capability: 'read_only',
      execute,
      isCurrentTask: () => true,
    });
    const result = adapter.createResponse({
      instructions: 'Use only the declared safe tools.',
      input: 'Search milk.',
      model: 'gpt-realtime-2.1',
    }, context);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await vi.waitFor(() => expect(sockets[0]!.sent.length).toBeGreaterThan(2));
    sockets[0]!.message({
      type: 'response.done',
      response: {
        id: 'resp_tool_1',
        output: [{
          type: 'function_call',
          call_id: 'call_12345678',
          name: 'search_products',
          arguments: JSON.stringify({ request: 'milk' }),
        }],
      },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(
      sockets[0]!.sent.some((raw) =>
        raw.includes('"type":"function_call_output"')),
    ).toBe(true));
    sockets[0]!.message({
      type: 'response.done',
      response: {
        id: 'resp_tool_2',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'I found milk options.' }],
        }],
      },
    });

    await expect(result).resolves.toMatchObject({
      response: { id: 'resp_tool_2' },
      toolBridge: {
        executed: [{
          callId: 'call_12345678',
          toolName: 'search_products',
        }],
        responseRequested: true,
      },
    });
    expect(execute.mock.calls[0]![1]).toMatchObject({
      taskId: context.taskId,
      operationId: expect.stringMatching(/^operation_/),
    });
  });
});
