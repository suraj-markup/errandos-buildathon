import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AppiumHttpClient,
  detectBlinkitAndroidStage,
  type BlinkitAndroidStage,
} from '@errandos/provider-connectors';
import {
  companionIssueV2,
  type CompanionIssueV2,
} from './progress/v2/companion-issue';

const execFileAsync = promisify(execFile);
const BLINKIT_PACKAGE = 'com.grofers.customerapp';
const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';
const DEFAULT_SARVAM_URL = 'https://api.sarvam.ai/';
const DEFAULT_PER_PROBE_TIMEOUT_MS = 1_250;
const DEFAULT_OVERALL_TIMEOUT_MS = 1_500;

type DeviceDiagnosticProbeIdV2 =
  | 'voice_server'
  | 'adb_device'
  | 'appium'
  | 'device_state'
  | 'blinkit'
  | 'sarvam';

type DeviceDiagnosticReasonV2 =
  | 'device_not_listed'
  | 'device_state_unavailable'
  | 'locked'
  | 'login_required'
  | 'misconfigured'
  | 'not_interactive'
  | 'not_ready'
  | 'screen_unrecognized'
  | 'timeout'
  | 'unauthorized'
  | 'unreachable'
  | 'wrong_foreground';

type DiagnosticProbeBaseV2 = {
  id: DeviceDiagnosticProbeIdV2;
  issue?: CompanionIssueV2;
  latencyMs: number;
  reason?: DeviceDiagnosticReasonV2;
  status: 'blocked' | 'ready';
};

type DeviceDiagnosticProbeV2 =
  | (DiagnosticProbeBaseV2 & {
      id: 'voice_server';
    })
  | (DiagnosticProbeBaseV2 & {
      authorized: boolean;
      connection:
        | 'authorized'
        | 'not_listed'
        | 'offline'
        | 'unauthorized';
      id: 'adb_device';
      transport: 'usb' | 'wireless' | 'unknown';
    })
  | (DiagnosticProbeBaseV2 & {
      id: 'appium';
    })
  | (DiagnosticProbeBaseV2 & {
      id: 'device_state';
      interactive: boolean | null;
      locked: boolean | null;
    })
  | (DiagnosticProbeBaseV2 & {
      foreground: 'blinkit' | 'other' | 'unknown';
      id: 'blinkit';
      screen:
        | BlinkitAndroidStage
        | 'not_checked';
    })
  | (DiagnosticProbeBaseV2 & {
      id: 'sarvam';
    });

type DeviceDiagnosticsSnapshotV2 = {
  checkedAt: string;
  issues: CompanionIssueV2[];
  latencyMs: number;
  probes: DeviceDiagnosticProbeV2[];
  ready: boolean;
  version: 2;
};

type AdbDeviceDiagnostic = {
  authorized: boolean;
  connection:
    | 'authorized'
    | 'not_listed'
    | 'offline'
    | 'unauthorized';
  listed: boolean;
  transport: 'usb' | 'wireless' | 'unknown';
};

type AndroidDeviceStateDiagnostic = {
  interactive: boolean | null;
  locked: boolean | null;
};

type BlinkitDiagnostic = {
  foreground: 'blinkit' | 'other' | 'unknown';
  screen: BlinkitAndroidStage | 'not_checked';
};

export type DeviceDiagnosticsDependencies = {
  appiumReady: (signal: AbortSignal) => Promise<boolean>;
  blinkit: (signal: AbortSignal) => Promise<BlinkitDiagnostic>;
  deviceState: (
    signal: AbortSignal,
  ) => Promise<AndroidDeviceStateDiagnostic>;
  exactAdbDevice: (signal: AbortSignal) => Promise<AdbDeviceDiagnostic>;
  now: () => number;
  sarvamAvailable: (signal: AbortSignal) => Promise<boolean>;
  voiceServerReady: (signal: AbortSignal) => Promise<boolean>;
};

export type DeviceDiagnosticsOptions = {
  overallTimeoutMs?: number;
  perProbeTimeoutMs?: number;
};

type WithoutLatency<T> = T extends unknown
  ? Omit<T, 'latencyMs'>
  : never;
type ProbeProjection = WithoutLatency<DeviceDiagnosticProbeV2>;

function issue(
  stage:
    | 'adb_device'
    | 'appium'
    | 'blinkit_authentication'
    | 'device_lock'
    | 'provider_screen'
    | 'server'
    | 'speech_provider',
  status: string,
): CompanionIssueV2 {
  return companionIssueV2({ version: 2, stage, status });
}

function boundedDuration(value: number, name: string, fallback: number): number {
  const candidate = value || fallback;
  if (
    !Number.isSafeInteger(candidate)
    || candidate < 10
    || candidate > 10_000
  ) {
    throw new RangeError(`${name} must be an integer from 10 to 10000.`);
  }
  return candidate;
}

async function boundedProbe(input: {
  fallback: (reason: 'failed' | 'timeout') => ProbeProjection;
  now: () => number;
  overallSignal: AbortSignal;
  probe: (signal: AbortSignal) => Promise<ProbeProjection>;
  timeoutMs: number;
}): Promise<DeviceDiagnosticProbeV2> {
  const startedAt = input.now();
  const controller = new AbortController();
  let timedOut = false;
  const abortForOverall = (): void => controller.abort();
  input.overallSignal.addEventListener('abort', abortForOverall, {
    once: true,
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);

  const result = await Promise.race([
    Promise.resolve()
      .then(() => input.probe(controller.signal))
      .then(
        (value) => ({ kind: 'result' as const, value }),
        () => ({ kind: 'failed' as const }),
      ),
    new Promise<{ kind: 'aborted' }>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ kind: 'aborted' });
        return;
      }
      controller.signal.addEventListener(
        'abort',
        () => resolve({ kind: 'aborted' }),
        { once: true },
      );
    }),
  ]);

  clearTimeout(timeout);
  input.overallSignal.removeEventListener('abort', abortForOverall);
  const projection = result.kind === 'result'
    ? result.value
    : input.fallback(timedOut || input.overallSignal.aborted
      ? 'timeout'
      : 'failed');
  return {
    ...projection,
    latencyMs: Math.max(0, Math.round(input.now() - startedAt)),
  } as DeviceDiagnosticProbeV2;
}

function voiceProjection(ready: boolean): ProbeProjection {
  return ready
    ? { id: 'voice_server', status: 'ready' }
    : {
        id: 'voice_server',
        issue: issue('server', 'unreachable'),
        reason: 'unreachable',
        status: 'blocked',
      };
}

function adbProjection(value: AdbDeviceDiagnostic): ProbeProjection {
  if (!value.listed) {
    return {
      authorized: false,
      connection: 'not_listed',
      id: 'adb_device',
      issue: issue('adb_device', 'disconnected'),
      reason: 'device_not_listed',
      status: 'blocked',
      transport: 'unknown',
    };
  }
  if (!value.authorized) {
    const unauthorized = value.connection === 'unauthorized';
    return {
      authorized: false,
      connection: value.connection,
      id: 'adb_device',
      issue: issue(
        'adb_device',
        unauthorized ? 'unauthorized' : 'disconnected',
      ),
      reason: unauthorized ? 'unauthorized' : 'device_state_unavailable',
      status: 'blocked',
      transport: value.transport,
    };
  }
  return {
    authorized: true,
    connection: 'authorized',
    id: 'adb_device',
    status: 'ready',
    transport: value.transport,
  };
}

function appiumProjection(ready: boolean): ProbeProjection {
  return ready
    ? { id: 'appium', status: 'ready' }
    : {
        id: 'appium',
        issue: issue('appium', 'unavailable'),
        reason: 'not_ready',
        status: 'blocked',
      };
}

function deviceStateProjection(
  value: AndroidDeviceStateDiagnostic,
): ProbeProjection {
  if (value.interactive === null || value.locked === null) {
    return {
      id: 'device_state',
      interactive: value.interactive,
      issue: issue('adb_device', 'disconnected'),
      locked: value.locked,
      reason: 'device_state_unavailable',
      status: 'blocked',
    };
  }
  if (value.locked) {
    return {
      id: 'device_state',
      interactive: value.interactive,
      issue: issue('device_lock', 'locked'),
      locked: true,
      reason: 'locked',
      status: 'blocked',
    };
  }
  if (!value.interactive) {
    return {
      id: 'device_state',
      interactive: false,
      issue: issue('device_lock', 'locked'),
      locked: false,
      reason: 'not_interactive',
      status: 'blocked',
    };
  }
  return {
    id: 'device_state',
    interactive: true,
    locked: false,
    status: 'ready',
  };
}

function blinkitProjection(value: BlinkitDiagnostic): ProbeProjection {
  if (value.foreground === 'other') {
    return {
      foreground: 'other',
      id: 'blinkit',
      issue: issue('provider_screen', 'unexpected'),
      reason: 'wrong_foreground',
      screen: 'not_checked',
      status: 'blocked',
    };
  }
  if (value.foreground !== 'blinkit') {
    return {
      foreground: 'unknown',
      id: 'blinkit',
      issue: issue('provider_screen', 'unavailable'),
      reason: 'unreachable',
      screen: 'not_checked',
      status: 'blocked',
    };
  }
  if (
    value.screen === 'login_required'
    || value.screen === 'otp_requested'
  ) {
    return {
      foreground: 'blinkit',
      id: 'blinkit',
      issue: issue('blinkit_authentication', 'login_required'),
      reason: 'login_required',
      screen: value.screen,
      status: 'blocked',
    };
  }
  if (value.screen === 'unknown') {
    return {
      foreground: 'blinkit',
      id: 'blinkit',
      issue: issue('provider_screen', 'unavailable'),
      reason: 'screen_unrecognized',
      screen: 'unknown',
      status: 'blocked',
    };
  }
  if (
    value.screen === 'location_permission'
    || value.screen === 'review_prompt'
  ) {
    return {
      foreground: 'blinkit',
      id: 'blinkit',
      issue: issue('provider_screen', 'unexpected'),
      reason: 'screen_unrecognized',
      screen: value.screen,
      status: 'blocked',
    };
  }
  return {
    foreground: 'blinkit',
    id: 'blinkit',
    screen: value.screen,
    status: 'ready',
  };
}

function sarvamProjection(ready: boolean): ProbeProjection {
  return ready
    ? { id: 'sarvam', status: 'ready' }
    : {
        id: 'sarvam',
        issue: issue('speech_provider', 'unavailable'),
        reason: 'unreachable',
        status: 'blocked',
      };
}

function timedOut(
  id: DeviceDiagnosticProbeIdV2,
): ProbeProjection {
  switch (id) {
    case 'voice_server':
      return {
        id,
        issue: issue('server', 'unreachable'),
        reason: 'timeout',
        status: 'blocked',
      };
    case 'adb_device':
      return {
        authorized: false,
        connection: 'not_listed',
        id,
        issue: issue('adb_device', 'disconnected'),
        reason: 'timeout',
        status: 'blocked',
        transport: 'unknown',
      };
    case 'appium':
      return {
        id,
        issue: issue('appium', 'unavailable'),
        reason: 'timeout',
        status: 'blocked',
      };
    case 'device_state':
      return {
        id,
        interactive: null,
        issue: issue('adb_device', 'disconnected'),
        locked: null,
        reason: 'timeout',
        status: 'blocked',
      };
    case 'blinkit':
      return {
        foreground: 'unknown',
        id,
        issue: issue('provider_screen', 'unavailable'),
        reason: 'timeout',
        screen: 'not_checked',
        status: 'blocked',
      };
    case 'sarvam':
      return {
        id,
        issue: issue('speech_provider', 'unavailable'),
        reason: 'timeout',
        status: 'blocked',
      };
  }
}

function failed(id: DeviceDiagnosticProbeIdV2): ProbeProjection {
  const fallback = timedOut(id);
  return {
    ...fallback,
    reason: id === 'appium'
      ? 'not_ready'
      : id === 'device_state'
        ? 'device_state_unavailable'
        : id === 'blinkit'
          ? 'unreachable'
          : 'unreachable',
  } as ProbeProjection;
}

export async function collectDeviceDiagnosticsV2(
  dependencies: DeviceDiagnosticsDependencies,
  options: DeviceDiagnosticsOptions = {},
): Promise<DeviceDiagnosticsSnapshotV2> {
  const perProbeTimeoutMs = boundedDuration(
    options.perProbeTimeoutMs ?? DEFAULT_PER_PROBE_TIMEOUT_MS,
    'perProbeTimeoutMs',
    DEFAULT_PER_PROBE_TIMEOUT_MS,
  );
  const overallTimeoutMs = boundedDuration(
    options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS,
    'overallTimeoutMs',
    DEFAULT_OVERALL_TIMEOUT_MS,
  );
  const startedAt = dependencies.now();
  const overallController = new AbortController();
  const overallTimeout = setTimeout(
    () => overallController.abort(),
    overallTimeoutMs,
  );
  const run = (
    id: DeviceDiagnosticProbeIdV2,
    probe: (signal: AbortSignal) => Promise<ProbeProjection>,
  ): Promise<DeviceDiagnosticProbeV2> => boundedProbe({
    fallback: (reason) => reason === 'timeout'
      ? timedOut(id)
      : failed(id),
    now: dependencies.now,
    overallSignal: overallController.signal,
    probe,
    timeoutMs: Math.min(perProbeTimeoutMs, overallTimeoutMs),
  });

  try {
    const probes = await Promise.all([
      run(
        'voice_server',
        async (signal) => voiceProjection(
          await dependencies.voiceServerReady(signal),
        ),
      ),
      run(
        'adb_device',
        async (signal) => adbProjection(
          await dependencies.exactAdbDevice(signal),
        ),
      ),
      run(
        'appium',
        async (signal) => appiumProjection(
          await dependencies.appiumReady(signal),
        ),
      ),
      run(
        'device_state',
        async (signal) => deviceStateProjection(
          await dependencies.deviceState(signal),
        ),
      ),
      run(
        'blinkit',
        async (signal) => blinkitProjection(
          await dependencies.blinkit(signal),
        ),
      ),
      run(
        'sarvam',
        async (signal) => sarvamProjection(
          await dependencies.sarvamAvailable(signal),
        ),
      ),
    ]);
    const issues = [...new Map(
      probes
        .flatMap((probe) => probe.issue ? [probe.issue] : [])
        .map((candidate) => [candidate.code, candidate]),
    ).values()];
    return {
      checkedAt: new Date(dependencies.now()).toISOString(),
      issues,
      latencyMs: Math.max(
        0,
        Math.round(dependencies.now() - startedAt),
      ),
      probes,
      ready: probes.every((probe) => probe.status === 'ready'),
      version: 2,
    };
  } finally {
    clearTimeout(overallTimeout);
    overallController.abort();
  }
}

function exactDeviceUdid(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment['ANDROID_DEVICE_UDID']?.trim();
  if (
    !value
    || value.length > 128
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 32 || code === 127;
    })
  ) {
    return undefined;
  }
  return value;
}

function safeHttpUrl(
  value: string | undefined,
  fallback: string,
): string | undefined {
  try {
    const parsed = new URL(value?.trim() || fallback);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

async function runAdb(
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await execFileAsync('adb', [...arguments_], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    signal,
  });
  return stdout;
}

function listedDeviceState(
  stdout: string,
  udid: string,
): string | undefined {
  for (const line of stdout.split(/\r?\n/u).slice(1)) {
    const [serial, state] = line.trim().split(/\s+/u, 3);
    if (serial === udid) return state;
  }
  return undefined;
}

function parseBooleanEvidence(
  text: string,
  positive: readonly RegExp[],
  negative: readonly RegExp[],
): boolean | null {
  if (positive.some((pattern) => pattern.test(text))) return true;
  if (negative.some((pattern) => pattern.test(text))) return false;
  return null;
}

function parseAndroidDeviceState(
  power: string,
  windowPolicy: string,
): AndroidDeviceStateDiagnostic {
  const interactive = parseBooleanEvidence(
    power,
    [
      /\bmWakefulness=Awake\b/u,
      /\binteractiveState=INTERACTIVE_STATE_AWAKE\b/u,
    ],
    [
      /\bmWakefulness=(?:Asleep|Dozing|Dreaming)\b/u,
      /\binteractiveState=INTERACTIVE_STATE_SLEEP\b/u,
    ],
  );
  const locked = parseBooleanEvidence(
    windowPolicy,
    [
      /\bshowing=true\b/u,
      /\bmShowingLockscreen=true\b/u,
      /\bisStatusBarKeyguard=true\b/u,
    ],
    [
      /\bshowing=false\b/u,
      /\bmShowingLockscreen=false\b/u,
      /\bisStatusBarKeyguard=false\b/u,
    ],
  );
  return { interactive, locked };
}

export function productionDeviceDiagnosticsDependencies(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeviceDiagnosticsDependencies {
  const udid = exactDeviceUdid(environment);
  const appiumUrl = safeHttpUrl(
    environment['APPIUM_URL'],
    DEFAULT_APPIUM_URL,
  );
  const sarvamUrl = safeHttpUrl(
    environment['JALDI_PREFLIGHT_SARVAM_URL'],
    DEFAULT_SARVAM_URL,
  );
  const sarvamKey = environment['SARVAM_API_KEY']?.trim();

  return {
    appiumReady: async () => appiumUrl
      ? AppiumHttpClient.isReady({
          endpoint: appiumUrl,
          requestTimeoutMs: DEFAULT_PER_PROBE_TIMEOUT_MS,
        })
      : false,
    blinkit: async (signal): Promise<BlinkitDiagnostic> => {
      if (!appiumUrl || !udid) {
        return { foreground: 'unknown', screen: 'not_checked' };
      }
      let client: AppiumHttpClient | undefined;
      try {
        client = await AppiumHttpClient.open({
          activateApp: false,
          appPackage: BLINKIT_PACKAGE,
          endpoint: appiumUrl,
          requestTimeoutMs: DEFAULT_PER_PROBE_TIMEOUT_MS,
          udid,
        });
        if (signal.aborted) {
          return { foreground: 'unknown', screen: 'not_checked' };
        }
        if ((await client.currentPackage()).trim() !== BLINKIT_PACKAGE) {
          return { foreground: 'other', screen: 'not_checked' };
        }
        if (signal.aborted) {
          return { foreground: 'unknown', screen: 'not_checked' };
        }
        return {
          foreground: 'blinkit',
          screen: detectBlinkitAndroidStage(await client.source()),
        };
      } finally {
        await client?.close().catch(() => undefined);
      }
    },
    deviceState: async (
      signal,
    ): Promise<AndroidDeviceStateDiagnostic> => {
      if (!udid) return { interactive: null, locked: null };
      const [power, windowPolicy] = await Promise.all([
        runAdb(['-s', udid, 'shell', 'dumpsys', 'power'], signal),
        runAdb(
          ['-s', udid, 'shell', 'dumpsys', 'window', 'policy'],
          signal,
        ),
      ]);
      return parseAndroidDeviceState(power, windowPolicy);
    },
    exactAdbDevice: async (signal): Promise<AdbDeviceDiagnostic> => {
      if (!udid) {
        return {
          authorized: false,
          connection: 'not_listed',
          listed: false,
          transport: 'unknown',
        };
      }
      const state = listedDeviceState(
        await runAdb(['devices', '-l'], signal),
        udid,
      );
      return {
        authorized: state === 'device',
        connection: state === 'device'
          ? 'authorized'
          : state === 'unauthorized'
            ? 'unauthorized'
            : state === undefined
              ? 'not_listed'
              : 'offline',
        listed: state !== undefined,
        transport: udid.includes(':') ? 'wireless' : 'usb',
      };
    },
    now: Date.now,
    sarvamAvailable: async (signal): Promise<boolean> => {
      if (!sarvamUrl || !sarvamKey) return false;
      const response = await fetch(sarvamUrl, {
        cache: 'no-store',
        headers: { 'api-subscription-key': sarvamKey },
        keepalive: true,
        method: 'HEAD',
        redirect: 'manual',
        signal,
      });
      return (
        response.status >= 200
        && response.status < 500
        && response.status !== 401
        && response.status !== 403
      );
    },
    // Reaching this code through the local route is the bounded server probe.
    voiceServerReady: async () => true,
  };
}
