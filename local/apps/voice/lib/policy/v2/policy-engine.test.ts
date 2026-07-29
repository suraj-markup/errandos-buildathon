import { describe, expect, it } from 'vitest';
import { capabilityCatalogV2 } from './capability-catalog';
import { evaluatePhoneActionPolicyV2 } from './policy-engine';
import type {
  PhoneCapabilityV2,
  PolicyEvaluationInputV2,
} from './types';

function input(
  capability: PhoneCapabilityV2,
  override: Partial<PolicyEvaluationInputV2> = {},
): PolicyEvaluationInputV2 {
  return {
    action: {
      actionDigest: `digest-${capability}`,
      adapterId: 'blinkit',
      capability,
      idempotencyKey: `key-${capability}`,
    },
    availableCapabilities: [capabilityCatalogV2[capability]],
    currentTaskRevision: 4,
    now: 1_000,
    ...override,
  };
}

describe('V2 phone-action policy', () => {
  it('requires a bound confirmation for irreversible actions', () => {
    expect(evaluatePhoneActionPolicyV2(input('confirm_order'))).toEqual({
      decision: 'confirm',
      reason: 'confirmation_required',
    });

    expect(evaluatePhoneActionPolicyV2(input('confirm_order', {
      confirmationGrant: {
        actionDigest: 'digest-confirm_order',
        adapterId: 'blinkit',
        expiresAt: 2_000,
        taskRevision: 4,
      },
    }))).toEqual({ decision: 'allow' });
  });

  it('rejects a confirmation from another revision or action', () => {
    expect(evaluatePhoneActionPolicyV2(input('confirm_order', {
      confirmationGrant: {
        actionDigest: 'different-action',
        adapterId: 'blinkit',
        expiresAt: 2_000,
        taskRevision: 3,
      },
    }))).toEqual({
      decision: 'block',
      reason: 'confirmation_grant_mismatch',
    });
  });

  it('blocks target actions against a stale observation', () => {
    expect(evaluatePhoneActionPolicyV2(input('select_payment_method', {
      action: {
        actionDigest: 'digest-payment',
        adapterId: 'blinkit',
        capability: 'select_payment_method',
        idempotencyKey: 'key-payment',
        sourceObservationId: 'observation-a',
      },
      observation: {
        adapterId: 'blinkit',
        capturedAt: 100,
        expiresAt: 999,
        observationId: 'observation-a',
        restricted: false,
      },
    }))).toEqual({
      decision: 'block',
      reason: 'observation_stale',
    });
  });

  it('forces reconciliation instead of another mutation', () => {
    expect(evaluatePhoneActionPolicyV2(input('add_cart_item', {
      unresolvedMutation: {
        operationId: 'operation-uncertain',
        outcome: 'ambiguous',
      },
    }))).toEqual({
      decision: 'reconcile',
      operationId: 'operation-uncertain',
      reason: 'unresolved_mutation',
    });
  });

  it('hands mutation control back when only persisted V2 state survived restart', () => {
    expect(evaluatePhoneActionPolicyV2(input('add_cart_item', {
      availableCapabilities: [],
      recoveryHandoffRequired: true,
    }))).toEqual({
      decision: 'handoff',
      reason: 'recovery_state_requires_handoff',
    });
  });
});
