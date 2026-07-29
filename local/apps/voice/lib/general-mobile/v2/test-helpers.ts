import { capabilityCatalogV2 } from '../../policy/v2/capability-catalog';
import type {
  PhoneActionEffectV2,
  PhoneCapabilityV2,
} from '../../policy/v2/types';
import { GeneralMobileAdapterRegistryV2 } from './adapter-registry';
import type {
  GeneralMobileActionV2,
  GeneralMobileObservationV2,
} from './contracts';
import {
  createInstrumentedActionV2,
  InstrumentedFakeGeneralMobileAdapterV2,
} from './fake-adapter';
import { ReadOnlyGeneralMobileCompanionV2 } from './read-only-companion';

export const fakePackageName = 'test.instrumented.app';

export function testSystem() {
  let observationSequence = 0;
  const adapter = new InstrumentedFakeGeneralMobileAdapterV2();
  const registry = new GeneralMobileAdapterRegistryV2();
  registry.register(adapter);
  const companion = new ReadOnlyGeneralMobileCompanionV2(registry, {
    idFactory: () => `observation:test-${++observationSequence}`,
    maxTtlMs: 30_000,
  });
  return { adapter, companion, registry };
}

export function actionFor(input: {
  capability: PhoneCapabilityV2;
  actionId: string;
  observation?: GeneralMobileObservationV2;
  targetRef?: string;
  effect?: PhoneActionEffectV2;
  packageName?: string;
  payload?: unknown;
  idempotencyKey?: string;
}): GeneralMobileActionV2 {
  return createInstrumentedActionV2({
    actionId: input.actionId,
    adapterId: 'instrumented-fake',
    packageName: input.packageName ?? fakePackageName,
    capability: input.capability,
    effect: input.effect ?? capabilityCatalogV2[input.capability].effect,
    ...(input.observation
      ? { sourceObservationId: input.observation.observationId }
      : {}),
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    input: input.payload ?? {},
    expectedPostcondition: { kind: `${input.capability}_verified` },
    ...(input.idempotencyKey
      ? { idempotencyKey: input.idempotencyKey }
      : {}),
  });
}

export async function observeSafe(
  companion: ReadOnlyGeneralMobileCompanionV2,
  focus?: string,
) {
  const result = await companion.observe({
    adapterId: 'instrumented-fake',
    clientId: 'test-client',
    operationId: `observe:${focus ?? 'screen'}`,
    packageName: fakePackageName,
    ...(focus ? { focus } : {}),
  });
  if (result.status !== 'ready') {
    throw new Error('Expected a safe fake observation.');
  }
  return result;
}
