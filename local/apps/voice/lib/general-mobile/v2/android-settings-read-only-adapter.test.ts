import { describe, expect, it, vi } from 'vitest';
import {
  AndroidSettingsReadOnlyAdapterV2,
  AppiumForegroundSourcePortV2,
  androidSettingsPackageV2,
  type ForegroundSourcePortV2,
} from './android-settings-read-only-adapter';
import {
  createGeneralMobileProductionServiceV2,
  GeneralMobileProductionServiceV2,
} from './service';
import { InstrumentedFakeGeneralMobileAdapterV2 } from './fake-adapter';
import { createInstrumentedActionV2 } from './fake-adapter';

const settingsSource = (label = 'Network and internet') =>
  `<hierarchy><node package="${androidSettingsPackageV2}" class="android.widget.TextView" text="${label}" enabled="true" bounds="[0,0][100,20]" /></hierarchy>`;

function capturePort(
  capture: ForegroundSourcePortV2['capture'],
): ForegroundSourcePortV2 {
  return { capture };
}

describe('Android Settings production read-only adapter', () => {
  it('wires the real adapter and the instrumented adapter through one service', async () => {
    const realPort = capturePort(vi.fn(async () => ({
      packageName: androidSettingsPackageV2,
      source: settingsSource(),
    })));
    const fake = new InstrumentedFakeGeneralMobileAdapterV2();
    const service = new GeneralMobileProductionServiceV2({
      adapters: [
        new AndroidSettingsReadOnlyAdapterV2({ port: realPort }),
        fake,
      ],
      idFactory: () => 'observation:production-service',
      serialize: async (operation) => operation(),
    });

    expect(service.descriptors().map((entry) => entry.adapterId)).toEqual([
      'android-settings-read-only',
      'instrumented-fake',
    ]);
    await expect(service.observe({
      adapterId: 'instrumented-fake',
      clientId: 'client:test',
      operationId: 'operation:test-adapter',
      packageName: 'test.instrumented.app',
    })).resolves.toMatchObject({ status: 'ready' });
    await expect(service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:real',
      operationId: 'operation:settings',
      packageName: androidSettingsPackageV2,
      focus: 'network',
    })).resolves.toMatchObject({
      status: 'ready',
      pointTarget: {
        elementRef: expect.stringMatching(/^element:/),
        observationId: 'observation:production-service',
      },
    });
    await expect(service.execute({
      action: createInstrumentedActionV2({
        actionId: 'action:forbidden-settings-navigation',
        adapterId: 'android-settings-read-only',
        packageName: androidSettingsPackageV2,
        capability: 'activate',
        effect: 'navigation',
        input: {},
        expectedPostcondition: { kind: 'navigation_verified' },
      }),
      currentTaskRevision: 1,
    })).resolves.toEqual({
      status: 'blocked',
      reason: 'capability_scope_mismatch',
    });
  });

  it('enforces foreground package scope before returning source', async () => {
    const source = vi.fn(async () => settingsSource());
    const close = vi.fn(async () => undefined);
    const port = new AppiumForegroundSourcePortV2({
      openPort: async () => ({
        close,
        currentPackage: vi.fn(async () => 'com.android.systemui'),
        source,
      }),
    });

    await expect(port.capture({
      expectedPackage: androidSettingsPackageV2,
      isCancelled: () => false,
    })).rejects.toThrow('outside the adapter scope');
    expect(source).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('applies privacy policy before exposing Settings candidates', async () => {
    const service = createGeneralMobileProductionServiceV2({
      androidSettingsPort: capturePort(vi.fn(async () => ({
        packageName: androidSettingsPackageV2,
        source: settingsSource('Enter OTP verification code'),
      }))),
      idFactory: () => 'observation:private-settings',
      serialize: async (operation) => operation(),
    });

    const result = await service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:private',
      operationId: 'operation:private',
      packageName: androidSettingsPackageV2,
      focus: 'verification',
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
  });

  it('rejects stale references before the read-only adapter executes', async () => {
    let now = 100;
    const service = createGeneralMobileProductionServiceV2({
      androidSettingsPort: capturePort(vi.fn(async () => ({
        packageName: androidSettingsPackageV2,
        source: settingsSource(),
      }))),
      idFactory: () => 'observation:stale-settings',
      maxObservationTtlMs: 5,
      now: () => now,
      serialize: async (operation) => operation(),
    });
    const observed = await service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:stale',
      operationId: 'operation:stale',
      packageName: androidSettingsPackageV2,
      focus: 'network',
    });
    expect(observed.status).toBe('ready');
    if (observed.status !== 'ready') return;
    now = 106;
    const action = createInstrumentedActionV2({
      actionId: 'action:stale-settings',
      adapterId: 'android-settings-read-only',
      packageName: androidSettingsPackageV2,
      capability: 'observe',
      effect: 'read_only',
      sourceObservationId: observed.observation.observationId,
      targetRef: observed.pointTarget!.elementRef,
      input: {},
      expectedPostcondition: { kind: 'screen_observed' },
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

  it('cancels a read in progress and closes the Appium session', async () => {
    let cancelled = false;
    const close = vi.fn(async () => undefined);
    const source = vi.fn(async () => {
      cancelled = true;
      return settingsSource();
    });
    const port = new AppiumForegroundSourcePortV2({
      openPort: async () => ({
        close,
        currentPackage: vi.fn(async () => androidSettingsPackageV2),
        source,
      }),
    });
    const service = createGeneralMobileProductionServiceV2({
      androidSettingsPort: port,
      serialize: async (operation) => operation(),
    });

    await expect(service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:cancel',
      operationId: 'operation:cancel',
      packageName: androidSettingsPackageV2,
      isCancelled: () => cancelled,
    })).resolves.toEqual({
      status: 'cancelled',
      explanation: 'Screen observation was cancelled.',
    });
    expect(source).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('records rollback evidence and disables the adapter immediately', async () => {
    const port = capturePort(vi.fn(async () => ({
      packageName: androidSettingsPackageV2,
      source: settingsSource(),
    })));
    const service = createGeneralMobileProductionServiceV2({
      androidSettingsPort: port,
      now: () => 1234,
      serialize: async (operation) => operation(),
    });

    expect(service.rollbackAdapter({
      adapterId: 'android-settings-read-only',
      reason: 'canary regression',
    })).toEqual({
      action: 'rollback',
      actorId: 'system',
      adapterId: 'android-settings-read-only',
      capabilities: ['observe'],
      changedAt: 1234,
      enabledAfter: false,
      enabledBefore: true,
      mode: 'read_only',
      outcome: 'changed',
      packages: [androidSettingsPackageV2],
      reason: 'canary regression',
      sequence: 0,
    });
    expect(service.rollbackHistory()).toHaveLength(1);
    await expect(service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:rollback',
      operationId: 'operation:rollback',
      packageName: androidSettingsPackageV2,
    })).rejects.toThrow('No adapter is registered');
    expect(port.capture).not.toHaveBeenCalled();
  });
});
