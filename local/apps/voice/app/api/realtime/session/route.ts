import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function createRealtimeBody(sdp: string): FormData {
  const body = new FormData();
  body.set('sdp', sdp);
  body.set('session', JSON.stringify(sessionConfig));
  return body;
}

const sessionConfig = {
  type: 'realtime',
  model: process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-mini',
  instructions: [
    'You are JaldiAI, a concise voice-first assistant operating the owner’s Android phone.',
    'Sound calm, direct, and useful. Keep spoken responses under three sentences.',
    'Use operate_phone when the user asks to inspect the phone, open Blinkit, or begin a grocery task.',
    'Opening an app and read-only checks are safe.',
    'Never claim an order was placed unless the tool returns a verified provider reference.',
    'Before any purchase, summarize the exact terms and say that explicit review is required.',
  ].join(' '),
  output_modalities: ['audio'],
  tool_choice: 'auto',
  tools: [
    {
      type: 'function',
      name: 'operate_phone',
      description: 'Run one narrow, owner-requested action on the connected Android phone.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['phone_status', 'open_blinkit', 'prepare_grocery'],
          },
          request: {
            type: 'string',
            description: 'The exact grocery request in the user’s words when action is prepare_grocery.',
          },
        },
        required: ['action'],
      },
    },
  ],
};

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'OPENAI_API_KEY is not configured.' }, { status: 503 });
  }

  const sdp = await request.text();
  if (!sdp.trim()) {
    return NextResponse.json({ error: 'A WebRTC SDP offer is required.' }, { status: 400 });
  }

  let response: Response | undefined;
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch('https://api.openai.com/v1/realtime/calls', {
          body: createRealtimeBody(sdp),
          headers: {
            authorization: `Bearer ${apiKey}`,
          },
          method: 'POST',
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!response) throw lastError;
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error
      ? error.cause as { code?: string } | undefined
      : undefined;

    return NextResponse.json({
      error: {
        code: cause?.code ?? 'realtime_upstream_unavailable',
        message: 'Could not reach OpenAI Realtime. Check the Mac internet connection and try again.',
        type: 'upstream_connection_error',
      },
    }, { status: 502 });
  }

  const payload = await response.text();
  if (!response.ok) {
    const headers = new Headers({
      'content-type': response.headers.get('content-type') ?? 'text/plain',
    });
    for (const name of [
      'retry-after',
      'x-ratelimit-limit-requests',
      'x-ratelimit-remaining-requests',
      'x-request-id',
    ]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(payload, {
      headers,
      status: response.status,
    });
  }

  return new Response(payload, {
    headers: {
      'content-type': 'application/sdp',
      'x-realtime-call-id': response.headers.get('location') ?? '',
    },
    status: 201,
  });
}
