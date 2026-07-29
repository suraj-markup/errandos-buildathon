import { describe, expect, it, vi } from 'vitest';
import {
  androidSettingsPackageV2,
  createGeneralMobileProductionServiceV2,
} from '../../../../../lib/general-mobile/v2';
import { handleAndroidSettingsAdapterControlV2 } from './route';

function fixture() {
  let now = 100;
  const capture = vi.fn(async () => ({
    packageName: androidSettingsPackageV2,
    source: '<hierarchy />',
  }));
  const service = createGeneralMobileProductionServiceV2({
    androidSettingsPort: { capture },
    now: () => now,
    serialize: async (operation) => operation(),
  });
  const logControl = vi.fn();
  return {
    capture,
    dependencies: {
      authorize: () => true,
      logControl,
      service,
    },
    logControl,
    service,
    setNow(value: number) {
      now = value;
    },
  };
}

function request(
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Request {
  return new Request(
    'http://localhost/api/general-mobile/v2/android-settings',
    {
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: { 'content-type': 'application/json' },
      method,
    },
  );
}

async function responseBody(response: Response) {
  return await response.json() as Record<string, unknown>;
}

describe('Android Settings general-mobile control route', () => {
  it('returns narrow read-only status and bounded audit evidence', async () => {
    const { dependencies } = fixture();
    const response = await handleAndroidSettingsAdapterControlV2(
      request('GET'),
      dependencies,
    );

    expect(response.status).toBe(200);
    expect(await responseBody(response)).toEqual({
      adapter: {
        adapterId: 'android-settings-read-only',
        capabilities: ['observe'],
        displayName: 'Android Settings read-only companion',
        enabled: true,
        mode: 'read_only',
        packages: [androidSettingsPackageV2],
      },
      evidence: [],
      version: 2,
    });
  });

  it('disables and re-enables the adapter through the service kill switch', async () => {
    const { capture, dependencies, logControl, service, setNow } = fixture();
    const disabled = await handleAndroidSettingsAdapterControlV2(
      request('POST', {
        action: 'disable',
        actorId: 'release.operator',
        reason: 'pause canary',
        version: 2,
      }),
      dependencies,
    );
    expect(disabled.status).toBe(200);
    expect(await responseBody(disabled)).toMatchObject({
      adapter: { enabled: false },
      evidence: {
        action: 'disable',
        actorId: 'release.operator',
        changedAt: 100,
        enabledAfter: false,
        enabledBefore: true,
        outcome: 'changed',
        sequence: 0,
      },
    });
    await expect(service.observe({
      adapterId: 'android-settings-read-only',
      clientId: 'client:disabled',
      operationId: 'operation:disabled',
      packageName: androidSettingsPackageV2,
    })).rejects.toThrow('No adapter is registered');
    expect(capture).not.toHaveBeenCalled();
    expect(logControl).toHaveBeenCalledWith(expect.objectContaining({
      action: 'disable',
      outcome: 'changed',
    }));

    setNow(101);
    const enabled = await handleAndroidSettingsAdapterControlV2(
      request('POST', {
        action: 'enable',
        actorId: 'release.operator',
        reason: 'resume canary',
        version: 2,
      }),
      dependencies,
    );
    expect(await responseBody(enabled)).toMatchObject({
      adapter: { enabled: true },
      evidence: {
        action: 'enable',
        changedAt: 101,
        enabledAfter: true,
        enabledBefore: false,
        outcome: 'changed',
        sequence: 1,
      },
    });
    expect(logControl).toHaveBeenCalledTimes(2);
  });

  it('rolls back idempotently and retains auditable before/after evidence', async () => {
    const { dependencies } = fixture();
    const command = {
      action: 'rollback',
      actorId: 'incident.commander',
      reason: 'privacy canary regression',
      version: 2,
    };
    const first = await handleAndroidSettingsAdapterControlV2(
      request('POST', command),
      dependencies,
    );
    const retry = await handleAndroidSettingsAdapterControlV2(
      request('POST', command),
      dependencies,
    );
    expect(await responseBody(first)).toMatchObject({
      evidence: {
        action: 'rollback',
        enabledAfter: false,
        enabledBefore: true,
        outcome: 'changed',
        sequence: 0,
      },
    });
    expect(await responseBody(retry)).toMatchObject({
      evidence: {
        action: 'rollback',
        enabledAfter: false,
        enabledBefore: false,
        outcome: 'unchanged',
        sequence: 1,
      },
    });

    const status = await handleAndroidSettingsAdapterControlV2(
      request('GET'),
      dependencies,
    );
    const body = await responseBody(status);
    expect(body).toMatchObject({
      adapter: {
        enabled: false,
        lastEvidence: { sequence: 1 },
      },
    });
    expect(body['evidence']).toHaveLength(2);
  });

  it('rejects unauthorized, malformed, and expansive control requests', async () => {
    const { dependencies, service } = fixture();
    const unauthorized = await handleAndroidSettingsAdapterControlV2(
      request('GET'),
      { ...dependencies, authorize: () => false },
    );
    expect(unauthorized.status).toBe(401);

    for (const body of [
      {
        action: 'activate',
        actorId: 'operator',
        reason: 'not allowed',
        version: 2,
      },
      {
        action: 'disable',
        actorId: 'operator',
        capability: 'activate',
        reason: 'expansive field',
        version: 2,
      },
      {
        action: 'disable',
        actorId: 'bad actor',
        reason: 'invalid actor',
        version: 2,
      },
    ]) {
      const response = await handleAndroidSettingsAdapterControlV2(
        request('POST', body),
        dependencies,
      );
      expect(response.status).toBe(400);
    }
    expect(service.adapterStatus('android-settings-read-only')?.enabled)
      .toBe(true);
    expect(service.controlHistory()).toEqual([]);
  });
});
