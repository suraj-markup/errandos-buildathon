import { NextResponse } from 'next/server';
import { executePhoneAction, type PhoneActionArguments } from '../../../../lib/phone-tool';
import {
  isExplicitCodConfirmation,
  type CodCheckoutSnapshot,
} from '../../../../lib/cod';

export const runtime = 'nodejs';

type OpenAIOutputItem = {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type OpenAIResponse = {
  id?: string;
  output?: OpenAIOutputItem[];
  output_text?: string;
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
};

type SarvamTranscript = {
  transcript?: string;
  language_code?: string | null;
  error?: {
    message?: string;
  };
};

type GroceryOption = {
  offerId?: string;
  product?: string;
  price?: string;
  size?: string;
};

type PendingGrocery = {
  options: GroceryOption[];
  request: string;
};

type ConversationState = {
  responseId: string;
  languageCode: string;
  pendingCod?: CodCheckoutSnapshot;
  pendingGrocery?: PendingGrocery;
  updatedAt: number;
};

const voiceGlobal = globalThis as typeof globalThis & {
  errandosVoiceConversations?: Map<string, ConversationState>;
};
const conversations =
  voiceGlobal.errandosVoiceConversations ?? new Map<string, ConversationState>();
voiceGlobal.errandosVoiceConversations = conversations;
const conversationTtlMs = 10 * 60 * 1000;
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

const phoneTools = [
  {
    type: 'function',
    name: 'prepare_grocery',
    description: [
      'Search Blinkit and safely prepare a requested grocery item.',
      'Use this whenever the user asks to add, buy, find, search, or get a grocery product.',
      'This action searches the product and either adds one unambiguous exact match or returns visible options for clarification.',
      'Do not use open_blinkit for a grocery request.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        request: {
          type: 'string',
          description: [
            'The exact product words spoken by the user.',
            'Preserve brand, flavor, quantity, and size exactly when provided.',
            'Never invent a variant or size that the user did not say.',
          ].join(' '),
        },
        offerId: {
          type: ['string', 'null'],
          description: [
            'The opaque offerId from a pending visible option.',
            'Use null on the first search.',
            'Never invent an offerId and never copy an ID from outside the pending options.',
          ].join(' '),
        },
      },
      required: ['request', 'offerId'],
    },
  },
  {
    type: 'function',
    name: 'prepare_cod_checkout',
    description: [
      'Open and review the existing Blinkit cart, select Cash on Delivery when available, and return the verified total and saved address label.',
      'This never presses the final Place Order button.',
      'Use when the user asks to prepare, review, checkout, or order the cart using COD.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'confirm_cod_order',
    description: [
      'Press the final Blinkit Place Order button exactly once for previously reviewed, unchanged COD terms.',
      'Use only after a COD review when the user’s current speech explicitly says “Confirm COD order”.',
      'Never use for “yes”, “go ahead”, “add to cart”, or an initial checkout request.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'open_blinkit',
    description: [
      'Open Blinkit without searching or adding anything.',
      'Use only when the user explicitly asks to open or launch Blinkit and does not request a product.',
    ].join(' '),
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'phone_status',
    description: 'Check whether the connected Android phone and Appium are reachable.',
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
];

function phoneActionForCall(
  callName: string,
  arguments_: PhoneActionArguments,
  pendingGrocery?: PendingGrocery,
  pendingCod?: CodCheckoutSnapshot,
): PhoneActionArguments {
  if (callName === 'prepare_grocery') {
    return {
      action: 'prepare_grocery',
      request: arguments_.request,
      ...(arguments_.offerId ? { offerId: arguments_.offerId } : {}),
      ...(pendingGrocery ? { searchQuery: pendingGrocery.request } : {}),
    };
  }
  if (callName === 'prepare_cod_checkout') {
    return { action: 'prepare_cod_checkout' };
  }
  if (callName === 'confirm_cod_order') {
    return {
      action: 'confirm_cod_order',
      expectedFingerprint: pendingCod?.fingerprint,
    };
  }
  if (callName === 'open_blinkit') return { action: 'open_blinkit' };
  if (callName === 'phone_status') return { action: 'phone_status' };
  return {};
}

function extractText(response: OpenAIResponse): string {
  if (response.output_text?.trim()) return response.output_text.trim();

  return response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text' && content.text)
    .map((content) => content.text)
    .join('')
    .trim() ?? '';
}

async function createOpenAIResponse(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<OpenAIResponse> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json() as OpenAIResponse;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `OpenAI returned ${response.status}.`);
  }

  return payload;
}

async function transcribeAudio(apiKey: string, audio: File): Promise<SarvamTranscript> {
  const body = new FormData();
  const contentType = audio.type.split(';', 1)[0] || 'application/octet-stream';
  const normalizedAudio = new Blob([await audio.arrayBuffer()], { type: contentType });
  body.set('file', normalizedAudio, audio.name || 'command.webm');
  body.set('model', 'saaras:v3');
  body.set('mode', 'codemix');
  body.set('language_code', 'unknown');

  const response = await fetch('https://api.sarvam.ai/speech-to-text', {
    body,
    headers: { 'api-subscription-key': apiKey },
    method: 'POST',
  });
  const payload = await response.json() as SarvamTranscript;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Sarvam transcription returned ${response.status}.`);
  }

  return payload;
}

async function synthesizeSpeech(
  apiKey: string,
  text: string,
  languageCode: string,
): Promise<{ audioBase64?: string; audioType?: string }> {
  const response = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
    body: JSON.stringify({
      text,
      target_language_code: languageCode,
      speaker: 'shubh',
      model: 'bulbul:v3',
      output_audio_codec: 'mp3',
      pace: 1.05,
    }),
    headers: {
      'api-subscription-key': apiKey,
      'content-type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    return {};
  }

  const audio = Buffer.from(await response.arrayBuffer()).toString('base64');
  return {
    audioBase64: audio,
    audioType: response.headers.get('content-type') ?? 'audio/mpeg',
  };
}

export async function POST(request: Request): Promise<Response> {
  const sarvamApiKey = process.env.SARVAM_API_KEY;
  const openAIApiKey = process.env.OPENAI_API_KEY;
  if (!sarvamApiKey || !openAIApiKey) {
    return NextResponse.json(
      { error: 'The server voice providers are not configured.' },
      { status: 503 },
    );
  }

  try {
    const form = await request.formData();
    const audio = form.get('audio');
    const clientIdValue = form.get('clientId');
    const clientId = typeof clientIdValue === 'string' && clientIdValue.trim()
      ? clientIdValue.trim().slice(0, 80)
      : 'pixel-web';
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: 'A recorded voice command is required.' }, { status: 400 });
    }

    const transcription = await transcribeAudio(sarvamApiKey, audio);
    const transcript = transcription.transcript?.trim();
    if (!transcript) {
      return NextResponse.json({ error: 'I could not hear a clear command. Please try again.' }, { status: 422 });
    }

    const savedConversation = conversations.get(clientId);
    const conversation = savedConversation
      && Date.now() - savedConversation.updatedAt < conversationTtlMs
      ? savedConversation
      : undefined;

    const detectedLanguageRequirement = transcription.language_code
      ? languageRequirements[transcription.language_code]
      : undefined;
    const currentLanguageInstruction = transcription.language_code === 'en-IN'
      ? 'For this turn, the detected language is English. Reply only in English.'
      : detectedLanguageRequirement
        ? `For this turn, reply only in ${detectedLanguageRequirement}`
        : 'Follow the user’s detected Indian language or code-mixed speaking style for this turn.';
    const instructions = [
      'You are JaldiAI, a concise voice-first assistant operating the owner’s Android phone.',
      'The user may speak an Indian language, English, or a code-mixed combination.',
      'Always reply in the same spoken language, script style, and code-mix as the user.',
      'If the transcript is entirely English, reply only in English.',
      'Use Hinglish only when the user mixes Hindi and English.',
      'For Hinglish input, reply in natural Hinglish rather than formal Hindi or English.',
      'Keep the spoken response under three short sentences.',
      'For every request to add, buy, find, search, or get a grocery item, call prepare_grocery immediately.',
      'Never call only open_blinkit when the user also names or requests a grocery item.',
      'Pass the user’s exact product phrase to prepare_grocery; do not invent or silently choose a brand, flavor, pack, or size.',
      'When structured pending grocery options are provided, treat the new speech as the answer to that prior question.',
      'Resolve a matching follow-up to the full exact visible product and size before calling prepare_grocery.',
      'When a pending option is selected, pass its exact opaque offerId to prepare_grocery. Never invent an offerId.',
      'If multiple pending options remain and the user only says add to cart, ask which option; never choose one yourself.',
      'Use open_blinkit only for a bare request to open the app.',
      'Use prepare_cod_checkout to review an existing cart for Cash on Delivery; it never places the order.',
      'After a COD review, read the total and saved address label and require the user to say the exact phrase “Confirm COD order”.',
      'Use confirm_cod_order only when that exact phrase is present in the user’s current speech.',
      'Never treat yes, okay, go ahead, or add to cart as final purchase authorization.',
      'When a tool returns needs_clarification, say one short spoken question and mention the exact visible product or size options.',
      'When a tool returns confirmation_required, clearly speak the total, saved address label, and required confirmation phrase.',
      'When a tool returns not_found, ask the user to repeat or use another product name.',
      'Never imply an item was added when a tool asks for clarification.',
      'When a tool confirms added or already_in_cart, speak that exact result.',
      'Opening an app and read-only checks are safe.',
      'Never claim an order was placed unless a tool returns a verified provider reference.',
      'Before any purchase, say that explicit review is required.',
      currentLanguageInstruction,
    ].join(' ');

    const modelInput = conversation?.pendingGrocery
      ? [
          'The user is answering a pending grocery clarification.',
          `Original request: ${conversation.pendingGrocery.request}`,
          `Visible options: ${JSON.stringify(conversation.pendingGrocery.options)}`,
          `New spoken answer: ${transcript}`,
          'Use only these visible options. If the answer uniquely identifies one, call prepare_grocery with its full exact product name and size.',
          'Pass the selected visible option’s exact offerId. If no option is uniquely selected, do not call the tool.',
          'If the answer does not uniquely identify one, ask a short follow-up and do not add anything.',
        ].join('\n')
      : conversation?.pendingCod
        ? [
            'A reviewed COD checkout is pending explicit confirmation.',
            `Reviewed terms: ${JSON.stringify(conversation.pendingCod)}`,
            `New spoken answer: ${transcript}`,
            'Only call confirm_cod_order if the new spoken answer contains the exact phrase “Confirm COD order”.',
            'Otherwise remind the user of that phrase and do not perform the final action.',
          ].join('\n')
      : transcript;

    let aiResponse = await createOpenAIResponse(openAIApiKey, {
      model: 'gpt-4.1-mini',
      instructions,
      input: modelInput,
      tools: phoneTools,
      tool_choice: 'auto',
      ...(conversation ? { previous_response_id: conversation.responseId } : {}),
    });

    const toolCalls = aiResponse.output?.filter((item) => item.type === 'function_call') ?? [];
    const toolEvents: string[] = [];
    const toolResults: unknown[] = [];

    if (toolCalls.length > 0 && aiResponse.id) {
      const toolOutputs = [];
      for (const call of toolCalls) {
        if (!call.call_id || !call.name) continue;

        let arguments_: PhoneActionArguments = {};
        try {
          arguments_ = JSON.parse(call.arguments ?? '{}') as PhoneActionArguments;
        } catch {
          arguments_ = {};
        }

        const phoneAction = phoneActionForCall(
          call.name,
          arguments_,
          conversation?.pendingGrocery,
          conversation?.pendingCod,
        );
        const result =
          call.name === 'confirm_cod_order'
            && (
              !conversation?.pendingCod
                || !isExplicitCodConfirmation(transcript)
            )
            ? {
                ok: false,
                status: 'confirmation_required',
                message: 'The final order is locked. Say “Confirm COD order” after reviewing the total and address.',
              }
            : await executePhoneAction(phoneAction);
        toolEvents.push(phoneAction.action ?? call.name);
        toolResults.push(result);
        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }

      if (toolOutputs.length > 0) {
        aiResponse = await createOpenAIResponse(openAIApiKey, {
          model: 'gpt-4.1-mini',
          instructions,
          previous_response_id: aiResponse.id,
          input: toolOutputs,
          tools: phoneTools,
        });
      }
    }

    const reply = extractText(aiResponse) || 'Done.';
    const detectedLanguage = transcription.language_code || conversation?.languageCode || 'en-IN';
    const isShortFollowUp = transcript.trim().split(/\s+/).length <= 3;
    const responseLanguage = isShortFollowUp && conversation
      ? conversation.languageCode
      : detectedLanguage;
    const firstToolResult = toolResults[0] as {
      checkout?: CodCheckoutSnapshot;
      options?: GroceryOption[];
      request?: string;
      status?: string;
    } | undefined;
    let pendingGrocery = conversation?.pendingGrocery;
    if (
      firstToolResult?.status === 'needs_clarification'
        && firstToolResult.request
        && firstToolResult.options?.length
    ) {
      pendingGrocery = {
        options: firstToolResult.options,
        request: firstToolResult.request,
      };
    } else if (
      firstToolResult
        && ![
          'needs_clarification',
          'automation_failed',
          'device_locked',
        ].includes(firstToolResult.status ?? '')
    ) {
      pendingGrocery = undefined;
    }
    let pendingCod = conversation?.pendingCod;
    if (
      firstToolResult?.status === 'confirmation_required'
        && firstToolResult.checkout?.fingerprint
    ) {
      pendingCod = firstToolResult.checkout;
    } else if (
      firstToolResult
        && [
          'checkout_changed',
          'ordered',
          'order_attempt_already_made',
          'order_status_ambiguous',
        ].includes(firstToolResult.status ?? '')
    ) {
      pendingCod = undefined;
    }

    if (aiResponse.id) {
      conversations.set(clientId, {
        responseId: aiResponse.id,
        languageCode: responseLanguage,
        ...(pendingCod ? { pendingCod } : {}),
        ...(pendingGrocery ? { pendingGrocery } : {}),
        updatedAt: Date.now(),
      });
    }

    const assistantState = [
      'needs_clarification',
      'not_found',
      'confirmation_required',
      'device_locked',
    ].includes(
      firstToolResult?.status ?? '',
    )
      ? 'clarification'
      : ['added', 'already_in_cart', 'ordered'].includes(firstToolResult?.status ?? '')
        ? 'success'
          : [
            'automation_failed',
            'checkout_changed',
            'order_attempt_already_made',
            'order_status_ambiguous',
          ].includes(firstToolResult?.status ?? '')
          ? 'error'
          : 'ready';
    const voice = await synthesizeSpeech(sarvamApiKey, reply, responseLanguage);

    return NextResponse.json({
      ok: true,
      transcript,
      reply,
      languageCode: responseLanguage,
      toolEvents,
      toolResults,
      assistantState,
      ...voice,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The voice turn failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
