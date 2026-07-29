import { blinkitExecutionService } from '../../blinkit-execution';
import type {
  RecoveryReconciliationResultV2,
  TaskRecoveryReconcilerV2,
} from './recovery';
import type { SelectedProductOffer } from '../../product-workflow';

type AddCartInput = {
  offerId?: string;
  quantity: number;
  request: string;
  searchQuery?: string;
  selectedOffer?: SelectedProductOffer;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function verifiedIdentityAbsent(
  verification: Record<string, unknown>,
): boolean {
  const identity = record(verification['identity']);
  const resolution =
    verification['identityResolution']
    ?? verification['identityMatchStatus']
    ?? identity['status'];
  const conflicts =
    verification['conflicts']
    ?? verification['conflictEvidence']
    ?? identity['conflicts'];
  return resolution === 'none'
    && (!Array.isArray(conflicts) || conflicts.length === 0);
}

export class ProductionTaskRecoveryReconcilerV2
implements TaskRecoveryReconcilerV2 {
  constructor(
    private readonly reconcileAdd:
      (input: AddCartInput & { reconcileOnly: true }) => Promise<unknown>
      = (input) => blinkitExecutionService.addCartItem(input),
  ) {}

  async reconcile(
    input: Parameters<TaskRecoveryReconcilerV2['reconcile']>[0],
  ): Promise<RecoveryReconciliationResultV2> {
    if (input.mode === 'final_dispatch') {
      return {
        outcome: 'ambiguous',
        evidenceRef: `final-dispatch-not-replayed:${input.operation.operationId}`,
      };
    }
    const step = input.task.steps.find(
      (candidate) => candidate.stepId === input.operation.stepId,
    );
    const stepInput = record(step?.input);
    if (
      !step
      || step.kind !== 'add_cart_item'
      || typeof stepInput['request'] !== 'string'
    ) {
      return {
        outcome: 'ambiguous',
        evidenceRef: `unsupported-reconciliation:${input.operation.operationId}`,
      };
    }
    const result = record(await this.reconcileAdd({
      reconcileOnly: true,
      request: stepInput['request'],
      quantity:
        typeof stepInput['quantity'] === 'number'
          ? stepInput['quantity']
          : 1,
      ...(typeof stepInput['offerId'] === 'string'
        ? { offerId: stepInput['offerId'] }
        : {}),
      ...(typeof stepInput['searchQuery'] === 'string'
        ? { searchQuery: stepInput['searchQuery'] }
        : {}),
      ...(stepInput['selectedOffer']
        && typeof stepInput['selectedOffer'] === 'object'
          ? { selectedOffer: stepInput['selectedOffer'] as AddCartInput['selectedOffer'] }
          : {}),
    }));
    const verification = record(result['verification']);
    if (
      ['added', 'already_in_cart'].includes(String(result['status'] ?? ''))
      && verification['outcome'] === 'verified_success'
    ) {
      return {
        outcome: 'verified_applied',
        evidenceRef: `cart-reconciled:${input.operation.operationId}`,
      };
    }
    if (
      verification['outcome'] === 'verified_no_change'
      && verifiedIdentityAbsent(verification)
    ) {
      return {
        outcome: 'verified_not_applied',
        evidenceRef: `cart-unchanged:${input.operation.operationId}`,
      };
    }
    return {
      outcome: 'ambiguous',
      evidenceRef: `cart-reconciliation-ambiguous:${input.operation.operationId}`,
    };
  }
}
