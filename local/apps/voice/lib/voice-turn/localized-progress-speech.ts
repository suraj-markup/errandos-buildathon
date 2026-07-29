export type LocalizedProgressAudio = {
  audioBase64?: string;
  audioType?: string;
};

type LocalizedProgressCacheStatus =
  | 'deduplicated'
  | 'hit'
  | 'miss';

type LocalizedProgressSpeechMetadata = {
  cacheStatus: LocalizedProgressCacheStatus;
  requestLatencyMs: number;
  synthesisLatencyMs?: number;
};

export type LocalizedProgressSpeechResult =
  | {
      audio: LocalizedProgressAudio;
      metadata: LocalizedProgressSpeechMetadata;
      status: 'ready';
      synthesisId: string;
    }
  | {
      metadata: LocalizedProgressSpeechMetadata;
      status: 'pending';
      synthesisId: string;
    }
  | {
      metadata: LocalizedProgressSpeechMetadata;
      status: 'obsolete' | 'unavailable';
      synthesisId: string;
    };

type LocalizedProgressSpeechMetrics = {
  cacheEntries: number;
  cacheHits: number;
  cacheMisses: number;
  deduplicatedRequests: number;
  evictions: number;
  expirations: number;
  inFlightSyntheses: number;
  obsoleteDeliveries: number;
  synthesisCompleted: number;
  synthesisFailed: number;
  totalSynthesisLatencyMs: number;
};

type LocalizedProgressSpeechCacheOptions = {
  clock?: () => number;
  idFactory?: () => string;
  maxEntries?: number;
  maxRequests?: number;
  maxTextCharacters?: number;
  synthesize: (
    text: string,
    languageCode: string,
  ) => Promise<LocalizedProgressAudio>;
  ttlMs?: number;
};

type SharedSynthesis = {
  cacheKey: string;
  completedAt?: number;
  promise: Promise<void>;
  result?: LocalizedProgressAudio;
  startedAt: number;
  synthesisLatencyMs?: number;
  unavailable: boolean;
};

type RequestRecord = {
  cacheStatus: 'deduplicated' | 'miss';
  clientId: string;
  createdAt: number;
  generation?: string;
  job: SharedSynthesis;
  obsolete: boolean;
  synthesisId: string;
};

type CacheEntry = {
  audio: LocalizedProgressAudio;
  expiresAt: number;
  synthesisLatencyMs: number;
};

export class LocalizedProgressSpeechWaitAbortedError extends Error {
  readonly code = 'LOCALIZED_PROGRESS_SPEECH_WAIT_ABORTED';

  constructor() {
    super('Waiting for localized progress speech was aborted.');
    this.name = 'LocalizedProgressSpeechWaitAbortedError';
  }
}

function normalizedPhrase(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function copiedAudio(audio: LocalizedProgressAudio): LocalizedProgressAudio {
  return {
    ...(audio.audioBase64 ? { audioBase64: audio.audioBase64 } : {}),
    ...(audio.audioType ? { audioType: audio.audioType } : {}),
  };
}

/**
 * Process-local cache for deterministic, short progress phrases.
 *
 * `request` never waits for the speech provider. A cache hit is returned
 * synchronously; a miss starts synthesis and returns an opaque ID for status
 * lookup. Cancellation marks only this client's delivery obsolete. It never
 * aborts the shared provider request and deliberately has no phone-operation
 * dependency or controller.
 */
export class LocalizedProgressSpeechCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly clock: () => number;
  private readonly idFactory: () => string;
  private readonly inFlight = new Map<string, SharedSynthesis>();
  private readonly maxEntries: number;
  private readonly maxRequests: number;
  private readonly maxTextCharacters: number;
  private readonly requests = new Map<string, RequestRecord>();
  private readonly synthesize: (
    text: string,
    languageCode: string,
  ) => Promise<LocalizedProgressAudio>;
  private readonly ttlMs: number;
  private readonly totals = {
    cacheHits: 0,
    cacheMisses: 0,
    deduplicatedRequests: 0,
    evictions: 0,
    expirations: 0,
    obsoleteDeliveries: 0,
    synthesisCompleted: 0,
    synthesisFailed: 0,
    totalSynthesisLatencyMs: 0,
  };

  constructor(input: LocalizedProgressSpeechCacheOptions) {
    this.clock = input.clock ?? Date.now;
    this.idFactory =
      input.idFactory ?? (() => `progress-speech:${crypto.randomUUID()}`);
    this.maxEntries = input.maxEntries ?? 64;
    this.maxRequests = input.maxRequests ?? this.maxEntries * 4;
    this.maxTextCharacters = input.maxTextCharacters ?? 120;
    this.synthesize = input.synthesize;
    this.ttlMs = input.ttlMs ?? 5 * 60_000;

    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive integer.');
    }
    if (!Number.isInteger(this.maxRequests) || this.maxRequests < 1) {
      throw new RangeError('maxRequests must be a positive integer.');
    }
    if (
      !Number.isInteger(this.maxTextCharacters)
      || this.maxTextCharacters < 1
    ) {
      throw new RangeError('maxTextCharacters must be a positive integer.');
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('ttlMs must be positive.');
    }
  }

  request(input: {
    clientId: string;
    generation?: string;
    languageCode: string;
    text: string;
  }): LocalizedProgressSpeechResult {
    const startedAt = this.clock();
    const text = normalizedPhrase(input.text);
    const languageCode = input.languageCode.trim();
    this.validateRequest({
      clientId: input.clientId,
      languageCode,
      text,
    });
    this.pruneExpired(startedAt);

    const cacheKey = `${languageCode.toLocaleLowerCase()}\u0000${text}`;
    const synthesisId = this.idFactory();
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.totals.cacheHits += 1;
      this.touchCacheEntry(cacheKey, cached);
      return {
        audio: copiedAudio(cached.audio),
        metadata: {
          cacheStatus: 'hit',
          requestLatencyMs: Math.max(0, this.clock() - startedAt),
          synthesisLatencyMs: cached.synthesisLatencyMs,
        },
        status: 'ready',
        synthesisId,
      };
    }

    this.ensureRequestCapacity();
    let job = this.inFlight.get(cacheKey);
    const cacheStatus = job ? 'deduplicated' : 'miss';
    if (job) {
      this.totals.deduplicatedRequests += 1;
    } else {
      this.totals.cacheMisses += 1;
      job = this.startSynthesis({ cacheKey, languageCode, text });
    }

    this.requests.set(synthesisId, {
      cacheStatus,
      clientId: input.clientId,
      createdAt: startedAt,
      generation: input.generation,
      job,
      obsolete: false,
      synthesisId,
    });

    return {
      metadata: {
        cacheStatus,
        requestLatencyMs: Math.max(0, this.clock() - startedAt),
      },
      status: 'pending',
      synthesisId,
    };
  }

  status(synthesisId: string): LocalizedProgressSpeechResult | undefined {
    const request = this.requests.get(synthesisId);
    if (!request) return undefined;
    return this.resultForRequest(request);
  }

  statusForClient(
    synthesisId: string,
    clientId: string,
  ): LocalizedProgressSpeechResult | undefined {
    const request = this.requests.get(synthesisId);
    if (!request || request.clientId !== clientId) return undefined;
    return this.resultForRequest(request);
  }

  async waitFor(
    synthesisId: string,
    input: { signal?: AbortSignal } = {},
  ): Promise<LocalizedProgressSpeechResult | undefined> {
    const request = this.requests.get(synthesisId);
    if (!request) return undefined;
    if (request.obsolete || request.job.completedAt !== undefined) {
      return this.resultForRequest(request);
    }
    await waitWithoutCancellingSharedSynthesis(request.job.promise, input.signal);
    return this.resultForRequest(request);
  }

  cancelClient(clientId: string): number {
    let cancelled = 0;
    for (const request of this.requests.values()) {
      if (
        request.clientId === clientId
        && !request.obsolete
      ) {
        request.obsolete = true;
        cancelled += 1;
      }
    }
    this.totals.obsoleteDeliveries += cancelled;
    return cancelled;
  }

  markGenerationObsolete(input: {
    clientId: string;
    generation: string;
  }): number {
    let cancelled = 0;
    for (const request of this.requests.values()) {
      if (
        request.clientId === input.clientId
        && request.generation === input.generation
        && !request.obsolete
      ) {
        request.obsolete = true;
        cancelled += 1;
      }
    }
    this.totals.obsoleteDeliveries += cancelled;
    return cancelled;
  }

  metrics(): LocalizedProgressSpeechMetrics {
    this.pruneExpired(this.clock());
    return {
      cacheEntries: this.cache.size,
      cacheHits: this.totals.cacheHits,
      cacheMisses: this.totals.cacheMisses,
      deduplicatedRequests: this.totals.deduplicatedRequests,
      evictions: this.totals.evictions,
      expirations: this.totals.expirations,
      inFlightSyntheses: this.inFlight.size,
      obsoleteDeliveries: this.totals.obsoleteDeliveries,
      synthesisCompleted: this.totals.synthesisCompleted,
      synthesisFailed: this.totals.synthesisFailed,
      totalSynthesisLatencyMs: this.totals.totalSynthesisLatencyMs,
    };
  }

  private ensureRequestCapacity(): void {
    if (this.requests.size < this.maxRequests) return;
    for (const [synthesisId, request] of this.requests) {
      if (request.obsolete || request.job.completedAt !== undefined) {
        this.requests.delete(synthesisId);
        if (this.requests.size < this.maxRequests) return;
      }
    }
    throw new Error('Localized progress speech request capacity was reached.');
  }

  private pruneExpired(now: number): void {
    for (const [cacheKey, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(cacheKey);
        this.totals.expirations += 1;
      }
    }
  }

  private resultForRequest(
    request: RequestRecord,
  ): LocalizedProgressSpeechResult {
    const metadata: LocalizedProgressSpeechMetadata = {
      cacheStatus: request.cacheStatus,
      requestLatencyMs: Math.max(0, this.clock() - request.createdAt),
      ...(request.job.synthesisLatencyMs === undefined
        ? {}
        : { synthesisLatencyMs: request.job.synthesisLatencyMs }),
    };
    if (request.obsolete) {
      return {
        metadata,
        status: 'obsolete',
        synthesisId: request.synthesisId,
      };
    }
    if (request.job.completedAt === undefined) {
      return {
        metadata,
        status: 'pending',
        synthesisId: request.synthesisId,
      };
    }
    if (request.job.unavailable || !request.job.result) {
      return {
        metadata,
        status: 'unavailable',
        synthesisId: request.synthesisId,
      };
    }
    return {
      audio: copiedAudio(request.job.result),
      metadata,
      status: 'ready',
      synthesisId: request.synthesisId,
    };
  }

  private startSynthesis(input: {
    cacheKey: string;
    languageCode: string;
    text: string;
  }): SharedSynthesis {
    const job: SharedSynthesis = {
      cacheKey: input.cacheKey,
      promise: Promise.resolve(),
      startedAt: this.clock(),
      unavailable: false,
    };
    job.promise = Promise.resolve()
      .then(() => this.synthesize(input.text, input.languageCode))
      .then((audio) => {
        job.completedAt = this.clock();
        job.synthesisLatencyMs = Math.max(0, job.completedAt - job.startedAt);
        this.totals.totalSynthesisLatencyMs += job.synthesisLatencyMs;
        if (!audio.audioBase64) {
          job.unavailable = true;
          this.totals.synthesisFailed += 1;
          return;
        }
        job.result = copiedAudio(audio);
        this.totals.synthesisCompleted += 1;
        this.writeCache(input.cacheKey, {
          audio: job.result,
          expiresAt: job.completedAt + this.ttlMs,
          synthesisLatencyMs: job.synthesisLatencyMs,
        });
      })
      .catch(() => {
        job.completedAt = this.clock();
        job.synthesisLatencyMs = Math.max(0, job.completedAt - job.startedAt);
        job.unavailable = true;
        this.totals.synthesisFailed += 1;
        this.totals.totalSynthesisLatencyMs += job.synthesisLatencyMs;
      })
      .finally(() => {
        if (this.inFlight.get(input.cacheKey) === job) {
          this.inFlight.delete(input.cacheKey);
        }
      });
    this.inFlight.set(input.cacheKey, job);
    return job;
  }

  private touchCacheEntry(cacheKey: string, entry: CacheEntry): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
  }

  private validateRequest(input: {
    clientId: string;
    languageCode: string;
    text: string;
  }): void {
    if (!input.clientId.trim()) {
      throw new TypeError('clientId is required.');
    }
    if (!input.languageCode) {
      throw new TypeError('languageCode is required.');
    }
    if (!input.text) {
      throw new TypeError('text is required.');
    }
    if (input.text.length > this.maxTextCharacters) {
      throw new RangeError(
        `Localized progress speech is limited to ${this.maxTextCharacters} characters.`,
      );
    }
  }

  private writeCache(cacheKey: string, entry: CacheEntry): void {
    this.cache.delete(cacheKey);
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
      this.totals.evictions += 1;
    }
    this.cache.set(cacheKey, entry);
  }
}

const globalProgressSpeech = globalThis as typeof globalThis & {
  errandosLocalizedProgressSpeechCache?: LocalizedProgressSpeechCache;
};

/**
 * Creates the process-global cache on first use. Request and status routes can
 * import this module independently while sharing the same opaque synthesis IDs.
 */
export function getOrCreateLocalizedProgressSpeechCache(
  input: LocalizedProgressSpeechCacheOptions,
): LocalizedProgressSpeechCache {
  const existing = globalProgressSpeech.errandosLocalizedProgressSpeechCache;
  if (existing) return existing;
  const cache = new LocalizedProgressSpeechCache(input);
  globalProgressSpeech.errandosLocalizedProgressSpeechCache = cache;
  return cache;
}

export function getLocalizedProgressSpeechCache():
  LocalizedProgressSpeechCache | undefined {
  return globalProgressSpeech.errandosLocalizedProgressSpeechCache;
}

async function waitWithoutCancellingSharedSynthesis(
  promise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await promise;
    return;
  }
  if (signal.aborted) throw new LocalizedProgressSpeechWaitAbortedError();

  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      reject(new LocalizedProgressSpeechWaitAbortedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
