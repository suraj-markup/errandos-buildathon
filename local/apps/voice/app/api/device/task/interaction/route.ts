import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  completionChoiceIdsV2,
  completionChoicePromptForTaskV2,
  resolveCompletionChoiceV2,
  taskEventStreamV2,
  type CompletionChoiceIdV2,
  type RetainedTaskEventStreamV2,
} from '../../../../../lib/progress/v2';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../../../../lib/workflow/identifiers';
import {
  phoneTaskRepositoryV2,
  resolveNextActionChoiceV2,
  resolveV2InteractionForCompatibility,
  TaskRevisionConflictV2Error,
  type PhoneTaskRepositoryV2,
  type PhoneTaskV2,
  type NextActionChoiceV2,
} from '../../../../../lib/workflow/v2';
import {
  recordUxTimingIntervalSafelyV1,
  uxTimingMetricsV1,
  type DeterministicUxTimingMetricsCollectorV1,
  type UxTimingMetricV1,
} from '../../../../../lib/ux-timing-metrics';

export const runtime = 'nodejs';

type CompletionInteractionRequestV2 = {
  choiceId: CompletionChoiceIdV2;
  clientId: string;
  interactionId: string;
  source: 'tap';
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  version: 2;
};

export type CompletionInteractionRouteDependencies = {
  newContinuationStepId?: () => string;
  now: () => number;
  metrics?: DeterministicUxTimingMetricsCollectorV1;
  repository: PhoneTaskRepositoryV2;
  stream: RetainedTaskEventStreamV2;
};

function exactString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new Error(`${field} must be an exact non-empty string.`);
  }
  return value;
}

function clientId(value: unknown): string {
  const result = exactString(value, 'clientId', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(result)) {
    throw new Error('clientId is invalid.');
  }
  return result;
}

function interactionId(value: unknown): string {
  const result = exactString(value, 'interactionId', 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(result)) {
    throw new Error('interactionId is invalid.');
  }
  return result;
}

function parseRequest(value: unknown): CompletionInteractionRequestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Interaction request must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (input['version'] !== 2) {
    throw new Error('Unsupported interaction request version.');
  }
  if (input['source'] !== 'tap') {
    throw new Error('The device interaction route accepts tap input only.');
  }
  const taskRevision = input['taskRevision'];
  if (
    typeof taskRevision !== 'number'
    || !Number.isSafeInteger(taskRevision)
    || taskRevision < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  const requestedChoiceId = exactString(input['choiceId'], 'choiceId', 40);
  const choiceId = requestedChoiceId === 'keep_shopping'
    ? 'add_more'
    : requestedChoiceId;
  if (!completionChoiceIdsV2.includes(choiceId as CompletionChoiceIdV2)) {
    throw new Error('choiceId is invalid.');
  }
  return {
    choiceId: choiceId as CompletionChoiceIdV2,
    clientId: clientId(input['clientId']),
    interactionId: interactionId(input['interactionId']),
    source: 'tap',
    taskId: parseLocalIdentifier('task', input['taskId']),
    taskRevision,
    version: 2,
  };
}

function responseRef(
  input: Pick<
    CompletionInteractionRequestV2,
    'choiceId' | 'interactionId' | 'source' | 'taskId' | 'taskRevision'
  >,
): string {
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return `completion-choice:${digest}`;
}

function priorResolution(
  task: PhoneTaskV2,
  input: CompletionInteractionRequestV2,
): 'already_resolved' | 'duplicate' | undefined {
  const prefix = `interaction-resolved:${input.interactionId}:`;
  const entry = task.journal.find((candidate) =>
    candidate.type === 'resolve_interaction'
    && candidate.entryId.startsWith(prefix));
  if (!entry) return undefined;
  return entry.dataRef === responseRef(input)
    ? 'duplicate'
    : 'already_resolved';
}

function rejected(
  input: CompletionInteractionRequestV2 | undefined,
  reason: string,
  status: number,
): Response {
  return NextResponse.json({
    version: 2,
    acknowledgement: 'rejected',
    reason,
    ...(input
      ? {
          choiceId: input.choiceId,
          interactionId: input.interactionId,
          taskId: input.taskId,
          taskRevision: input.taskRevision,
        }
      : {}),
  }, { status });
}

function replayResponse(
  task: PhoneTaskV2,
  input: CompletionInteractionRequestV2,
): Response | undefined {
  const replay = priorResolution(task, input);
  if (!replay) return undefined;
  if (replay === 'duplicate') {
    return NextResponse.json({
      version: 2,
      acknowledgement: 'duplicate',
      choiceId: input.choiceId,
      interactionId: input.interactionId,
      taskId: input.taskId,
      taskRevision: task.revision,
    });
  }
  return rejected(input, 'already_resolved', 409);
}

function defaultDependencies(): CompletionInteractionRouteDependencies {
  return {
    newContinuationStepId: () => `step:next-action:${crypto.randomUUID()}`,
    now: Date.now,
    repository: phoneTaskRepositoryV2(),
    stream: taskEventStreamV2,
  };
}

export async function handleCompletionInteractionRequest(
  request: Request,
  dependencies: CompletionInteractionRouteDependencies = defaultDependencies(),
): Promise<Response> {
  const acknowledgementStartedAt = dependencies.now();
  const metrics = dependencies.metrics ?? uxTimingMetricsV1;
  const finish = (
    response: Response,
    outcome: UxTimingMetricV1['outcome'],
    correlation?: CompletionInteractionRequestV2,
    choiceStartedAt?: number,
  ): Response => {
    const endedAt = dependencies.now();
    const ids = correlation
      ? {
          clientId: correlation.clientId,
          interactionId: correlation.interactionId,
          taskId: correlation.taskId,
        }
      : {};
    if (choiceStartedAt !== undefined) {
      recordUxTimingIntervalSafelyV1(metrics, {
        ...ids,
        endedAt: acknowledgementStartedAt,
        outcome,
        phase: 'choice_wait',
        startedAt: choiceStartedAt,
      });
    }
    recordUxTimingIntervalSafelyV1(metrics, {
      ...ids,
      endedAt,
      outcome,
      phase: 'choice_acknowledgement',
      startedAt: acknowledgementStartedAt,
      targetMs: 250,
    });
    return response;
  };
  let input: CompletionInteractionRequestV2;
  try {
    input = parseRequest(await request.json());
  } catch {
    return finish(
      rejected(undefined, 'malformed_interaction_request', 400),
      'rejected',
    );
  }

  const record = await dependencies.repository.getById(input.taskId);
  if (!record) {
    return finish(rejected(input, 'unknown_task', 404), 'rejected', input);
  }
  if (record.task.clientId !== input.clientId) {
    return finish(
      rejected(input, 'client_task_mismatch', 403),
      'rejected',
      input,
    );
  }
  const replay = replayResponse(record.task, input);
  if (replay) {
    return finish(
      replay,
      priorResolution(record.task, input) === 'duplicate'
        ? 'duplicate'
        : 'rejected',
      input,
    );
  }
  if (record.task.status === 'paused') {
    return finish(
      rejected(input, 'task_paused', 409),
      'rejected',
      input,
      record.task.pendingInteraction?.createdAt,
    );
  }
  if (record.task.revision !== input.taskRevision) {
    return finish(
      rejected(input, 'stale_revision', 409),
      'rejected',
      input,
    );
  }
  const pending = record.task.pendingInteraction;
  if (!pending || pending.interactionId !== input.interactionId) {
    return finish(
      rejected(input, 'unknown_interaction', 404),
      'rejected',
      input,
    );
  }
  if (
    pending.taskId !== input.taskId
    || pending.taskRevision !== input.taskRevision
    || pending.status !== 'open'
  ) {
    return finish(
      rejected(input, 'stale_interaction', 409),
      'rejected',
      input,
      pending.createdAt,
    );
  }
  if (dependencies.now() >= pending.expiresAt) {
    return finish(
      rejected(input, 'expired', 409),
      'rejected',
      input,
      pending.createdAt,
    );
  }
  const prompt = completionChoicePromptForTaskV2({
    now: dependencies.now(),
    task: record.task,
  });
  if (!prompt) {
    return finish(
      rejected(input, 'unsupported_interaction', 422),
      'rejected',
      input,
      pending.createdAt,
    );
  }
  const resolution = resolveCompletionChoiceV2({
    choiceId: input.choiceId,
    now: dependencies.now(),
    prompt,
    source: input.source,
    taskRevision: input.taskRevision,
  });
  if (!resolution.accepted) {
    return finish(
      rejected(
        input,
        resolution.reason,
        resolution.reason === 'choice_unavailable' ? 422 : 409,
      ),
      'rejected',
      input,
      pending.createdAt,
    );
  }

  let committed;
  try {
    committed = pending.kind === 'next_action'
      ? await resolveNextActionChoiceV2({
          at: dependencies.now(),
          choice: resolution.choiceId as NextActionChoiceV2,
          ...(resolution.choiceId === 'review_cart'
            ? {
                continuationStepId:
                  dependencies.newContinuationStepId?.()
                  ?? `step:next-action:${crypto.randomUUID()}`,
              }
            : {}),
          repository: dependencies.repository,
          responseRef: responseRef(input),
          task: record.task,
        })
      : await resolveV2InteractionForCompatibility({
          at: dependencies.now(),
          repository: dependencies.repository,
          responseRef: responseRef(input),
          task: record.task,
        });
  } catch (error) {
    if (!(error instanceof TaskRevisionConflictV2Error)) throw error;
    const latest = await dependencies.repository.getById(input.taskId);
    if (latest) {
      const racedReplay = replayResponse(latest.task, input);
      if (racedReplay) {
        return finish(
          racedReplay,
          priorResolution(latest.task, input) === 'duplicate'
            ? 'duplicate'
            : 'rejected',
          input,
          pending.createdAt,
        );
      }
    }
    return finish(
      rejected(input, 'stale_revision', 409),
      'rejected',
      input,
      pending.createdAt,
    );
  }

  const selected = prompt.choices.find(
    (choice) => choice.choiceId === resolution.choiceId,
  )!;
  const event = dependencies.stream.publish({
    dedupeKey: responseRef(input),
    kind: 'selection_accepted',
    ...(committed.task.activeStepId
      ? { stepId: committed.task.activeStepId }
      : {}),
    taskId: input.taskId,
    taskRevision: committed.task.revision,
    title: `${selected.label} selected`,
    detail: 'The choice was accepted once. Preparing the next safe step.',
    announcement: {
      channel: 'visual_only',
      text: `${selected.label} selected.`,
    },
  });
  if (
    committed.task.status === 'completed'
    && committed.task.terminalAt !== undefined
  ) {
    recordUxTimingIntervalSafelyV1(metrics, {
      clientId: input.clientId,
      endedAt: committed.task.terminalAt,
      outcome: 'completed',
      phase: 'task_completion',
      startedAt: committed.task.createdAt,
      taskId: input.taskId,
    });
  }
  return finish(
    NextResponse.json({
      version: 2,
      acknowledgement: 'accepted',
      choiceId: resolution.choiceId,
      command: resolution.command,
      event: {
        eventId: event.eventId,
        sequence: event.sequence,
      },
      interactionId: input.interactionId,
      taskId: input.taskId,
      taskRevision: committed.task.revision,
    }),
    'completed',
    input,
    pending.createdAt,
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleCompletionInteractionRequest(request);
}
