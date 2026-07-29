import { describe, expect, it, vi } from 'vitest';
import {
  type DeviceDiagnosticsDependencies,
} from '../../../../lib/device-diagnostics';
import {
  handleDeviceDiagnosticsRequest,
} from './route';

function dependencies(
  overrides: Partial<DeviceDiagnosticsDependencies> = {},
): DeviceDiagnosticsDependencies {
  return {
    appiumReady: vi.fn(async () => true),
    blinkit: vi.fn(async () => ({
      foreground: 'blinkit' as const,
      screen: 'storefront' as const,
    })),
    deviceState: vi.fn(async () => ({
      interactive: true,
      locked: false,
    })),
    exactAdbDevice: vi.fn(async () => ({
      authorized: true,
      connection: 'authorized' as const,
      listed: true,
      transport: 'usb' as const,
    })),
    now: () => 1_000,
    sarvamAvailable: vi.fn(async () => true),
    voiceServerReady: vi.fn(async () => true),
    ...overrides,
  };
}

async function run(
  overrides: Partial<DeviceDiagnosticsDependencies> = {},
  options: { overallTimeoutMs?: number; perProbeTimeoutMs?: number } = {},
): Promise<{
  body: {
    issues: Array<{ code: string }>;
    probes: Array<Record<string, unknown>>;
    ready: boolean;
    version: number;
  };
  response: Response;
}> {
  const response = await handleDeviceDiagnosticsRequest(
    new Request('http://localhost/api/device/diagnostics'),
    dependencies(overrides),
    options,
  );
  return {
    body: await response.json() as {
      issues: Array<{ code: string }>;
      probes: Array<Record<string, unknown>>;
      ready: boolean;
      version: number;
    },
    response,
  };
}

function probe(
  body: Awaited<ReturnType<typeof run>>['body'],
  id: string,
): Record<string, unknown> {
  const result = body.probes.find((candidate) => candidate['id'] === id);
  if (!result) throw new Error(`Missing ${id} diagnostic.`);
  return result;
}

describe('GET /api/device/diagnostics', () => {
  it('returns an all-ready, privacy-safe snapshot from read-only probes', async () => {
    const { body, response } = await run();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control'))
      .toBe('no-store, max-age=0');
    expect(body).toMatchObject({
      issues: [],
      ready: true,
      version: 2,
    });
    expect(body.probes).toMatchObject([
      { id: 'voice_server', status: 'ready' },
      {
        authorized: true,
        connection: 'authorized',
        id: 'adb_device',
        status: 'ready',
        transport: 'usb',
      },
      { id: 'appium', status: 'ready' },
      {
        id: 'device_state',
        interactive: true,
        locked: false,
        status: 'ready',
      },
      {
        foreground: 'blinkit',
        id: 'blinkit',
        screen: 'storefront',
        status: 'ready',
      },
      { id: 'sarvam', status: 'ready' },
    ]);
  });

  it.each([
    {
      expectedCode: 'server_unreachable',
      expectedId: 'voice_server',
      overrides: {
        voiceServerReady: vi.fn(async () => false),
      },
    },
    {
      expectedCode: 'phone_disconnected',
      expectedId: 'adb_device',
      overrides: {
        exactAdbDevice: vi.fn(async () => ({
          authorized: false,
          connection: 'not_listed' as const,
          listed: false,
          transport: 'unknown' as const,
        })),
      },
    },
    {
      expectedCode: 'appium_unavailable',
      expectedId: 'appium',
      overrides: {
        appiumReady: vi.fn(async () => false),
      },
    },
    {
      expectedCode: 'device_locked',
      expectedId: 'device_state',
      overrides: {
        deviceState: vi.fn(async () => ({
          interactive: false,
          locked: true,
        })),
      },
    },
    {
      expectedCode: 'provider_screen_unexpected',
      expectedId: 'blinkit',
      overrides: {
        blinkit: vi.fn(async () => ({
          foreground: 'other' as const,
          screen: 'not_checked' as const,
        })),
      },
    },
    {
      expectedCode: 'speech_provider_unavailable',
      expectedId: 'sarvam',
      overrides: {
        sarvamAvailable: vi.fn(async () => false),
      },
    },
  ])(
    'maps a blocked $expectedId probe to $expectedCode',
    async ({ expectedCode, expectedId, overrides }) => {
      const { body } = await run(
        overrides as Partial<DeviceDiagnosticsDependencies>,
      );

      expect(body.ready).toBe(false);
      expect(probe(body, expectedId)).toMatchObject({
        issue: { code: expectedCode, version: 2 },
        status: 'blocked',
      });
      expect(body.issues).toContainEqual(
        expect.objectContaining({ code: expectedCode }),
      );
    },
  );

  it('distinguishes an exact unauthorized wireless transport', async () => {
    const { body } = await run({
      exactAdbDevice: vi.fn(async () => ({
        authorized: false,
        connection: 'unauthorized' as const,
        listed: true,
        transport: 'wireless' as const,
      })),
    });

    expect(probe(body, 'adb_device')).toMatchObject({
      authorized: false,
      connection: 'unauthorized',
      issue: { code: 'phone_unauthorized' },
      reason: 'unauthorized',
      status: 'blocked',
      transport: 'wireless',
    });
  });

  it('distinguishes an offline exact device from an authorization prompt', async () => {
    const { body } = await run({
      exactAdbDevice: vi.fn(async () => ({
        authorized: false,
        connection: 'offline' as const,
        listed: true,
        transport: 'usb' as const,
      })),
    });

    expect(probe(body, 'adb_device')).toMatchObject({
      authorized: false,
      connection: 'offline',
      issue: { code: 'phone_disconnected' },
      status: 'blocked',
      transport: 'usb',
    });
  });

  it.each([
    ['login_required', 'blinkit_login_required'],
    ['otp_requested', 'blinkit_login_required'],
    ['unknown', 'provider_screen_unavailable'],
    ['review_prompt', 'provider_screen_unexpected'],
  ] as const)(
    'classifies the Blinkit %s screen without returning source',
    async (screen, expectedCode) => {
      const { body } = await run({
        blinkit: vi.fn(async () => ({
          foreground: 'blinkit' as const,
          screen,
        })),
      });

      expect(probe(body, 'blinkit')).toMatchObject({
        foreground: 'blinkit',
        issue: { code: expectedCode },
        screen,
        status: 'blocked',
      });
    },
  );

  it('bounds an uncooperative probe and classifies its timeout', async () => {
    const startedAt = Date.now();
    const { body } = await run({
      sarvamAvailable: vi.fn(
        async () => await new Promise<boolean>(() => undefined),
      ),
    }, {
      overallTimeoutMs: 60,
      perProbeTimeoutMs: 20,
    });

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(probe(body, 'sarvam')).toMatchObject({
      issue: { code: 'speech_provider_unavailable' },
      reason: 'timeout',
      status: 'blocked',
    });
  });

  it('never serializes raw errors, UI source, secrets, URLs, or device IDs', async () => {
    const sensitive = [
      'sk-secret-provider-key',
      '55221VDAQ000J1',
      'http://127.0.0.1:4723/session/private',
      '<hierarchy text="private cart"/>',
    ].join(' ');
    const { body } = await run({
      blinkit: vi.fn(async () => {
        throw new Error(sensitive);
      }),
    });
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('55221VDAQ000J1');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain('hierarchy');
    expect(probe(body, 'blinkit')).toMatchObject({
      issue: { code: 'provider_screen_unavailable' },
      reason: 'unreachable',
      status: 'blocked',
    });
  });
});
