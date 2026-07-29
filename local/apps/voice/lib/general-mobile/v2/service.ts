import { enqueuePhoneOperation } from '../../operation-queue';
import { GeneralMobileAdapterRegistryV2 } from './adapter-registry';
import {
  assertGeneralMobileIdentifierV2,
  type GeneralMobileAdapterDescriptorV2,
  type GeneralMobileAdapterV2,
  type GeneralMobileExecutionRequestV2,
  type GeneralMobileExecutionResultV2,
} from './contracts';
import {
  AndroidSettingsReadOnlyAdapterV2,
  type ForegroundSourcePortV2,
} from './android-settings-read-only-adapter';
import {
  ReadOnlyGeneralMobileCompanionV2,
  type ReadOnlyCompanionResultV2,
} from './read-only-companion';

type GeneralMobileProductionServiceOptionsV2 = {
  adapters?: GeneralMobileAdapterV2[];
  idFactory?: () => string;
  maxObservationTtlMs?: number;
  now?: () => number;
  serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export type GeneralMobileAdapterControlEvidenceV2 = {
  action: 'disable' | 'enable' | 'rollback';
  actorId: string;
  adapterId: string;
  capabilities: string[];
  changedAt: number;
  enabledAfter: boolean;
  enabledBefore: boolean;
  mode: 'mixed' | 'read_only';
  outcome: 'changed' | 'unchanged';
  packages: string[];
  reason: string;
  sequence: number;
};

export type GeneralMobileRollbackEvidenceV2 =
  GeneralMobileAdapterControlEvidenceV2;

export type GeneralMobileAdapterControlStatusV2 = {
  adapterId: string;
  capabilities: string[];
  displayName: string;
  enabled: boolean;
  lastEvidence?: GeneralMobileAdapterControlEvidenceV2;
  mode: 'mixed' | 'read_only';
  packages: string[];
};

export class GeneralMobileProductionServiceV2 {
  readonly #adapters = new Map<string, GeneralMobileAdapterV2>();
  readonly #companion: ReadOnlyGeneralMobileCompanionV2;
  readonly #controlEvidence: GeneralMobileAdapterControlEvidenceV2[] = [];
  readonly #now: () => number;
  readonly #registry: GeneralMobileAdapterRegistryV2;
  readonly #serialize: <T>(operation: () => Promise<T>) => Promise<T>;

  constructor(options: GeneralMobileProductionServiceOptionsV2 = {}) {
    this.#now = options.now ?? Date.now;
    this.#serialize = options.serialize ?? enqueuePhoneOperation;
    this.#registry = new GeneralMobileAdapterRegistryV2({
      now: this.#now,
    });
    for (const adapter of options.adapters ?? []) {
      this.#registry.register(adapter);
      this.#adapters.set(adapter.descriptor.adapterId, adapter);
    }
    this.#companion = new ReadOnlyGeneralMobileCompanionV2(this.#registry, {
      idFactory: options.idFactory,
      maxTtlMs: options.maxObservationTtlMs,
      now: this.#now,
    });
  }

  descriptors(): GeneralMobileAdapterDescriptorV2[] {
    return this.#registry.descriptors();
  }

  observe(input: {
    adapterId: string;
    clientId: string;
    focus?: string;
    isCancelled?: () => boolean;
    operationId: string;
    packageName: string;
  }): Promise<ReadOnlyCompanionResultV2> {
    return this.#serialize(() => this.#companion.observe(input));
  }

  execute(
    request: GeneralMobileExecutionRequestV2,
  ): Promise<GeneralMobileExecutionResultV2> {
    return this.#serialize(() => this.#registry.execute(request));
  }

  rollbackAdapter(input: {
    adapterId: string;
    actorId?: string;
    reason: string;
  }): GeneralMobileAdapterControlEvidenceV2 | undefined {
    return this.controlAdapter({
      action: 'rollback',
      actorId: input.actorId ?? 'system',
      adapterId: input.adapterId,
      reason: input.reason,
    });
  }

  rollbackHistory(): GeneralMobileAdapterControlEvidenceV2[] {
    return this.controlHistory();
  }

  adapterStatus(
    adapterId: string,
  ): GeneralMobileAdapterControlStatusV2 | undefined {
    assertGeneralMobileIdentifierV2(adapterId, 'adapter identifier');
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) return undefined;
    const descriptor = adapter.descriptor;
    const lastEvidence = this.#controlEvidence.findLast(
      (entry) => entry.adapterId === adapterId,
    );
    return {
      adapterId,
      capabilities: descriptor.capabilities.map(
        (capability) => capability.capability,
      ),
      displayName: descriptor.displayName,
      enabled: Boolean(this.#registry.adapter(adapterId)),
      ...(lastEvidence
        ? { lastEvidence: structuredClone(lastEvidence) }
        : {}),
      mode: descriptor.capabilities.every(
        (capability) => capability.effect === 'read_only',
      )
        ? 'read_only'
        : 'mixed',
      packages: [...descriptor.packages],
    };
  }

  controlAdapter(input: {
    action: 'disable' | 'enable' | 'rollback';
    actorId: string;
    adapterId: string;
    reason: string;
  }): GeneralMobileAdapterControlEvidenceV2 | undefined {
    assertGeneralMobileIdentifierV2(input.adapterId, 'adapter identifier');
    assertGeneralMobileIdentifierV2(input.actorId, 'control actor identifier');
    const reason = input.reason.trim();
    if (!reason) throw new Error('Adapter control evidence requires a reason.');
    const adapter = this.#adapters.get(input.adapterId);
    if (!adapter) return undefined;
    const descriptor = adapter.descriptor;
    const enabledBefore = Boolean(this.#registry.adapter(input.adapterId));
    if (input.action === 'enable') {
      if (!enabledBefore) this.#registry.register(adapter);
    } else if (enabledBefore) {
      this.#registry.unregister(input.adapterId);
    }
    const enabledAfter = Boolean(this.#registry.adapter(input.adapterId));
    const evidence: GeneralMobileAdapterControlEvidenceV2 = {
      action: input.action,
      actorId: input.actorId,
      adapterId: descriptor.adapterId,
      capabilities: descriptor.capabilities.map(
        (capability) => capability.capability,
      ),
      changedAt: this.#now(),
      enabledAfter,
      enabledBefore,
      mode: descriptor.capabilities.every(
        (capability) => capability.effect === 'read_only',
      )
        ? 'read_only'
        : 'mixed',
      outcome: enabledAfter === enabledBefore ? 'unchanged' : 'changed',
      packages: [...descriptor.packages],
      reason: reason.slice(0, 160),
      sequence: this.#controlEvidence.length,
    };
    this.#controlEvidence.push(evidence);
    return structuredClone(evidence);
  }

  controlHistory(input: {
    adapterId?: string;
    limit?: number;
  } = {}): GeneralMobileAdapterControlEvidenceV2[] {
    if (input.adapterId) {
      assertGeneralMobileIdentifierV2(
        input.adapterId,
        'adapter identifier',
      );
    }
    const requestedLimit = input.limit ?? 50;
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('Adapter control history limit must be positive.');
    }
    const limit = Math.min(requestedLimit, 100);
    const entries = input.adapterId
      ? this.#controlEvidence.filter(
        (entry) => entry.adapterId === input.adapterId,
      )
      : this.#controlEvidence;
    return structuredClone(entries.slice(-limit));
  }
}

export function createGeneralMobileProductionServiceV2(options: {
  androidSettingsEnabled?: boolean;
  androidSettingsPort?: ForegroundSourcePortV2;
  idFactory?: () => string;
  maxObservationTtlMs?: number;
  now?: () => number;
  serialize?: <T>(operation: () => Promise<T>) => Promise<T>;
} = {}): GeneralMobileProductionServiceV2 {
  const adapters: GeneralMobileAdapterV2[] = [];
  if (options.androidSettingsEnabled !== false) {
    adapters.push(new AndroidSettingsReadOnlyAdapterV2({
      now: options.now,
      port: options.androidSettingsPort,
    }));
  }
  return new GeneralMobileProductionServiceV2({
    adapters,
    idFactory: options.idFactory,
    maxObservationTtlMs: options.maxObservationTtlMs,
    now: options.now,
    serialize: options.serialize,
  });
}

const serviceGlobal = globalThis as typeof globalThis & {
  errandosGeneralMobileProductionServiceV2?: GeneralMobileProductionServiceV2;
};

export function authoritativeGeneralMobileProductionServiceV2():
GeneralMobileProductionServiceV2 {
  serviceGlobal.errandosGeneralMobileProductionServiceV2 ??=
    createGeneralMobileProductionServiceV2();
  return serviceGlobal.errandosGeneralMobileProductionServiceV2;
}
