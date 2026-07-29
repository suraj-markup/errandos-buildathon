import { describe, expect, it, vi } from 'vitest';
import {
  formatConnectivitySnapshot,
  loadConnectivityPreflightConfig,
  parseConnectivityPreflightArguments,
  runConnectivityKeepAlive,
  runConnectivityPreflight,
  type ConnectivityPreflightConfig,
  type ConnectivityPreflightSnapshot,
} from './ux079-connectivity-preflight';

const exactUdid = '192.168.50.12:5555';

function config(
  overrides: Partial<ConnectivityPreflightConfig> = {},
): ConnectivityPreflightConfig {
  return {
    androidDeviceUdid: exactUdid,
    appiumUrl: 'http://127.0.0.1:4723',
    openAiApiKey: 'openai-secret-value',
    openAiUrl: 'https://api.openai.example/v1/models',
    sarvamApiKey: 'sarvam-secret-value',
    sarvamUrl: 'https://api.sarvam.example/',
    timeoutMs: 1_000,
    voiceServiceUrl: 'http://127.0.0.1:3000',
    ...overrides,
  };
}

function readySnapshot(): ConnectivityPreflightSnapshot {
  return {
    checkedAt: '2026-07-28T00:00:00.000Z',
    latencyMs: 1,
    ready: true,
    results: [],
    version: 1,
  };
}

describe('UX079 connectivity preflight', () => {
  it('requires an explicit exact Android UDID and never supplies a default', () => {
    expect(() => loadConnectivityPreflightConfig({
      APPIUM_URL: 'http://127.0.0.1:4723',
      OPENAI_API_KEY: 'openai',
      SARVAM_API_KEY: 'sarvam',
    })).toThrow(/ANDROID_DEVICE_UDID is required/);
    expect(() => loadConnectivityPreflightConfig({
      ANDROID_DEVICE_UDID: 'serial with whitespace',
      APPIUM_URL: 'http://127.0.0.1:4723',
      OPENAI_API_KEY: 'openai',
      SARVAM_API_KEY: 'sarvam',
    })).toThrow(/not a valid exact device serial/);
    expect(() => loadConnectivityPreflightConfig({
      ANDROID_DEVICE_UDID: exactUdid,
      OPENAI_API_KEY: 'openai',
      SARVAM_API_KEY: 'sarvam',
      JALDI_PREFLIGHT_VOICE_URL: 'http://127.0.0.1:3100',
    })).toThrow(/APPIUM_URL is required/);
    expect(() => loadConnectivityPreflightConfig({
      ANDROID_DEVICE_UDID: exactUdid,
      APPIUM_URL: 'http://127.0.0.1:4723',
      OPENAI_API_KEY: 'openai',
      SARVAM_API_KEY: 'sarvam',
    })).toThrow(/JALDI_PREFLIGHT_VOICE_URL is required/);
  });

  it('parses only bounded keep-alive arguments', () => {
    expect(parseConnectivityPreflightArguments([
      '--keep-alive',
      '--interval-ms=1500',
      '--max-iterations=3',
    ])).toEqual({
      intervalMs: 1_500,
      keepAlive: true,
      maxIterations: 3,
    });
    expect(() => parseConnectivityPreflightArguments([
      '--max-iterations=0',
    ])).toThrow(/1 to 10000/);
    expect(() => parseConnectivityPreflightArguments([
      '--interval-ms=999',
    ])).toThrow(/1000 to 600000/);
  });

  it('refuses a different connected device without targeting it', async () => {
    const runAdb = vi.fn(async (arguments_: readonly string[]) => {
      expect(arguments_).toEqual(['devices']);
      return {
        stdout: [
          'List of devices attached',
          'wrong-device\tdevice',
          '',
        ].join('\n'),
      };
    });
    const fetchImplementation = vi.fn(async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;

    const snapshot = await runConnectivityPreflight(config(), {
      fetchImplementation,
      runAdb,
    });

    expect(snapshot.ready).toBe(false);
    expect(snapshot.results).toContainEqual(expect.objectContaining({
      reason: 'device_not_listed',
      status: 'blocked',
      target: 'android_device',
    }));
    expect(runAdb).toHaveBeenCalledOnce();
    expect(runAdb.mock.calls.flatMap(([arguments_]) => arguments_))
      .not.toContain('wrong-device');
  });

  it('uses only exact-device read checks and GET/HEAD provider health probes', async () => {
    let now = 10;
    const adbArguments: string[][] = [];
    const runAdb = vi.fn(async (arguments_: readonly string[]) => {
      adbArguments.push([...arguments_]);
      now += 2;
      return arguments_[0] === 'devices'
        ? {
            stdout: [
              'List of devices attached',
              `${exactUdid}\tdevice`,
              'unrelated-device\tdevice',
              '',
            ].join('\n'),
          }
        : { stdout: 'device\n' };
    });
    const requests: Array<{
      headers: Headers;
      method: string;
      url: string;
    }> = [];
    const fetchSpy = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        now += 3;
        const normalizedUrl =
          typeof url === 'string' ? url : url instanceof URL
            ? url.toString()
            : url.url;
        requests.push({
          headers: new Headers(init?.headers),
          method: init?.method ?? 'GET',
          url: normalizedUrl,
        });
        return new Response(null, {
          status: normalizedUrl.includes('sarvam') ? 404 : 200,
        });
      },
    );
    const fetchImplementation = fetchSpy as unknown as typeof fetch;

    const snapshot = await runConnectivityPreflight(config(), {
      clock: () => now,
      fetchImplementation,
      runAdb,
    });

    expect(snapshot.ready).toBe(true);
    expect(adbArguments).toEqual([
      ['devices'],
      ['-s', exactUdid, 'get-state'],
    ]);
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: 'http://127.0.0.1:4723/status' },
      { method: 'GET', url: 'http://127.0.0.1:3000' },
      { method: 'GET', url: 'https://api.openai.example/v1/models' },
      { method: 'HEAD', url: 'https://api.sarvam.example/' },
    ]);
    expect(requests.every(({ method }) =>
      ['GET', 'HEAD'].includes(method))).toBe(true);
    expect(fetchSpy.mock.calls.every(([, init]) =>
      init?.keepalive === true)).toBe(true);
    expect(requests[2]?.headers.get('authorization'))
      .toBe('Bearer openai-secret-value');
    expect(requests[3]?.headers.get('api-subscription-key'))
      .toBe('sarvam-secret-value');

    const output = formatConnectivitySnapshot(snapshot);
    expect(output).not.toContain('openai-secret-value');
    expect(output).not.toContain('sarvam-secret-value');
    expect(output).not.toContain('authorization');
    expect(output).not.toContain('api-subscription-key');
    expect(snapshot.results.every(({ latencyMs }) => latencyMs >= 0)).toBe(true);
  });

  it('reports authorization failure without response bodies or credentials', async () => {
    const fetchImplementation = vi.fn(
      async (url: string | URL | Request) => {
        const text = url.toString();
        return text.includes('openai')
          ? new Response('secret provider response', { status: 401 })
          : new Response(null, { status: 200 });
      },
    ) as unknown as typeof fetch;
    const runAdb = vi.fn(async (arguments_: readonly string[]) =>
      arguments_[0] === 'devices'
        ? {
            stdout: `List of devices attached\n${exactUdid}\tdevice\n`,
          }
        : { stdout: 'device\n' });

    const snapshot = await runConnectivityPreflight(config(), {
      fetchImplementation,
      runAdb,
    });
    const output = formatConnectivitySnapshot(snapshot);

    expect(snapshot.results).toContainEqual(expect.objectContaining({
      httpStatus: 401,
      reason: 'unauthorized',
      status: 'blocked',
      target: 'openai',
    }));
    expect(output).not.toContain('secret provider response');
    expect(output).not.toContain('openai-secret-value');
  });

  it('keeps probes sequential and stops after the configured iterations', async () => {
    let active = 0;
    let maximumActive = 0;
    const probe = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return readySnapshot();
    });
    const onSnapshot = vi.fn();
    const wait = vi.fn(async () => {});

    await runConnectivityKeepAlive({
      intervalMs: 1_000,
      maxIterations: 3,
      onSnapshot,
      probe,
      signal: new AbortController().signal,
      wait,
    });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
  });

  it('stops keep-alive immediately when any read-only probe is blocked', async () => {
    const blocked = {
      ...readySnapshot(),
      ready: false,
      results: [{
        latencyMs: 4,
        reason: 'unreachable' as const,
        status: 'blocked' as const,
        target: 'voice_service' as const,
      }],
    };
    const probe = vi.fn(async () => blocked);
    const onSnapshot = vi.fn();
    const wait = vi.fn(async () => {});

    await runConnectivityKeepAlive({
      intervalMs: 1_000,
      maxIterations: 3,
      onSnapshot,
      probe,
      signal: new AbortController().signal,
      wait,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(blocked);
    expect(wait).not.toHaveBeenCalled();
  });
});
