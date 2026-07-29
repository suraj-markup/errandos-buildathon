import { describe, expect, it, vi } from 'vitest';
import { ProductionTaskRecoveryReconcilerV2 } from './production-recovery-reconciler';
import { validTaskV2 } from './test-fixtures';

function recoveryInput(mode: 'mutation' | 'final_dispatch') {
  const task = validTaskV2();
  task.steps[0] = {
    ...task.steps[0]!,
    kind: 'add_cart_item',
    input: {
      request: 'Amul milk',
      quantity: 1,
      offerId: 'offer-milk',
    },
  };
  return {
    mode,
    task,
    operation: {
      operationId: 'operation:recovery',
      taskId: task.taskId,
      stepId: task.steps[0]!.stepId,
      kind: 'add_cart_item',
      boundary: mode === 'final_dispatch'
        ? 'final_dispatch_attempted' as const
        : 'mutation_attempted' as const,
      status: 'ambiguous' as const,
      updatedAt: 2,
    },
  };
}

describe('production V2 recovery reconciler', () => {
  it('uses the read-only add reconciliation path and recognizes success', async () => {
    const reconcileAdd = vi.fn(async () => ({
      status: 'already_in_cart',
      verification: { outcome: 'verified_success' },
    }));
    const result = await new ProductionTaskRecoveryReconcilerV2(
      reconcileAdd,
    ).reconcile(recoveryInput('mutation'));

    expect(reconcileAdd).toHaveBeenCalledWith(expect.objectContaining({
      reconcileOnly: true,
      request: 'Amul milk',
      quantity: 1,
      offerId: 'offer-milk',
    }));
    expect(result.outcome).toBe('verified_applied');
  });

  it('recognizes explicit verified identity absence without replaying', async () => {
    const reconcileAdd = vi.fn(async () => ({
      status: 'execution_failed',
      verification: {
        identityResolution: 'none',
        outcome: 'verified_no_change',
      },
    }));
    const result = await new ProductionTaskRecoveryReconcilerV2(
      reconcileAdd,
    ).reconcile(recoveryInput('mutation'));
    expect(reconcileAdd).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('verified_not_applied');
  });

  it('keeps non-unique unchanged identity ambiguous without retrying', async () => {
    const reconcileAdd = vi.fn(async () => ({
      status: 'execution_failed',
      verification: {
        conflicts: [{
          field: 'pack_size',
          expected: '200 g',
          observed: '250 g',
        }],
        identityResolution: 'ambiguous',
        outcome: 'verified_no_change',
      },
    }));
    const result = await new ProductionTaskRecoveryReconcilerV2(
      reconcileAdd,
    ).reconcile(recoveryInput('mutation'));

    expect(reconcileAdd).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: 'ambiguous',
      evidenceRef: expect.stringContaining('cart-reconciliation-ambiguous'),
    });
  });

  it('never replays final dispatch', async () => {
    const reconcileAdd = vi.fn();
    const result = await new ProductionTaskRecoveryReconcilerV2(
      reconcileAdd,
    ).reconcile(recoveryInput('final_dispatch'));
    expect(reconcileAdd).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'ambiguous',
      evidenceRef: expect.stringContaining('final-dispatch-not-replayed'),
    });
  });
});
