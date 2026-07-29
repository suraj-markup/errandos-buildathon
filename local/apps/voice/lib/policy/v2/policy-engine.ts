import type {
  CapabilityDescriptorV2,
  PolicyDecisionV2,
  PolicyEvaluationInputV2,
} from './types';

function capabilityFor(
  input: PolicyEvaluationInputV2,
): CapabilityDescriptorV2 | undefined {
  return input.availableCapabilities.find(
    (candidate) => candidate.capability === input.action.capability,
  );
}

export function evaluatePhoneActionPolicyV2(
  input: PolicyEvaluationInputV2,
): PolicyDecisionV2 {
  const now = input.now ?? Date.now();
  if (
    input.recoveryHandoffRequired
    && !['ask_user', 'cancel_task', 'observe'].includes(
      input.action.capability,
    )
  ) {
    return {
      decision: 'handoff',
      reason: 'recovery_state_requires_handoff',
    };
  }
  if (input.unresolvedMutation) {
    if (input.action.capability !== 'reconcile_operation') {
      return {
        decision: 'reconcile',
        operationId: input.unresolvedMutation.operationId,
        reason: 'unresolved_mutation',
      };
    }
  }

  const capability = capabilityFor(input);
  if (!capability) {
    return { decision: 'block', reason: 'capability_unavailable' };
  }
  if (input.action.adapterId !== input.observation?.adapterId
      && input.action.sourceObservationId) {
    return { decision: 'block', reason: 'observation_adapter_mismatch' };
  }

  if (capability.requiresFreshObservation) {
    if (!input.observation || !input.action.sourceObservationId) {
      return { decision: 'block', reason: 'observation_missing' };
    }
    if (input.observation.restricted) {
      return { decision: 'block', reason: 'observation_restricted' };
    }
    if (
      input.observation.expiresAt <= now
      || input.observation.observationId !== input.action.sourceObservationId
    ) {
      return { decision: 'block', reason: 'observation_stale' };
    }
    if (input.observation.adapterId !== input.action.adapterId) {
      return { decision: 'block', reason: 'adapter_scope_mismatch' };
    }
  }

  if (
    capability.idempotency !== 'none'
    && !input.action.idempotencyKey
  ) {
    return { decision: 'block', reason: 'idempotency_key_required' };
  }

  if (capability.requiresConfirmation) {
    if (!input.confirmationGrant) {
      return { decision: 'confirm', reason: 'confirmation_required' };
    }
    if (input.confirmationGrant.expiresAt <= now) {
      return { decision: 'block', reason: 'confirmation_grant_stale' };
    }
    if (
      input.confirmationGrant.actionDigest !== input.action.actionDigest
      || input.confirmationGrant.adapterId !== input.action.adapterId
      || input.confirmationGrant.taskRevision !== input.currentTaskRevision
    ) {
      return { decision: 'block', reason: 'confirmation_grant_mismatch' };
    }
  }

  return { decision: 'allow' };
}
