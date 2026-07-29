import { evaluatePhoneActionPolicyV2 } from '../../policy/v2/policy-engine';
import { phoneActionEffectsV2 } from '../../policy/v2/types';
import {
  assertGeneralMobileIdentifierV2,
  assertPackageNameV2,
  toObservationPolicyStateV2,
  validateGeneralMobileActionV2,
  type GeneralMobileAdapterDescriptorV2,
  type GeneralMobileAdapterV2,
  type GeneralMobileExecutionRequestV2,
  type GeneralMobileExecutionResultV2,
} from './contracts';

function validateDescriptor(
  value: GeneralMobileAdapterDescriptorV2,
): GeneralMobileAdapterDescriptorV2 {
  const descriptor = structuredClone(value);
  if (descriptor.version !== 2) throw new Error('Unsupported adapter version.');
  assertGeneralMobileIdentifierV2(descriptor.adapterId, 'adapter identifier');
  if (!descriptor.displayName.trim() || descriptor.displayName.length > 120) {
    throw new Error('Invalid adapter display name.');
  }
  if (
    descriptor.packages.length === 0
    || new Set(descriptor.packages).size !== descriptor.packages.length
  ) {
    throw new Error('Adapter requires unique package scope.');
  }
  descriptor.packages.forEach((packageName) =>
    assertPackageNameV2(packageName, 'adapter package'));
  if (
    descriptor.capabilities.length === 0
    || new Set(descriptor.capabilities.map((entry) => entry.capability)).size
      !== descriptor.capabilities.length
  ) {
    throw new Error('Adapter requires unique capabilities.');
  }
  for (const capability of descriptor.capabilities) {
    if (
      !phoneActionEffectsV2.includes(capability.effect)
      || typeof capability.requiresConfirmation !== 'boolean'
      || typeof capability.requiresFreshObservation !== 'boolean'
    ) {
      throw new Error('Invalid adapter capability descriptor.');
    }
  }
  return descriptor;
}

export class GeneralMobileAdapterRegistryV2 {
  readonly #adapters = new Map<string, GeneralMobileAdapterV2>();
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  register(adapter: GeneralMobileAdapterV2): void {
    const descriptor = validateDescriptor(adapter.descriptor);
    if (this.#adapters.has(descriptor.adapterId)) {
      throw new Error(`Adapter ${descriptor.adapterId} is already registered.`);
    }
    this.#adapters.set(descriptor.adapterId, adapter);
  }

  unregister(adapterId: string): GeneralMobileAdapterDescriptorV2 | undefined {
    assertGeneralMobileIdentifierV2(adapterId, 'adapter identifier');
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) return undefined;
    this.#adapters.delete(adapterId);
    return structuredClone(adapter.descriptor);
  }

  adapter(
    adapterId: string,
    packageName?: string,
  ): GeneralMobileAdapterV2 | undefined {
    const adapter = this.#adapters.get(adapterId);
    if (
      adapter
      && (
        packageName === undefined
        || adapter.descriptor.packages.includes(packageName)
      )
    ) {
      return adapter;
    }
    return undefined;
  }

  descriptors(): GeneralMobileAdapterDescriptorV2[] {
    return [...this.#adapters.values()].map((adapter) =>
      structuredClone(adapter.descriptor));
  }

  async execute(
    requestValue: GeneralMobileExecutionRequestV2,
  ): Promise<GeneralMobileExecutionResultV2> {
    let action;
    try {
      action = validateGeneralMobileActionV2(requestValue.action);
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes('Raw coordinates')
      ) {
        return { status: 'blocked', reason: 'raw_coordinates_forbidden' };
      }
      throw error;
    }
    const adapter = this.#adapters.get(action.adapterId);
    if (!adapter) return { status: 'blocked', reason: 'adapter_not_registered' };
    if (!adapter.descriptor.packages.includes(action.packageName)) {
      return { status: 'blocked', reason: 'package_scope_mismatch' };
    }
    if (
      requestValue.observation
      && requestValue.observation.packageName !== action.packageName
    ) {
      return { status: 'blocked', reason: 'observation_package_mismatch' };
    }
    if (
      requestValue.observation?.restricted
      && !['ask_user', 'cancel_task', 'observe'].includes(action.capability)
    ) {
      return { status: 'blocked', reason: 'observation_restricted' };
    }
    if (action.targetRef) {
      if (!requestValue.observation || !action.sourceObservationId) {
        return { status: 'blocked', reason: 'observation_missing' };
      }
      if (
        requestValue.observation.observationId !== action.sourceObservationId
        || requestValue.observation.expiresAt <= this.#now()
        || !requestValue.observation.elements.some((element) =>
          element.observationId === action.sourceObservationId
          && element.elementRef === action.targetRef)
      ) {
        return { status: 'blocked', reason: 'observation_stale' };
      }
    }
    const capability = adapter.descriptor.capabilities.find(
      (candidate) => candidate.capability === action.capability,
    );
    if (!capability) {
      return { status: 'blocked', reason: 'capability_scope_mismatch' };
    }
    if (capability.effect !== action.effect) {
      return { status: 'blocked', reason: 'effect_mismatch' };
    }
    const policy = evaluatePhoneActionPolicyV2({
      action: {
        actionDigest: action.actionDigest,
        adapterId: action.adapterId,
        capability: action.capability,
        ...(action.idempotencyKey
          ? { idempotencyKey: action.idempotencyKey }
          : {}),
        ...(action.sourceObservationId
          ? { sourceObservationId: action.sourceObservationId }
          : {}),
      },
      availableCapabilities: adapter.descriptor.capabilities,
      ...(requestValue.confirmationGrant
        ? { confirmationGrant: requestValue.confirmationGrant }
        : {}),
      currentTaskRevision: requestValue.currentTaskRevision,
      ...(requestValue.observation
        ? { observation: toObservationPolicyStateV2(requestValue.observation) }
        : {}),
      ...(requestValue.unresolvedMutation
        ? { unresolvedMutation: requestValue.unresolvedMutation }
        : {}),
    });
    if (policy.decision !== 'allow') {
      return {
        status: 'blocked',
        reason: policy.reason,
        ...('operationId' in policy ? { operationId: policy.operationId } : {}),
      };
    }
    return adapter.execute(action, {
      ...(requestValue.observation
        ? { observation: structuredClone(requestValue.observation) }
        : {}),
      isCancelled: requestValue.isCancelled ?? (() => false),
    });
  }
}
