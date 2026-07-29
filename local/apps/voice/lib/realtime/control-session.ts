import { voiceRuntimePolicy } from '../runtime-policy';

export type RealtimeFunctionTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeControlConfig = {
  instructions: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium';
  tools?: RealtimeFunctionTool[];
};

export type RealtimeClientEvent = Record<string, unknown> & {
  type: string;
};

export type RealtimeServerEvent = Record<string, unknown> & {
  type: string;
};

export interface RealtimeEventTransport {
  connect(config: Record<string, unknown>): Promise<void>;
  send(event: RealtimeClientEvent): Promise<void>;
  close(): Promise<void>;
}

export type RealtimeControlState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'responding'
  | 'reconnecting'
  | 'expired'
  | 'closed'
  | 'failed';

export type RealtimeControlTurn = {
  transcript: string;
  imageDataUrl?: string;
};

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;

export function createRealtimeControlConfig(
  input: RealtimeControlConfig,
): Record<string, unknown> {
  const instructions = input.instructions.trim();
  if (!instructions) {
    throw new Error('Realtime control instructions are required.');
  }

  return {
    type: 'realtime',
    model: input.model ?? voiceRuntimePolicy.realtime.model,
    instructions,
    output_modalities: ['text'],
    reasoning: {
      effort: input.reasoningEffort
        ?? voiceRuntimePolicy.realtime.reasoningEffort,
    },
    tool_choice: input.tools?.length ? 'auto' : 'none',
    tools: input.tools ?? [],
    truncation: {
      type: 'retention_ratio',
      retention_ratio: 0.8,
      token_limits: {
        post_instructions: voiceRuntimePolicy.realtime.contextTokenLimit,
      },
    },
  };
}

export function createRealtimeControlTurnEvents(
  turn: RealtimeControlTurn,
): RealtimeClientEvent[] {
  const transcript = turn.transcript.trim();
  if (!transcript) {
    throw new Error('A Sarvam transcript is required.');
  }

  const content: Array<Record<string, string>> = [{
    type: 'input_text',
    text: transcript,
  }];

  if (turn.imageDataUrl) {
    if (!SAFE_IMAGE_DATA_URL.test(turn.imageDataUrl)) {
      throw new Error('Realtime control images must be PNG, JPEG, or WebP data URLs.');
    }
    content.push({
      type: 'input_image',
      image_url: turn.imageDataUrl,
    });
  }

  return [
    {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content,
      },
    },
    {
      type: 'response.create',
      response: {
        output_modalities: ['text'],
      },
    },
  ];
}

export class RealtimeControlSession {
  private stateValue: RealtimeControlState = 'idle';
  private readonly config: Record<string, unknown>;
  private lifetimeTimer?: ReturnType<typeof setTimeout>;
  private lifetimeStarted = false;

  constructor(
    private readonly transport: RealtimeEventTransport,
    config: RealtimeControlConfig,
    private readonly options: {
      clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
      maxSessionDurationMs?: number;
      setTimeout?: (
        callback: () => void,
        delayMs: number,
      ) => ReturnType<typeof setTimeout>;
    } = {},
  ) {
    this.config = createRealtimeControlConfig(config);
  }

  get state(): RealtimeControlState {
    return this.stateValue;
  }

  async connect(): Promise<void> {
    if (this.stateValue !== 'idle' && this.stateValue !== 'failed') {
      throw new Error(`Cannot connect a Realtime control session from ${this.stateValue}.`);
    }

    this.stateValue = 'connecting';
    try {
      await this.transport.connect(this.config);
      this.stateValue = 'ready';
      this.startLifetimeGuard();
    } catch (error) {
      this.stateValue = 'failed';
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    if (this.stateValue === 'closed' || this.stateValue === 'expired') {
      throw new Error(
        `A ${this.stateValue} Realtime control session cannot reconnect.`,
      );
    }

    this.stateValue = 'reconnecting';
    try {
      await this.transport.close();
      await this.transport.connect(this.config);
      this.stateValue = 'ready';
    } catch (error) {
      this.stateValue = 'failed';
      throw error;
    }
  }

  async submitTurn(turn: RealtimeControlTurn): Promise<void> {
    if (this.stateValue !== 'ready') {
      throw new Error(`Cannot submit a Realtime control turn from ${this.stateValue}.`);
    }

    const events = createRealtimeControlTurnEvents(turn);
    this.stateValue = 'responding';
    try {
      for (const event of events) {
        await this.transport.send(event);
      }
    } catch (error) {
      this.stateValue = 'failed';
      throw error;
    }
  }

  async cancelResponse(): Promise<boolean> {
    if (this.stateValue !== 'responding') return false;
    await this.transport.send({ type: 'response.cancel' });
    this.stateValue = 'ready';
    return true;
  }

  async requestResponse(): Promise<void> {
    if (this.stateValue !== 'ready') {
      throw new Error(
        `Cannot request a Realtime control response from ${this.stateValue}.`,
      );
    }
    this.stateValue = 'responding';
    try {
      await this.transport.send({
        type: 'response.create',
        response: { output_modalities: ['text'] },
      });
    } catch (error) {
      this.stateValue = 'failed';
      throw error;
    }
  }

  receive(event: unknown): RealtimeServerEvent {
    if (!event || typeof event !== 'object') {
      this.stateValue = 'failed';
      throw new Error('Malformed Realtime server event.');
    }

    const type = (event as { type?: unknown }).type;
    if (typeof type !== 'string' || !type) {
      this.stateValue = 'failed';
      throw new Error('Realtime server event type is required.');
    }

    if (type.startsWith('response.') && type !== 'response.created'
        && this.stateValue !== 'responding') {
      this.stateValue = 'failed';
      throw new Error(`Out-of-order Realtime event: ${type}.`);
    }

    if (type === 'response.done') this.stateValue = 'ready';
    if (type === 'error') this.stateValue = 'failed';
    return event as RealtimeServerEvent;
  }

  async close(): Promise<void> {
    if (this.stateValue === 'closed') return;
    this.clearLifetimeGuard();
    await this.transport.close();
    this.stateValue = 'closed';
  }

  private startLifetimeGuard(): void {
    if (this.lifetimeStarted) return;
    this.lifetimeStarted = true;
    const durationMs = this.options.maxSessionDurationMs
      ?? voiceRuntimePolicy.realtime.maxSessionDurationMs;
    const schedule = this.options.setTimeout ?? setTimeout;
    this.lifetimeTimer = schedule(() => {
      void this.expire();
    }, durationMs);
  }

  private clearLifetimeGuard(): void {
    if (!this.lifetimeTimer) return;
    const clear = this.options.clearTimeout ?? clearTimeout;
    clear(this.lifetimeTimer);
    this.lifetimeTimer = undefined;
  }

  private async expire(): Promise<void> {
    if (this.stateValue === 'closed' || this.stateValue === 'expired') return;
    this.lifetimeTimer = undefined;
    if (this.stateValue === 'responding') {
      try {
        await this.transport.send({ type: 'response.cancel' });
      } catch {
        // Expiry remains fail-closed even when cancellation cannot be sent.
      }
    }
    try {
      await this.transport.close();
    } finally {
      this.stateValue = 'expired';
    }
  }
}

export function createFlaggedRealtimeControlSession(input: {
  enabled: boolean;
  transport: RealtimeEventTransport;
  config: RealtimeControlConfig;
}): RealtimeControlSession | null {
  if (!input.enabled) return null;
  return new RealtimeControlSession(input.transport, input.config);
}
