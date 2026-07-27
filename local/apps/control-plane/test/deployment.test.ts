import { describe, expect, it } from 'vitest';
import { validateDeploymentEnvironment } from '../src/deployment.js';

describe('deployment environment validation', () => {
  it('allows filesystem persistence in an explicit personal production deployment', () => {
    expect(() => validateDeploymentEnvironment({
      NODE_ENV: 'production',
      ERRANDOS_DEPLOYMENT_PROFILE: 'personal',
      ERRANDOS_PERSISTENCE_MODE: 'filesystem',
    })).not.toThrow();
  });

  it('rejects production filesystem persistence without the personal profile', () => {
    expect(() => validateDeploymentEnvironment({
      NODE_ENV: 'production',
      ERRANDOS_PERSISTENCE_MODE: 'filesystem',
    })).toThrow('production filesystem persistence requires ERRANDOS_DEPLOYMENT_PROFILE=personal');
  });

  it('keeps PostgreSQL valid for production deployments', () => {
    expect(() => validateDeploymentEnvironment({
      NODE_ENV: 'production',
      ERRANDOS_PERSISTENCE_MODE: 'postgres',
    })).not.toThrow();
  });

  it('requires pinned private SSH worker configuration for Android Blinkit', () => {
    expect(() => validateDeploymentEnvironment({ ERRANDOS_BLINKIT_EXECUTION: 'android' })).toThrow('ERRANDOS_ANDROID_WORKER_SSH_HOST');
    expect(() => validateDeploymentEnvironment({
      ERRANDOS_BLINKIT_EXECUTION: 'android',
      ERRANDOS_ANDROID_WORKER_SSH_HOST: 'errandos-android-worker.example.ts.net',
      ERRANDOS_ANDROID_WORKER_SSH_USER: 'errandos-worker-agent',
      ERRANDOS_ANDROID_WORKER_IDENTITY_FILE: '/run/secrets/android-worker-key',
      ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE: '/run/secrets/android-worker-known-hosts',
      ERRANDOS_ANDROID_WORKER_COMMAND: '/opt/errandos/bin/android-worker-job',
    })).not.toThrow();
  });

  it('requires absolute SSH credential paths', () => {
    expect(() => validateDeploymentEnvironment({
      ERRANDOS_BLINKIT_EXECUTION: 'android',
      ERRANDOS_ANDROID_WORKER_SSH_HOST: 'errandos-android-worker.example.ts.net',
      ERRANDOS_ANDROID_WORKER_SSH_USER: 'errandos-worker-agent',
      ERRANDOS_ANDROID_WORKER_IDENTITY_FILE: 'relative/key',
      ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE: '/run/secrets/android-worker-known-hosts',
      ERRANDOS_ANDROID_WORKER_COMMAND: '/opt/errandos/bin/android-worker-job',
    })).toThrow('must be absolute paths');
  });

  it('rejects every Blinkit Playwright runtime and Android-less live action', () => {
    expect(() => validateDeploymentEnvironment({ ERRANDOS_BLINKIT_EXECUTION: 'playwright' })).toThrow('Playwright execution has been removed');
    expect(() => validateDeploymentEnvironment({ ERRANDOS_LIVE_BROWSER_ACTIONS: 'true' })).toThrow('Android provider execution');
  });

  it('allows only Android Rapido execution and requires the isolated worker', () => {
    expect(() => validateDeploymentEnvironment({ ERRANDOS_RAPIDO_EXECUTION: 'private_api' })).toThrow('must be android');
    expect(() => validateDeploymentEnvironment({ ERRANDOS_RAPIDO_EXECUTION: 'android' })).toThrow('ERRANDOS_ANDROID_WORKER_SSH_HOST');
    expect(() => validateDeploymentEnvironment({
      ERRANDOS_RAPIDO_EXECUTION: 'android',
      ERRANDOS_ANDROID_WORKER_SSH_HOST: 'worker',
      ERRANDOS_ANDROID_WORKER_SSH_USER: 'errandos',
      ERRANDOS_ANDROID_WORKER_IDENTITY_FILE: '/run/secrets/key',
      ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE: '/run/secrets/known-hosts',
      ERRANDOS_ANDROID_WORKER_COMMAND: '/opt/errandos/bin/android-worker-job',
    })).not.toThrow();
  });

  it('keeps Rapido final requests behind an independent gate', () => {
    expect(() => validateDeploymentEnvironment({
      ERRANDOS_RAPIDO_LIVE_COMMIT: 'true',
      ERRANDOS_LIVE_COMMIT: 'true',
    })).toThrow('Rapido live commit requires Android Rapido execution');
    expect(() => validateDeploymentEnvironment({
      ERRANDOS_RAPIDO_EXECUTION: 'android',
      ERRANDOS_RAPIDO_LIVE_COMMIT: 'true',
      ERRANDOS_ANDROID_WORKER_SSH_HOST: 'worker',
      ERRANDOS_ANDROID_WORKER_SSH_USER: 'errandos',
      ERRANDOS_ANDROID_WORKER_IDENTITY_FILE: '/run/secrets/key',
      ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE: '/run/secrets/known-hosts',
      ERRANDOS_ANDROID_WORKER_COMMAND: '/opt/errandos/bin/android-worker-job',
    })).toThrow('global live commit gate');
  });
});
