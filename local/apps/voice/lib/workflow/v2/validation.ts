import {
  PHONE_TASK_V2_VERSION,
  TERMINAL_STEP_STATUSES_V2,
  TERMINAL_TASK_STATUSES_V2,
  type PendingInteractionV2,
  type PhoneTaskStepStatusV2,
  type PhoneTaskStepV2,
  type PhoneTaskStatusV2,
  type PhoneTaskV2,
  type ProductChoicePolicyModeV2,
  type ProductChoicePolicyV2,
  type TaskBudgetsV2,
  type TaskJournalEntryV2,
  type TaskTurnContextV2,
  type VerifiedFactReferenceV2,
} from './contracts';
import {
  isSafeProductChoicePolicyTextV2,
  normalizeProductChoicePolicyTextV2,
} from './product-choice-policy-text';

const taskStatuses = new Set<PhoneTaskStatusV2>([
  'active',
  'paused',
  'waiting_for_user',
  'waiting_for_phone',
  'blocked',
  'completed',
  'cancelled',
  'ambiguous',
]);

const stepStatuses = new Set<PhoneTaskStepStatusV2>([
  'planned',
  'ready',
  'running',
  'waiting_for_user',
  'verified',
  'skipped',
  'failed',
  'ambiguous',
  'blocked',
]);

const interactionKinds = new Set([
  'product_choice',
  'next_action',
  'payment_choice',
  'checkout_confirmation',
  'recovery_handoff',
]);

const interactionStatuses = new Set([
  'open',
  'resolving',
  'resolved',
  'expired',
  'cancelled',
]);

const productChoicePolicyModes = new Set<ProductChoicePolicyModeV2>([
  'ask_every_time',
  'lowest_price_matching_pack',
  'known_brand_then_lowest_price',
  'repeat_previous_preference',
  'suggested_with_price_limit',
]);

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const parsed = stringValue(value, label);
  if (!identifierPattern.test(parsed)) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const parsed = stringValue(value, label);
  if (parsed.length > maximum) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function boundedTrimmedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const parsed = boundedString(value, label, maximum);
  if (parsed.trim() !== parsed) throw new Error(`Invalid ${label}.`);
  return parsed;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Invalid ${label}.`);
  }
}

function parseProductChoicePolicyV2(
  value: unknown,
): ProductChoicePolicyV2 {
  const input = record(value, 'product choice policy');
  exactKeys(
    input,
    ['mode', 'preferredBrands', 'previousPreference', 'priceCeiling'],
    'product choice policy',
  );
  const mode = input['mode'];
  if (
    typeof mode !== 'string'
    || !productChoicePolicyModes.has(mode as ProductChoicePolicyModeV2)
  ) {
    throw new Error('Invalid product choice policy mode.');
  }

  let preferredBrands: string[] | undefined;
  if (input['preferredBrands'] !== undefined) {
    if (
      !Array.isArray(input['preferredBrands'])
      || input['preferredBrands'].length === 0
      || input['preferredBrands'].length > 10
    ) {
      throw new Error('Invalid product choice preferred brands.');
    }
    preferredBrands = input['preferredBrands'].map((brand) =>
      boundedTrimmedString(brand, 'product choice preferred brand', 80));
    if (preferredBrands.some((brand) =>
      !isSafeProductChoicePolicyTextV2(brand))) {
      throw new Error('Invalid product choice preferred brands.');
    }
    const uniqueBrands = new Set(preferredBrands.map(
      normalizeProductChoicePolicyTextV2,
    ));
    if (uniqueBrands.size !== preferredBrands.length) {
      throw new Error('Invalid product choice preferred brands.');
    }
  }

  let priceCeiling: ProductChoicePolicyV2['priceCeiling'];
  if (input['priceCeiling'] !== undefined) {
    const ceiling = record(input['priceCeiling'], 'product choice price ceiling');
    exactKeys(
      ceiling,
      ['amount', 'currency'],
      'product choice price ceiling',
    );
    if (
      typeof ceiling['amount'] !== 'number'
      || !Number.isFinite(ceiling['amount'])
      || ceiling['amount'] <= 0
      || ceiling['amount'] > 1_000_000
      || ceiling['currency'] !== 'INR'
    ) {
      throw new Error('Invalid product choice price ceiling.');
    }
    priceCeiling = {
      amount: ceiling['amount'],
      currency: 'INR',
    };
  }

  let previousPreference: ProductChoicePolicyV2['previousPreference'];
  if (input['previousPreference'] !== undefined) {
    const previous = record(
      input['previousPreference'],
      'previous product choice preference',
    );
    exactKeys(
      previous,
      ['brand', 'category', 'packSize', 'productForm'],
      'previous product choice preference',
    );
    previousPreference = {
      category: boundedTrimmedString(
        previous['category'],
        'previous product choice category',
        120,
      ),
      ...(previous['brand'] === undefined
        ? {}
        : {
          brand: boundedTrimmedString(
            previous['brand'],
            'previous product choice brand',
            80,
          ),
        }),
      ...(previous['packSize'] === undefined
        ? {}
        : {
          packSize: boundedTrimmedString(
            previous['packSize'],
            'previous product choice pack size',
            80,
          ),
        }),
      ...(previous['productForm'] === undefined
        ? {}
        : {
          productForm: boundedTrimmedString(
            previous['productForm'],
            'previous product choice form',
            80,
          ),
        }),
    };
    if (
      !previousPreference.brand
      && !previousPreference.packSize
      && !previousPreference.productForm
    ) {
      throw new Error('Invalid previous product choice preference.');
    }
    if (
      Object.values(previousPreference).some((entry) =>
        !isSafeProductChoicePolicyTextV2(entry))
    ) {
      throw new Error('Invalid previous product choice preference.');
    }
  }

  if (mode === 'known_brand_then_lowest_price' && !preferredBrands) {
    throw new Error('Known-brand policy requires preferred brands.');
  }
  if (mode === 'repeat_previous_preference' && !previousPreference) {
    throw new Error('Repeat policy requires a previous preference.');
  }
  if (mode === 'suggested_with_price_limit' && !priceCeiling) {
    throw new Error('Suggested policy requires a price ceiling.');
  }
  return {
    mode: mode as ProductChoicePolicyModeV2,
    ...(priceCeiling ? { priceCeiling } : {}),
    ...(preferredBrands ? { preferredBrands } : {}),
    ...(previousPreference ? { previousPreference } : {}),
  };
}

function assertJsonValue(
  value: unknown,
  label: string,
  seen = new Set<object>(),
): void {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`Invalid ${label}: cyclic value.`);
    seen.add(value);
    for (const entry of value) assertJsonValue(entry, label, seen);
    seen.delete(value);
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw new Error(`Invalid ${label}: cyclic value.`);
    seen.add(value);
    for (const entry of Object.values(value)) {
      if (entry === undefined) continue;
      assertJsonValue(entry, label, seen);
    }
    seen.delete(value);
    return;
  }
  throw new Error(`Invalid ${label}: value must be JSON-compatible.`);
}

function parseBudgets(value: unknown): TaskBudgetsV2 {
  const input = record(value, 'task budgets');
  return {
    maxAttemptsPerStep: integer(
      input['maxAttemptsPerStep'],
      'maximum attempts per step',
      1,
    ),
    maxJournalEntries: integer(
      input['maxJournalEntries'],
      'maximum journal entries',
      1,
    ),
    maxSteps: integer(input['maxSteps'], 'maximum steps', 1),
    maxVerifiedFacts: integer(
      input['maxVerifiedFacts'],
      'maximum verified facts',
      1,
    ),
  };
}

function parseStep(value: unknown): PhoneTaskStepV2 {
  const input = record(value, 'phone task step');
  const status = stringValue(input['status'], 'phone task step status');
  if (!stepStatuses.has(status as PhoneTaskStepStatusV2)) {
    throw new Error('Invalid phone task step status.');
  }
  if (!Array.isArray(input['dependsOn'])) {
    throw new Error('Invalid phone task step dependencies.');
  }
  assertJsonValue(input['input'], 'phone task step input');
  assertJsonValue(
    input['expectedPostcondition'],
    'phone task step expected postcondition',
  );
  return {
    stepId: identifier(input['stepId'], 'phone task step identifier'),
    adapterId: identifier(input['adapterId'], 'phone task adapter identifier'),
    kind: identifier(input['kind'], 'phone task step kind'),
    status: status as PhoneTaskStepStatusV2,
    dependsOn: input['dependsOn'].map((dependency) =>
      identifier(dependency, 'phone task step dependency')),
    input: input['input'],
    expectedPostcondition: input['expectedPostcondition'],
    ...(input['operationId'] === undefined
      ? {}
      : { operationId: identifier(input['operationId'], 'operation identifier') }),
    attempts: integer(input['attempts'], 'phone task step attempts'),
    ...(input['lastResultRef'] === undefined
      ? {}
      : { lastResultRef: identifier(input['lastResultRef'], 'result reference') }),
  };
}

function parseInteraction(value: unknown): PendingInteractionV2 {
  const input = record(value, 'pending interaction');
  const kind = stringValue(input['kind'], 'pending interaction kind');
  const status = stringValue(input['status'], 'pending interaction status');
  if (!interactionKinds.has(kind)) throw new Error('Invalid pending interaction kind.');
  if (!interactionStatuses.has(status)) {
    throw new Error('Invalid pending interaction status.');
  }
  assertJsonValue(input['allowedResponses'], 'pending interaction responses');
  return {
    interactionId: identifier(
      input['interactionId'],
      'pending interaction identifier',
    ),
    taskId: identifier(input['taskId'], 'pending interaction task identifier'),
    taskRevision: integer(
      input['taskRevision'],
      'pending interaction task revision',
    ),
    kind: kind as PendingInteractionV2['kind'],
    allowedResponses: input['allowedResponses'],
    presentationRef: identifier(
      input['presentationRef'],
      'pending interaction presentation reference',
    ),
    status: status as PendingInteractionV2['status'],
    createdAt: timestamp(input['createdAt'], 'pending interaction creation time'),
    expiresAt: timestamp(input['expiresAt'], 'pending interaction expiry time'),
  };
}

function parseTurnContext(value: unknown): TaskTurnContextV2 {
  const input = record(value, 'task turn context');
  return {
    languageCode: boundedString(
      input['languageCode'],
      'task turn language code',
      24,
    ),
    ...(input['responseId'] === undefined
      ? {}
      : {
        responseId: boundedString(
          input['responseId'],
          'task turn response identifier',
          512,
        ),
      }),
    updatedAt: timestamp(input['updatedAt'], 'task turn context update time'),
  };
}

function parseFact(value: unknown): VerifiedFactReferenceV2 {
  const input = record(value, 'verified fact reference');
  const freshness = record(input['freshness'], 'verified fact freshness');
  const freshnessKind = stringValue(
    freshness['kind'],
    'verified fact freshness kind',
  );
  let parsedFreshness: VerifiedFactReferenceV2['freshness'];
  if (freshnessKind === 'task_lifetime') {
    parsedFreshness = { kind: 'task_lifetime' };
  } else if (freshnessKind === 'expires_at') {
    parsedFreshness = {
      kind: 'expires_at',
      expiresAt: timestamp(freshness['expiresAt'], 'fact expiry time'),
    };
  } else if (freshnessKind === 'until_provider_change') {
    parsedFreshness = {
      kind: 'until_provider_change',
      providerFingerprint: identifier(
        freshness['providerFingerprint'],
        'fact freshness provider fingerprint',
      ),
    };
  } else {
    throw new Error('Invalid verified fact freshness kind.');
  }
  const confidence = stringValue(input['confidence'], 'verified fact confidence');
  if (!['verified', 'uncertain', 'reconciliation_required'].includes(confidence)) {
    throw new Error('Invalid verified fact confidence.');
  }
  return {
    factId: identifier(input['factId'], 'verified fact identifier'),
    kind: identifier(input['kind'], 'verified fact kind'),
    originOperationId: identifier(
      input['originOperationId'],
      'verified fact operation identifier',
    ),
    observedAt: timestamp(input['observedAt'], 'verified fact observation time'),
    freshness: parsedFreshness,
    ...(input['providerFingerprint'] === undefined
      ? {}
      : {
        providerFingerprint: identifier(
          input['providerFingerprint'],
          'verified fact provider fingerprint',
        ),
      }),
    ...(input['observationRef'] === undefined
      ? {}
      : {
        observationRef: identifier(
          input['observationRef'],
          'verified fact observation reference',
        ),
      }),
    valueRef: identifier(input['valueRef'], 'verified fact value reference'),
    confidence: confidence as VerifiedFactReferenceV2['confidence'],
  };
}

function parseJournalEntry(value: unknown): TaskJournalEntryV2 {
  const input = record(value, 'task journal entry');
  return {
    entryId: identifier(input['entryId'], 'journal entry identifier'),
    at: timestamp(input['at'], 'journal entry time'),
    type: identifier(input['type'], 'journal entry type'),
    ...(input['stepId'] === undefined
      ? {}
      : { stepId: identifier(input['stepId'], 'journal step identifier') }),
    ...(input['operationId'] === undefined
      ? {}
      : {
        operationId: identifier(
          input['operationId'],
          'journal operation identifier',
        ),
      }),
    ...(input['dataRef'] === undefined
      ? {}
      : { dataRef: identifier(input['dataRef'], 'journal data reference') }),
  };
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${label}.`);
  }
}

function assertAcyclic(steps: readonly PhoneTaskStepV2[]): void {
  const dependencies = new Map(steps.map((step) => [step.stepId, step.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) throw new Error('Phone task step graph contains a cycle.');
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of dependencies.get(stepId) ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.stepId);
}

export function parsePhoneTaskV2(value: unknown): PhoneTaskV2 {
  const input = record(value, 'phone task V2');
  if (input['version'] !== PHONE_TASK_V2_VERSION) {
    throw new Error('Unsupported phone task version.');
  }
  const status = stringValue(input['status'], 'phone task status');
  if (!taskStatuses.has(status as PhoneTaskStatusV2)) {
    throw new Error('Invalid phone task status.');
  }
  if (!Array.isArray(input['steps']) || input['steps'].length === 0) {
    throw new Error('A phone task V2 requires at least one step.');
  }
  if (!Array.isArray(input['verifiedFacts']) || !Array.isArray(input['journal'])) {
    throw new Error('Invalid phone task evidence collections.');
  }

  const steps = input['steps'].map(parseStep);
  const verifiedFacts = input['verifiedFacts'].map(parseFact);
  const journal = input['journal'].map(parseJournalEntry);
  const budgets = parseBudgets(input['budgets']);
  const taskId = identifier(input['taskId'], 'phone task identifier');
  const revision = integer(input['revision'], 'phone task revision');
  const activeStepId = input['activeStepId'] === undefined
    ? undefined
    : identifier(input['activeStepId'], 'active step identifier');
  const pendingInteraction = input['pendingInteraction'] === undefined
    ? undefined
    : parseInteraction(input['pendingInteraction']);
  const turnContext = input['turnContext'] === undefined
    ? undefined
    : parseTurnContext(input['turnContext']);

  assertUnique(steps.map((step) => step.stepId), 'phone task step identifier');
  assertUnique(
    verifiedFacts.map((fact) => fact.factId),
    'verified fact identifier',
  );
  assertUnique(journal.map((entry) => entry.entryId), 'journal entry identifier');

  const stepIds = new Set(steps.map((step) => step.stepId));
  for (const step of steps) {
    assertUnique(step.dependsOn, `dependency on step ${step.stepId}`);
    for (const dependency of step.dependsOn) {
      if (dependency === step.stepId || !stepIds.has(dependency)) {
        throw new Error(`Invalid dependency on step ${step.stepId}.`);
      }
    }
    if (step.attempts > budgets.maxAttemptsPerStep) {
      throw new Error(`Step ${step.stepId} exceeds its attempt budget.`);
    }
  }
  assertAcyclic(steps);

  if (steps.length > budgets.maxSteps) throw new Error('Task exceeds its step budget.');
  if (journal.length > budgets.maxJournalEntries) {
    throw new Error('Task exceeds its journal budget.');
  }
  if (verifiedFacts.length > budgets.maxVerifiedFacts) {
    throw new Error('Task exceeds its verified fact budget.');
  }
  if (activeStepId && !stepIds.has(activeStepId)) {
    throw new Error('Active step does not exist.');
  }
  if (pendingInteraction) {
    if (pendingInteraction.taskId !== taskId) {
      throw new Error('Pending interaction belongs to another task.');
    }
    if (pendingInteraction.taskRevision !== revision) {
      throw new Error('Pending interaction revision is stale.');
    }
    if (pendingInteraction.expiresAt <= pendingInteraction.createdAt) {
      throw new Error('Pending interaction expiry must follow its creation.');
    }
    if (!['open', 'resolving'].includes(pendingInteraction.status)) {
      throw new Error('A retained pending interaction must still be actionable.');
    }
  }
  if (status === 'waiting_for_user' && !pendingInteraction) {
    throw new Error('A task waiting for the user requires a pending interaction.');
  }
  if (
    pendingInteraction
    && !['paused', 'waiting_for_user'].includes(status)
  ) {
    throw new Error(
      'Only a paused task or task waiting for the user may retain an interaction.',
    );
  }
  const terminalAt = input['terminalAt'] === undefined
    ? undefined
    : timestamp(input['terminalAt'], 'phone task terminal time');
  if (TERMINAL_TASK_STATUSES_V2.has(status as PhoneTaskStatusV2)) {
    if (terminalAt === undefined) throw new Error('Terminal task is missing terminal time.');
    if (
      status === 'completed'
      && steps.some((step) => !TERMINAL_STEP_STATUSES_V2.has(step.status))
    ) {
      throw new Error('Completed task contains unfinished steps.');
    }
  } else if (terminalAt !== undefined) {
    throw new Error('Non-terminal task cannot have a terminal time.');
  }

  const desired = input['desiredTerminalOutcome'] === undefined
    ? undefined
    : record(input['desiredTerminalOutcome'], 'desired terminal outcome');
  const productChoicePolicy = input['productChoicePolicy'] === undefined
    ? undefined
    : parseProductChoicePolicyV2(input['productChoicePolicy']);
  const createdAt = timestamp(input['createdAt'], 'phone task creation time');
  const updatedAt = timestamp(input['updatedAt'], 'phone task update time');
  if (updatedAt < createdAt || (terminalAt !== undefined && terminalAt < createdAt)) {
    throw new Error('Phone task timestamps are out of order.');
  }
  if (
    turnContext
    && (
      turnContext.updatedAt < createdAt
      || turnContext.updatedAt > updatedAt
    )
  ) {
    throw new Error('Task turn context timestamp is out of range.');
  }

  const parsed: PhoneTaskV2 = {
    version: PHONE_TASK_V2_VERSION,
    taskId,
    clientId: stringValue(input['clientId'], 'phone task client'),
    revision,
    originalGoal: stringValue(input['originalGoal'], 'phone task original goal'),
    goalKind: identifier(input['goalKind'], 'phone task goal kind'),
    status: status as PhoneTaskStatusV2,
    ...(activeStepId ? { activeStepId } : {}),
    steps,
    ...(desired
      ? {
        desiredTerminalOutcome: {
          kind: identifier(desired['kind'], 'desired terminal outcome kind'),
          ...(desired['paymentPreference'] === undefined
            ? {}
            : {
              paymentPreference: desired['paymentPreference'] as
                | 'cod'
                | 'provider_saved'
                | 'ask_user',
            }),
        },
      }
      : {}),
    ...(productChoicePolicy ? { productChoicePolicy } : {}),
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(turnContext ? { turnContext } : {}),
    verifiedFacts,
    journal,
    budgets,
    createdAt,
    updatedAt,
    ...(terminalAt === undefined ? {} : { terminalAt }),
  };

  if (
    parsed.desiredTerminalOutcome?.paymentPreference
    && !['cod', 'provider_saved', 'ask_user'].includes(
      parsed.desiredTerminalOutcome.paymentPreference,
    )
  ) {
    throw new Error('Invalid desired payment preference.');
  }
  return parsed;
}

export function cloneAndValidatePhoneTaskV2(value: unknown): PhoneTaskV2 {
  return parsePhoneTaskV2(structuredClone(value));
}
