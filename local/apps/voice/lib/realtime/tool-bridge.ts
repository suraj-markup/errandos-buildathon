import type {
  RealtimeClientEvent,
  RealtimeEventTransport,
  RealtimeServerEvent,
} from './control-session';
import {
  SafeRealtimeToolError,
  type RealtimeFunctionCallV1,
  type RealtimeToolBindingV1,
  type SafeRealtimePhoneToolAdapter,
  type SafeRealtimeToolResultV1,
} from './safe-phone-tools';

export type RealtimeSafeToolExecutor = Pick<
  SafeRealtimePhoneToolAdapter,
  'execute' | 'functionCallOutput'
>;

export type RealtimeToolBridgeResultV1 = {
  executed: SafeRealtimeToolResultV1[];
  rejected: Array<{
    callId: string;
    code: string;
    toolName: string;
  }>;
  responseRequested: boolean;
  version: 1;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function functionCalls(
  event: RealtimeServerEvent,
): RealtimeFunctionCallV1[] {
  if (event.type !== 'response.done') return [];
  const response = record(event['response']);
  const output = Array.isArray(response?.['output'])
    ? response['output']
    : [];
  return output.flatMap((raw): RealtimeFunctionCallV1[] => {
    const item = record(raw);
    if (item?.['type'] !== 'function_call') return [];
    const callId = item['call_id'];
    const name = item['name'];
    const arguments_ = item['arguments'];
    if (
      typeof callId !== 'string'
      || typeof name !== 'string'
      || typeof arguments_ !== 'string'
    ) {
      return [{
        arguments: '',
        callId: typeof callId === 'string' ? callId : 'invalid_call',
        name: typeof name === 'string' ? name : 'invalid_tool',
        version: 1,
      }];
    }
    return [{
      arguments: arguments_,
      callId,
      name,
      version: 1,
    }];
  });
}

function rejectedOutput(input: {
  callId: string;
  code: string;
}): RealtimeClientEvent {
  return {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: input.callId,
      output: JSON.stringify({
        authority: 'local_phone_adapter',
        error: { code: input.code },
        status: 'rejected',
        version: 1,
      }),
    },
  };
}

/**
 * Consumes complete Realtime function calls, executes them through the shared
 * safe adapter, and returns local structured results to the conversation.
 * The model never receives an executor directly.
 */
export class RealtimeSafeToolBridge {
  constructor(
    private readonly transport: Pick<RealtimeEventTransport, 'send'>,
    private readonly tools: RealtimeSafeToolExecutor,
  ) {}

  async handleResponseDone(input: {
    binding: RealtimeToolBindingV1;
    continueAfterResult?: (
      result: SafeRealtimeToolResultV1,
    ) => boolean;
    event: RealtimeServerEvent;
  }): Promise<RealtimeToolBridgeResultV1> {
    const calls = functionCalls(input.event);
    const executed: SafeRealtimeToolResultV1[] = [];
    const rejected: RealtimeToolBridgeResultV1['rejected'] = [];
    let responseRequested = false;

    for (const call of calls) {
      try {
        const result = await this.tools.execute(call, input.binding);
        executed.push(result);
        await this.transport.send(
          this.tools.functionCallOutput(result) as RealtimeClientEvent,
        );
        if (input.continueAfterResult?.(result) ?? true) {
          responseRequested = true;
        }
      } catch (error) {
        const code = error instanceof SafeRealtimeToolError
          ? error.code
          : 'local_execution_failed';
        rejected.push({
          callId: call.callId,
          code,
          toolName: call.name,
        });
        await this.transport.send(rejectedOutput({
          callId: call.callId,
          code,
        }));
        responseRequested = true;
      }
    }
    if (responseRequested) {
      await this.transport.send({
        type: 'response.create',
        response: { output_modalities: ['text'] },
      });
    }
    return {
      executed,
      rejected,
      responseRequested,
      version: 1,
    };
  }
}
