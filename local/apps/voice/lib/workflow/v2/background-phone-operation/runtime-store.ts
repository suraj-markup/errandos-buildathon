import { join } from 'node:path';
import { FileBackedBackgroundPhoneOperationStoreV2 } from './file-store';
import {
  InMemoryBackgroundPhoneOperationStoreV2,
  type BackgroundPhoneOperationStoreV2,
} from './store';

const runtimeGlobal = globalThis as typeof globalThis & {
  errandosBackgroundPhoneOperationStoreV2?:
    BackgroundPhoneOperationStoreV2;
};

export function backgroundPhoneOperationStoreV2():
BackgroundPhoneOperationStoreV2 {
  runtimeGlobal.errandosBackgroundPhoneOperationStoreV2 ??=
    process.env.NODE_ENV === 'test'
      ? new InMemoryBackgroundPhoneOperationStoreV2(128)
      : new FileBackedBackgroundPhoneOperationStoreV2(
        join(
          process.cwd(),
          '.runtime',
          'background-phone-operations-v2.json',
        ),
        128,
      );
  return runtimeGlobal.errandosBackgroundPhoneOperationStoreV2;
}
