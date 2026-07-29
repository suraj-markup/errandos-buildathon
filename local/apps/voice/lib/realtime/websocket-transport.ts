import {
  type LocalIdentifier,
} from '../workflow/identifiers';
import {
  correlationFields,
  createCorrelationContext,
  type CorrelationContextV1,
} from '../correlation';
import type {
  RealtimeClientEvent,
  RealtimeEventTransport,
  RealtimeServerEvent,
} from './control-session';
import { voiceRuntimePolicy } from '../runtime-policy';

const DEFAULT_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const SOCKET_OPEN = 1;
const AUTHENTICATION_CLOSE_CODES = new Set([4001, 4003, 4401, 4403]);

type SocketEventType = 'close' | 'error' | 'message' | 'open';
type SocketListener = (event: unknown) => void;

export interface RealtimeWebSocketLike {
  readonly readyState: number;
  addEventListener(type: SocketEventType, listener: SocketListener): void;
  removeEventListener(type: SocketEventType, listener: SocketListener): void;
  send(data: string): Promise<void> | void;
  close(code?: number, reason?: string): void;
}

export type RealtimeSocketFactoryInput = {
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  url: string;
};

export type RealtimeSocketFactory = (
  input: RealtimeSocketFactoryInput,
) => Promise<RealtimeWebSocketLike> | RealtimeWebSocketLike;

export type RealtimeServerAuth = {
  apiKey: string;
  organization?: string;
  project?: string;
  safetyIdentifier?: string;
};

export type RealtimeTransportCorrelation = {
  clarificationId?: LocalIdentifier<'clarification'> | string;
  clientId: string;
  itemId?: LocalIdentifier<'task_item'> | string;
  observationId?: LocalIdentifier<'observation'> | string;
  operationId?: LocalIdentifier<'operation'> | string;
  realtimeSessionId: LocalIdentifier<'realtime'> | string;
  requestId: string;
  selectionId?: LocalIdentifier<'selection'> | string;
  taskId: LocalIdentifier<'task'> | string;
};

export type RealtimeTransportState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export type RealtimeTransportEventMetadata = {
  connectionAttempt: number;
  receivedAtMs: number;
  sequence: number;
} & Omit<CorrelationContextV1, 'version'>;

export type RealtimeTransportErrorMetadata = {
  connectionAttempt: number;
} & Omit<CorrelationContextV1, 'version'>;

export type RealtimeTransportOptions = {
  auth: RealtimeServerAuth;
  baseUrl?: string;
  correlation: RealtimeTransportCorrelation;
  createSocket: RealtimeSocketFactory;
  maxReconnectAttempts?: number;
  now?: () => number;
  reconnectDelayMs?: (attempt: number) => number;
  signal?: AbortSignal;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

export class RealtimeTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeTransportError';
  }
}

export class RealtimeAuthenticationError extends RealtimeTransportError {
  constructor() {
    super('Realtime WebSocket authentication failed.');
    this.name = 'RealtimeAuthenticationError';
  }
}

export class RealtimeTransportClosedError extends RealtimeTransportError {
  constructor() {
    super('Realtime WebSocket transport is closed.');
    this.name = 'RealtimeTransportClosedError';
  }
}

export class RealtimeTransportAbortedError extends RealtimeTransportError {
  constructor() {
    super('Realtime WebSocket transport was aborted.');
    this.name = 'RealtimeTransportAbortedError';
  }
}

export class MalformedRealtimeEventError extends RealtimeTransportError {
  constructor() {
    super('Malformed Realtime WebSocket event.');
    this.name = 'MalformedRealtimeEventError';
  }
}

type EventSubscriber = (
  event: RealtimeServerEvent,
  metadata: RealtimeTransportEventMetadata,
) => void;

type ErrorSubscriber = (
  error: Error,
  metadata: RealtimeTransportErrorMetadata,
) => void;

type ConnectionListeners = {
  abort: () => void;
  close: SocketListener;
  error: SocketListener;
  message: SocketListener;
  open: SocketListener;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RealtimeTransportError(`${field} is required.`);
  }
  return value.trim();
}

function finiteNonNegativeInteger(
  value: number | undefined,
  field: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw new RealtimeTransportError(
      `${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function hasAudioPayload(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') {
    return value === 'audio'
      || value === 'input_audio'
      || value === 'output_audio';
  }
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasAudioPayload(entry, seen));
  }
  return Object.entries(value).some(([key, nested]) => (
    key === 'audio'
    || key === 'voice'
    || key.startsWith('audio_')
    || key.startsWith('input_audio')
    || key.startsWith('output_audio')
    || hasAudioPayload(nested, seen)
  ));
}

function isAudioEventType(type: string): boolean {
  return type.includes('audio');
}

function cloneTextOnlyClientEvent(
  event: RealtimeClientEvent,
): RealtimeClientEvent {
  if (!isRecord(event) || typeof event.type !== 'string' || !event.type) {
    throw new RealtimeTransportError('Realtime client event type is required.');
  }
  if (event.type === 'session.update') {
    throw new RealtimeTransportError(
      'session.update is owned by the Realtime transport.',
    );
  }
  if (isAudioEventType(event.type) || hasAudioPayload(event)) {
    throw new RealtimeTransportError(
      'Audio events are disabled for the Realtime control transport.',
    );
  }
  if (event.type !== 'response.create') return { ...event };

  const response = isRecord(event.response) ? event.response : {};
  return {
    ...event,
    response: {
      ...response,
      output_modalities: ['text'],
    },
  };
}

function createTextOnlySession(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (hasAudioPayload(config)) {
    throw new RealtimeTransportError(
      'Audio configuration is disabled for the Realtime control transport.',
    );
  }
  const model = nonEmptyString(config.model, 'Realtime model');
  const instructions = nonEmptyString(
    config.instructions,
    'Realtime instructions',
  );
  const tools = config.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    throw new RealtimeTransportError('Realtime tools must be an array.');
  }
  const toolChoice = config.tool_choice;
  if (
    toolChoice !== undefined
    && typeof toolChoice !== 'string'
    && !isRecord(toolChoice)
  ) {
    throw new RealtimeTransportError('Invalid Realtime tool choice.');
  }
  const truncation = config.truncation;
  if (truncation !== undefined && !isRecord(truncation)) {
    throw new RealtimeTransportError('Invalid Realtime truncation configuration.');
  }
  const reasoning = config.reasoning;
  if (reasoning !== undefined && !isRecord(reasoning)) {
    throw new RealtimeTransportError('Invalid Realtime reasoning configuration.');
  }

  return {
    type: 'realtime',
    model,
    instructions,
    output_modalities: ['text'],
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    tools: tools ?? [],
    ...(truncation === undefined ? {} : { truncation: { ...truncation } }),
    ...(reasoning === undefined ? {} : { reasoning: { ...reasoning } }),
  };
}

function createHeaders(auth: RealtimeServerAuth): Readonly<Record<string, string>> {
  const apiKey = nonEmptyString(auth.apiKey, 'Realtime API key');
  return Object.freeze({
    Authorization: `Bearer ${apiKey}`,
    ...(auth.organization
      ? { 'OpenAI-Organization': nonEmptyString(
        auth.organization,
        'OpenAI organization',
      ) }
      : {}),
    ...(auth.project
      ? { 'OpenAI-Project': nonEmptyString(auth.project, 'OpenAI project') }
      : {}),
    ...(auth.safetyIdentifier
      ? { 'OpenAI-Safety-Identifier': nonEmptyString(
        auth.safetyIdentifier,
        'OpenAI safety identifier',
      ) }
      : {}),
  });
}

function createRealtimeUrl(baseUrl: string, model: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RealtimeTransportError('Invalid Realtime WebSocket URL.');
  }
  if (url.protocol !== 'wss:') {
    throw new RealtimeTransportError(
      'Realtime WebSocket URL must use wss.',
    );
  }
  url.searchParams.set('model', model);
  return url.toString();
}

function closeCode(event: unknown): number | undefined {
  if (!isRecord(event)) return undefined;
  return typeof event.code === 'number' ? event.code : undefined;
}

function socketMessageData(event: unknown): unknown {
  if (isRecord(event) && 'data' in event) return event.data;
  return event;
}

function decodeSocketMessage(event: unknown): string {
  const data = socketMessageData(event);
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  throw new MalformedRealtimeEventError();
}

function parseServerEvent(event: unknown): RealtimeServerEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSocketMessage(event));
  } catch (error) {
    if (error instanceof MalformedRealtimeEventError) throw error;
    throw new MalformedRealtimeEventError();
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || !parsed.type) {
    throw new MalformedRealtimeEventError();
  }
  if (isAudioEventType(parsed.type)) {
    throw new MalformedRealtimeEventError();
  }
  return parsed as RealtimeServerEvent;
}

function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(
    voiceRuntimePolicy.realtime.reconnectBaseDelayMs
      * (2 ** (attempt - 1)),
    voiceRuntimePolicy.realtime.reconnectMaxDelayMs,
  );
}

function defaultWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new RealtimeTransportAbortedError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new RealtimeTransportAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Trusted-server transport for text/image Realtime control events.
 *
 * It owns authentication and `session.update`, intentionally has no audio
 * methods, and never receives a phone executor.
 */
export class RealtimeWebSocketTransport implements RealtimeEventTransport {
  readonly correlation: CorrelationContextV1 & {
    realtimeSessionId: LocalIdentifier<'realtime'>;
    taskId: LocalIdentifier<'task'>;
  };

  private readonly authHeaders: Readonly<Record<string, string>>;
  private readonly baseUrl: string;
  private readonly controller = new AbortController();
  private readonly createSocket: RealtimeSocketFactory;
  private readonly errorSubscribers = new Set<ErrorSubscriber>();
  private readonly eventSubscribers = new Set<EventSubscriber>();
  private readonly maxReconnectAttempts: number;
  private readonly now: () => number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly wait: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private connectionAttempt = 0;
  private connectionGeneration = 0;
  private currentListeners: ConnectionListeners | undefined;
  private initialConnectTask: Promise<void> | undefined;
  private reconnectTask: Promise<void> | undefined;
  private sequence = 0;
  private sessionConfig: Record<string, unknown> | undefined;
  private socket: RealtimeWebSocketLike | undefined;
  private stateValue: RealtimeTransportState = 'idle';
  private terminalError: Error | undefined;
  private sendTail: Promise<void> = Promise.resolve();

  constructor(options: RealtimeTransportOptions) {
    this.authHeaders = createHeaders(options.auth);
    this.baseUrl = options.baseUrl ?? DEFAULT_REALTIME_URL;
    const correlation = createCorrelationContext(options.correlation);
    if (!correlation.taskId || !correlation.realtimeSessionId) {
      throw new RealtimeTransportError(
        'Realtime transport requires task and session correlation.',
      );
    }
    this.correlation = Object.freeze({
      ...correlation,
      taskId: correlation.taskId,
      realtimeSessionId: correlation.realtimeSessionId,
    });
    this.createSocket = options.createSocket;
    this.maxReconnectAttempts = finiteNonNegativeInteger(
      options.maxReconnectAttempts,
      'maxReconnectAttempts',
      voiceRuntimePolicy.realtime.reconnectAttempts,
    );
    this.now = options.now ?? Date.now;
    this.reconnectDelayMs = options.reconnectDelayMs
      ?? defaultReconnectDelayMs;
    this.wait = options.wait ?? defaultWait;

    if (options.signal) {
      if (options.signal.aborted) {
        this.abort();
      } else {
        options.signal.addEventListener('abort', () => this.abort(), {
          once: true,
          signal: this.controller.signal,
        });
      }
    }
  }

  get state(): RealtimeTransportState {
    return this.stateValue;
  }

  get reconnecting(): Promise<void> | undefined {
    return this.reconnectTask;
  }

  subscribe(listener: EventSubscriber): () => void {
    this.eventSubscribers.add(listener);
    return () => this.eventSubscribers.delete(listener);
  }

  subscribeErrors(listener: ErrorSubscriber): () => void {
    this.errorSubscribers.add(listener);
    return () => this.errorSubscribers.delete(listener);
  }

  async connect(config: Record<string, unknown>): Promise<void> {
    if (this.stateValue === 'closed') throw new RealtimeTransportClosedError();
    if (
      this.stateValue !== 'idle'
      && this.stateValue !== 'failed'
    ) {
      throw new RealtimeTransportError(
        `Cannot connect Realtime transport from ${this.stateValue}.`,
      );
    }

    this.sessionConfig = createTextOnlySession(config);
    this.terminalError = undefined;
    this.stateValue = 'connecting';
    const task = this.openConnection(0);
    this.initialConnectTask = task;
    try {
      await task;
    } catch (error) {
      const normalized = this.normalizeConnectionError(error);
      this.terminalError = normalized;
      if (this.state !== 'closed') this.stateValue = 'failed';
      throw normalized;
    } finally {
      if (this.initialConnectTask === task) this.initialConnectTask = undefined;
    }
  }

  send(event: RealtimeClientEvent): Promise<void> {
    let sanitized: RealtimeClientEvent;
    try {
      sanitized = cloneTextOnlyClientEvent(event);
    } catch (error) {
      return Promise.reject(error);
    }

    const sent = this.sendTail.then(async () => {
      await this.waitUntilReady();
      const socket = this.socket;
      if (!socket || socket.readyState !== SOCKET_OPEN) {
        throw new RealtimeTransportError(
          'Realtime WebSocket is not ready.',
        );
      }
      await socket.send(JSON.stringify(sanitized));
    });
    this.sendTail = sent.catch(() => undefined);
    return sent;
  }

  cancelResponse(): Promise<void> {
    return this.send({ type: 'response.cancel' });
  }

  abort(): void {
    if (this.stateValue === 'closed') return;
    const socket = this.socket;
    this.terminalError = new RealtimeTransportAbortedError();
    this.stateValue = 'closed';
    this.controller.abort(this.terminalError);
    this.detachCurrentSocket();
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, 'transport aborted');
      } catch {
        // Best-effort cleanup only.
      }
    }
    this.eventSubscribers.clear();
    this.errorSubscribers.clear();
  }

  async close(): Promise<void> {
    if (this.stateValue === 'closed') return;
    this.abort();
    await this.sendTail;
  }

  private async openConnection(attempt: number): Promise<void> {
    if (this.controller.signal.aborted) {
      throw this.terminalError ?? new RealtimeTransportAbortedError();
    }
    const session = this.sessionConfig;
    if (!session) {
      throw new RealtimeTransportError(
        'Realtime session configuration is unavailable.',
      );
    }

    const model = nonEmptyString(session.model, 'Realtime model');
    const generation = ++this.connectionGeneration;
    this.connectionAttempt = attempt;
    const socket = await this.createSocket({
      headers: this.authHeaders,
      signal: this.controller.signal,
      url: createRealtimeUrl(this.baseUrl, model),
    });
    if (this.controller.signal.aborted) {
      try {
        socket.close(1000, 'transport aborted');
      } catch {
        // Best-effort cleanup only.
      }
      throw this.terminalError ?? new RealtimeTransportAbortedError();
    }
    this.detachCurrentSocket();
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let connectionReady = false;
      let settled = false;

      const rejectConnection = (error: Error) => {
        if (settled) return;
        settled = true;
        this.detachSocket(socket, listeners);
        if (this.socket === socket) this.socket = undefined;
        if (socket.readyState !== 3) {
          try {
            socket.close(1000, 'connection stopped');
          } catch {
            // Best-effort cleanup only.
          }
        }
        reject(error);
      };

      const listeners: ConnectionListeners = {
        abort: () => {
          rejectConnection(
            this.terminalError ?? new RealtimeTransportAbortedError(),
          );
        },
        close: (event) => {
          if (generation !== this.connectionGeneration) return;
          const code = closeCode(event);
          const error = code !== undefined
            && AUTHENTICATION_CLOSE_CODES.has(code)
            ? new RealtimeAuthenticationError()
            : new RealtimeTransportError(
              'Realtime WebSocket connection closed unexpectedly.',
            );
          this.detachSocket(socket, listeners);
          if (this.socket === socket) this.socket = undefined;
          if (!connectionReady) {
            rejectConnection(error);
            return;
          }
          if (
            this.stateValue !== 'closed'
            && !this.controller.signal.aborted
          ) {
            this.startReconnect(error);
          }
        },
        error: () => {
          const error = new RealtimeTransportError(
            'Realtime WebSocket connection failed.',
          );
          if (!connectionReady) {
            rejectConnection(error);
          } else {
            this.notifyError(error);
          }
        },
        message: (event) => {
          if (generation !== this.connectionGeneration) return;
          this.receiveSocketEvent(event);
        },
        open: () => {
          if (settled || generation !== this.connectionGeneration) return;
          void Promise.resolve(socket.send(JSON.stringify({
            type: 'session.update',
            session,
          }))).then(() => {
            if (
              settled
              || generation !== this.connectionGeneration
              || socket.readyState !== SOCKET_OPEN
            ) {
              return;
            }
            connectionReady = true;
            settled = true;
            this.currentListeners = listeners;
            this.stateValue = 'ready';
            resolve();
          }, (error: unknown) => {
            rejectConnection(this.normalizeConnectionError(error));
          });
        },
      };

      socket.addEventListener('close', listeners.close);
      socket.addEventListener('error', listeners.error);
      socket.addEventListener('message', listeners.message);
      socket.addEventListener('open', listeners.open);
      this.controller.signal.addEventListener('abort', listeners.abort, {
        once: true,
      });
      this.currentListeners = listeners;
      if (this.controller.signal.aborted) {
        listeners.abort();
      } else if (socket.readyState === SOCKET_OPEN) {
        listeners.open({});
      } else if (socket.readyState === 3) {
        rejectConnection(new RealtimeTransportError(
          'Realtime WebSocket connection closed unexpectedly.',
        ));
      }
    });
  }

  private startReconnect(cause: Error): void {
    if (this.reconnectTask || this.stateValue === 'closed') return;
    this.stateValue = 'reconnecting';
    const task = this.runReconnect(cause);
    this.reconnectTask = task;
    void task.then(
      () => {
        if (this.reconnectTask === task) this.reconnectTask = undefined;
      },
      (error: unknown) => {
        if (this.reconnectTask === task) this.reconnectTask = undefined;
        const normalized = this.normalizeConnectionError(error);
        this.terminalError = normalized;
        if (this.stateValue !== 'closed') this.stateValue = 'failed';
        this.notifyError(normalized);
      },
    );
  }

  private async runReconnect(initialCause: Error): Promise<void> {
    let lastError = initialCause;
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt += 1) {
      const delay = this.reconnectDelayMs(attempt);
      if (!Number.isFinite(delay) || delay < 0) {
        throw new RealtimeTransportError(
          'Reconnect delay must be a non-negative finite number.',
        );
      }
      await this.wait(delay, this.controller.signal);
      try {
        await this.openConnection(attempt);
        return;
      } catch (error) {
        lastError = this.normalizeConnectionError(error);
        if (lastError instanceof RealtimeAuthenticationError) throw lastError;
        if (this.controller.signal.aborted) {
          throw this.terminalError ?? new RealtimeTransportAbortedError();
        }
      }
    }
    throw lastError;
  }

  private async waitUntilReady(): Promise<void> {
    if (this.stateValue === 'ready') return;
    if (this.stateValue === 'connecting' && this.initialConnectTask) {
      await this.initialConnectTask;
    } else if (this.stateValue === 'reconnecting' && this.reconnectTask) {
      await this.reconnectTask;
    }
    const stateAfterWait: RealtimeTransportState = this.state;
    if (stateAfterWait !== 'ready') {
      throw this.terminalError ?? (
        stateAfterWait === 'closed'
          ? new RealtimeTransportClosedError()
          : new RealtimeTransportError('Realtime WebSocket is not ready.')
      );
    }
  }

  private receiveSocketEvent(rawEvent: unknown): void {
    let event: RealtimeServerEvent;
    try {
      event = parseServerEvent(rawEvent);
    } catch (error) {
      this.notifyError(
        error instanceof Error ? error : new MalformedRealtimeEventError(),
      );
      return;
    }

    const metadata: RealtimeTransportEventMetadata = Object.freeze({
      ...correlationFields(this.correlation),
      connectionAttempt: this.connectionAttempt,
      receivedAtMs: this.now(),
      sequence: ++this.sequence,
    });
    for (const subscriber of this.eventSubscribers) {
      try {
        subscriber(event, metadata);
      } catch {
        this.notifyError(
          new RealtimeTransportError(
            'Realtime event subscriber failed.',
          ),
        );
      }
    }
  }

  private notifyError(error: Error): void {
    const metadata: RealtimeTransportErrorMetadata = Object.freeze({
      ...correlationFields(this.correlation),
      connectionAttempt: this.connectionAttempt,
    });
    for (const subscriber of this.errorSubscribers) {
      try {
        subscriber(error, metadata);
      } catch {
        // Diagnostics subscribers cannot affect the transport lifecycle.
      }
    }
  }

  private detachCurrentSocket(): void {
    const socket = this.socket;
    const listeners = this.currentListeners;
    if (socket && listeners) this.detachSocket(socket, listeners);
    this.currentListeners = undefined;
    this.socket = undefined;
  }

  private detachSocket(
    socket: RealtimeWebSocketLike,
    listeners: ConnectionListeners,
  ): void {
    socket.removeEventListener('close', listeners.close);
    socket.removeEventListener('error', listeners.error);
    socket.removeEventListener('message', listeners.message);
    socket.removeEventListener('open', listeners.open);
    this.controller.signal.removeEventListener('abort', listeners.abort);
    if (this.currentListeners === listeners) {
      this.currentListeners = undefined;
    }
  }

  private normalizeConnectionError(error: unknown): Error {
    if (error instanceof RealtimeTransportError) return error;
    return new RealtimeTransportError(
      'Realtime WebSocket connection failed.',
    );
  }
}
