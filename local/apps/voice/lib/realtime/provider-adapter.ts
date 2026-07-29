import type {
  OpenAIResponse,
  OpenAIResponseRequest,
} from '../voice-turn/provider-adapters';
import { voiceRuntimePolicy } from '../runtime-policy';
import {
  newLocalIdentifier,
  type LocalIdentifier,
} from '../workflow/identifiers';
import {
  RealtimeControlSession,
  type RealtimeFunctionTool,
  type RealtimeServerEvent,
} from './control-session';
import { createNodeRealtimeSocket } from './node-websocket-factory';
import {
  SafeRealtimePhoneToolAdapter,
  type RealtimeToolBindingV1,
  type SafeRealtimePhoneToolAdapterOptions,
} from './safe-phone-tools';
import {
  RealtimeSafeToolBridge,
  type RealtimeToolBridgeResultV1,
} from './tool-bridge';
import {
  RealtimeWebSocketTransport,
  type RealtimeSocketFactory,
} from './websocket-transport';
import { activeRealtimeResponseRegistry } from './active-response-registry';

export type RealtimeControlRequestContextV1 = {
  clientId: string;
  imageDataUrl?: string;
  itemId?: LocalIdentifier<'task_item'> | string;
  requestId: string;
  safeTools?: SafeRealtimePhoneToolAdapterOptions;
  signal?: AbortSignal;
  taskId?: LocalIdentifier<'task'> | string;
  version: 1;
};

type RealtimeControlProviderResultV1 = {
  response: OpenAIResponse;
  toolBridge?: RealtimeToolBridgeResultV1;
  version: 1;
};

export interface RealtimeControlProvider {
  cancelResponse(clientId: string): Promise<boolean>;
  createResponse(
    body: OpenAIResponseRequest,
    context: RealtimeControlRequestContextV1,
  ): Promise<RealtimeControlProviderResultV1>;
}

export class RealtimeImageDetailRoutingError extends Error {
  constructor(readonly detail: 'high' | 'low') {
    super(
      `Realtime does not expose image detail=${detail}; route this grounded turn through Responses.`,
    );
    this.name = 'RealtimeImageDetailRoutingError';
  }
}

type ActiveTurn = {
  session: RealtimeControlSession;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required for Realtime control.`);
  }
  return value.trim();
}

function responseFromEvent(event: RealtimeServerEvent): OpenAIResponse {
  const response = event['response'];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('Realtime response.done did not contain a response.');
  }
  const record = response as Record<string, unknown>;
  return {
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    output: Array.isArray(record.output)
      ? record.output as OpenAIResponse['output']
      : [],
    ...(typeof record.output_text === 'string'
      ? { output_text: record.output_text }
      : {}),
  };
}

/**
 * Server-owned text/image Realtime adapter.
 *
 * Sarvam remains responsible for speech. This adapter creates no audio input
 * or output and can only execute tools when given the local safe adapter.
 */
export class OpenAIRealtimeControlAdapter implements RealtimeControlProvider {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly createSocket: RealtimeSocketFactory;

  constructor(
    private readonly options: {
      apiKey: string;
      createSocket?: RealtimeSocketFactory;
      organization?: string;
      project?: string;
      safeTools?: Omit<SafeRealtimePhoneToolAdapterOptions, 'capability'> & {
        capability: SafeRealtimePhoneToolAdapterOptions['capability'];
      };
    },
  ) {
    this.createSocket = options.createSocket ?? createNodeRealtimeSocket;
  }

  async cancelResponse(clientId: string): Promise<boolean> {
    const active = this.activeTurns.get(clientId);
    return active ? active.session.cancelResponse() : false;
  }

  async createResponse(
    body: OpenAIResponseRequest,
    context: RealtimeControlRequestContextV1,
  ): Promise<RealtimeControlProviderResultV1> {
    if (context.version !== 1) {
      throw new Error('Unsupported Realtime control request version.');
    }
    const instructions = requiredString(body['instructions'], 'instructions');
    const input = requiredString(body['input'], 'input');
    if (
      context.imageDataUrl
      && voiceRuntimePolicy.screenshot.detail !== 'auto'
    ) {
      throw new RealtimeImageDetailRoutingError(
        voiceRuntimePolicy.screenshot.detail,
      );
    }
    const taskId = context.taskId ?? newLocalIdentifier('task');
    const realtimeSessionId = newLocalIdentifier('realtime');
    const transport = new RealtimeWebSocketTransport({
      auth: {
        apiKey: this.options.apiKey,
        ...(this.options.organization
          ? { organization: this.options.organization }
          : {}),
        ...(this.options.project ? { project: this.options.project } : {}),
      },
      correlation: {
        clientId: context.clientId,
        requestId: context.requestId,
        realtimeSessionId,
        taskId,
        ...(context.itemId ? { itemId: context.itemId } : {}),
      },
      createSocket: this.createSocket,
      ...(context.signal ? { signal: context.signal } : {}),
    });
    const safeToolOptions = context.safeTools ?? this.options.safeTools;
    if (
      !safeToolOptions
      && Array.isArray(body['tools'])
      && body['tools'].length > 0
    ) {
      throw new Error(
        'Realtime tool schemas require the shared safe phone adapter.',
      );
    }
    const safeTools = safeToolOptions
      ? new SafeRealtimePhoneToolAdapter(safeToolOptions)
      : undefined;
    const definitions: RealtimeFunctionTool[] = safeTools?.definitions() ?? [];
    const session = new RealtimeControlSession(
      transport,
      {
        instructions,
        model: typeof body['model'] === 'string'
          ? body['model']
          : voiceRuntimePolicy.realtime.model,
        reasoningEffort: voiceRuntimePolicy.realtime.reasoningEffort,
        tools: definitions,
      },
      { maxSessionDurationMs: voiceRuntimePolicy.realtime.maxSessionDurationMs },
    );
    this.activeTurns.set(context.clientId, { session });
    const unregisterActiveResponse = activeRealtimeResponseRegistry.register({
      clientId: context.clientId,
      response: session,
      taskId: String(taskId),
    });

    let bridgeResult: RealtimeToolBridgeResultV1 | undefined;
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let unsubscribeErrors: () => void = () => undefined;
    let resolveResponse!: (value: OpenAIResponse) => void;
    let rejectResponse!: (reason: unknown) => void;
    const completed = new Promise<OpenAIResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const binding: RealtimeToolBindingV1 = {
      taskId,
      ...(context.itemId ? { itemId: context.itemId } : {}),
      version: 1,
    };
    const bridgeTransport = {
      send: async (event: Record<string, unknown> & { type: string }) => {
        if (event.type === 'response.create') {
          await session.requestResponse();
          return;
        }
        await transport.send(event);
      },
    };
    const bridge = safeTools
      ? new RealtimeSafeToolBridge(bridgeTransport, safeTools)
      : undefined;

    const finish = (response: OpenAIResponse) => {
      if (settled) return;
      settled = true;
      resolveResponse(response);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectResponse(error);
    };
    let eventTail = Promise.resolve();
    let responseText = '';
    unsubscribe = transport.subscribe((event) => {
      eventTail = eventTail.then(async () => {
        session.receive(event);
        if (
          event.type === 'response.output_text.delta'
          && typeof event['delta'] === 'string'
        ) {
          responseText += event['delta'];
        }
        if (
          event.type === 'response.output_text.done'
          && typeof event['text'] === 'string'
          && event['text'].trim()
        ) {
          // Some GA transports coalesce the complete text and do not deliver
          // every delta. The done event is authoritative for that output item.
          responseText = event['text'];
        }
        if (event.type !== 'response.done') return;
        const response = responseFromEvent(event);
        if (!response.output_text && responseText) {
          response.output_text = responseText;
        }
        responseText = '';
        const hasFunctionCall = response.output?.some(
          (item) => item.type === 'function_call',
        ) ?? false;
        if (hasFunctionCall && bridge) {
          const nextBridgeResult = await bridge.handleResponseDone({
            binding,
            event,
          });
          bridgeResult = bridgeResult
            ? {
                executed: [
                  ...bridgeResult.executed,
                  ...nextBridgeResult.executed,
                ],
                rejected: [
                  ...bridgeResult.rejected,
                  ...nextBridgeResult.rejected,
                ],
                responseRequested:
                  bridgeResult.responseRequested
                  || nextBridgeResult.responseRequested,
                version: 1,
              }
            : nextBridgeResult;
          if (bridgeResult.responseRequested) return;
        }
        finish(response);
      }).catch(fail);
    });
    unsubscribeErrors = transport.subscribeErrors(fail);

    const abort = () => {
      void session.cancelResponse().finally(() => {
        fail(new Error('Realtime control request was aborted.'));
      });
    };
    context.signal?.addEventListener('abort', abort, { once: true });
    try {
      await session.connect();
      await session.submitTurn({
        transcript: input,
        ...(context.imageDataUrl
          ? { imageDataUrl: context.imageDataUrl }
          : {}),
      });
      const response = await completed;
      return {
        response,
        ...(bridgeResult ? { toolBridge: bridgeResult } : {}),
        version: 1,
      };
    } finally {
      context.signal?.removeEventListener('abort', abort);
      unsubscribe();
      unsubscribeErrors();
      unregisterActiveResponse();
      if (this.activeTurns.get(context.clientId)?.session === session) {
        this.activeTurns.delete(context.clientId);
      }
      await session.close();
    }
  }
}
