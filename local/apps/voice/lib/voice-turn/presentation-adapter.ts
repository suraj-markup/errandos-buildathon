import type {
  OverlayPresentationV1,
  OverlayProductSelectionBinding,
  OverlayStructuredTaskProgressV1,
} from '@errandos/contracts';
import {
  buildOverlayPresentation,
  legacyAssistantStateFor,
} from '../overlay-presentation-builder';
import {
  presentToolResults,
  type PresentableToolResult,
} from '../voice-presentation';
import {
  errorDetails,
  logEvent,
} from '../structured-logger';
import { loadVoiceRuntimePolicy } from '../runtime-policy';
import {
  extractResponseText,
  type OpenAIResponse,
  type ResponsesProvider,
} from './provider-adapters';

const languageRequirements: Record<string, string> = {
  'bn-IN': 'Bengali using Bengali script. Do not switch to Hindi or Hinglish.',
  'gu-IN': 'Gujarati using Gujarati script. Do not switch to Hindi or Hinglish.',
  'hi-IN': 'Hindi using Devanagari script, preserving natural English product or app names.',
  'kn-IN': 'Kannada using Kannada script. Do not switch to Hindi or Hinglish.',
  'ml-IN': 'Malayalam using Malayalam script. Do not switch to Hindi or Hinglish.',
  'mr-IN': 'Marathi using Devanagari script. Do not switch to Hindi or Hinglish.',
  'od-IN': 'Odia using Odia script. Do not switch to Hindi or Hinglish.',
  'pa-IN': 'Punjabi using Gurmukhi script. Do not switch to Hindi or Hinglish.',
  'ta-IN': 'Tamil using Tamil script. Do not switch to Hindi or Hinglish.',
  'te-IN': 'Telugu using Telugu script. Do not switch to Hindi or Hinglish.',
};

type VoicePresentation = {
  assistantState: 'clarification' | 'error' | 'ready' | 'success';
  presentation: OverlayPresentationV1;
  reply: string;
};

type VoicePresentationInput = {
  fallbackReply: string;
  languageCode: string;
  modelResponse: OpenAIResponse;
  productSelection?: OverlayProductSelectionBinding;
  replyOverride?: string;
  result: PresentableToolResult;
  taskProgress?: OverlayStructuredTaskProgressV1;
  toolResults: readonly PresentableToolResult[];
  transcript: string;
};

export interface VoicePresentationAdapter {
  /**
   * Builds authoritative presentation text synchronously. This is safe to
   * publish before optional localization or speech synthesis has completed.
   */
  createDeterministic(input: VoicePresentationInput): VoicePresentation;

  /**
   * Optionally localizes an already-built deterministic presentation without
   * changing its structured result or state.
   */
  localize(
    input: VoicePresentationInput,
    deterministic: VoicePresentation,
  ): Promise<VoicePresentation>;

  /**
   * Compatibility path for callers that still want to await localization.
   */
  create(input: VoicePresentationInput): Promise<VoicePresentation>;
}

export class DeterministicVoicePresentationAdapter
implements VoicePresentationAdapter {
  constructor(
    private readonly responses: ResponsesProvider,
    private readonly boundedControlModel =
      loadVoiceRuntimePolicy().boundedControlModel,
  ) {}

  createDeterministic(input: VoicePresentationInput): VoicePresentation {
    const conciseReply = input.replyOverride
      ?? (
        input.toolResults.length > 0
          ? presentToolResults(input.toolResults)
          : extractResponseText(input.modelResponse) || input.fallbackReply
      );
    return this.build(input, conciseReply);
  }

  async localize(
    input: VoicePresentationInput,
    deterministic: VoicePresentation,
  ): Promise<VoicePresentation> {
    if (input.toolResults.length === 0 || input.languageCode === 'en-IN') {
      return deterministic;
    }
    const reply = await this.localizeReply(
      deterministic.reply,
      input.transcript,
      input.languageCode,
    );
    if (reply === deterministic.reply) return deterministic;
    return this.build(input, reply);
  }

  async create(
    input: VoicePresentationInput,
  ): Promise<VoicePresentation> {
    const deterministic = this.createDeterministic(input);
    return this.localize(input, deterministic);
  }

  private build(
    input: VoicePresentationInput,
    reply: string,
  ): VoicePresentation {
    const presentation = buildOverlayPresentation({
      languageCode: input.languageCode,
      ...(input.productSelection
        ? { productSelection: input.productSelection }
        : {}),
      result: input.result,
      spokenText: reply,
      ...(input.taskProgress ? { taskProgress: input.taskProgress } : {}),
    });

    return {
      assistantState: legacyAssistantStateFor(presentation),
      presentation,
      reply,
    };
  }

  private async localizeReply(
    reply: string,
    transcript: string,
    languageCode: string,
  ): Promise<string> {
    if (languageCode === 'en-IN') return reply;
    const requirement = languageRequirements[languageCode]
      ?? 'the same Indian language and code-mixed style as the user';
    try {
      const response = await this.responses.createResponse({
        model: this.boundedControlModel,
        instructions: [
          `Translate the supplied assistant reply into ${requirement}.`,
          'Return only the translated reply.',
          'Do not add facts, explanations, greetings, or product words.',
          'Preserve product labels, numbers, currency amounts, and pack sizes exactly.',
          'Keep the translation at least as concise as the source.',
        ].join(' '),
        input: [
          `User speech: ${transcript}`,
          `Assistant reply: ${reply}`,
        ].join('\n'),
      });
      return extractResponseText(response) || reply;
    } catch (error) {
      logEvent('warn', 'presentation.localization_fallback', {
        languageCode,
        ...errorDetails(error),
      });
      return reply;
    }
  }
}
