import { NextResponse } from 'next/server';
import {
  collectDeviceDiagnosticsV2,
  productionDeviceDiagnosticsDependencies,
} from '../../../../../lib/device-diagnostics';
import {
  dispatchProductionContinuationV2,
} from '../../../../../lib/workflow/v2/background-phone-operation/production-adapter';
import {
  executableRecoveryActionIdsV2,
  isReconnectRecoveryActionV2,
  parseRecoveryHandoffResponsesV2,
  phoneTaskRepositoryV2,
  priorRecoveryResolutionV2,
  resolveRecoveryHandoffV2,
  TaskRevisionConflictV2Error,
  type ExecutableRecoveryActionIdV2,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
} from '../../../../../lib/workflow/v2';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../../../../lib/workflow/identifiers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RecoveryRequestV2 = {
  version: 2;
  actionId: ExecutableRecoveryActionIdV2;
  clientId: string;
  interactionId: string;
  operationId: LocalIdentifier<'operation'>;
  source: 'tap' | 'voice';
  stepId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
};

export type RecoveryRouteDependenciesV2 = {
  diagnose: () => Promise<{ ready: boolean }>;
  dispatchReadOnly: (taskId: string) => Promise<unknown>;
  now: () => number;
  repository: PhoneTaskRepositoryV2;
};

function exactString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new Error(`${label} must be an exact non-empty string.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error('Recovery request contains unsupported fields.');
  }
}

function parseRequest(value: unknown): RecoveryRequestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recovery request must be an object.');
  }
  const input = value as Record<string, unknown>;
  exactKeys(input, [
    'version',
    'actionId',
    'clientId',
    'interactionId',
    'operationId',
    'source',
    'stepId',
    'taskId',
    'taskRevision',
  ]);
  if (input['version'] !== 2) {
    throw new Error('Unsupported recovery request version.');
  }
  if (!['tap', 'voice'].includes(String(input['source']))) {
    throw new Error('Recovery source is invalid.');
  }
  const actionId = exactString(input['actionId'], 'actionId', 40);
  if (!executableRecoveryActionIdsV2.includes(
    actionId as ExecutableRecoveryActionIdV2,
  )) {
    throw new Error('Recovery action is invalid.');
  }
  const taskRevision = input['taskRevision'];
  if (
    typeof taskRevision !== 'number'
    || !Number.isSafeInteger(taskRevision)
    || taskRevision < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  const clientId = exactString(input['clientId'], 'clientId', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(clientId)) {
    throw new Error('clientId is invalid.');
  }
  const interactionId = exactString(
    input['interactionId'],
    'interactionId',
    160,
  );
  const stepId = exactString(input['stepId'], 'stepId', 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(interactionId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(stepId)
  ) {
    throw new Error('Recovery interaction identity is invalid.');
  }
  return {
    version: 2,
    actionId: actionId as ExecutableRecoveryActionIdV2,
    clientId,
    interactionId,
    operationId: parseLocalIdentifier('operation', input['operationId']),
    source: input['source'] as 'tap' | 'voice',
    stepId,
    taskId: parseLocalIdentifier('task', input['taskId']),
    taskRevision,
  };
}

function rejected(
  input: RecoveryRequestV2 | undefined,
  reason: string,
  status: number,
): Response {
  return NextResponse.json({
    version: 2,
    acknowledgement: 'rejected',
    reason,
    ...(input
      ? {
          actionId: input.actionId,
          interactionId: input.interactionId,
          operationId: input.operationId,
          stepId: input.stepId,
          taskId: input.taskId,
          taskRevision: input.taskRevision,
        }
      : {}),
  }, {
    status,
    headers: { 'cache-control': 'no-store, max-age=0' },
  });
}

function replay(
  task: PhoneTaskV2,
  input: RecoveryRequestV2,
): Response | undefined {
  const prior = priorRecoveryResolutionV2({ ...input, task });
  if (!prior) return undefined;
  return prior === 'duplicate'
    ? NextResponse.json({
        version: 2,
        acknowledgement: 'duplicate',
        actionId: input.actionId,
        interactionId: input.interactionId,
        operationId: input.operationId,
        stepId: input.stepId,
        taskId: input.taskId,
        taskRevision: task.revision,
      }, { headers: { 'cache-control': 'no-store, max-age=0' } })
    : rejected(input, 'already_resolved', 409);
}

function defaultDependencies(): RecoveryRouteDependenciesV2 {
  return {
    diagnose: async (): Promise<{ ready: boolean }> => {
      const snapshot = await collectDeviceDiagnosticsV2(
        productionDeviceDiagnosticsDependencies(),
      );
      return { ready: snapshot.ready };
    },
    dispatchReadOnly: dispatchProductionContinuationV2,
    now: Date.now,
    repository: phoneTaskRepositoryV2(),
  };
}

export async function handleRecoveryRequestV2(
  request: Request,
  dependencies: RecoveryRouteDependenciesV2 = defaultDependencies(),
): Promise<Response> {
  let input: RecoveryRequestV2;
  try {
    input = parseRequest(await request.json());
  } catch {
    return rejected(undefined, 'malformed_recovery_request', 400);
  }
  const record = await dependencies.repository.getById(input.taskId);
  if (!record) return rejected(input, 'unknown_task', 404);
  if (record.task.clientId !== input.clientId) {
    return rejected(input, 'client_task_mismatch', 403);
  }
  const prior = replay(record.task, input);
  if (prior) return prior;
  if (record.task.revision !== input.taskRevision) {
    return rejected(input, 'stale_revision', 409);
  }
  const pending = record.task.pendingInteraction;
  if (
    !pending
    || pending.kind !== 'recovery_handoff'
    || pending.interactionId !== input.interactionId
  ) {
    return rejected(input, 'unknown_recovery_interaction', 404);
  }
  if (
    pending.taskId !== input.taskId
    || pending.taskRevision !== input.taskRevision
    || pending.status !== 'open'
  ) {
    return rejected(input, 'stale_recovery_interaction', 409);
  }
  if (dependencies.now() >= pending.expiresAt) {
    return rejected(input, 'expired', 409);
  }
  let responses;
  try {
    responses = parseRecoveryHandoffResponsesV2(pending.allowedResponses);
  } catch {
    return rejected(input, 'invalid_recovery_handoff', 409);
  }
  if (
    responses.operationId !== input.operationId
    || responses.stepId !== input.stepId
  ) {
    return rejected(input, 'recovery_identity_mismatch', 409);
  }
  const allowed = responses.actions.find((action) =>
    action.actionId === input.actionId);
  if (!allowed) return rejected(input, 'action_not_allowed', 422);
  if (
    input.actionId === 'check_cart_again'
    && allowed.safety !== 'read_only'
  ) {
    return rejected(input, 'unsafe_recovery_action', 422);
  }

  let committed;
  try {
    committed = await resolveRecoveryHandoffV2({
      ...input,
      at: dependencies.now(),
      repository: dependencies.repository,
      task: record.task,
    });
  } catch (error) {
    if (!(error instanceof TaskRevisionConflictV2Error)) {
      return rejected(input, 'invalid_recovery_transition', 409);
    }
    const latest = await dependencies.repository.getById(input.taskId);
    const raced = latest ? replay(latest.task, input) : undefined;
    return raced ?? rejected(input, 'stale_revision', 409);
  }

  let followup:
    | { kind: 'diagnostics'; ready: boolean }
    | { kind: 'guidance'; message: string }
    | { kind: 'read_only_operation'; dispatched: boolean }
    | { kind: 'stopped' };
  if (
    input.actionId === 'check_cart_again'
    || input.actionId === 'refresh_choices'
  ) {
    try {
      await dependencies.dispatchReadOnly(committed.task.taskId);
      followup = { kind: 'read_only_operation', dispatched: true };
    } catch {
      followup = { kind: 'read_only_operation', dispatched: false };
    }
  } else if (isReconnectRecoveryActionV2(input.actionId)) {
    try {
      const diagnostic = await dependencies.diagnose();
      followup = { kind: 'diagnostics', ready: diagnostic.ready };
    } catch {
      followup = { kind: 'diagnostics', ready: false };
    }
  } else if (input.actionId === 'unlock_phone') {
    followup = {
      kind: 'guidance',
      message:
        'Unlock the phone manually. JaldiAI cannot bypass the device lock.',
    };
  } else {
    followup = { kind: 'stopped' };
  }
  return NextResponse.json({
    version: 2,
    acknowledgement: 'accepted',
    actionId: input.actionId,
    interactionId: input.interactionId,
    operationId: input.operationId,
    stepId: input.stepId,
    taskId: input.taskId,
    taskRevision: committed.task.revision,
    followup,
  }, { headers: { 'cache-control': 'no-store, max-age=0' } });
}

export async function POST(request: Request): Promise<Response> {
  return handleRecoveryRequestV2(request);
}
