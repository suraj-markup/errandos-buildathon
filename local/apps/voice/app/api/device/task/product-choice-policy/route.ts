import { NextResponse } from 'next/server';
import {
  taskEventStreamV2,
  type RetainedTaskEventStreamV2,
} from '../../../../../lib/progress/v2';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../../../../lib/workflow/identifiers';
import {
  commitProductChoicePolicyV2,
  parseProductChoicePolicyUpdateV2,
  phoneTaskRepositoryV2,
  productChoicePolicyStateV2,
  TaskRevisionConflictV2Error,
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskRepositoryV2,
  type ProductChoicePolicyV2,
} from '../../../../../lib/workflow/v2';

export const runtime = 'nodejs';

const MAX_REQUEST_BYTES = 8_192;

type PolicyRequestV2 = {
  clientId: string;
  operation: 'clear' | 'set';
  policy?: unknown;
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  version: 2;
};

export type ProductChoicePolicyRouteDependenciesV2 = {
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
    throw new Error('Product choice policy request has unsupported fields.');
  }
}

function clientId(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)
  ) {
    throw new Error('clientId is invalid.');
  }
  return value;
}

function parseRequest(value: unknown): PolicyRequestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Product choice policy request must be an object.');
  }
  const input = value as Record<string, unknown>;
  exactKeys(
    input,
    ['clientId', 'operation', 'policy', 'taskId', 'taskRevision', 'version'],
  );
  if (input['version'] !== 2) {
    throw new Error('Unsupported product choice policy version.');
  }
  if (!['clear', 'set'].includes(String(input['operation'] ?? ''))) {
    throw new Error('Product choice policy operation is invalid.');
  }
  if (
    !Number.isSafeInteger(input['taskRevision'])
    || (input['taskRevision'] as number) < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  const operation = input['operation'] as PolicyRequestV2['operation'];
  if (
    operation === 'set' && input['policy'] === undefined
    || operation === 'clear' && input['policy'] !== undefined
  ) {
    throw new Error('Product choice policy payload does not match operation.');
  }
  return {
    clientId: clientId(input['clientId']),
    operation,
    ...(operation === 'set' ? { policy: input['policy'] } : {}),
    taskId: parseLocalIdentifier('task', input['taskId']),
    taskRevision: input['taskRevision'] as number,
    version: 2,
  };
}

function policyLabel(policy: ProductChoicePolicyV2 | undefined): string {
  switch (policy?.mode ?? 'ask_every_time') {
    case 'ask_every_time':
      return 'Ask every time';
    case 'known_brand_then_lowest_price':
      return 'Known brand, then lowest price';
    case 'lowest_price_matching_pack':
      return 'Lowest price for the matching pack';
    case 'repeat_previous_preference':
      return 'Repeat the previous preference';
    case 'suggested_with_price_limit':
      return 'Suggested item within the price limit';
  }
  return 'Ask every time';
}

function defaultDependencies(): ProductChoicePolicyRouteDependenciesV2 {
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

export async function handleProductChoicePolicyRequestV2(
  request: Request,
  dependencies: ProductChoicePolicyRouteDependenciesV2 = defaultDependencies(),
): Promise<Response> {
  let input: PolicyRequestV2;
  try {
    const contentType = request.headers.get('content-type')?.split(';')[0];
    if (contentType !== 'application/json') {
      throw new Error('Content-Type must be application/json.');
    }
    const body = await request.text();
    if (
      new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES
      || body.length === 0
    ) {
      throw new Error('Product choice policy request is too large or empty.');
    }
    input = parseRequest(JSON.parse(body));
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : 'Invalid policy request.',
      400,
    );
  }

  const current = await dependencies.repository.getById(input.taskId);
  if (!current) return rejected('unknown_task', 404);
  if (current.task.clientId !== input.clientId) {
    return rejected('client_task_mismatch', 403);
  }
  if (TERMINAL_TASK_STATUSES_V2.has(current.task.status)) {
    return rejected('task_terminal', 409);
  }
  if (current.task.revision !== input.taskRevision) {
    return rejected('stale_task_revision', 409, {
      actualRevision: current.task.revision,
    });
  }

  let policy: ProductChoicePolicyV2 | undefined;
  try {
    policy = input.operation === 'set'
      ? parseProductChoicePolicyUpdateV2(current.task, input.policy)
      : undefined;
  } catch (error) {
    return rejected(
      error instanceof Error ? error.message : 'Invalid policy.',
      400,
    );
  }

  try {
    const committed = await commitProductChoicePolicyV2({
      at: dependencies.now(),
      expectedRevision: input.taskRevision,
      ...(policy ? { policy } : {}),
      repository: dependencies.repository,
      taskId: input.taskId,
    });
    const state = productChoicePolicyStateV2(
      committed.task.productChoicePolicy,
    );
    const label = policyLabel(committed.task.productChoicePolicy);
    try {
      dependencies.stream.publish({
        announcement: {
          channel: 'visual_only',
          text: `Product choice preference: ${label}.`,
        },
        dedupeKey:
          `product-choice-policy:${committed.task.taskId}:${committed.task.revision}`,
        detail: `Product choice preference: ${label}.`,
        kind: 'selection_accepted',
        safePresentation: {
          version: 1,
          mode: 'success',
          primarySurface: 'overlay_card',
          card: {
            type: 'compact_status',
            tone: 'success',
          },
          spoken: {
            languageCode: 'en-IN',
            text: `Product choice preference: ${label}.`,
          },
          behavior: {
            autoCollapse: true,
            keepVisibleWhileSpeaking: false,
          },
        },
        taskId: input.taskId,
        taskRevision: committed.task.revision,
        title: 'Product choice preference updated',
      });
    } catch {
      // Retained presentation is best effort; repository truth is authoritative.
    }
    return NextResponse.json({
      version: 2,
      acknowledgement: 'accepted',
      taskId: input.taskId,
      taskRevision: committed.task.revision,
      policy: state,
    });
  } catch (error) {
    if (error instanceof TaskRevisionConflictV2Error) {
      return rejected('stale_task_revision', 409, {
        actualRevision: error.actualRevision,
      });
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleProductChoicePolicyRequestV2(request);
}
