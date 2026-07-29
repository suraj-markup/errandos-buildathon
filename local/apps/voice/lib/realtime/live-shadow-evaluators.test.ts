import { describe, expect, it } from 'vitest';
import { CONTROL_SHADOW_CORPUS_V1 } from './shadow-corpus';
import { parseControlShadowDecisionV1 } from './live-shadow-evaluators';

describe('live shadow evaluator fixtures', () => {
  it('use only sanitized transcripts and observation metadata', () => {
    expect(CONTROL_SHADOW_CORPUS_V1).toHaveLength(12);
    expect(JSON.stringify(CONTROL_SHADOW_CORPUS_V1)).not.toMatch(
      /data:image|screenshotBase64|deviceSerial|address/i,
    );
  });

  it('normalizes a blockquoted GA response and derives a null follow-up flag from task state', () => {
    expect(parseControlShadowDecisionV1(
      [
        '>',
        JSON.stringify({
          clarification: 'resolved',
          followUp: null,
          negatedOrdinals: [1],
          negatedProducts: [],
          ordinal: 2,
          products: [],
          taskIntent: 'resolve_product_choice',
          toolIntent: 'select_product',
          version: 1,
        }),
      ].join(''),
      {
        task: {
          activeItemPosition: 1,
          awaitingClarification: true,
          hasPendingCheckout: false,
          itemCount: 1,
          phase: 'awaiting_product_choice',
          version: 1,
        },
      },
    )).toMatchObject({
      followUp: true,
      ordinal: 2,
      taskIntent: 'resolve_product_choice',
      toolIntent: 'select_product',
    });
  });

  it('rejects unknown tool intent instead of casting it into the decision', () => {
    expect(() => parseControlShadowDecisionV1(
      JSON.stringify({
        clarification: 'none',
        followUp: false,
        negatedOrdinals: [],
        negatedProducts: [],
        products: [],
        taskIntent: 'inspect_cart',
        toolIntent: 'place_order',
        version: 1,
      }),
      {
        task: {
          awaitingClarification: false,
          hasPendingCheckout: false,
          itemCount: 0,
          phase: 'active',
          version: 1,
        },
      },
    )).toThrow(/invalid decision/);
  });
});
