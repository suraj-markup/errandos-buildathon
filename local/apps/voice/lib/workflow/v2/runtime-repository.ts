import { join } from 'node:path';
import { FileBackedPhoneTaskRepositoryV2 } from './file-repository';
import {
  InMemoryPhoneTaskRepositoryV2,
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { commitTaskTurnContextV2 } from './turn-context';

const runtimeGlobal = globalThis as typeof globalThis & {
  errandosPhoneTaskRepositoryV2?: PhoneTaskRepositoryV2;
};

export function phoneTaskRepositoryV2(): PhoneTaskRepositoryV2 {
  const configuredPath =
    process.env.JALDI_PHONE_TASK_V2_STATE_PATH?.trim();
  runtimeGlobal.errandosPhoneTaskRepositoryV2 ??=
    process.env.NODE_ENV === 'test'
      ? new InMemoryPhoneTaskRepositoryV2({
        maxEventsPerTask: 200,
        maxTasks: 100,
        ttlMs: 30 * 60_000,
      })
      : new FileBackedPhoneTaskRepositoryV2(
        configuredPath
          || join(process.cwd(), '.runtime', 'phone-task-v2.json'),
        {
          maxEventsPerTask: 200,
          maxTasks: 100,
          ttlMs: 30 * 60_000,
        },
      );
  return runtimeGlobal.errandosPhoneTaskRepositoryV2;
}

export async function persistPhoneTaskTurnContextV2(input: {
  clientId: string;
  languageCode: string;
  responseId?: string;
  at?: number;
}): Promise<TaskRepositoryRecordV2 | undefined> {
  const repository = phoneTaskRepositoryV2();
  const record = await repository.getByClientId(input.clientId);
  if (!record) return undefined;
  return commitTaskTurnContextV2({
    repository,
    record,
    languageCode: input.languageCode,
    ...(input.responseId ? { responseId: input.responseId } : {}),
    at: Math.max(input.at ?? Date.now(), record.task.updatedAt),
  });
}
