import { execFile } from 'node:child_process';

const ADB_PATH = process.env.ADB_PATH
  ?? '/Users/suraj/Library/Android/sdk/platform-tools/adb';
const DEVICE_UDID = process.env.ANDROID_DEVICE_UDID ?? '55221VDAQ000J1';
const OVERLAY_PACKAGE = 'ai.errandos.overlay';
const OVERLAY_ACTION = 'ai.errandos.overlay.STATUS';
const INGRESS_CAPABILITY_PATH = 'files/status-ingress-capability';
const INGRESS_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ingressCapabilities = new Map<string, Promise<string>>();
const currentInstallByDevice = new Map<string, string>();
const BROAD_ATTENTION_SUBJECTS = new Set([
  'address',
  'cart',
  'checkout',
  'confirmation',
  'options',
  'payment',
  'product',
  'recent_orders',
]);

type OverlayState =
  | 'working'
  | 'searching'
  | 'adding'
  | 'checkout'
  | 'confirmation'
  | 'success'
  | 'clarification'
  | 'error'
  | 'ready';

interface AdbResult {
  stdout: string;
  stderr: string;
}

function executeAdb(arguments_: string[]): Promise<AdbResult> {
  return new Promise((resolve, reject) => {
    execFile(
      ADB_PATH,
      arguments_,
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function validIngressCapability(value: string): boolean {
  if (!INGRESS_CAPABILITY_PATTERN.test(value)) return false;
  try {
    return Buffer.from(value, 'base64url').length === 32;
  } catch {
    return false;
  }
}

async function installedOverlayIdentity(): Promise<string | null> {
  try {
    const result = await executeAdb([
      '-s',
      DEVICE_UDID,
      'shell',
      'pm',
      'path',
      OVERLAY_PACKAGE,
    ]);
    const packagePath = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith('package:'));
    if (!packagePath) return null;
    return `${DEVICE_UDID}:${packagePath}`;
  } catch {
    return null;
  }
}

async function ingressCapability(
  installIdentity: string,
): Promise<string> {
  const cached = ingressCapabilities.get(installIdentity);
  if (cached) return cached;

  const pending = (async () => {
    const result = await executeAdb([
      '-s',
      DEVICE_UDID,
      'shell',
      'run-as',
      OVERLAY_PACKAGE,
      'cat',
      INGRESS_CAPABILITY_PATH,
    ]);
    const capability = result.stdout.trim();
    if (!validIngressCapability(capability)) {
      throw new Error('Overlay ingress capability unavailable');
    }
    return capability;
  })();
  ingressCapabilities.set(installIdentity, pending);
  try {
    return await pending;
  } catch (error) {
    ingressCapabilities.delete(installIdentity);
    throw error;
  }
}

function invalidateIngressCapability(installIdentity: string): void {
  ingressCapabilities.delete(installIdentity);
}

function broadcastWasRejected(result: AdbResult): boolean {
  return /(?:ingress|broadcast).*(?:reject|denied)|securityexception/iu.test(
    `${result.stdout}\n${result.stderr}`,
  );
}

async function publishAuthenticatedExtras(
  extras: string[],
): Promise<boolean> {
  const installIdentity = await installedOverlayIdentity();
  if (!installIdentity) return false;

  const previousInstall = currentInstallByDevice.get(DEVICE_UDID);
  if (previousInstall && previousInstall !== installIdentity) {
    invalidateIngressCapability(previousInstall);
  }
  currentInstallByDevice.set(DEVICE_UDID, installIdentity);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const capability = await ingressCapability(installIdentity);
      const result = await executeAdb([
        '-s',
        DEVICE_UDID,
        'shell',
        'am',
        'broadcast',
        '-a',
        OVERLAY_ACTION,
        '-p',
        OVERLAY_PACKAGE,
        '--es',
        'ingressCapability',
        capability,
        ...extras,
      ]);
      if (!broadcastWasRejected(result)) return true;
    } catch {
      // The capability may have rotated after an app reinstall.
    }
    invalidateIngressCapability(installIdentity);
  }
  return false;
}

export async function publishOverlayStatus(
  message: string,
  state: OverlayState,
): Promise<boolean> {
  return publishAuthenticatedExtras([
    '--es',
    'message',
    message,
    '--es',
    'state',
    state,
  ]);
}

/**
 * Temporarily hides visual attention while a private screenshot is captured.
 * This broadcast carries no presentation or user data.
 */
export async function setOverlayCaptureSuppressed(
  suppressed: boolean,
): Promise<boolean> {
  return publishAuthenticatedExtras([
    '--ez',
    'captureSuppressed',
    String(suppressed),
  ]);
}

async function publishAttentionExtra(
  name: string,
  value: string,
): Promise<boolean> {
  return publishAuthenticatedExtras(['--es', name, value]);
}

/**
 * Private local transport. Callers must never log or persist `payload`.
 */
export async function publishPrivateOverlayAttention(
  payload: string,
): Promise<boolean> {
  if (!payload || payload.length > 12_000) return false;
  return publishAttentionExtra(
    'spatialAttentionBase64',
    Buffer.from(payload, 'utf8').toString('base64'),
  );
}

export async function publishBroadOverlayAttention(
  subject: string,
): Promise<boolean> {
  if (!BROAD_ATTENTION_SUBJECTS.has(subject)) return false;
  return publishAttentionExtra('broadAttentionSubject', subject);
}

export async function clearOverlaySpatialAttention(): Promise<boolean> {
  return publishAttentionExtra('clearSpatialAttention', 'true');
}
