type ResponseHistoryResetReason =
  | 'inactive'
  | 'max_response_chain'
  | 'max_turns'
  | 'start_over';

type ResponseHistoryTurn = {
  previousResponseId?: string;
  resetReason?: ResponseHistoryResetReason;
  responseCount: number;
  turnCount: number;
};

type ResponseHistorySnapshot = {
  activeTurnId?: string;
  latestResponseId?: string;
  responseCount: number;
  turnCount: number;
  updatedAt: number;
};

type BoundedResponseHistoryOptions = {
  inactiveTtlMs?: number;
  maxResponseChainLength?: number;
  maxTurns?: number;
  now?: () => number;
};

type StoredResponseHistory = ResponseHistorySnapshot;

const DEFAULT_INACTIVE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_RESPONSE_CHAIN_LENGTH = 12;
const DEFAULT_MAX_TURNS = 8;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SAFE_RESPONSE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,180}$/;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return resolved;
}

function safeKey(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_KEY.test(normalized)) {
    throw new Error(`${field} must be a sanitized opaque identifier.`);
  }
  return normalized;
}

function safeResponseId(value: string): string {
  const normalized = value.trim();
  if (!SAFE_RESPONSE_ID.test(normalized)) {
    throw new Error('responseId must be an opaque OpenAI response identifier.');
  }
  return normalized;
}

/**
 * Stores only response-chain metadata. Shopping items, clarifications,
 * selections, checkout terms, and every other authoritative task field live
 * in the task repository and are never truncated with prose history.
 */
export class BoundedResponseHistoryStore {
  readonly #histories = new Map<string, StoredResponseHistory>();
  readonly #inactiveTtlMs: number;
  readonly #maxResponseChainLength: number;
  readonly #maxTurns: number;
  readonly #now: () => number;

  constructor(options: BoundedResponseHistoryOptions = {}) {
    this.#inactiveTtlMs = positiveInteger(
      options.inactiveTtlMs,
      DEFAULT_INACTIVE_TTL_MS,
      'inactiveTtlMs',
    );
    this.#maxResponseChainLength = positiveInteger(
      options.maxResponseChainLength,
      DEFAULT_MAX_RESPONSE_CHAIN_LENGTH,
      'maxResponseChainLength',
    );
    this.#maxTurns = positiveInteger(
      options.maxTurns,
      DEFAULT_MAX_TURNS,
      'maxTurns',
    );
    this.#now = options.now ?? Date.now;
  }

  beginTurn(input: {
    clientId: string;
    expectedResponses?: number;
    startOver?: boolean;
    turnId: string;
  }): ResponseHistoryTurn {
    const clientId = safeKey(input.clientId, 'clientId');
    const turnId = safeKey(input.turnId, 'turnId');
    const expectedResponses = positiveInteger(
      input.expectedResponses,
      1,
      'expectedResponses',
    );
    const now = this.#now();
    const current = this.#histories.get(clientId);
    let resetReason: ResponseHistoryResetReason | undefined;
    if (input.startOver) {
      resetReason = 'start_over';
    } else if (current && now - current.updatedAt >= this.#inactiveTtlMs) {
      resetReason = 'inactive';
    } else if (current && current.turnCount >= this.#maxTurns) {
      resetReason = 'max_turns';
    } else if (
      current
      && current.responseCount + expectedResponses
        > this.#maxResponseChainLength
    ) {
      resetReason = 'max_response_chain';
    }

    const retained = resetReason ? undefined : current;
    const next: StoredResponseHistory = {
      activeTurnId: turnId,
      ...(retained?.latestResponseId
        ? { latestResponseId: retained.latestResponseId }
        : {}),
      responseCount: retained?.responseCount ?? 0,
      turnCount: (retained?.turnCount ?? 0) + 1,
      updatedAt: now,
    };
    this.#histories.set(clientId, next);
    return {
      ...(next.latestResponseId
        ? { previousResponseId: next.latestResponseId }
        : {}),
      ...(resetReason ? { resetReason } : {}),
      responseCount: next.responseCount,
      turnCount: next.turnCount,
    };
  }

  completeTurn(input: {
    clientId: string;
    responseCount: number;
    responseId: string;
    turnId: string;
  }): boolean {
    const clientId = safeKey(input.clientId, 'clientId');
    const turnId = safeKey(input.turnId, 'turnId');
    const responseId = safeResponseId(input.responseId);
    const responseCount = positiveInteger(
      input.responseCount,
      1,
      'responseCount',
    );
    const current = this.#histories.get(clientId);
    if (!current || current.activeTurnId !== turnId) return false;
    if (
      current.responseCount + responseCount
      > this.#maxResponseChainLength
    ) {
      throw new Error('Completed response chain exceeds its configured bound.');
    }
    this.#histories.set(clientId, {
      ...current,
      latestResponseId: responseId,
      responseCount: current.responseCount + responseCount,
      updatedAt: this.#now(),
    });
    return true;
  }

  startOver(clientId: string): boolean {
    return this.#histories.delete(safeKey(clientId, 'clientId'));
  }

  cleanup(): number {
    const now = this.#now();
    let removed = 0;
    for (const [clientId, history] of this.#histories) {
      if (now - history.updatedAt < this.#inactiveTtlMs) continue;
      this.#histories.delete(clientId);
      removed += 1;
    }
    return removed;
  }

  snapshot(clientId: string): ResponseHistorySnapshot | undefined {
    const history = this.#histories.get(safeKey(clientId, 'clientId'));
    return history ? { ...history } : undefined;
  }

  get size(): number {
    return this.#histories.size;
  }
}

export function isStartOverRequest(transcript: string): boolean {
  return /^(?:please\s+)?(?:start over|start again|new conversation|reset conversation)(?:\s+please)?[.!]?$/i
    .test(transcript.trim());
}
