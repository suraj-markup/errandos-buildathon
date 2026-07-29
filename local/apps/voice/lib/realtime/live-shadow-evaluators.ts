import {
  extractResponseText,
  OpenAIResponsesAdapter,
} from '../voice-turn/provider-adapters';
import type {
  ControlShadowDecisionV1,
  ControlShadowEvaluator,
  ControlShadowEvaluatorInputV1,
} from './shadow-coordinator';
import { OpenAIRealtimeControlAdapter } from './provider-adapter';

const SHADOW_DECISION_INSTRUCTIONS = [
  'You are evaluating phone-control intent. Do not execute any tool.',
  'Return only one valid JSON object, with no Markdown, prose, or blockquote prefix.',
  'Set followUp to true or false; never return null.',
  'The object must have version=1 and these fields:',
  'taskIntent, toolIntent, clarification, followUp, products,',
  'negatedProducts, negatedOrdinals, and optional ordinal and groundingCandidateId.',
  'Allowed taskIntent: add_product, cancel_task, inspect_cart, prepare_checkout, remove_product, resolve_product_choice.',
  'Allowed toolIntent: add_cart_item, cancel_current_task, inspect_cart, prepare_checkout, remove_cart_item, select_product.',
  'Allowed clarification: none, required, resolved.',
  'Each product has product, quantity, and optional brand, packAmount, packUnit.',
  'Allowed packUnit: g, kg, l, ml, piece.',
  'Use the supplied sanitized task and observation metadata only.',
].join(' ');

function evaluatorPrompt(input: Readonly<ControlShadowEvaluatorInputV1>): string {
  return JSON.stringify({
    languageCode: input.languageCode,
    observation: input.observation ?? null,
    sarvamTranscript: input.sarvamTranscript,
    task: input.task,
  });
}

const TASK_INTENTS = new Set<ControlShadowDecisionV1['taskIntent']>([
  'add_product',
  'cancel_task',
  'inspect_cart',
  'prepare_checkout',
  'remove_product',
  'resolve_product_choice',
]);
const TOOL_INTENTS = new Set<ControlShadowDecisionV1['toolIntent']>([
  'add_cart_item',
  'cancel_current_task',
  'inspect_cart',
  'prepare_checkout',
  'remove_cart_item',
  'select_product',
]);
const CLARIFICATIONS = new Set<ControlShadowDecisionV1['clarification']>([
  'none',
  'required',
  'resolved',
]);

function extractJsonObject(text: string): string {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^>\s*/, '');
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error('Control shadow evaluator did not return a JSON object.');
  }
  return trimmed.slice(firstBrace, lastBrace + 1);
}

export function parseControlShadowDecisionV1(
  text: string,
  context: Pick<ControlShadowEvaluatorInputV1, 'task'>,
): ControlShadowDecisionV1 {
  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  const products = Array.isArray(parsed.products)
    ? parsed.products.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
        const product = raw as Record<string, unknown>;
        if (
          typeof product.product !== 'string'
          || typeof product.quantity !== 'number'
        ) return [];
        return [{
          product: product.product,
          quantity: product.quantity,
          ...(typeof product.brand === 'string'
            ? { brand: product.brand }
            : {}),
          ...(typeof product.packAmount === 'number'
            ? { packAmount: product.packAmount }
            : {}),
          ...(
            typeof product.packUnit === 'string'
            && ['g', 'kg', 'l', 'ml', 'piece'].includes(product.packUnit)
              ? {
                  packUnit: product.packUnit as
                    'g' | 'kg' | 'l' | 'ml' | 'piece',
                }
              : {}
          ),
        }];
      })
    : [];
  const negatedProducts = Array.isArray(parsed.negatedProducts)
    ? parsed.negatedProducts.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const negatedOrdinals = Array.isArray(parsed.negatedOrdinals)
    ? parsed.negatedOrdinals.filter(
        (value): value is number => typeof value === 'number',
      )
    : [];
  if (
    parsed.version !== 1
    || (
      typeof parsed.followUp !== 'boolean'
      && parsed.followUp !== null
      && parsed.followUp !== undefined
    )
    || !TASK_INTENTS.has(
      parsed.taskIntent as ControlShadowDecisionV1['taskIntent'],
    )
    || !TOOL_INTENTS.has(
      parsed.toolIntent as ControlShadowDecisionV1['toolIntent'],
    )
    || !CLARIFICATIONS.has(
      parsed.clarification as ControlShadowDecisionV1['clarification'],
    )
  ) {
    throw new Error('Control shadow evaluator returned an invalid decision.');
  }
  return {
    clarification: parsed.clarification as ControlShadowDecisionV1['clarification'],
    // Realtime occasionally emits null for a required boolean despite an
    // explicit instruction. The sanitized task state is the authoritative
    // source for whether this is a follow-up turn.
    followUp: typeof parsed.followUp === 'boolean'
      ? parsed.followUp
      : context.task.awaitingClarification,
    ...(typeof parsed.groundingCandidateId === 'string'
      ? { groundingCandidateId: parsed.groundingCandidateId }
      : {}),
    negatedOrdinals,
    negatedProducts,
    ...(typeof parsed.ordinal === 'number'
      ? { ordinal: parsed.ordinal }
      : {}),
    products,
    taskIntent: parsed.taskIntent as ControlShadowDecisionV1['taskIntent'],
    toolIntent: parsed.toolIntent as ControlShadowDecisionV1['toolIntent'],
    version: 1,
  };
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}

export function createLiveResponsesShadowEvaluator(input: {
  apiKey: string;
  concurrency?: number;
  model: string;
}): ControlShadowEvaluator {
  const provider = new OpenAIResponsesAdapter(input.apiKey);
  const semaphore = new Semaphore(input.concurrency ?? 2);
  return {
    evaluate: async (turn) => semaphore.run(async () => {
      const response = await provider.createResponse({
        instructions: SHADOW_DECISION_INSTRUCTIONS,
        input: evaluatorPrompt(turn),
        model: input.model,
        tool_choice: 'none',
        tools: [],
      });
      return parseControlShadowDecisionV1(extractResponseText(response), turn);
    }),
  };
}

export function createLiveRealtimeShadowEvaluator(input: {
  apiKey: string;
  concurrency?: number;
  model: string;
}): ControlShadowEvaluator {
  const provider = new OpenAIRealtimeControlAdapter({ apiKey: input.apiKey });
  const semaphore = new Semaphore(input.concurrency ?? 2);
  return {
    evaluate: async (turn, context) => semaphore.run(async () => {
      const result = await provider.createResponse({
        instructions: SHADOW_DECISION_INSTRUCTIONS,
        input: evaluatorPrompt(turn),
        model: input.model,
        tool_choice: 'none',
        tools: [],
      }, {
        clientId: `shadow-${turn.caseId}`,
        requestId: `shadow-${turn.caseId}`,
        signal: context.signal,
        version: 1,
      });
      return parseControlShadowDecisionV1(
        extractResponseText(result.response),
        turn,
      );
    }),
  };
}
