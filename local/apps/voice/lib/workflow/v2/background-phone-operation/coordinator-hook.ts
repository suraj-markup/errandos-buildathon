import type { OperationAcceptedV2 } from '../../../progress/v2/contracts';
import type { LocalIdentifier } from '../../identifiers';
import type {
  BackgroundPhoneOperationEnqueueInputV2,
} from './contracts';
import type {
  BackgroundPhoneOperationManagerV2,
} from './manager';

type BackgroundPhoneOperationCoordinatorHookResultV2 = {
  disposition: 'enqueued' | 'duplicate' | 'task_busy';
  operationAccepted: OperationAcceptedV2;
};

export async function acceptBackgroundPhoneOperationV2(
  manager: BackgroundPhoneOperationManagerV2,
  request: BackgroundPhoneOperationEnqueueInputV2,
  operationId?: LocalIdentifier<'operation'>,
): Promise<BackgroundPhoneOperationCoordinatorHookResultV2> {
  return manager.enqueue(request, operationId);
}
