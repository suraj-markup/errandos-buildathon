import { NextResponse } from 'next/server';
import {
  taskEventStreamV2,
  type RetainedTaskEventStreamV2,
  type SemanticTaskEventDraftV2,
} from '../../../../../lib/progress/v2';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../../../../lib/workflow/identifiers';
import {
  commitQueueEditV2,
  InvalidPhoneTaskV2TransitionError,
  phoneTaskRepositoryV2,
  priorQueueEditV2,
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
  type QueueEditCommandV2,
  type QueueEditOutcomeV2,
} from '../../../../../lib/workflow/v2';

export const runtime = 'nodejs';

const MAX_REQUEST_BYTES = 8_192;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type QueueEditRequestV2 = {
  clientId: string;
  command: QueueEditCommandV2;
  commandId: string;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  version: 2;
};

export type QueueEditRouteDependenciesV2 = {
  now: () => number;
  repository: PhoneTaskRepositoryV2;
  stream: RetainedTaskEventStreamV2;
};

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error('Queue edit request has unsupported fields.');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Queue edit command must be an object.');
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string, maximum = 160): string {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || !identifierPattern.test(value)
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function text(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function parseCommand(value: unknown): QueueEditCommandV2 {
  const input = record(value);
  const command = input['command'];
  if (command === 'refine') {
    exactKeys(input, ['command', 'quantity', 'request', 'stepId']);
    const quantity = input['quantity'];
    if (
      quantity !== undefined
      && (!Number.isSafeInteger(quantity) || (quantity as number) < 1
        || (quantity as number) > 100)
    ) {
      throw new Error('quantity must be an integer between 1 and 100.');
    }
    return {
      command,
      request: text(input['request'], 'request', 160),
      stepId: identifier(input['stepId'], 'stepId'),
      ...(quantity === undefined ? {} : { quantity: quantity as number }),
    };
  }
  if (command === 'remove' || command === 'skip') {
    exactKeys(input, ['command', 'stepId']);
    return {
      command,
      stepId: identifier(input['stepId'], 'stepId'),
    };
  }
  if (command === 'reorder') {
    exactKeys(input, ['command', 'orderedStepIds']);
    if (
      !Array.isArray(input['orderedStepIds'])
      || input['orderedStepIds'].length < 2
      || input['orderedStepIds'].length > 50
    ) {
      throw new Error('orderedStepIds must contain 2 to 50 items.');
    }
    return {
      command,
      orderedStepIds: input['orderedStepIds'].map((stepId) =>
        identifier(stepId, 'orderedStepId')),
    };
  }
  if (command === 'pause' || command === 'resume' || command === 'cancel') {
    exactKeys(input, ['command']);
    return { command };
  }
  throw new Error('Queue edit command is unsupported.');
}

function parseRequest(value: unknown): QueueEditRequestV2 {
  const input = record(value);
  exactKeys(
    input,
    ['clientId', 'command', 'commandId', 'taskId', 'taskRevision', 'version'],
  );
  if (input['version'] !== 2) {
    throw new Error('Unsupported queue edit version.');
  }
  if (
    !Number.isSafeInteger(input['taskRevision'])
    || (input['taskRevision'] as number) < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  return {
    version: 2,
    clientId: identifier(input['clientId'], 'clientId', 80),
    command: parseCommand(input['command']),
    commandId: identifier(input['commandId'], 'commandId'),
    taskId: parseLocalIdentifier('task', input['taskId']),
    taskRevision: input['taskRevision'] as number,
  };
}

function defaultDependencies(): QueueEditRouteDependenciesV2 {
  return {
    now: Date.now,
    repository: phoneTaskRepositoryV2(),
    stream: taskEventStreamV2,
  };
}

function rejected(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
): Response {
  return NextResponse.json({
    version: 2,
    acknowledgement: 'rejected',
    error,
    ...extra,
  }, { status });
}

function queueProgress(task: PhoneTaskV2): {
  completed: number;
  nextLabel?: string;
  total: number;
} {
  const items = task.steps.filter((step) =>
    ['add_cart_item', 'search_products'].includes(step.kind));
  const completed = items.filter((step) =>
    ['verified', 'skipped'].includes(step.status)).length;
  const next = items.find((step) =>
    ['ready', 'planned'].includes(step.status));
  const nextInput = next?.input && typeof next.input === 'object'
    ? next.input as Record<string, unknown>
    : undefined;
  const nextLabel = typeof nextInput?.['request'] === 'string'
    ? nextInput['request']
    : undefined;
  return {
    completed,
    total: items.length,
    ...(nextLabel ? { nextLabel } : {}),
  };
}

function eventFor(
  input: QueueEditRequestV2,
  outcome: QueueEditOutcomeV2,
  task: PhoneTaskV2,
): SemanticTaskEventDraftV2 {
  const labels: Record<QueueEditOutcomeV2, {
    detail: string;
    kind: SemanticTaskEventDraftV2['kind'];
    title: string;
  }> = {
    updated: {
      title: 'Task list updated',
      detail: 'The remaining items were updated from authoritative task state.',
      kind: 'selection_accepted',
    },
    paused: {
      title: 'Task paused',
      detail: 'No new phone operation will start until this task resumes.',
      kind: 'waiting_for_user',
    },
    resumed: {
      title: 'Task resumed',
      detail: 'The next safe item can now continue.',
      kind: 'moving_to_next_step',
    },
    cancelled: {
      title: 'Task cancelled',
      detail: 'No new phone operation will run for this task.',
      kind: 'cancelled',
    },
    cancellation_requested: {
      title: 'Cancellation requested',
      detail:
        'The active phone operation was preserved and no later item will start.',
      kind: 'blocked',
    },
  };
  const label = labels[outcome];
  return {
    announcement: {
      channel: 'visual_only',
      text: label.title,
    },
    dedupeKey: `queue-edit:${input.commandId}`,
    detail: label.detail,
    kind: label.kind,
    progress: queueProgress(task),
    taskId: input.taskId,
    taskRevision: task.revision,
    ...(outcome === 'cancelled' ? { terminal: true } : {}),
    title: label.title,
  };
}

async function readRequest(request: Request): Promise<QueueEditRequestV2> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new Error('Content-Type must be application/json.');
  }
  const body = await request.text();
  if (
    !body
    || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES
  ) {
    throw new Error('Queue edit request is too large or empty.');
  }
  return parseRequest(JSON.parse(body));
}

export async function handleQueueEditRequestV2(
  request: Request,
  dependencies: QueueEditRouteDependenciesV2 = defaultDependencies(),
): Promise<Response> {
  let input: QueueEditRequestV2;
  try {
    input = await readRequest(request);
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : 'Invalid queue edit request.',
      400,
    );
  }

  let current = await dependencies.repository.getById(input.taskId);
  if (!current) return rejected('unknown_task', 404);
  if (current.task.clientId !== input.clientId) {
    return rejected('client_task_mismatch', 403);
  }
  const prior = priorQueueEditV2(current.task, {
    command: input.command,
    commandId: input.commandId,
  });
  if (prior === 'command_id_conflict') {
    return rejected('command_id_conflict', 409);
  }
  if (prior === 'duplicate') {
    return NextResponse.json({
      version: 2,
      acknowledgement: 'duplicate',
      commandId: input.commandId,
      taskId: input.taskId,
      taskRevision: current.task.revision,
    });
  }

  try {
    const result = await commitQueueEditV2({
      at: Math.max(dependencies.now(), current.task.updatedAt),
      command: input.command,
      commandId: input.commandId,
      expectedRevision: input.taskRevision,
      repository: dependencies.repository,
      taskId: input.taskId,
    });
    try {
      dependencies.stream.publish(
        eventFor(input, result.outcome, result.record.task),
      );
    } catch {
      // Repository truth is authoritative; retained UI projection is best effort.
    }
    return NextResponse.json({
      version: 2,
      acknowledgement: 'accepted',
      commandId: input.commandId,
      outcome: result.outcome,
      taskId: input.taskId,
      taskRevision: result.record.task.revision,
    });
  } catch (error) {
    if (error instanceof TaskRevisionConflictV2Error) {
      current = await dependencies.repository.getById(input.taskId);
      const raced = current
        ? priorQueueEditV2(current.task, {
            command: input.command,
            commandId: input.commandId,
          })
        : undefined;
      if (raced === 'duplicate' && current) {
        return NextResponse.json({
          version: 2,
          acknowledgement: 'duplicate',
          commandId: input.commandId,
          taskId: input.taskId,
          taskRevision: current.task.revision,
        });
      }
      return rejected('stale_task_revision', 409, {
        actualRevision: current?.task.revision ?? error.actualRevision,
      });
    }
    if (error instanceof InvalidPhoneTaskV2TransitionError) {
      return rejected(error.message, 409);
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleQueueEditRequestV2(request);
}
