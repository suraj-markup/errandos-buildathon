import { isAbsolute } from 'node:path';

export function validateDeploymentEnvironment(environment: NodeJS.ProcessEnv): void {
  const isProduction = environment['NODE_ENV'] === 'production';
  const usesFilesystem = environment['ERRANDOS_PERSISTENCE_MODE'] === 'filesystem';
  const isPersonal = environment['ERRANDOS_DEPLOYMENT_PROFILE'] === 'personal';

  if (isProduction && usesFilesystem && !isPersonal) {
    throw new Error('production filesystem persistence requires ERRANDOS_DEPLOYMENT_PROFILE=personal');
  }

  const execution = environment['ERRANDOS_BLINKIT_EXECUTION'];
  const rapidoExecution = environment['ERRANDOS_RAPIDO_EXECUTION'];
  if (execution === 'playwright') throw new Error('Blinkit Playwright execution has been removed; use android');
  if (execution !== undefined && execution !== 'android') throw new Error('ERRANDOS_BLINKIT_EXECUTION must be android');
  if (rapidoExecution !== undefined && rapidoExecution !== 'android') {
    throw new Error('ERRANDOS_RAPIDO_EXECUTION must be android');
  }
  if (
    environment['ERRANDOS_RAPIDO_LIVE_COMMIT'] === 'true'
    && (rapidoExecution !== 'android' || environment['ERRANDOS_LIVE_COMMIT'] !== 'true')
  ) {
    throw new Error('Rapido live commit requires Android Rapido execution and the global live commit gate');
  }
  if (
    environment['ERRANDOS_LIVE_BROWSER_ACTIONS'] === 'true'
    && execution !== 'android'
    && rapidoExecution !== 'android'
  ) {
    throw new Error('live actions require an Android provider execution');
  }
  if (execution === 'android' || rapidoExecution === 'android') {
    for (const name of [
      'ERRANDOS_ANDROID_WORKER_SSH_HOST',
      'ERRANDOS_ANDROID_WORKER_SSH_USER',
      'ERRANDOS_ANDROID_WORKER_IDENTITY_FILE',
      'ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE',
    ] as const) {
      if (!environment[name]) throw new Error(`${name} is required for Android provider execution`);
    }
    if (!isAbsolute(environment['ERRANDOS_ANDROID_WORKER_IDENTITY_FILE']!)
      || !isAbsolute(environment['ERRANDOS_ANDROID_WORKER_KNOWN_HOSTS_FILE']!)) {
      throw new Error('Android worker SSH identity and known-hosts files must be absolute paths');
    }
    if (environment['ERRANDOS_ANDROID_WORKER_COMMAND'] !== '/opt/errandos/bin/android-worker-job') {
      throw new Error('ERRANDOS_ANDROID_WORKER_COMMAND must use the fixed Android worker command');
    }
  }
}
