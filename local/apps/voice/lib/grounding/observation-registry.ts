import { randomUUID } from 'node:crypto';
import type { AndroidScreenOrientation } from '@errandos/provider-connectors';

export type LocalBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type ObservationMetadata = {
  capturedAt: number;
  contentRect: LocalBounds;
  fingerprint: string;
  orientation: AndroidScreenOrientation;
  packageName: string;
  viewport: LocalBounds;
};

export type LocalElementBinding = {
  bounds: LocalBounds;
  localNodeId: string;
};

export type SafeObservation = {
  candidateCount: number;
  capturedAt: number;
  expiresAt: number;
  fingerprint: string;
  observationId: string;
  orientation: AndroidScreenOrientation;
  packageName: string;
};

export type ObservationContext = {
  clientId: string;
  fingerprint: string;
  operationId: string;
  orientation: AndroidScreenOrientation;
  packageName: string;
};

type PrivateObservation = {
  bindings: Map<string, LocalElementBinding>;
  clientId: string;
  expiresAt: number;
  image: Uint8Array;
  metadata: ObservationMetadata;
  observationId: string;
  operationId: string;
};

type ObservationRegistryOptions = {
  idFactory?: () => string;
  maxTtlMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60_000;

function cloneBounds(bounds: LocalBounds): LocalBounds {
  return { ...bounds };
}

function sameContext(
  observation: PrivateObservation,
  context: ObservationContext,
): boolean {
  return observation.clientId === context.clientId
    && observation.operationId === context.operationId
    && observation.metadata.fingerprint === context.fingerprint
    && observation.metadata.orientation === context.orientation
    && observation.metadata.packageName === context.packageName;
}

export class EphemeralObservationRegistry {
  readonly #entries = new Map<string, PrivateObservation>();
  readonly #idFactory: () => string;
  readonly #maxTtlMs: number;
  readonly #now: () => number;

  public constructor(options: ObservationRegistryOptions = {}) {
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maxTtlMs = Math.min(
      Math.max(options.maxTtlMs ?? DEFAULT_TTL_MS, 1),
      MAX_TTL_MS,
    );
    this.#now = options.now ?? Date.now;
  }

  public register(input: {
    bindings: ReadonlyMap<string, LocalElementBinding>;
    clientId: string;
    image: Uint8Array;
    metadata: ObservationMetadata;
    operationId: string;
    ttlMs?: number;
  }): SafeObservation {
    this.cleanup();
    this.invalidateClient(input.clientId);
    const observationId = this.#idFactory();
    const expiresAt = this.#now() + Math.min(
      Math.max(input.ttlMs ?? this.#maxTtlMs, 1),
      this.#maxTtlMs,
    );
    const bindings = new Map(
      [...input.bindings].map(([reference, binding]) => [
        reference,
        {
          bounds: cloneBounds(binding.bounds),
          localNodeId: binding.localNodeId,
        },
      ]),
    );
    this.#entries.set(observationId, {
      bindings,
      clientId: input.clientId,
      expiresAt,
      image: new Uint8Array(input.image),
      metadata: {
        ...input.metadata,
        contentRect: cloneBounds(input.metadata.contentRect),
        viewport: cloneBounds(input.metadata.viewport),
      },
      observationId,
      operationId: input.operationId,
    });
    return this.safe(this.#entries.get(observationId)!);
  }

  public beginOperation(clientId: string, operationId: string): void {
    for (const [id, observation] of this.#entries) {
      if (
        observation.clientId === clientId
        && observation.operationId !== operationId
      ) {
        this.#entries.delete(id);
      }
    }
  }

  public get(
    observationId: string,
    context: ObservationContext,
  ): SafeObservation | undefined {
    const observation = this.validObservation(observationId, context);
    return observation ? this.safe(observation) : undefined;
  }

  public resolve(
    observationId: string,
    elementRef: string,
    context: ObservationContext,
  ): LocalElementBinding | undefined {
    const observation = this.validObservation(observationId, context);
    const binding = observation?.bindings.get(elementRef);
    return binding
      ? {
          bounds: cloneBounds(binding.bounds),
          localNodeId: binding.localNodeId,
        }
      : undefined;
  }

  public image(
    observationId: string,
    context: ObservationContext,
  ): Uint8Array | undefined {
    const observation = this.validObservation(observationId, context);
    return observation ? new Uint8Array(observation.image) : undefined;
  }

  public invalidateClient(clientId: string): void {
    for (const [id, observation] of this.#entries) {
      if (observation.clientId === clientId) this.#entries.delete(id);
    }
  }

  public cleanup(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, observation] of this.#entries) {
      if (observation.expiresAt <= now) {
        this.#entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  public size(): number {
    this.cleanup();
    return this.#entries.size;
  }

  private validObservation(
    observationId: string,
    context: ObservationContext,
  ): PrivateObservation | undefined {
    const observation = this.#entries.get(observationId);
    if (!observation) return undefined;
    if (observation.expiresAt <= this.#now()) {
      this.#entries.delete(observationId);
      return undefined;
    }
    if (observation.clientId !== context.clientId) return undefined;
    if (!sameContext(observation, context)) {
      this.#entries.delete(observationId);
      return undefined;
    }
    return observation;
  }

  private safe(observation: PrivateObservation): SafeObservation {
    return {
      candidateCount: observation.bindings.size,
      capturedAt: observation.metadata.capturedAt,
      expiresAt: observation.expiresAt,
      fingerprint: observation.metadata.fingerprint,
      observationId: observation.observationId,
      orientation: observation.metadata.orientation,
      packageName: observation.metadata.packageName,
    };
  }
}
