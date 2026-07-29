import { logEvent } from '../../structured-logger';
import { ProductionTaskRecoveryReconcilerV2 } from './production-recovery-reconciler';
import { recoverRepositoryOnStartupV2 } from './recovery';
import { phoneTaskRepositoryV2 } from './runtime-repository';

const runtimeGlobal = globalThis as typeof globalThis & {
  errandosPhoneTaskRecoveryV2?: Promise<void>;
};

export function ensurePhoneTaskRecoveryV2(): Promise<void> {
  runtimeGlobal.errandosPhoneTaskRecoveryV2 ??= (async () => {
    const reports = await recoverRepositoryOnStartupV2({
      repository: phoneTaskRepositoryV2(),
      reconciler: new ProductionTaskRecoveryReconcilerV2(),
    });
    logEvent('info', 'workflow.v2.startup_recovery', {
      reportCount: reports.length,
      reports,
    });
  })().catch((error) => {
    runtimeGlobal.errandosPhoneTaskRecoveryV2 = undefined;
    logEvent('error', 'workflow.v2.startup_recovery_failed', {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  return runtimeGlobal.errandosPhoneTaskRecoveryV2;
}
