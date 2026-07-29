import { describe, expect, it, vi } from 'vitest';
import {
  DeterministicVoicePresentationAdapter,
} from './presentation-adapter';
import type {
  OpenAIResponse,
  OpenAIResponseRequest,
  ResponsesProvider,
} from './provider-adapters';

class FakeResponsesProvider implements ResponsesProvider {
  readonly requests: OpenAIResponseRequest[] = [];

  constructor(private readonly translatedText = 'जोड़ दिया।') {}

  async createResponse(
    body: OpenAIResponseRequest,
  ): Promise<OpenAIResponse> {
    this.requests.push(body);
    return {
      id: 'localized-response',
      output_text: this.translatedText,
    };
  }
}

describe('deterministic voice presentation adapter', () => {
  it('makes deterministic presentation text available before localization settles', async () => {
    let resolveLocalization:
      | ((value: OpenAIResponse) => void)
      | undefined;
    const provider: ResponsesProvider = {
      createResponse: vi.fn(
        (): Promise<OpenAIResponse> => new Promise((resolve) => {
          resolveLocalization = resolve;
        }),
      ),
    };
    const adapter = new DeterministicVoicePresentationAdapter(provider);
    const input = {
      fallbackReply: 'Done.',
      languageCode: 'hi-IN',
      modelResponse: {},
      result: {
        ok: true as const,
        product: 'Amul Milk',
        quantity: 1,
        status: 'added',
      },
      toolResults: [{
        ok: true as const,
        product: 'Amul Milk',
        quantity: 1,
        status: 'added',
      }],
      transcript: 'दूध जोड़ो',
    };

    const deterministic = adapter.createDeterministic(input);

    expect(deterministic.reply).toBe('Added Amul Milk.');
    expect(deterministic.presentation.spoken.text).toBe('Added Amul Milk.');
    expect(provider.createResponse).not.toHaveBeenCalled();

    const localizedPromise = adapter.localize(input, deterministic);
    expect(provider.createResponse).toHaveBeenCalledTimes(1);
    resolveLocalization?.({
      id: 'localized-response',
      output_text: 'Amul Milk जोड़ दिया।',
    });

    const localized = await localizedPromise;
    expect(localized.reply).toBe('Amul Milk जोड़ दिया।');
    expect(localized.presentation.spoken.text).toBe(localized.reply);
    expect(localized.assistantState).toBe(deterministic.assistantState);
    expect(localized.presentation.card).toEqual(
      deterministic.presentation.card,
    );
  });

  it('derives spoken wording and overlay state from verified tool results', async () => {
    const provider = new FakeResponsesProvider();
    const adapter = new DeterministicVoicePresentationAdapter(provider);

    const output = await adapter.create({
      fallbackReply: 'Done.',
      languageCode: 'en-IN',
      modelResponse: { output_text: 'The model guessed something else.' },
      result: {
        ok: true,
        product: 'Amul Taaza Toned Milk',
        quantity: 1,
        size: '500 ml',
        status: 'added',
      },
      toolResults: [{
        ok: true,
        product: 'Amul Taaza Toned Milk',
        quantity: 1,
        size: '500 ml',
        status: 'added',
      }],
      transcript: 'Add milk.',
    });

    expect(output.reply).toBe('Added Amul Taaza Toned Milk, 500 ml.');
    expect(output.assistantState).toBe('success');
    expect(output.presentation.mode).toBe('success');
    expect(output.presentation.spoken.text).toBe(output.reply);
    expect(provider.requests).toHaveLength(0);
  });

  it('uses the response provider only for localization and falls back safely', async () => {
    const provider = new FakeResponsesProvider('दूध जोड़ दिया।');
    const adapter = new DeterministicVoicePresentationAdapter(provider);

    const output = await adapter.create({
      fallbackReply: 'Done.',
      languageCode: 'hi-IN',
      modelResponse: {},
      result: {
        ok: true,
        product: 'दूध',
        quantity: 1,
        status: 'added',
      },
      toolResults: [{
        ok: true,
        product: 'दूध',
        quantity: 1,
        status: 'added',
      }],
      transcript: 'दूध जोड़ो',
    });

    expect(output.reply).toBe('दूध जोड़ दिया।');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.['tools']).toBeUndefined();
  });

  it('keeps provider prose from overriding deterministic tool truth', async () => {
    const provider: ResponsesProvider = {
      createResponse: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };
    const adapter = new DeterministicVoicePresentationAdapter(provider);

    const output = await adapter.create({
      fallbackReply: 'Done.',
      languageCode: 'hi-IN',
      modelResponse: { output_text: 'The order was placed.' },
      result: {
        failure: {
          operation: 'add_cart_item',
          reason: 'cart_not_updated',
          recoverable: true,
          stage: 'mutation',
        },
        ok: false,
        status: 'execution_failed',
      },
      toolResults: [{
        failure: {
          operation: 'add_cart_item',
          reason: 'cart_not_updated',
          recoverable: true,
          stage: 'mutation',
        },
        ok: false,
        status: 'execution_failed',
      }],
      transcript: 'दूध जोड़ो',
    });

    expect(output.reply).toBe('The cart did not update. Try again.');
    expect(output.assistantState).toBe('error');
    expect(output.reply).not.toContain('order was placed');
  });

  it('renders precise reconciliation as ambiguous with no mutation retry', () => {
    const adapter = new DeterministicVoicePresentationAdapter(
      new FakeResponsesProvider(),
    );

    const output = adapter.createDeterministic({
      fallbackReply: 'Done.',
      languageCode: 'en-IN',
      modelResponse: {},
      result: {
        ok: false,
        product: 'Amul Milk',
        status: 'reconciliation_required',
      },
      toolResults: [{
        ok: false,
        product: 'Amul Milk',
        status: 'reconciliation_required',
      }],
      transcript: 'Add milk.',
    });

    expect(output.assistantState).toBe('error');
    expect(output.presentation.mode).toBe('ambiguous');
    expect(output.presentation.card).toEqual({ type: 'ambiguous' });
    expect(output.reply).toContain('stopped before the next item');
    expect(output.reply).not.toContain('Try again');
  });

  it('renders a precise connection issue instead of provider prose', () => {
    const adapter = new DeterministicVoicePresentationAdapter(
      new FakeResponsesProvider(),
    );

    const output = adapter.createDeterministic({
      fallbackReply: 'Done.',
      languageCode: 'en-IN',
      modelResponse: { output_text: 'Everything worked.' },
      result: {
        message: 'private raw Appium exception',
        ok: false,
        status: 'appium_unavailable',
      },
      toolResults: [{
        message: 'private raw Appium exception',
        ok: false,
        status: 'appium_unavailable',
      }],
      transcript: 'Add milk.',
    });

    expect(output.presentation.mode).toBe('error');
    expect(output.presentation.card).toEqual({
      reason: 'The phone automation service is not reachable.',
      type: 'provider_constraint',
    });
    expect(output.reply).toBe(
      'Phone control unavailable. '
      + 'The phone automation service is not reachable.',
    );
    expect(output.reply).not.toContain('private raw');
  });
});
