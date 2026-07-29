import type { LocalIdentifier } from '../../identifiers';

export const BACKGROUND_PHONE_OPERATION_VERSION = 2 as const;

type BackgroundPhoneOperationStatusV2 =
  | 'queued'
  | 'running'
  | 'mutation_attempted'
  | 'completed'
  | 'failed'
  | 'ambiguous';

export type BackgroundPhoneOperationTerminalStatusV2 = Extract<
  BackgroundPhoneOperationStatusV2,
  'completed' | 'failed' | 'ambiguous'
>;

export type BackgroundPhoneOperationRecordV2 = {
  version: typeof BACKGROUND_PHONE_OPERATION_VERSION;
  operationId: LocalIdentifier<'operation'>;
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  taskRevision: number;
  stepId: string;
  operationKind: string;
  requestPayload: unknown;
  status: BackgroundPhoneOperationStatusV2;
  attempts: number;
  recoveryCount: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  mutationAttemptedAt?: number;
  terminalAt?: number;
  resultRef?: string;
  detail?: string;
  terminalEventPublishedAt?: number;
};

export type BackgroundPhoneOperationEnqueueInputV2 = {
  taskId: LocalIdentifier<'task'>;
  itemId?: LocalIdentifier<'task_item'>;
  taskRevision: number;
  stepId: string;
  operationKind: string;
  requestPayload: unknown;
};

export type BackgroundPhoneOperationWorkerResultV2 = {
  outcome: BackgroundPhoneOperationTerminalStatusV2;
  detail?: string;
  resultRef?: string;
};

export type BackgroundPhoneOperationWorkerV2 = (
  operation: Readonly<BackgroundPhoneOperationRecordV2>,
  control: Readonly<{
    markMutationAttempted(): Promise<void>;
  }>,
) => Promise<BackgroundPhoneOperationWorkerResultV2>;

type BackgroundPhoneOperationPublicStatusV2 = Omit<
  BackgroundPhoneOperationRecordV2,
  'requestPayload'
>;

export function publicBackgroundPhoneOperationStatusV2(
  operation: BackgroundPhoneOperationRecordV2,
): BackgroundPhoneOperationPublicStatusV2 {
  const publicStatus = structuredClone(operation);
  delete (publicStatus as Partial<BackgroundPhoneOperationRecordV2>)
    .requestPayload;
  return publicStatus;
}
