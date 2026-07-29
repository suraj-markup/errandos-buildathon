import { createHash } from 'node:crypto';
import type {
  CapabilityDescriptorV2,
  ConfirmationGrantSummaryV2,
  ObservationPolicyStateV2,
  PhoneActionEffectV2,
  PhoneCapabilityV2,
  PolicyDecisionV2,
  UnresolvedMutationV2,
} from '../../policy/v2/types';

export type SemanticElementRoleV2 =
  | 'button'
  | 'dialog'
  | 'field'
  | 'heading'
  | 'image'
  | 'link'
  | 'list_item'
  | 'menu_item'
  | 'switch'
  | 'tab'
  | 'text';

export type SemanticElementReferenceV2 = {
  elementRef: string;
  observationId: string;
  role: SemanticElementRoleV2;
  label?: string;
  state?: 'checked' | 'disabled' | 'editable' | 'enabled' | 'selected';
};

export type GeneralMobileObservationV2 = {
  version: 2;
  observationId: string;
  adapterId: string;
  packageName: string;
  capturedAt: number;
  expiresAt: number;
  fingerprint: string;
  restricted: boolean;
  restrictedClasses: string[];
  elements: SemanticElementReferenceV2[];
};

export type AdapterObservationCaptureV2 = {
  captureId: string;
  packageName: string;
  capturedAt: number;
  fingerprint: string;
  source: string;
  candidates: Array<{
    localNodeId: string;
    role: SemanticElementRoleV2;
    label?: string;
    state?: SemanticElementReferenceV2['state'];
  }>;
};

export type GeneralMobileActionV2 = {
  version: 2;
  actionId: string;
  actionDigest: string;
  adapterId: string;
  packageName: string;
  capability: PhoneCapabilityV2;
  effect: PhoneActionEffectV2;
  sourceObservationId?: string;
  targetRef?: string;
  input: unknown;
  expectedPostcondition: unknown;
  idempotencyKey?: string;
};

export type GeneralMobileAdapterResultV2 =
  | {
    status: 'verified';
    resultRef: string;
  }
  | {
    status:
      | 'cancelled'
      | 'failed'
      | 'no_progress'
      | 'stale_target'
      | 'unexpected_dialog';
    reasonRef: string;
  };

export type GeneralMobileBlockedReasonV2 =
  | 'adapter_not_registered'
  | 'capability_scope_mismatch'
  | 'effect_mismatch'
  | 'observation_package_mismatch'
  | 'package_scope_mismatch'
  | 'raw_coordinates_forbidden'
  | Extract<PolicyDecisionV2, { decision: 'block' }>['reason']
  | Extract<PolicyDecisionV2, { decision: 'confirm' }>['reason']
  | Extract<PolicyDecisionV2, { decision: 'handoff' }>['reason']
  | Extract<PolicyDecisionV2, { decision: 'reconcile' }>['reason'];

export type GeneralMobileExecutionResultV2 =
  | GeneralMobileAdapterResultV2
  | {
    status: 'blocked';
    reason: GeneralMobileBlockedReasonV2;
    operationId?: string;
  };

export type GeneralMobileExecutionRequestV2 = {
  action: GeneralMobileActionV2;
  currentTaskRevision: number;
  observation?: GeneralMobileObservationV2;
  confirmationGrant?: ConfirmationGrantSummaryV2;
  unresolvedMutation?: UnresolvedMutationV2;
  isCancelled?: () => boolean;
};

export type GeneralMobileAdapterDescriptorV2 = {
  version: 2;
  adapterId: string;
  displayName: string;
  packages: string[];
  capabilities: CapabilityDescriptorV2[];
};

export interface GeneralMobileAdapterV2 {
  readonly descriptor: GeneralMobileAdapterDescriptorV2;
  observe(input: {
    clientId: string;
    isCancelled?: () => boolean;
    packageName: string;
    operationId: string;
  }): Promise<AdapterObservationCaptureV2>;
  execute(
    action: GeneralMobileActionV2,
    context: {
      observation?: GeneralMobileObservationV2;
      isCancelled: () => boolean;
    },
  ): Promise<GeneralMobileAdapterResultV2>;
}

export class GeneralMobileObservationCancelledErrorV2 extends Error {
  constructor() {
    super('General-mobile observation was cancelled.');
    this.name = 'GeneralMobileObservationCancelledErrorV2';
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const forbiddenCoordinateKeys = new Set([
  'bounds',
  'bottom',
  'coordinate',
  'coordinates',
  'left',
  'point',
  'right',
  'top',
  'x',
  'y',
]);

export function assertGeneralMobileIdentifierV2(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

export function assertPackageNameV2(
  value: unknown,
  label = 'package name',
): asserts value is string {
  if (typeof value !== 'string' || !packagePattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function assertJsonWithoutCoordinates(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Action payload contains a cycle.');
    seen.add(value);
    for (const entry of value) assertJsonWithoutCoordinates(entry, seen);
    seen.delete(value);
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error('Action payload contains a cycle.');
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (forbiddenCoordinateKeys.has(key.toLocaleLowerCase('en-US'))) {
        throw new Error('Raw coordinates are forbidden in general-mobile actions.');
      }
      if (entry !== undefined) assertJsonWithoutCoordinates(entry, seen);
    }
    seen.delete(value);
    return;
  }
  throw new Error('Action payload must be JSON-compatible.');
}

export function canonicalGeneralMobileActionDigestV2(
  action: Omit<GeneralMobileActionV2, 'actionDigest'>,
): string {
  const material = {
    actionId: action.actionId,
    adapterId: action.adapterId,
    packageName: action.packageName,
    capability: action.capability,
    effect: action.effect,
    sourceObservationId: action.sourceObservationId,
    targetRef: action.targetRef,
    input: action.input,
    expectedPostcondition: action.expectedPostcondition,
    idempotencyKey: action.idempotencyKey,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

export function validateGeneralMobileActionV2(
  value: GeneralMobileActionV2,
): GeneralMobileActionV2 {
  const action = structuredClone(value);
  if (action.version !== 2) throw new Error('Unsupported general-mobile action.');
  assertGeneralMobileIdentifierV2(action.actionId, 'action identifier');
  assertGeneralMobileIdentifierV2(action.adapterId, 'adapter identifier');
  assertPackageNameV2(action.packageName);
  if (
    action.sourceObservationId !== undefined
    && typeof action.sourceObservationId !== 'string'
  ) {
    throw new Error('Invalid source observation identifier.');
  }
  if (action.targetRef !== undefined) {
    assertGeneralMobileIdentifierV2(action.targetRef, 'semantic target reference');
  }
  if (action.idempotencyKey !== undefined) {
    assertGeneralMobileIdentifierV2(action.idempotencyKey, 'idempotency key');
  }
  assertJsonWithoutCoordinates(action.input);
  assertJsonWithoutCoordinates(action.expectedPostcondition);
  const { actionDigest: _digest, ...digestInput } = action;
  if (
    !/^[a-f0-9]{64}$/.test(action.actionDigest)
    || canonicalGeneralMobileActionDigestV2(digestInput) !== action.actionDigest
  ) {
    throw new Error('General-mobile action digest does not match its contents.');
  }
  return action;
}

export function toObservationPolicyStateV2(
  observation: GeneralMobileObservationV2,
): ObservationPolicyStateV2 {
  return {
    adapterId: observation.adapterId,
    capturedAt: observation.capturedAt,
    expiresAt: observation.expiresAt,
    observationId: observation.observationId,
    restricted: observation.restricted,
  };
}
