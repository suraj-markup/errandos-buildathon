import { NextResponse } from 'next/server';
import {
  publishBackgroundPhoneOperationTerminalEventV2,
} from '../../../../../../lib/progress/v2/background-phone-operation-events';
import { taskEventStreamV2 } from '../../../../../../lib/progress/v2/task-event-bus';
import type {
  RetainedTaskEventStreamV2,
} from '../../../../../../lib/progress/v2/retained-task-event-stream';
import { parseLocalIdentifier } from '../../../../../../lib/workflow/identifiers';
import {
  publicBackgroundPhoneOperationStatusV2,
} from '../../../../../../lib/workflow/v2/background-phone-operation/contracts';
import {
  backgroundPhoneOperationStoreV2,
} from '../../../../../../lib/workflow/v2/background-phone-operation/runtime-store';
import type {
  BackgroundPhoneOperationStoreV2,
} from '../../../../../../lib/workflow/v2/background-phone-operation/store';

export type BackgroundPhoneOperationStatusRouteDependenciesV2 = {
  store: BackgroundPhoneOperationStoreV2;
  stream: RetainedTaskEventStreamV2;
};

function defaultDependencies():
BackgroundPhoneOperationStatusRouteDependenciesV2 {
  return {
    store: backgroundPhoneOperationStoreV2(),
    stream: taskEventStreamV2,
  };
}

export async function handleBackgroundPhoneOperationStatusRequestV2(
  request: Request,
  dependencies:
    BackgroundPhoneOperationStatusRouteDependenciesV2 = defaultDependencies(),
): Promise<Response> {
  const url = new URL(request.url);
  let operationId;
  try {
    operationId = parseLocalIdentifier(
      'operation',
      url.searchParams.get('operationId'),
    );
  } catch {
    return NextResponse.json(
      { error: 'A valid operationId is required.' },
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
  const operation = await dependencies.store.get(operationId);
  if (!operation) {
    return NextResponse.json(
      { error: 'Background phone operation was not found.' },
      { status: 404 },
    );
  }
  if (
    operation.status === 'completed'
    || operation.status === 'failed'
    || operation.status === 'ambiguous'
  ) {
    publishBackgroundPhoneOperationTerminalEventV2({
      operation,
      stream: dependencies.stream,
    });
  }
  return NextResponse.json({
    version: 2,
    operation: publicBackgroundPhoneOperationStatusV2(operation),
    events: dependencies.stream.readAfter({
      afterSequence,
      taskId: operation.taskId,
    }),
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleBackgroundPhoneOperationStatusRequestV2(request);
}
