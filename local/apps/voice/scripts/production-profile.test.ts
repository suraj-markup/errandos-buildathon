import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProductionProfileValidationError,
  requireProductionProfile,
  validateProductionProfile,
} from './production-profile';

const validEnvironment = {
  ANDROID_DEVICE_UDID: 'R5CT20ABC9K',
  APPIUM_URL: 'http://127.0.0.1:4723',
  ERRANDOS_LIVE_BROWSER_ACTIONS: 'false',
  ERRANDOS_LIVE_COMMIT: 'false',
  JALDI_LOG_CONTENT_V1: 'false',
  JALDI_REALTIME_CONTROL_V1: 'false',
  JALDI_REALTIME_PHONE_TOOLS_V1: 'false',
  JALDI_REALTIME_SHADOW_V1: 'false',
  JALDI_SCREENSHOT_OBSERVATION_V1: 'false',
  JALDI_VISION_GROUNDING_V1: 'false',
  NODE_ENV: 'production',
  OPENAI_API_KEY: 'sk-proj-production-credential-123456',
  SARVAM_API_KEY: 'sarvam-production-credential-123456',
} as const;
const validatorScript = resolve(
  import.meta.dirname,
  'validate-production-profile.ts',
);

describe('production voice profile validation', () => {
  it('accepts a complete profile and exposes no provider credentials', () => {
    const result = validateProductionProfile(validEnvironment);

    expect(result).toEqual({
      ok: true,
      profile: {
        appium: {
          origin: 'http://127.0.0.1:4723',
          selectedDeviceUdid: 'R5CT20ABC9K',
        },
        mode: 'production',
        providers: {
          openAI: 'configured',
          sarvam: 'configured',
        },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(validEnvironment.OPENAI_API_KEY);
    expect(serialized).not.toContain(validEnvironment.SARVAM_API_KEY);
  });

  it('reports every missing required setting in deterministic order', () => {
    const result = validateProductionProfile({});

    expect(result).toEqual({
      issues: [
        {
          code: 'missing',
          field: 'NODE_ENV',
          message: 'NODE_ENV must be set to production.',
        },
        {
          code: 'missing',
          field: 'OPENAI_API_KEY',
          message: 'OPENAI_API_KEY must be configured.',
        },
        {
          code: 'missing',
          field: 'SARVAM_API_KEY',
          message: 'SARVAM_API_KEY must be configured.',
        },
        {
          code: 'missing',
          field: 'APPIUM_URL',
          message: 'APPIUM_URL must be configured.',
        },
        {
          code: 'missing',
          field: 'ANDROID_DEVICE_UDID',
          message: 'ANDROID_DEVICE_UDID must select one device explicitly.',
        },
        {
          code: 'missing',
          field: 'ERRANDOS_LIVE_BROWSER_ACTIONS',
          message: 'ERRANDOS_LIVE_BROWSER_ACTIONS must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'ERRANDOS_LIVE_COMMIT',
          message: 'ERRANDOS_LIVE_COMMIT must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_LOG_CONTENT_V1',
          message: 'JALDI_LOG_CONTENT_V1 must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_SCREENSHOT_OBSERVATION_V1',
          message: 'JALDI_SCREENSHOT_OBSERVATION_V1 must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_VISION_GROUNDING_V1',
          message: 'JALDI_VISION_GROUNDING_V1 must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_REALTIME_SHADOW_V1',
          message: 'JALDI_REALTIME_SHADOW_V1 must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_REALTIME_CONTROL_V1',
          message: 'JALDI_REALTIME_CONTROL_V1 must be set explicitly to false.',
        },
        {
          code: 'missing',
          field: 'JALDI_REALTIME_PHONE_TOOLS_V1',
          message: 'JALDI_REALTIME_PHONE_TOOLS_V1 must be set explicitly to false.',
        },
      ],
      ok: false,
    });
  });

  it('rejects checked-in and inherited placeholder values without echoing them', () => {
    const environment = {
      ...validEnvironment,
      ANDROID_DEVICE_UDID: '192.168.1.100:5555',
      OPENAI_API_KEY: 'sk-your-server-managed-key',
      SARVAM_API_KEY: '${SARVAM_API_KEY}',
    };

    const result = validateProductionProfile(environment);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid profile.');
    expect(result.issues.map(({ code, field }) => [field, code])).toEqual([
      ['OPENAI_API_KEY', 'placeholder'],
      ['SARVAM_API_KEY', 'placeholder'],
      ['ANDROID_DEVICE_UDID', 'placeholder'],
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(environment.OPENAI_API_KEY);
    expect(serialized).not.toContain(environment.SARVAM_API_KEY);
  });

  it('rejects malformed or reused provider credentials with redacted errors', () => {
    const reusedCredential = 'sk-shared-production-credential-12345';
    const reused = validateProductionProfile({
      ...validEnvironment,
      OPENAI_API_KEY: reusedCredential,
      SARVAM_API_KEY: reusedCredential,
    });
    expect(reused.ok).toBe(false);
    if (reused.ok) throw new Error('Expected an invalid profile.');
    expect(reused.issues).toContainEqual({
      code: 'provider_keys_reused',
      field: 'SARVAM_API_KEY',
      message: 'Provider credentials must be configured independently.',
    });
    expect(JSON.stringify(reused)).not.toContain(reusedCredential);

    const malformed = validateProductionProfile({
      ...validEnvironment,
      OPENAI_API_KEY: 'not-an-openai-key',
      SARVAM_API_KEY: 'short',
    });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error('Expected an invalid profile.');
    expect(malformed.issues.map(({ code, field }) => [field, code])).toEqual([
      ['OPENAI_API_KEY', 'invalid'],
      ['SARVAM_API_KEY', 'invalid'],
    ]);
  });

  it.each([
    'R5CT20ABC9K',
    'emulator-5554',
    '10.0.0.24:5555',
    'pixel-demo.local:5555',
    '[2001:db8::24]:5555',
    'adb-R5CT20ABC9K-abc123._adb-tls-connect._tcp',
  ])('accepts one explicit Android device selection: %s', (udid) => {
    const result = validateProductionProfile({
      ...validEnvironment,
      ANDROID_DEVICE_UDID: udid,
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    'phone-1,phone-2',
    'phone serial',
    '*',
    '10.0.0.24:0',
    '10.0.0.24:65536',
    '[not-ipv6]:5555',
  ])('rejects ambiguous or malformed Android device selection: %s', (udid) => {
    const result = validateProductionProfile({
      ...validEnvironment,
      ANDROID_DEVICE_UDID: udid,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid profile.');
    expect(result.issues).toContainEqual({
      code: 'invalid',
      field: 'ANDROID_DEVICE_UDID',
      message:
        'ANDROID_DEVICE_UDID must identify exactly one USB or wireless device.',
    });
  });

  it('accepts only loopback Appium origins for the local demo profile', () => {
    for (const appiumUrl of [
      'http://127.0.0.1:4723',
      'http://localhost:4723',
      'http://[::1]:4723',
    ]) {
      expect(validateProductionProfile({
        ...validEnvironment,
        APPIUM_URL: appiumUrl,
      }).ok).toBe(true);
    }

    for (const appiumUrl of [
      'http://0.0.0.0:4723',
      'http://10.0.0.24:4723',
      'https://appium.example.com',
    ]) {
      const result = validateProductionProfile({
        ...validEnvironment,
        APPIUM_URL: appiumUrl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected an invalid profile.');
      expect(result.issues).toContainEqual({
        code: 'invalid',
        field: 'APPIUM_URL',
        message:
          'APPIUM_URL must be a loopback origin without credentials, query, or path.',
      });
    }
  });

  it('rejects non-production mode and unsafe Appium URLs', () => {
    const result = validateProductionProfile({
      ...validEnvironment,
      APPIUM_URL: 'http://user:password@127.0.0.1:4723/wd/hub?token=secret',
      NODE_ENV: 'development',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected an invalid profile.');
    expect(result.issues.map(({ code, field }) => [field, code])).toEqual([
      ['NODE_ENV', 'not_production'],
      ['APPIUM_URL', 'invalid'],
    ]);
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('fails closed unless every live and diagnostic flag is explicit false', () => {
    const safetyFlags = [
      'ERRANDOS_LIVE_BROWSER_ACTIONS',
      'ERRANDOS_LIVE_COMMIT',
      'JALDI_LOG_CONTENT_V1',
      'JALDI_SCREENSHOT_OBSERVATION_V1',
      'JALDI_VISION_GROUNDING_V1',
      'JALDI_REALTIME_SHADOW_V1',
      'JALDI_REALTIME_CONTROL_V1',
      'JALDI_REALTIME_PHONE_TOOLS_V1',
    ] as const;

    for (const field of safetyFlags) {
      const result = validateProductionProfile({
        ...validEnvironment,
        [field]: 'true',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Expected an invalid profile.');
      expect(result.issues).toEqual([{
        code: 'unsafe_enabled',
        field,
        message: `${field} must be set explicitly to false.`,
      }]);
    }
  });

  it('throws an actionable redacted error from the required-profile API', () => {
    const secret = 'sk-proj-sensitive-value-that-must-not-leak';

    expect(() => requireProductionProfile({
      ...validEnvironment,
      OPENAI_API_KEY: secret,
      SARVAM_API_KEY: secret,
    })).toThrow(ProductionProfileValidationError);

    try {
      requireProductionProfile({
        ...validEnvironment,
        OPENAI_API_KEY: secret,
        SARVAM_API_KEY: secret,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionProfileValidationError);
      expect(String(error)).toContain('SARVAM_API_KEY:provider_keys_reused');
      expect(String(error)).not.toContain(secret);
    }
  });

  it('keeps raw environment values out of CLI output in both exit paths', () => {
    const successOutput = execFileSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', validatorScript],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...validEnvironment,
        },
      },
    );
    expect(successOutput).toContain('"ok":true');
    expect(successOutput).not.toContain(validEnvironment.OPENAI_API_KEY);
    expect(successOutput).not.toContain(validEnvironment.SARVAM_API_KEY);
    expect(successOutput).not.toContain(validEnvironment.ANDROID_DEVICE_UDID);

    const invalidOpenAIKey = 'sk-your-server-managed-key';
    const invalidSarvamKey = 'your-sarvam-server-managed-key';
    const failure = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-strip-types', validatorScript],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...validEnvironment,
          OPENAI_API_KEY: invalidOpenAIKey,
          SARVAM_API_KEY: invalidSarvamKey,
        },
      },
    );
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toContain('"ok":false');
    expect(failure.stderr).not.toContain(invalidOpenAIKey);
    expect(failure.stderr).not.toContain(invalidSarvamKey);
  });
});
