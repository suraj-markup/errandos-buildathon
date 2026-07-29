import type {
  PhoneTaskV2,
  ProductChoicePolicyV2,
} from './contracts';
import {
  type PhoneTaskRepositoryV2,
  type TaskRepositoryRecordV2,
} from './repository';
import { parsePhoneTaskV2 } from './validation';

export type ProductChoicePolicyStateV2 = {
  configured: boolean;
  hasPreviousPreference: boolean;
  mode: ProductChoicePolicyV2['mode'];
  preferredBrandCount: number;
  priceCeiling?: {
    amount: number;
    currency: 'INR';
  };
};

export function productChoicePolicyStateV2(
  policy: ProductChoicePolicyV2 | undefined,
): ProductChoicePolicyStateV2 {
  return {
    configured: policy !== undefined,
    hasPreviousPreference: policy?.previousPreference !== undefined,
    mode: policy?.mode ?? 'ask_every_time',
    preferredBrandCount: policy?.preferredBrands?.length ?? 0,
    ...(policy?.priceCeiling
      ? { priceCeiling: structuredClone(policy.priceCeiling) }
      : {}),
  };
}

export function parseProductChoicePolicyUpdateV2(
  task: PhoneTaskV2,
  value: unknown,
): ProductChoicePolicyV2 {
  const parsed = parsePhoneTaskV2({
    ...structuredClone(task),
    productChoicePolicy: structuredClone(value),
  });
  if (!parsed.productChoicePolicy) {
    throw new Error('A product choice policy is required.');
  }
  return parsed.productChoicePolicy;
}

export async function commitProductChoicePolicyV2(input: {
  at?: number;
  expectedRevision: number;
  policy?: ProductChoicePolicyV2;
  repository: PhoneTaskRepositoryV2;
  taskId: string;
}): Promise<TaskRepositoryRecordV2> {
  const current = await input.repository.getById(input.taskId);
  if (!current) throw new Error('Unknown product choice policy task.');
  const at = Math.max(input.at ?? Date.now(), current.task.updatedAt);
  const revision = current.task.revision + 1;
  const next = parsePhoneTaskV2({
    ...structuredClone(current.task),
    revision,
    updatedAt: at,
    ...(current.task.pendingInteraction
      ? {
          pendingInteraction: {
            ...structuredClone(current.task.pendingInteraction),
            taskRevision: revision,
          },
        }
      : {}),
    ...(input.policy
      ? { productChoicePolicy: structuredClone(input.policy) }
      : { productChoicePolicy: undefined }),
  });
  const mode = next.productChoicePolicy?.mode ?? 'ask_every_time';
  return input.repository.commit({
    expectedRevision: input.expectedRevision,
    task: next,
    event: {
      eventId: `product-choice-policy:${next.revision}`,
      taskId: next.taskId,
      taskRevision: next.revision,
      at,
      kind: input.policy
        ? 'product_choice_policy_set'
        : 'product_choice_policy_cleared',
      dataRef: `policy:${mode}`,
    },
    ...(current.activeOperation
      ? { activeOperation: structuredClone(current.activeOperation) }
      : {}),
  });
}
