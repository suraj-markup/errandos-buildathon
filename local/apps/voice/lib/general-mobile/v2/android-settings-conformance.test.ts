import { describe, expect, it, vi } from 'vitest';
import {
  androidSettingsPackageV2,
  type ForegroundSourcePortV2,
} from './android-settings-read-only-adapter';
import { createInstrumentedActionV2 } from './fake-adapter';
import {
  createGeneralMobileProductionServiceV2,
  type GeneralMobileProductionServiceV2,
} from './service';

const adapterId = 'android-settings-read-only';
const safeSource =
  `<hierarchy><node package="${androidSettingsPackageV2}" class="android.widget.TextView" text="Network and internet" enabled="true" /></hierarchy>`;
const privateSource =
  `<hierarchy><node package="${androidSettingsPackageV2}" class="android.widget.EditText" text="Enter OTP verification code" editable="true" /></hierarchy>`;

function harness(input: {
  source?: string;
  ttlMs?: number;
} = {}) {
  let now = 1_000;
  const capture = vi.fn<ForegroundSourcePortV2['capture']>(async () => ({
    packageName: androidSettingsPackageV2,
    source: input.source ?? safeSource,
  }));
  const service = createGeneralMobileProductionServiceV2({
    androidSettingsPort: { capture },
    idFactory: () => 'observation:conformance',
    maxObservationTtlMs: input.ttlMs ?? 50,
    now: () => now,
    serialize: async (operation) => operation(),
  });
  return {
    capture,
    service,
    setNow(value: number) {
      now = value;
    },
  };
}

async function safeObservation(service: GeneralMobileProductionServiceV2) {
  const result = await service.observe({
    adapterId,
    clientId: 'client:conformance',
    focus: 'network',
    operationId: 'operation:conformance',
    packageName: androidSettingsPackageV2,
  });
  if (result.status !== 'ready') {
    throw new Error('Expected a safe conformance observation.');
  }
  return result;
}

function targetAction(input: {
  observationId: string;
  targetRef: string;
}) {
  return createInstrumentedActionV2({
    actionId: 'action:conformance-target',
    adapterId,
    packageName: androidSettingsPackageV2,
    capability: 'activate',
    effect: 'navigation',
    sourceObservationId: input.observationId,
    targetRef: input.targetRef,
    input: {},
    expectedPostcondition: { kind: 'navigation_verified' },
  });
}

describe('H094 Android Settings read-only adapter conformance', () => {
  it('H094-package-scope: refuses observation outside the exact package', async () => {
    const { capture, service } = harness();
    await expect(service.observe({
      adapterId,
      clientId: 'client:wrong-package',
      operationId: 'operation:wrong-package',
      packageName: 'com.android.systemui',
    })).rejects.toThrow('No adapter is registered');
    expect(capture).not.toHaveBeenCalled();
  });

  it('H094-privacy: redacts restricted source and semantic candidates', async () => {
    const { service } = harness({ source: privateSource });
    const result = await service.observe({
      adapterId,
      clientId: 'client:private',
      focus: 'verification',
      operationId: 'operation:private',
      packageName: androidSettingsPackageV2,
    });
    expect(result).toMatchObject({
      status: 'blocked_sensitive',
      observation: {
        elements: [],
        restricted: true,
        restrictedClasses: ['otp'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('verification code');
    expect(JSON.stringify(result)).not.toContain('<hierarchy');
  });

  it('H094-stale-reference: rejects an unknown observation-bound target', async () => {
    const { service } = harness();
    const observed = await safeObservation(service);
    const action = targetAction({
      observationId: observed.observation.observationId,
      targetRef: 'element:unknown-conformance-target',
    });
    await expect(service.execute({
      action,
      currentTaskRevision: 1,
      observation: observed.observation,
    })).resolves.toEqual({
      status: 'blocked',
      reason: 'observation_stale',
    });
  });

  it('H094-cancellation: stops before capture without producing an observation', async () => {
    const { capture, service } = harness();
    await expect(service.observe({
      adapterId,
      clientId: 'client:cancelled',
      isCancelled: () => true,
      operationId: 'operation:cancelled',
      packageName: androidSettingsPackageV2,
    })).resolves.toEqual({
      status: 'cancelled',
      explanation: 'Screen observation was cancelled.',
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it('H094-rollback: records an exact read-only rollback transition', () => {
    const { service } = harness();
    expect(service.rollbackAdapter({
      actorId: 'h094.runner',
      adapterId,
      reason: 'conformance rollback',
    })).toMatchObject({
      action: 'rollback',
      actorId: 'h094.runner',
      capabilities: ['observe'],
      enabledAfter: false,
      enabledBefore: true,
      mode: 'read_only',
      outcome: 'changed',
      packages: [androidSettingsPackageV2],
      sequence: 0,
    });
  });

  it('H094-disabled-state: prevents capture until explicitly re-enabled', async () => {
    const { capture, service } = harness();
    service.controlAdapter({
      action: 'disable',
      actorId: 'h094.runner',
      adapterId,
      reason: 'disabled-state conformance',
    });
    await expect(service.observe({
      adapterId,
      clientId: 'client:disabled',
      operationId: 'operation:disabled',
      packageName: androidSettingsPackageV2,
    })).rejects.toThrow('No adapter is registered');
    expect(capture).not.toHaveBeenCalled();
    expect(service.adapterStatus(adapterId)?.enabled).toBe(false);
  });

  it('H094-observation-freshness: distinguishes fresh from expired references', async () => {
    const { service, setNow } = harness({ ttlMs: 10 });
    const observed = await safeObservation(service);
    const action = targetAction({
      observationId: observed.observation.observationId,
      targetRef: observed.pointTarget!.elementRef,
    });
    expect(observed.observation).toMatchObject({
      capturedAt: 1_000,
      expiresAt: 1_010,
    });
    await expect(service.execute({
      action,
      currentTaskRevision: 1,
      observation: observed.observation,
    })).resolves.toEqual({
      status: 'blocked',
      reason: 'capability_scope_mismatch',
    });

    setNow(1_010);
    await expect(service.execute({
      action,
      currentTaskRevision: 1,
      observation: observed.observation,
    })).resolves.toEqual({
      status: 'blocked',
      reason: 'observation_stale',
    });
  });

  it('H094-zero-mutation: declares and permits no mutation capability', async () => {
    const { capture, service } = harness();
    const status = service.adapterStatus(adapterId);
    expect(status).toMatchObject({
      capabilities: ['observe'],
      mode: 'read_only',
    });
    expect(service.descriptors()[0]!.capabilities).toEqual([{
      capability: 'observe',
      effect: 'read_only',
      idempotency: 'none',
      requiresConfirmation: false,
      requiresFreshObservation: false,
    }]);

    const mutation = createInstrumentedActionV2({
      actionId: 'action:conformance-submit',
      adapterId,
      packageName: androidSettingsPackageV2,
      capability: 'submit',
      effect: 'external_side_effect',
      idempotencyKey: 'operation:conformance-submit',
      input: {},
      expectedPostcondition: { kind: 'submission_verified' },
    });
    await expect(service.execute({
      action: mutation,
      currentTaskRevision: 1,
    })).resolves.toEqual({
      status: 'blocked',
      reason: 'capability_scope_mismatch',
    });
    expect(capture).not.toHaveBeenCalled();
  });
});
