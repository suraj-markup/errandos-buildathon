import type { LocalIdentifier } from '../identifiers';
import {
  transitionPhoneTaskV2,
} from './graph';
import {
  evaluateProductChoicePolicyV2,
  type ProductChoicePolicyDecisionV2,
  type ProductChoicePolicyOptionV2,
  type ProductChoicePolicyRequestV2,
  type ProductChoiceSensitivityV2,
} from './product-choice-policy';
import {
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

type JsonRecord = Record<string, unknown>;

export type SearchProductChoicePolicyCompletionV2 = {
  decision: ProductChoicePolicyDecisionV2;
  record: TaskRepositoryRecordV2;
  selected: boolean;
};

const sensitivities = new Set<ProductChoiceSensitivityV2>([
  'none',
  'age_restricted',
  'dietary_variant',
  'meat_cut',
  'medicine',
  'other_sensitive',
]);

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function exactText(
  value: unknown,
  maximum: number,
): string | undefined {
  return typeof value === 'string'
    && value.trim()
    && value.trim() === value
    && value.length <= maximum
    ? value
    : undefined;
}

function sensitivity(
  value: unknown,
): ProductChoiceSensitivityV2 | undefined {
  return typeof value === 'string'
    && sensitivities.has(value as ProductChoiceSensitivityV2)
    ? value as ProductChoiceSensitivityV2
    : undefined;
}

function policyRequest(
  result: JsonRecord,
  label: string,
): ProductChoicePolicyRequestV2 | undefined {
  const context = record(result['policyContext']);
  if (!context) return undefined;
  const allowed = new Set([
    'category',
    'packSize',
    'productForm',
    'sensitivity',
  ]);
  if (Object.keys(context).some((key) => !allowed.has(key))) return undefined;
  const category = exactText(context['category'], 120);
  if (!category) return undefined;
  const packSize = exactText(context['packSize'], 80);
  const productForm = exactText(context['productForm'], 80);
  const sensitivityValue = sensitivity(context['sensitivity']);
  if (
    context['packSize'] !== undefined && !packSize
    || context['productForm'] !== undefined && !productForm
    || context['sensitivity'] !== undefined && !sensitivityValue
  ) {
    return undefined;
  }
  return {
    category,
    label,
    ...(packSize ? { packSize } : {}),
    ...(productForm ? { productForm } : {}),
    ...(sensitivityValue ? { sensitivity: sensitivityValue } : {}),
  };
}

function policyOption(value: unknown): ProductChoicePolicyOptionV2 | undefined {
  const option = record(value);
  if (!option) return undefined;
  const offerId = exactText(option['offerId'], 200);
  const title = exactText(
    option['title'] ?? option['product'] ?? option['spokenLabel'],
    300,
  );
  const category = exactText(option['category'], 120);
  const brand = exactText(option['brand'], 80);
  const packSize = exactText(option['packSize'] ?? option['size'], 80);
  const productForm = exactText(option['productForm'], 80);
  const sensitivityValue = sensitivity(option['sensitivity']);
  const priceAmount = option['priceAmount'];
  if (
    !offerId
    || !title
    || !category
    || !packSize
    || !productForm
    || typeof priceAmount !== 'number'
    || !Number.isFinite(priceAmount)
    || priceAmount < 0
    || option['priceCurrency'] !== 'INR'
    || (option['brand'] !== undefined && !brand)
    || (option['sensitivity'] !== undefined && !sensitivityValue)
    || (
      option['suggested'] !== undefined
      && typeof option['suggested'] !== 'boolean'
    )
  ) {
    return undefined;
  }
  return {
    offerId,
    title,
    category,
    priceAmount,
    priceCurrency: 'INR',
    packSize,
    productForm,
    ...(brand ? { brand } : {}),
    ...(sensitivityValue ? { sensitivity: sensitivityValue } : {}),
    ...(typeof option['suggested'] === 'boolean'
      ? { suggested: option['suggested'] }
      : {}),
  };
}

function selectedAction(
  task: TaskRepositoryRecordV2['task'],
  stepId: string,
  option: ProductChoicePolicyOptionV2,
): JsonRecord {
  const step = task.steps.find((candidate) => candidate.stepId === stepId);
  const input = record(step?.input) ?? {};
  const quantity = Number.isSafeInteger(input['quantity'])
    && (input['quantity'] as number) >= 1
    && (input['quantity'] as number) <= 20
    ? input['quantity'] as number
    : 1;
  const searchQuery = exactText(input['request'], 500) ?? option.title;
  return {
    action: 'add_cart_item',
    offerId: option.offerId,
    quantity,
    request: option.title,
    searchQuery,
    selectedOffer: {
      offerId: option.offerId,
      title: option.title,
      packSize: option.packSize,
      priceAmount: option.priceAmount,
      priceCurrency: 'INR',
    },
  };
}

function policyResultRef(
  operationId: string,
  decision: ProductChoicePolicyDecisionV2,
): string {
  return decision.decision === 'select'
    ? `policy-selected:${operationId}:${decision.policy}`
    : `policy-asked:${operationId}:${decision.reason}`;
}

/**
 * Commits a search result and its policy decision in one task CAS. A selected
 * offer is persisted as the exact next add action before the background worker
 * reports completion, so continuation dispatch can never re-search.
 */
export async function commitSearchProductChoicePolicyV2(input: {
  operationId: LocalIdentifier<'operation'>;
  repository: PhoneTaskRepositoryV2;
  result: unknown;
  stepId: string;
  task: TaskRepositoryRecordV2['task'];
}): Promise<SearchProductChoicePolicyCompletionV2 | undefined> {
  const result = record(input.result);
  if (
    !result
    || !['needs_clarification', 'search_results'].includes(
      String(result['status'] ?? ''),
    )
    || !Array.isArray(result['options'])
    || result['options'].length === 0
  ) {
    return undefined;
  }
  const step = input.task.steps.find((candidate) =>
    candidate.stepId === input.stepId);
  if (
    !step
    || step.kind !== 'search_products'
    || step.status !== 'running'
    || step.operationId !== input.operationId
  ) {
    throw new Error('Search policy decision does not own the active step.');
  }

  const inputRecord = record(step.input) ?? {};
  const label = exactText(inputRecord['request'], 500) ?? '';
  const request = policyRequest(result, label);
  const options = result['options'].map(policyOption);
  const completeMetadata = Boolean(request)
    && options.length <= 10
    && options.every(
      (option): option is ProductChoicePolicyOptionV2 => option !== undefined,
    );
  const decision = completeMetadata
    ? evaluateProductChoicePolicyV2({
        options,
        policy: input.task.productChoicePolicy,
        request: request!,
      })
    : {
        decision: 'ask' as const,
        reason: 'invalid_options' as const,
      };
  const at = Math.max(Date.now(), input.task.updatedAt);
  const resultRef = policyResultRef(input.operationId, decision);

  if (decision.decision === 'ask') {
    const interaction = {
      interactionId:
        `interaction:${input.operationId}:${input.task.revision + 1}`,
      taskId: input.task.taskId,
      taskRevision: input.task.revision + 1,
      kind: 'product_choice' as const,
      allowedResponses: structuredClone(result['options']),
      presentationRef: `presentation:${input.operationId}`,
      status: 'open' as const,
      createdAt: at,
      expiresAt: at + 5 * 60_000,
    };
    const next = transitionPhoneTaskV2(input.task, {
      type: 'wait_for_user',
      stepId: input.stepId,
      interaction,
      entryId: `product-choice-policy-asked:${input.operationId}`,
      dataRef: resultRef,
      at,
    });
    const committed = await input.repository.commit({
      expectedRevision: input.task.revision,
      task: next,
      event: {
        eventId:
          `product-choice-policy-asked:${input.operationId}:${next.revision}`,
        taskId: next.taskId,
        taskRevision: next.revision,
        at,
        kind: 'product_choice_policy_asked',
        dataRef: resultRef,
      },
    });
    return { decision, record: committed, selected: false };
  }

  const option = options.find((candidate) =>
    candidate?.offerId === decision.offerId);
  if (!option) throw new Error('Product policy selected an unknown offer.');
  if (input.task.journal.length >= input.task.budgets.maxJournalEntries) {
    throw new Error('Product policy decision exceeds the journal budget.');
  }
  const action = selectedAction(input.task, input.stepId, option);
  const next = parsePhoneTaskV2({
    ...structuredClone(input.task),
    revision: input.task.revision + 1,
    status: 'active',
    activeStepId: undefined,
    pendingInteraction: undefined,
    updatedAt: at,
    steps: input.task.steps.map((candidate) =>
      candidate.stepId === input.stepId
        ? {
            ...structuredClone(candidate),
            kind: 'add_cart_item',
            status: 'ready',
            operationId: undefined,
            input: action,
            lastResultRef: resultRef,
          }
        : structuredClone(candidate)),
    journal: [...input.task.journal, {
      entryId: `product-choice-policy-selected:${input.operationId}`,
      at,
      type: 'product_choice_policy_selected',
      stepId: input.stepId,
      operationId: input.operationId,
      dataRef: resultRef,
    }],
  });
  const committed = await input.repository.commit({
    expectedRevision: input.task.revision,
    task: next,
    event: {
      eventId:
        `product-choice-policy-selected:${input.operationId}:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: 'product_choice_policy_selected',
      dataRef: resultRef,
    },
  });
  return { decision, record: committed, selected: true };
}
