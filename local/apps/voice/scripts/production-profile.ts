import { isIP } from 'node:net';

export const productionProfileEnvironmentKeys = [
  'NODE_ENV',
  'OPENAI_API_KEY',
  'SARVAM_API_KEY',
  'APPIUM_URL',
  'ANDROID_DEVICE_UDID',
  'ERRANDOS_LIVE_BROWSER_ACTIONS',
  'ERRANDOS_LIVE_COMMIT',
  'JALDI_LOG_CONTENT_V1',
  'JALDI_SCREENSHOT_OBSERVATION_V1',
  'JALDI_VISION_GROUNDING_V1',
  'JALDI_REALTIME_SHADOW_V1',
  'JALDI_REALTIME_CONTROL_V1',
  'JALDI_REALTIME_PHONE_TOOLS_V1',
] as const;

export type ProductionProfileEnvironmentKey =
  typeof productionProfileEnvironmentKeys[number];

export type ProductionProfileIssueCode =
  | 'invalid'
  | 'missing'
  | 'not_production'
  | 'placeholder'
  | 'provider_keys_reused'
  | 'unsafe_enabled';

export type ProductionProfileIssue = Readonly<{
  code: ProductionProfileIssueCode;
  field: ProductionProfileEnvironmentKey;
  message: string;
}>;

export type ProductionProfile = Readonly<{
  appium: Readonly<{
    origin: string;
    selectedDeviceUdid: string;
  }>;
  mode: 'production';
  providers: Readonly<{
    openAI: 'configured';
    sarvam: 'configured';
  }>;
}>;

export type ProductionProfileValidation =
  | Readonly<{
      issues: readonly ProductionProfileIssue[];
      ok: false;
    }>
  | Readonly<{
      ok: true;
      profile: ProductionProfile;
    }>;

type ProductionProfileEnvironment = Readonly<
  Record<string, string | undefined>
>;

const knownPlaceholderValues = new Set([
  'change-me',
  'changeme',
  'example',
  'placeholder',
  'replace-me',
  'sk-your-server-managed-key',
  'test',
  'todo',
  'undefined',
  'your-api-key',
  'your-key',
  'your-sarvam-server-managed-key',
]);

const knownPlaceholderDeviceUdids = new Set([
  '192.168.1.100:5555',
  'android-device-udid',
  'device',
  'device-serial',
  'your-device-udid',
]);

const disabledProductionSafetyFlags = [
  'ERRANDOS_LIVE_BROWSER_ACTIONS',
  'ERRANDOS_LIVE_COMMIT',
  'JALDI_LOG_CONTENT_V1',
  'JALDI_SCREENSHOT_OBSERVATION_V1',
  'JALDI_VISION_GROUNDING_V1',
  'JALDI_REALTIME_SHADOW_V1',
  'JALDI_REALTIME_CONTROL_V1',
  'JALDI_REALTIME_PHONE_TOOLS_V1',
] as const satisfies readonly ProductionProfileEnvironmentKey[];

function issue(
  field: ProductionProfileEnvironmentKey,
  code: ProductionProfileIssueCode,
  message: string,
): ProductionProfileIssue {
  return { code, field, message };
}

function normalizedValue(
  environment: ProductionProfileEnvironment,
  field: ProductionProfileEnvironmentKey,
): string {
  return environment[field]?.trim() ?? '';
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    knownPlaceholderValues.has(normalized)
    || /^<[^>]+>$/.test(value)
    || /^\$\{[^}]+}$/.test(value)
    || /^(?:x{8,}|[._-]{8,})$/i.test(value)
    || /^(?:sk-)?(?:your|example|sample|dummy|placeholder)(?:[-_].*)?$/i
      .test(value)
  );
}

function validateProviderKey(input: {
  field: 'OPENAI_API_KEY' | 'SARVAM_API_KEY';
  minimumLength: number;
  value: string;
}): ProductionProfileIssue | undefined {
  if (!input.value) {
    return issue(
      input.field,
      'missing',
      `${input.field} must be configured.`,
    );
  }
  if (isPlaceholder(input.value)) {
    return issue(
      input.field,
      'placeholder',
      `${input.field} contains a placeholder value.`,
    );
  }
  if (
    input.value.length < input.minimumLength
    || /\s/.test(input.value)
    || (input.field === 'OPENAI_API_KEY' && !input.value.startsWith('sk-'))
  ) {
    return issue(
      input.field,
      'invalid',
      `${input.field} is not a valid production credential.`,
    );
  }
  return undefined;
}

function validateAppiumUrl(value: string): {
  issue?: ProductionProfileIssue;
  origin?: string;
} {
  if (!value) {
    return {
      issue: issue(
        'APPIUM_URL',
        'missing',
        'APPIUM_URL must be configured.',
      ),
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      issue: issue(
        'APPIUM_URL',
        'invalid',
        'APPIUM_URL must be an absolute HTTP or HTTPS URL.',
      ),
    };
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    return {
      issue: issue(
        'APPIUM_URL',
        'invalid',
        'APPIUM_URL must be a loopback origin without credentials, query, or path.',
      ),
    };
  }
  return { origin: url.origin };
}

function validPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function validWirelessUdid(value: string): boolean {
  if (value.startsWith('[')) {
    const match = value.match(/^\[([^\]]+)]:(\d+)$/);
    return Boolean(
      match
      && isIP(match[1] ?? '') === 6
      && validPort(match[2] ?? ''),
    );
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return false;
  const host = value.slice(0, separator);
  const port = value.slice(separator + 1);
  const validHost =
    isIP(host) === 4
    || (
      host.length <= 253
      && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)
    );
  return validHost && validPort(port);
}

function validateDeviceUdid(value: string): ProductionProfileIssue | undefined {
  if (!value) {
    return issue(
      'ANDROID_DEVICE_UDID',
      'missing',
      'ANDROID_DEVICE_UDID must select one device explicitly.',
    );
  }
  if (knownPlaceholderDeviceUdids.has(value.toLowerCase())) {
    return issue(
      'ANDROID_DEVICE_UDID',
      'placeholder',
      'ANDROID_DEVICE_UDID contains a placeholder value.',
    );
  }
  if (
    value.length > 128
    || /[\s,;]/.test(value)
    || value === '*'
    || (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(value)
      && !validWirelessUdid(value)
    )
  ) {
    return issue(
      'ANDROID_DEVICE_UDID',
      'invalid',
      'ANDROID_DEVICE_UDID must identify exactly one USB or wireless device.',
    );
  }
  return undefined;
}

export function validateProductionProfile(
  environment: ProductionProfileEnvironment,
): ProductionProfileValidation {
  const mode = normalizedValue(environment, 'NODE_ENV');
  const openAIKey = normalizedValue(environment, 'OPENAI_API_KEY');
  const sarvamKey = normalizedValue(environment, 'SARVAM_API_KEY');
  const appiumUrl = normalizedValue(environment, 'APPIUM_URL');
  const deviceUdid = normalizedValue(environment, 'ANDROID_DEVICE_UDID');
  const issues: ProductionProfileIssue[] = [];

  if (mode !== 'production') {
    issues.push(issue(
      'NODE_ENV',
      mode ? 'not_production' : 'missing',
      'NODE_ENV must be set to production.',
    ));
  }

  const openAIIssue = validateProviderKey({
    field: 'OPENAI_API_KEY',
    minimumLength: 20,
    value: openAIKey,
  });
  if (openAIIssue) issues.push(openAIIssue);

  const sarvamIssue = validateProviderKey({
    field: 'SARVAM_API_KEY',
    minimumLength: 20,
    value: sarvamKey,
  });
  if (sarvamIssue) issues.push(sarvamIssue);

  if (
    openAIKey
    && sarvamKey
    && !openAIIssue
    && !sarvamIssue
    && openAIKey === sarvamKey
  ) {
    issues.push(issue(
      'SARVAM_API_KEY',
      'provider_keys_reused',
      'Provider credentials must be configured independently.',
    ));
  }

  const appium = validateAppiumUrl(appiumUrl);
  if (appium.issue) issues.push(appium.issue);

  const deviceIssue = validateDeviceUdid(deviceUdid);
  if (deviceIssue) issues.push(deviceIssue);

  for (const field of disabledProductionSafetyFlags) {
    const value = normalizedValue(environment, field);
    if (value !== 'false') {
      issues.push(issue(
        field,
        value ? 'unsafe_enabled' : 'missing',
        `${field} must be set explicitly to false.`,
      ));
    }
  }

  if (issues.length > 0) return { issues, ok: false };

  return {
    ok: true,
    profile: {
      appium: {
        origin: appium.origin!,
        selectedDeviceUdid: deviceUdid,
      },
      mode: 'production',
      providers: {
        openAI: 'configured',
        sarvam: 'configured',
      },
    },
  };
}

export class ProductionProfileValidationError extends Error {
  readonly issues: readonly ProductionProfileIssue[];

  constructor(issues: readonly ProductionProfileIssue[]) {
    super(
      `Invalid production voice profile: ${issues
        .map(({ code, field }) => `${field}:${code}`)
        .join(', ')}`,
    );
    this.name = 'ProductionProfileValidationError';
    this.issues = issues;
  }
}

export function requireProductionProfile(
  environment: ProductionProfileEnvironment,
): ProductionProfile {
  const validation = validateProductionProfile(environment);
  if (!validation.ok) {
    throw new ProductionProfileValidationError(validation.issues);
  }
  return validation.profile;
}
