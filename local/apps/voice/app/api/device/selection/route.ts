import { NextResponse } from 'next/server';
import {
  errorDetails,
  logEvent,
  newRequestId,
  updateLogContext,
  withLogContext,
} from '../../../../lib/structured-logger';
import {
  correlatedResult,
  correlationFields,
  createCorrelationContext,
  extendCorrelationContext,
} from '../../../../lib/correlation';
import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from '../../../../lib/workflow/identifiers';
import {
  phoneTaskRepositoryV2,
  type PhoneTaskRepositoryV2,
} from '../../../../lib/workflow/v2';
import {
  enqueueProductionBackgroundPhoneOperationV2,
} from '../../../../lib/workflow/v2/background-phone-operation/production-adapter';
import {
  executeResolvedProductSelectionV2,
  resolveProductSelectionInteractionV2,
} from '../../../../lib/voice-turn/product-selection-interaction';

export const runtime = 'nodejs';

type ProductSelectionRequestV2 = {
  clientId: string;
  interactionId: string;
  offerId: string;
  selectionId: LocalIdentifier<'selection'>;
  source: 'tap' | 'voice';
  taskId: LocalIdentifier<'task'>;
  taskRevision: number;
  version: 2;
};

export type ProductSelectionRouteDependencies = {
  now: () => number;
  repository: PhoneTaskRepositoryV2;
  enqueue?: typeof enqueueProductionBackgroundPhoneOperationV2;
  execute?: Parameters<
    typeof executeResolvedProductSelectionV2
  >[1]['execute'];
};

function exactString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw new Error(`${field} must be a non-empty exact string.`);
  }
  return value;
}

function clientIdentifier(value: unknown): string {
  const clientId = exactString(value, 'clientId', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(clientId)) {
    throw new Error('clientId must be a sanitized opaque identifier.');
  }
  return clientId;
}

function interactionIdentifier(value: unknown): string {
  const interactionId = exactString(value, 'interactionId', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(interactionId)) {
    throw new Error('interactionId must be a sanitized opaque identifier.');
  }
  return interactionId;
}

function parseSelectionRequest(value: unknown): ProductSelectionRequestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Selection request must be an object.');
  }
  const input = value as Record<string, unknown>;
  if (input['version'] !== 2) {
    throw new Error('Unsupported selection request version.');
  }
  const source = input['source'];
  if (source !== 'tap' && source !== 'voice') {
    throw new Error('source must be tap or voice.');
  }
  const taskRevision = input['taskRevision'];
  if (
    typeof taskRevision !== 'number'
    || !Number.isSafeInteger(taskRevision)
    || taskRevision < 0
  ) {
    throw new Error('taskRevision must be a non-negative integer.');
  }
  return {
    clientId: clientIdentifier(input['clientId']),
    interactionId: interactionIdentifier(input['interactionId']),
    offerId: exactString(input['offerId'], 'offerId', 256),
    selectionId: parseLocalIdentifier('selection', input['selectionId']),
    source,
    taskId: parseLocalIdentifier('task', input['taskId']),
    taskRevision,
    version: 2,
  };
}

function rejected(
  input: ProductSelectionRequestV2 | undefined,
  reason: string,
  status: number,
  requestId: string,
  actualRevision?: number,
  winner?: {
    offerId: string;
    responseRef: string;
    selectionId?: LocalIdentifier<'selection'>;
    source?: 'tap' | 'voice';
  },
): Response {
  return NextResponse.json({
    version: 2,
    acknowledgement: 'rejected',
    mutationDisposition: 'none',
    ok: false,
    reason,
    requestId,
    status: reason === 'already_resolved' ? 'conflict' : 'rejected',
    ...(actualRevision === undefined ? {} : { actualRevision }),
    ...(winner ? { winner } : {}),
    ...(input
      ? {
          interactionId: input.interactionId,
          offerId: input.offerId,
          selectionId: input.selectionId,
          taskId: input.taskId,
          taskRevision: input.taskRevision,
        }
      : {}),
  }, { status });
}

function defaultDependencies(): ProductSelectionRouteDependencies {
  return {
    enqueue: enqueueProductionBackgroundPhoneOperationV2,
    now: Date.now,
    repository: phoneTaskRepositoryV2(),
  };
}

export async function handleProductSelectionRequest(
  request: Request,
  dependencies: ProductSelectionRouteDependencies = defaultDependencies(),
): Promise<Response> {
  const requestedId = request.headers.get('x-request-id')?.trim();
  const requestId = requestedId
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(requestedId)
    ? requestedId
    : newRequestId();
  return withLogContext(
    { requestId, route: 'device.selection' },
    async () => {
      const startedAt = performance.now();
      logEvent('info', 'request.start', { method: request.method });

      let input: ProductSelectionRequestV2;
      try {
        input = parseSelectionRequest(await request.json());
      } catch (error) {
        logEvent('warn', 'request.rejected', {
          durationMs: Math.round(performance.now() - startedAt),
          ...errorDetails(error),
          reason: 'malformed_selection_request',
        });
        return rejected(
          undefined,
          'malformed_selection_request',
          400,
          requestId,
        );
      }

      updateLogContext({
        clientId: input.clientId,
        selectionId: input.selectionId,
        taskId: input.taskId,
      });
      let correlation = createCorrelationContext({
        clientId: input.clientId,
        requestId,
        selectionId: input.selectionId,
        taskId: input.taskId,
      });
      const resolution = await resolveProductSelectionInteractionV2(
        input,
        dependencies,
      );
      if (resolution.acknowledgement === 'rejected') {
        return rejected(
          input,
          resolution.reason,
          resolution.status,
          requestId,
          resolution.actualRevision,
          resolution.winner,
        );
      }
      if (resolution.acknowledgement === 'duplicate') {
        return NextResponse.json({
          version: 2,
          acknowledgement: 'duplicate',
          mutationDisposition: 'none',
          ok: true,
          interactionId: input.interactionId,
          offerId: input.offerId,
          selectionId: input.selectionId,
          taskId: input.taskId,
          taskRevision: resolution.record.task.revision,
          requestId,
          status: 'duplicate',
          winner: resolution.winner,
        });
      }

      const execution = await executeResolvedProductSelectionV2(
        resolution,
        dependencies,
      );
      correlation = extendCorrelationContext(correlation, {
        operationId: execution.operationId,
      });
      updateLogContext(correlationFields(correlation));
      logEvent('info', 'product_selection.accepted', {
        durationMs: Math.round(performance.now() - startedAt),
        interactionId: input.interactionId,
        offerId: input.offerId,
        selectionId: input.selectionId,
        selectionSource: input.source,
      });
      return NextResponse.json(correlatedResult({
        version: 2,
        acknowledgement: 'accepted',
        interactionId: input.interactionId,
        mutationDisposition: 'enqueued_once',
        ok: true,
        offerId: input.offerId,
        operationId: execution.operationId,
        requestId,
        resolution: {
          offer: resolution.choice,
          selectionId: input.selectionId,
          source: input.source,
        },
        selectionId: input.selectionId,
        status: 'accepted',
        taskId: input.taskId,
        taskRevision: execution.record.task.revision,
        winner: resolution.winner,
        ...(execution.result === undefined
          ? {}
          : { execution: { published: true, result: execution.result } }),
      }, correlation));
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleProductSelectionRequest(request);
}
