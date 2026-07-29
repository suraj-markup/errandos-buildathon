import { describe, expect, it } from 'vitest';
import { GeneralMobileAdapterRegistryV2 } from './adapter-registry';
import { InstrumentedFakeGeneralMobileAdapterV2 } from './fake-adapter';
import {
  actionFor,
  fakePackageName,
  observeSafe,
  testSystem,
} from './test-helpers';

describe('general-mobile V2 adapter registration and scope', () => {
  it('rejects duplicate adapter registration', () => {
    const registry = new GeneralMobileAdapterRegistryV2();
    registry.register(new InstrumentedFakeGeneralMobileAdapterV2());
    expect(() => registry.register(
      new InstrumentedFakeGeneralMobileAdapterV2(),
    )).toThrow('already registered');
  });

  it('blocks execution outside the adapter package before calling it', async () => {
    const { adapter, registry } = testSystem();
    const result = await registry.execute({
      action: actionFor({
        actionId: 'action:outside-package',
        capability: 'back',
        packageName: 'other.example.app',
      }),
      currentTaskRevision: 1,
    });

    expect(result).toEqual({
      status: 'blocked',
      reason: 'package_scope_mismatch',
    });
    expect(adapter.actionLog).toHaveLength(0);
  });

  it('enforces declared capability and effect scope', async () => {
    const { adapter, registry } = testSystem();
    const capabilityResult = await registry.execute({
      action: actionFor({
        actionId: 'action:unsupported-submit',
        capability: 'submit',
        effect: 'external_side_effect',
        idempotencyKey: 'operation:submit',
      }),
      currentTaskRevision: 1,
    });
    expect(capabilityResult).toEqual({
      status: 'blocked',
      reason: 'capability_scope_mismatch',
    });

    const effectResult = await registry.execute({
      action: actionFor({
        actionId: 'action:wrong-effect',
        capability: 'back',
        effect: 'local_edit',
      }),
      currentTaskRevision: 1,
    });
    expect(effectResult).toEqual({
      status: 'blocked',
      reason: 'effect_mismatch',
    });
    expect(adapter.actionLog).toHaveLength(0);
  });

  it('rejects raw coordinates and stale semantic references', async () => {
    const { adapter, companion, registry } = testSystem();
    const raw = await registry.execute({
      action: actionFor({
        actionId: 'action:raw-coordinate',
        capability: 'back',
        payload: { x: 10, y: 20 },
      }),
      currentTaskRevision: 1,
    });
    expect(raw).toEqual({
      status: 'blocked',
      reason: 'raw_coordinates_forbidden',
    });

    const observed = await observeSafe(companion, 'Open editor');
    const stale = await registry.execute({
      action: actionFor({
        actionId: 'action:foreign-target',
        capability: 'activate',
        observation: observed.observation,
        targetRef: 'element:does-not-exist',
      }),
      observation: observed.observation,
      currentTaskRevision: 1,
    });
    expect(stale).toEqual({
      status: 'blocked',
      reason: 'observation_stale',
    });
    expect(adapter.actionLog).toHaveLength(0);
  });

  it('blocks non-read-only actions on sensitive observations', async () => {
    const { adapter, companion, registry } = testSystem();
    adapter.forceSensitiveScreen();
    const result = await companion.observe({
      adapterId: adapter.descriptor.adapterId,
      clientId: 'test-client',
      operationId: 'observe:sensitive',
      packageName: fakePackageName,
    });
    expect(result.status).toBe('blocked_sensitive');
    if (result.status !== 'blocked_sensitive') {
      throw new Error('Expected a restricted observation.');
    }

    const execution = await registry.execute({
      action: actionFor({
        actionId: 'action:back-sensitive',
        capability: 'back',
      }),
      observation: result.observation,
      currentTaskRevision: 1,
    });
    expect(execution).toEqual({
      status: 'blocked',
      reason: 'observation_restricted',
    });
    expect(adapter.actionLog).toHaveLength(0);
  });
});
