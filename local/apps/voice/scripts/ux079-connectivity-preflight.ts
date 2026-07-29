import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ConnectivityTarget =
  | 'android_device'
  | 'appium'
  | 'openai'
  | 'sarvam'
  | 'voice_service';

export type ConnectivityFailureReason =
  | 'device_not_listed'
  | 'device_offline'
  | 'request_timeout'
  | 'unauthorized'
  | 'unexpected_status'
  | 'unreachable';

export type ConnectivityProbeResult = {
  httpStatus?: number;
  latencyMs: number;
  reason?: ConnectivityFailureReason;
  status: 'blocked' | 'ready';
  target: ConnectivityTarget;
};

export type ConnectivityPreflightSnapshot = {
  checkedAt: string;
  latencyMs: number;
  ready: boolean;
  results: ConnectivityProbeResult[];
  version: 1;
};

export type ConnectivityPreflightConfig = {
  androidDeviceUdid: string;
  appiumUrl: string;
  openAiApiKey: string;
  openAiUrl: string;
  sarvamApiKey: string;
  sarvamUrl: string;
  timeoutMs: number;
  voiceServiceUrl: string;
};

export type AdbCommand = (
  arguments_: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string }>;

export type ConnectivityPreflightDependencies = {
  clock?: () => number;
  fetchImplementation?: typeof fetch;
  runAdb?: AdbCommand;
};

export type ConnectivityPreflightArguments = {
  intervalMs: number;
  keepAlive: boolean;
  maxIterations: number;
};

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for connectivity preflight.`);
  return value;
}

function safeUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must be a valid HTTP(S) URL.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} cannot contain credentials, query, or fragment.`);
  }
  return parsed.toString();
}

function exactAndroidUdid(value: string): string {
  const udid = value.trim();
  if (!udid) {
    throw new Error(
      'ANDROID_DEVICE_UDID is required; device auto-selection is forbidden.',
    );
  }
  if (
    udid.length > 128
    || /[\u0000-\u001f\u007f\s]/u.test(udid)
  ) {
    throw new Error('ANDROID_DEVICE_UDID is not a valid exact device serial.');
  }
  return udid;
}

export function loadConnectivityPreflightConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ConnectivityPreflightConfig {
  const timeoutText = environment['JALDI_PREFLIGHT_TIMEOUT_MS']?.trim();
  const timeoutMs = timeoutText === undefined ? 5_000 : Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error(
      'JALDI_PREFLIGHT_TIMEOUT_MS must be an integer from 100 to 60000.',
    );
  }

  return {
    androidDeviceUdid: exactAndroidUdid(
      requiredEnvironmentValue(environment, 'ANDROID_DEVICE_UDID'),
    ),
    appiumUrl: safeUrl(
      'APPIUM_URL',
      requiredEnvironmentValue(environment, 'APPIUM_URL'),
    ),
    openAiApiKey: requiredEnvironmentValue(environment, 'OPENAI_API_KEY'),
    openAiUrl: safeUrl(
      'JALDI_PREFLIGHT_OPENAI_URL',
      environment['JALDI_PREFLIGHT_OPENAI_URL']?.trim()
        || 'https://api.openai.com/v1/models',
    ),
    sarvamApiKey: requiredEnvironmentValue(environment, 'SARVAM_API_KEY'),
    sarvamUrl: safeUrl(
      'JALDI_PREFLIGHT_SARVAM_URL',
      environment['JALDI_PREFLIGHT_SARVAM_URL']?.trim()
        || 'https://api.sarvam.ai/',
    ),
    timeoutMs,
    voiceServiceUrl: safeUrl(
      'JALDI_PREFLIGHT_VOICE_URL',
      requiredEnvironmentValue(environment, 'JALDI_PREFLIGHT_VOICE_URL'),
    ),
  };
}

export function parseConnectivityPreflightArguments(
  arguments_: readonly string[],
): ConnectivityPreflightArguments {
  return {
    intervalMs: boundedIntegerArgument({
      arguments_,
      defaultValue: 30_000,
      maximum: 10 * 60_000,
      minimum: 1_000,
      name: '--interval-ms',
    }),
    keepAlive: arguments_.includes('--keep-alive'),
    maxIterations: boundedIntegerArgument({
      arguments_,
      defaultValue: 120,
      maximum: 10_000,
      minimum: 1,
      name: '--max-iterations',
    }),
  };
}

function boundedIntegerArgument(input: {
  arguments_: readonly string[];
  defaultValue: number;
  maximum: number;
  minimum: number;
  name: string;
}): number {
  const prefix = `${input.name}=`;
  const argument = input.arguments_.find((value) => value.startsWith(prefix));
  if (!argument) return input.defaultValue;
  const value = Number(argument.slice(prefix.length));
  if (
    !Number.isInteger(value)
    || value < input.minimum
    || value > input.maximum
  ) {
    throw new RangeError(
      `${input.name} must be an integer from ${input.minimum} to ${input.maximum}.`,
    );
  }
  return value;
}

function withPath(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function listedAndroidDevices(stdout: string): Map<string, string> {
  const devices = new Map<string, string>();
  for (const rawLine of stdout.split(/\r?\n/u).slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [serial, state] = line.split(/\s+/u, 3);
    if (serial && state) devices.set(serial, state);
  }
  return devices;
}

function blockedResult(input: {
  clock: () => number;
  reason: ConnectivityFailureReason;
  startedAt: number;
  target: ConnectivityTarget;
}): ConnectivityProbeResult {
  return {
    latencyMs: Math.max(0, input.clock() - input.startedAt),
    reason: input.reason,
    status: 'blocked',
    target: input.target,
  };
}

async function probeExactAndroidDevice(input: {
  clock: () => number;
  runAdb: AdbCommand;
  signal: AbortSignal;
  udid: string;
}): Promise<ConnectivityProbeResult> {
  const startedAt = input.clock();
  try {
    const listing = await input.runAdb(['devices'], input.signal);
    const devices = listedAndroidDevices(listing.stdout);
    if (!devices.has(input.udid)) {
      return blockedResult({
        clock: input.clock,
        reason: 'device_not_listed',
        startedAt,
        target: 'android_device',
      });
    }
    if (devices.get(input.udid) !== 'device') {
      return blockedResult({
        clock: input.clock,
        reason: 'device_offline',
        startedAt,
        target: 'android_device',
      });
    }

    const state = await input.runAdb(
      ['-s', input.udid, 'get-state'],
      input.signal,
    );
    if (state.stdout.trim() !== 'device') {
      return blockedResult({
        clock: input.clock,
        reason: 'device_offline',
        startedAt,
        target: 'android_device',
      });
    }
    return {
      latencyMs: Math.max(0, input.clock() - startedAt),
      status: 'ready',
      target: 'android_device',
    };
  } catch {
    return blockedResult({
      clock: input.clock,
      reason: input.signal.aborted ? 'request_timeout' : 'unreachable',
      startedAt,
      target: 'android_device',
    });
  }
}

async function probeHttp(input: {
  clock: () => number;
  fetchImplementation: typeof fetch;
  headers?: HeadersInit;
  method: 'GET' | 'HEAD';
  signal: AbortSignal;
  target: Exclude<ConnectivityTarget, 'android_device'>;
  url: string;
  validateStatus: (status: number) => boolean;
}): Promise<ConnectivityProbeResult> {
  const startedAt = input.clock();
  try {
    const response = await input.fetchImplementation(input.url, {
      cache: 'no-store',
      headers: input.headers,
      // Node's global fetch pools compatible origins. This flag preserves
      // connection reuse for bounded keep-alive iterations where supported.
      keepalive: true,
      method: input.method,
      redirect: 'manual',
      signal: input.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        httpStatus: response.status,
        latencyMs: Math.max(0, input.clock() - startedAt),
        reason: 'unauthorized',
        status: 'blocked',
        target: input.target,
      };
    }
    return {
      httpStatus: response.status,
      latencyMs: Math.max(0, input.clock() - startedAt),
      ...(input.validateStatus(response.status)
        ? { status: 'ready' as const }
        : {
            reason: 'unexpected_status' as const,
            status: 'blocked' as const,
          }),
      target: input.target,
    };
  } catch {
    return blockedResult({
      clock: input.clock,
      reason: input.signal.aborted ? 'request_timeout' : 'unreachable',
      startedAt,
      target: input.target,
    });
  }
}

async function defaultAdbCommand(
  arguments_: readonly string[],
  signal: AbortSignal,
): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync('adb', [...arguments_], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    signal,
  });
  return { stdout };
}

export async function runConnectivityPreflight(
  config: ConnectivityPreflightConfig,
  dependencies: ConnectivityPreflightDependencies = {},
): Promise<ConnectivityPreflightSnapshot> {
  const clock = dependencies.clock ?? Date.now;
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const runAdb = dependencies.runAdb ?? defaultAdbCommand;
  const startedAt = clock();
  const signal = AbortSignal.timeout(config.timeoutMs);

  const results = await Promise.all([
    probeExactAndroidDevice({
      clock,
      runAdb,
      signal,
      udid: exactAndroidUdid(config.androidDeviceUdid),
    }),
    probeHttp({
      clock,
      fetchImplementation,
      method: 'GET',
      signal,
      target: 'appium',
      url: withPath(config.appiumUrl, '/status'),
      validateStatus: (status) => status >= 200 && status < 300,
    }),
    probeHttp({
      clock,
      fetchImplementation,
      method: 'GET',
      signal,
      target: 'voice_service',
      url: config.voiceServiceUrl,
      validateStatus: (status) => status >= 200 && status < 400,
    }),
    probeHttp({
      clock,
      fetchImplementation,
      headers: { authorization: `Bearer ${config.openAiApiKey}` },
      method: 'GET',
      signal,
      target: 'openai',
      url: config.openAiUrl,
      validateStatus: (status) => status >= 200 && status < 300,
    }),
    probeHttp({
      clock,
      fetchImplementation,
      headers: { 'api-subscription-key': config.sarvamApiKey },
      method: 'HEAD',
      signal,
      target: 'sarvam',
      url: config.sarvamUrl,
      // Sarvam does not publish a billing-free health endpoint. A non-auth
      // 2xx-4xx response establishes TLS/API reachability without synthesis.
      validateStatus: (status) => status >= 200 && status < 500,
    }),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, clock() - startedAt),
    ready: results.every((result) => result.status === 'ready'),
    results,
    version: 1,
  };
}

export async function runConnectivityKeepAlive(input: {
  intervalMs: number;
  maxIterations?: number;
  onSnapshot: (
    snapshot: ConnectivityPreflightSnapshot,
  ) => Promise<void> | void;
  probe: () => Promise<ConnectivityPreflightSnapshot>;
  signal: AbortSignal;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  if (
    !Number.isInteger(input.intervalMs)
    || input.intervalMs < 1_000
    || input.intervalMs > 10 * 60_000
  ) {
    throw new RangeError('Keep-alive interval must be 1000 to 600000 ms.');
  }
  if (
    input.maxIterations !== undefined
    && (
      !Number.isInteger(input.maxIterations)
      || input.maxIterations < 1
      || input.maxIterations > 10_000
    )
  ) {
    throw new RangeError('Keep-alive iterations must be 1 to 10000.');
  }
  let iterations = 0;
  while (!input.signal.aborted) {
    const snapshot = await input.probe();
    await input.onSnapshot(snapshot);
    iterations += 1;
    if (!snapshot.ready) return;
    if (
      input.maxIterations !== undefined
      && iterations >= input.maxIterations
    ) {
      return;
    }
    await (input.wait ?? abortableWait)(input.intervalMs, input.signal);
  }
}

export function formatConnectivitySnapshot(
  snapshot: ConnectivityPreflightSnapshot,
): string {
  return JSON.stringify(snapshot);
}

async function abortableWait(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
