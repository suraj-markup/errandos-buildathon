import { createHash } from 'node:crypto';
import type {
  CompanionIssueV2,
  RecoveryActionIdV2,
} from '../../progress/v2/companion-issue';
import type {
  BackgroundPhoneOperationRecordV2,
} from './background-phone-operation/contracts';
import type {
  PendingInteractionV2,
  PhoneTaskStepV2,
  PhoneTaskV2,
} from './contracts';
import {
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export const executableRecoveryActionIdsV2 = [
  'check_cart_again',
  'refresh_choices',
  'reconnect_appium',
  'reconnect_phone',
  'reconnect_server',
  'stop_task',
  'unlock_phone',
] as const satisfies readonly RecoveryActionIdV2[];

export type ExecutableRecoveryActionIdV2 =
  typeof executableRecoveryActionIdsV2[number];

type RecoveryActionSafetyV2 = 'read_only' | 'stop_only' | 'user_guidance';

export type RecoveryHandoffResponsesV2 = {
  version: 2;
  operationId: string;
  stepId: string;
  actions: Array<{
    actionId: ExecutableRecoveryActionIdV2;
    safety: RecoveryActionSafetyV2;
  }>;
};

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

export function parseRecoveryHandoffResponsesV2(
  value: unknown,
): RecoveryHandoffResponsesV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recovery handoff responses must be an object.');
  }
  const input = value as Record<string, unknown>;
  exactKeys(
    input,
    ['version', 'operationId', 'stepId', 'actions'],
    'Recovery handoff responses',
  );
  if (input['version'] !== 2 || !Array.isArray(input['actions'])) {
    throw new Error('Invalid recovery handoff responses.');
  }
  const actions = input['actions'].map((value_) => {
    if (!value_ || typeof value_ !== 'object' || Array.isArray(value_)) {
      throw new Error('Invalid recovery action.');
    }
    const action = value_ as Record<string, unknown>;
    exactKeys(action, ['actionId', 'safety'], 'Recovery action');
    const actionId = identifier(action['actionId'], 'recovery action');
    if (!executableRecoveryActionIdsV2.includes(
      actionId as ExecutableRecoveryActionIdV2,
    )) {
      throw new Error('Unsupported recovery action.');
    }
    const safety = action['safety'];
    if (!['read_only', 'stop_only', 'user_guidance'].includes(
      String(safety),
    )) {
      throw new Error('Invalid recovery action safety.');
    }
    return {
      actionId: actionId as ExecutableRecoveryActionIdV2,
      safety: safety as RecoveryActionSafetyV2,
    };
  });
  if (
    actions.length < 1
    || actions.length > executableRecoveryActionIdsV2.length
    || new Set(actions.map((action) => action.actionId)).size
      !== actions.length
  ) {
    throw new Error('Recovery actions must be a bounded unique list.');
  }
  return {
    version: 2,
    operationId: identifier(input['operationId'], 'recovery operation'),
    stepId: identifier(input['stepId'], 'recovery step'),
    actions,
  };
}

function supportedActions(
  issue: CompanionIssueV2,
): RecoveryHandoffResponsesV2['actions'] {
  return issue.recoveryActions.flatMap((action) => {
    if (!executableRecoveryActionIdsV2.includes(
      action.actionId as ExecutableRecoveryActionIdV2,
    )) {
      return [];
    }
    if (action.safety === 'verified_not_applied_only') return [];
    return [{
      actionId: action.actionId as ExecutableRecoveryActionIdV2,
      safety: action.safety,
    }];
  });
}

export async function persistRecoveryHandoffV2(input: {
  expiresAt?: number;
  interactionId?: string;
  issue: CompanionIssueV2;
  now?: () => number;
  operation: BackgroundPhoneOperationRecordV2;
  repository: PhoneTaskRepositoryV2;
}): Promise<TaskRepositoryRecordV2 | undefined> {
  if (!['failed', 'ambiguous'].includes(input.operation.status)) {
    return undefined;
  }
  const record = await input.repository.getById(input.operation.taskId);
  if (!record || ['cancelled', 'completed'].includes(record.task.status)) {
    return undefined;
  }
  const step = record.task.steps.find((candidate) =>
    candidate.stepId === input.operation.stepId);
  if (
    !step
    || !['failed', 'ambiguous', 'blocked'].includes(step.status)
    || (
      step.operationId !== undefined
      && step.operationId !== input.operation.operationId
    )
  ) {
    return undefined;
  }
  if (record.task.pendingInteraction) {
    const pending = record.task.pendingInteraction;
    if (pending.kind !== 'recovery_handoff') return undefined;
    const responses = parseRecoveryHandoffResponsesV2(
      pending.allowedResponses,
    );
    return responses.operationId === input.operation.operationId
      && responses.stepId === input.operation.stepId
      ? record
      : undefined;
  }
  const actions = supportedActions(input.issue);
  if (actions.length === 0) return undefined;
  const at = Math.max(input.now?.() ?? Date.now(), record.task.updatedAt);
  const interactionId = identifier(
    input.interactionId ?? `recovery_${crypto.randomUUID()}`,
    'recovery interaction',
  );
  const expiresAt = input.expiresAt ?? at + 15 * 60_000;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= at) {
    throw new Error('Recovery interaction expiry must follow creation.');
  }
  const nextRevision = record.task.revision + 1;
  const interaction: PendingInteractionV2 = {
    interactionId,
    taskId: record.task.taskId,
    taskRevision: nextRevision,
    kind: 'recovery_handoff',
    allowedResponses: {
      version: 2,
      operationId: input.operation.operationId,
      stepId: input.operation.stepId,
      actions,
    } satisfies RecoveryHandoffResponsesV2,
    presentationRef: `recovery:${input.issue.code}:${input.operation.operationId}`,
    status: 'open',
    createdAt: at,
    expiresAt,
  };
  const entryId =
    `recovery-handoff:${input.operation.operationId}:${nextRevision}`;
  const task = parsePhoneTaskV2({
    ...structuredClone(record.task),
    revision: nextRevision,
    status: 'paused',
    activeStepId: input.operation.stepId,
    pendingInteraction: interaction,
    journal: [...record.task.journal, {
      entryId,
      at,
      type: 'recovery_handoff',
      stepId: input.operation.stepId,
      operationId: input.operation.operationId,
      dataRef: interactionId,
    }],
    updatedAt: at,
  });
  return input.repository.commit({
    expectedRevision: record.task.revision,
    task,
    event: {
      eventId: entryId,
      taskId: task.taskId,
      taskRevision: task.revision,
      at,
      kind: 'recovery_handoff',
      dataRef: interactionId,
    },
    ...(record.activeOperation
      ? { activeOperation: record.activeOperation }
      : {}),
  });
}

function responseRef(input: {
  actionId: ExecutableRecoveryActionIdV2;
  interactionId: string;
  operationId: string;
  source: 'tap' | 'voice';
  stepId: string;
  taskId: string;
  taskRevision: number;
}): string {
  return `recovery-response:${createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')}`;
}

function searchRequest(step: PhoneTaskStepV2): string | undefined {
  if (!step.input || typeof step.input !== 'object' || Array.isArray(step.input)) {
    return undefined;
  }
  const request = (step.input as Record<string, unknown>)['request'];
  return typeof request === 'string' && request.trim()
    ? request.trim()
    : undefined;
}

export function priorRecoveryResolutionV2(input: {
  actionId: ExecutableRecoveryActionIdV2;
  interactionId: string;
  operationId: string;
  source: 'tap' | 'voice';
  stepId: string;
  task: PhoneTaskV2;
  taskRevision: number;
}): 'already_resolved' | 'duplicate' | undefined {
  const prefix = `recovery-resolved:${input.interactionId}:`;
  const entry = input.task.journal.find((candidate) =>
    candidate.type === 'resolve_recovery'
    && candidate.entryId.startsWith(prefix));
  if (!entry) return undefined;
  return entry.dataRef === responseRef({
    actionId: input.actionId,
    interactionId: input.interactionId,
    operationId: input.operationId,
    source: input.source,
    stepId: input.stepId,
    taskId: input.task.taskId,
    taskRevision: input.taskRevision,
  })
    ? 'duplicate'
    : 'already_resolved';
}

export async function resolveRecoveryHandoffV2(input: {
  actionId: ExecutableRecoveryActionIdV2;
  at?: number;
  interactionId: string;
  operationId: string;
  repository: PhoneTaskRepositoryV2;
  source: 'tap' | 'voice';
  stepId: string;
  task: PhoneTaskV2;
  taskRevision: number;
}): Promise<TaskRepositoryRecordV2> {
  const pending = input.task.pendingInteraction;
  if (
    !pending
    || pending.kind !== 'recovery_handoff'
    || pending.interactionId !== input.interactionId
    || pending.taskRevision !== input.taskRevision
    || pending.status !== 'open'
  ) {
    throw new Error('The recovery interaction is no longer open.');
  }
  const responses = parseRecoveryHandoffResponsesV2(
    pending.allowedResponses,
  );
  if (
    responses.operationId !== input.operationId
    || responses.stepId !== input.stepId
  ) {
    throw new Error('Recovery action identity does not match the handoff.');
  }
  const allowed = responses.actions.find((candidate) =>
    candidate.actionId === input.actionId);
  if (!allowed) throw new Error('Recovery action is not allowed.');
  if (
    input.actionId === 'check_cart_again'
    && allowed.safety !== 'read_only'
  ) {
    throw new Error('Cart reconciliation must remain read-only.');
  }
  const index = input.task.steps.findIndex((candidate) =>
    candidate.stepId === input.stepId);
  const step = input.task.steps[index];
  if (
    index < 0
    || !step
    || !['failed', 'ambiguous', 'blocked'].includes(step.status)
    || (
      step.operationId !== undefined
      && step.operationId !== input.operationId
    )
  ) {
    throw new Error('Recovery step identity is stale.');
  }
  const at = Math.max(input.at ?? Date.now(), input.task.updatedAt);
  const resultRef = responseRef({
    actionId: input.actionId,
    interactionId: input.interactionId,
    operationId: input.operationId,
    source: input.source,
    stepId: input.stepId,
    taskId: input.task.taskId,
    taskRevision: input.taskRevision,
  });
  const steps = input.task.steps.map((candidate) => ({
    ...candidate,
    dependsOn: [...candidate.dependsOn],
  }));
  let status: PhoneTaskV2['status'] = 'paused';
  let activeStepId: string | undefined = input.stepId;
  let terminalAt: number | undefined;
  if (input.actionId === 'check_cart_again') {
    steps[index] = {
      ...step,
      kind: 'inspect_cart',
      status: 'ready',
      operationId: undefined,
      input: {
        action: 'inspect_cart',
        mode: 'read_only_reconciliation',
        reconcilesOperationId: input.operationId,
      },
      expectedPostcondition: {
        kind: 'cart_contents_observed',
        mutationReplay: false,
      },
      lastResultRef: resultRef,
    };
    status = 'active';
    activeStepId = undefined;
  } else if (input.actionId === 'refresh_choices') {
    const request = searchRequest(step);
    if (!request) {
      throw new Error('The recovery step has no bounded search request.');
    }
    steps[index] = {
      ...step,
      kind: 'search_products',
      status: 'ready',
      operationId: undefined,
      input: { action: 'search_products', request },
      expectedPostcondition: { kind: 'product_choices_observed' },
      lastResultRef: resultRef,
    };
    status = 'active';
    activeStepId = undefined;
  } else if (input.actionId === 'stop_task') {
    status = 'cancelled';
    activeStepId = undefined;
    terminalAt = at;
  }
  const next = parsePhoneTaskV2({
    ...structuredClone(input.task),
    revision: input.task.revision + 1,
    status,
    activeStepId,
    steps,
    pendingInteraction: undefined,
    journal: [...input.task.journal, {
      entryId:
        `recovery-resolved:${input.interactionId}:${input.task.revision + 1}`,
      at,
      type: 'resolve_recovery',
      stepId: input.stepId,
      operationId: input.operationId,
      dataRef: resultRef,
    }],
    updatedAt: at,
    terminalAt,
  });
  return input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId:
        `recovery-resolved:${input.interactionId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: `recovery_${input.actionId}`,
      dataRef: resultRef,
    },
  });
}

export function isReconnectRecoveryActionV2(
  actionId: ExecutableRecoveryActionIdV2,
): boolean {
  return [
    'reconnect_appium',
    'reconnect_phone',
    'reconnect_server',
  ].includes(actionId);
}
