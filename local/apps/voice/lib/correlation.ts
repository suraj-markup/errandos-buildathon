import {
  parseLocalIdentifier,
  type LocalIdentifier,
} from './workflow/identifiers';

const correlationFieldNames = [
  'requestId',
  'clientId',
  'taskId',
  'itemId',
  'operationId',
  'clarificationId',
  'selectionId',
  'observationId',
  'realtimeSessionId',
] as const;

type CorrelationFieldName = (typeof correlationFieldNames)[number];

export type CorrelationContextV1 = {
  clarificationId?: LocalIdentifier<'clarification'>;
  clientId: string;
  itemId?: LocalIdentifier<'task_item'>;
  observationId?: LocalIdentifier<'observation'> | string;
  operationId?: LocalIdentifier<'operation'>;
  realtimeSessionId?: LocalIdentifier<'realtime'>;
  requestId: string;
  selectionId?: LocalIdentifier<'selection'>;
  taskId?: LocalIdentifier<'task'>;
  version: 1;
};

type CorrelationInput = {
  clarificationId?: unknown;
  clientId: unknown;
  itemId?: unknown;
  observationId?: unknown;
  operationId?: unknown;
  realtimeSessionId?: unknown;
  requestId: unknown;
  selectionId?: unknown;
  taskId?: unknown;
};

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/;
const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_LEGACY_OBSERVATION_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f-]{27,72}|observation[-_][A-Za-z0-9-]{8,80})$/i;

function opaqueId(
  value: unknown,
  pattern: RegExp,
  field: string,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${field} correlation identifier.`);
  }
  return value;
}

function optionalLocal<K extends
  | 'clarification'
  | 'operation'
  | 'realtime'
  | 'selection'
  | 'task'
  | 'task_item'>(
  kind: K,
  value: unknown,
): LocalIdentifier<K> | undefined {
  return value === undefined ? undefined : parseLocalIdentifier(kind, value);
}

function optionalObservation(
  value: unknown,
): LocalIdentifier<'observation'> | string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseLocalIdentifier('observation', value);
  } catch {
    return opaqueId(
      value,
      SAFE_LEGACY_OBSERVATION_ID,
      'observationId',
    );
  }
}

export function createCorrelationContext(
  input: CorrelationInput,
): CorrelationContextV1 {
  const clarificationId = optionalLocal(
    'clarification',
    input.clarificationId,
  );
  const itemId = optionalLocal('task_item', input.itemId);
  const observationId = optionalObservation(input.observationId);
  const operationId = optionalLocal('operation', input.operationId);
  const realtimeSessionId = optionalLocal(
    'realtime',
    input.realtimeSessionId,
  );
  const selectionId = optionalLocal('selection', input.selectionId);
  const taskId = optionalLocal('task', input.taskId);
  return Object.freeze({
    version: 1,
    requestId: opaqueId(input.requestId, SAFE_REQUEST_ID, 'requestId'),
    clientId: opaqueId(input.clientId, SAFE_CLIENT_ID, 'clientId'),
    ...(taskId ? { taskId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(clarificationId ? { clarificationId } : {}),
    ...(selectionId ? { selectionId } : {}),
    ...(observationId ? { observationId } : {}),
    ...(realtimeSessionId ? { realtimeSessionId } : {}),
  });
}

export function extendCorrelationContext(
  current: CorrelationContextV1,
  update: Omit<Partial<CorrelationInput>, 'clientId' | 'requestId'>,
): CorrelationContextV1 {
  return createCorrelationContext({
    ...current,
    ...update,
  });
}

export function correlationFields(
  context: CorrelationContextV1,
): Omit<CorrelationContextV1, 'version'> {
  const {
    version: _version,
    ...fields
  } = context;
  return { ...fields };
}

export function correlatedResult<T extends Record<string, unknown>>(
  result: T,
  context: CorrelationContextV1,
): T & { correlation: CorrelationContextV1 } {
  return {
    ...result,
    correlation: { ...context },
  };
}
