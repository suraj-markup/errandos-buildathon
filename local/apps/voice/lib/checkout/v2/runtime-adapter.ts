import { join } from 'node:path';
import { FileCheckoutOrchestrationRepositoryV2 } from './file-orchestration-repository';
import {
  CheckoutOrchestrationServiceV2,
  InMemoryCheckoutOrchestrationRepositoryV2,
  type CheckoutOrchestrationRepositoryV2,
} from './orchestration-service';
import {
  VoiceTurnCheckoutAdapterV2,
  type VoiceTurnCheckoutCommitV2,
  type VoiceTurnCodConfirmationResultV2,
  type VoiceTurnPreparedCodCheckoutV2,
  type VoiceTurnCheckoutFailureV2,
  type PhoneToolCheckoutResultV2,
} from './voice-turn-adapter';
import type { AndroidCheckoutReviewV1 } from '@errandos/contracts';
import type { CurrentPaymentMethodV2 } from './contracts';
import type { CheckoutSessionAuthorityV2 } from './orchestration-service';
import {
  DurableCheckoutRecoveryServiceV2,
  type DurableCheckoutRecoveryV2,
} from './recovery';

type CheckoutRuntimeGlobalV2 = typeof globalThis & {
  errandosCheckoutAdapterV2?: VoiceTurnCheckoutAdapterV2;
  errandosCheckoutRecoveryV2?: DurableCheckoutRecoveryServiceV2;
  errandosCheckoutRepositoryV2?: CheckoutOrchestrationRepositoryV2;
  errandosCheckoutServiceV2?: CheckoutOrchestrationServiceV2;
};

const runtimeGlobal = globalThis as CheckoutRuntimeGlobalV2;

export function checkoutOrchestrationRepositoryV2():
  CheckoutOrchestrationRepositoryV2 {
  const configuredPath =
    process.env.JALDI_CHECKOUT_V2_STATE_PATH?.trim();
  runtimeGlobal.errandosCheckoutRepositoryV2 ??=
    process.env.NODE_ENV === 'test'
      ? new InMemoryCheckoutOrchestrationRepositoryV2()
      : new FileCheckoutOrchestrationRepositoryV2(
        configuredPath
          || join(process.cwd(), '.runtime', 'checkout-orchestration-v2'),
      );
  return runtimeGlobal.errandosCheckoutRepositoryV2;
}

export function checkoutOrchestrationServiceV2():
  CheckoutOrchestrationServiceV2 {
  runtimeGlobal.errandosCheckoutServiceV2 ??=
    new CheckoutOrchestrationServiceV2(
      checkoutOrchestrationRepositoryV2(),
    );
  return runtimeGlobal.errandosCheckoutServiceV2;
}

export function voiceTurnCheckoutAdapterV2(): VoiceTurnCheckoutAdapterV2 {
  runtimeGlobal.errandosCheckoutAdapterV2 ??=
    new VoiceTurnCheckoutAdapterV2(checkoutOrchestrationServiceV2());
  return runtimeGlobal.errandosCheckoutAdapterV2;
}

export function durableCheckoutRecoveryServiceV2():
  DurableCheckoutRecoveryServiceV2 {
  runtimeGlobal.errandosCheckoutRecoveryV2 ??=
    new DurableCheckoutRecoveryServiceV2(checkoutOrchestrationServiceV2());
  return runtimeGlobal.errandosCheckoutRecoveryV2;
}

export function recoverLatestCheckoutV2(input: {
  clientId: string;
  ownerId: string;
  taskId?: CheckoutSessionAuthorityV2['taskId'];
}): Promise<DurableCheckoutRecoveryV2> {
  return durableCheckoutRecoveryServiceV2().recoverLatest(input);
}

export function prepareVoiceTurnCodCheckoutV2(
  input: CheckoutSessionAuthorityV2 & {
    codAvailable?: boolean;
    currentPayment?: CurrentPaymentMethodV2;
    originalGoalIncludesOrder?: boolean;
    phoneResult: PhoneToolCheckoutResultV2;
  },
): Promise<VoiceTurnPreparedCodCheckoutV2 | VoiceTurnCheckoutFailureV2> {
  return voiceTurnCheckoutAdapterV2().prepareCodCheckout(input);
}

export function confirmVoiceTurnCodCheckoutV2(
  input: CheckoutSessionAuthorityV2 & {
    checkoutId: string;
    confirmationText: string;
    readCurrentTerms: () =>
      | AndroidCheckoutReviewV1
      | Promise<AndroidCheckoutReviewV1>;
    commit: VoiceTurnCheckoutCommitV2;
  },
): Promise<VoiceTurnCodConfirmationResultV2> {
  return voiceTurnCheckoutAdapterV2().confirmCodCheckout(input);
}
