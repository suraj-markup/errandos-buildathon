import { NextResponse } from 'next/server';
import {
  ensureCompletionChoicePromptEventV2,
  ensureTaskCancelledEventV2,
  authoritativeTaskQueueProjectionV2,
  taskEventStreamV2,
  type RetainedTaskEventStreamV2,
} from '../../../../../lib/progress/v2';
import { parseLocalIdentifier } from '../../../../../lib/workflow/identifiers';
import {
  phoneTaskRepositoryV2,
  TERMINAL_TASK_STATUSES_V2,
  type PhoneTaskRepositoryV2,
} from '../../../../../lib/workflow/v2';
import {
  DeterministicUxTimingMetricsCollectorV1,
  uxTimingMetricsV1,
} from '../../../../../lib/ux-timing-metrics';

const DEFAULT_LONG_POLL_MS = 4_000;
const MAX_LONG_POLL_MS = 4_500;

export type TaskEventsRouteDependencies = {
  metrics?: DeterministicUxTimingMetricsCollectorV1;
  now: () => number;
  repository: PhoneTaskRepositoryV2;
  stream: RetainedTaskEventStreamV2;
};

function defaultDependencies(): TaskEventsRouteDependencies {
  return {
    now: Date.now,
    repository: phoneTaskRepositoryV2(),
    stream: taskEventStreamV2,
  };
}

export async function handleTaskEventsRequest(
  request: Request,
  dependencies: TaskEventsRouteDependencies = defaultDependencies(),
): Promise<Response> {
  const url = new URL(request.url);
  let taskId;
  try {
    taskId = parseLocalIdentifier('task', url.searchParams.get('taskId'));
  } catch {
    return NextResponse.json(
      { error: 'A valid taskId is required.' },
      { status: 400 },
    );
  }
  const afterValue = url.searchParams.get('afterSequence');
  const afterSequence = afterValue === null ? -1 : Number(afterValue);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
    return NextResponse.json(
      { error: 'afterSequence must be -1 or a non-negative integer.' },
      { status: 400 },
    );
  }
  const waitValue = url.searchParams.get('waitMs');
  const waitMs = waitValue === null ? DEFAULT_LONG_POLL_MS : Number(waitValue);
  if (
    !Number.isSafeInteger(waitMs)
    || waitMs < 0
    || waitMs > MAX_LONG_POLL_MS
  ) {
    return NextResponse.json(
      { error: `waitMs must be an integer between 0 and ${MAX_LONG_POLL_MS}.` },
      { status: 400 },
    );
  }
  const record = await dependencies.repository.getById(taskId);
  const delivery = (dependencies.metrics ?? uxTimingMetricsV1).begin(
    'event_delivery',
    {
      ...(record ? { clientId: record.task.clientId } : {}),
      taskId,
    },
  );
  const respond = (
    snapshot: Awaited<ReturnType<RetainedTaskEventStreamV2['waitAfter']>>,
    outcome: 'cancelled' | 'completed' | 'timeout',
    task?: ReturnType<typeof authoritativeTaskQueueProjectionV2>,
  ): Response => {
    delivery.finish({ outcome });
    return NextResponse.json({
      ...snapshot,
      ...(task ? { task } : {}),
    });
  };
  if (record) {
    if (record.task.status === 'cancelled') {
      ensureTaskCancelledEventV2({
        stream: dependencies.stream,
        taskId,
        taskRevision: record.task.revision,
      });
    } else {
      ensureCompletionChoicePromptEventV2({
        now: dependencies.now(),
        stream: dependencies.stream,
        task: record.task,
      });
    }
  }
  if (!record) {
    return respond(
      dependencies.stream.readAfter({
        afterSequence,
        taskId,
      }),
      'completed',
    );
  }
  const terminal =
    TERMINAL_TASK_STATUSES_V2.has(record.task.status);
  const snapshot = await dependencies.stream.waitAfter({
    afterSequence,
    signal: request.signal,
    subscriptionId: record.task.clientId,
    taskId,
    timeoutMs:
      terminal
      || request.signal.aborted
        ? 0
        : waitMs,
  });
  const latestRecord = await dependencies.repository.getById(taskId);
  return respond(
    snapshot,
    snapshot.events.length > 0
      ? 'completed'
      : request.signal.aborted
        ? 'cancelled'
        : !terminal && waitMs > 0
          ? 'timeout'
          : 'completed',
    latestRecord
      ? authoritativeTaskQueueProjectionV2(latestRecord)
      : undefined,
  );
}

export async function GET(request: Request): Promise<Response> {
  return handleTaskEventsRequest(request);
}
