import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '../../../../lib/api-errors';
import { ChatRequestSchema, type ApiErrorResponse, type ChatResponse } from '../../../../lib/api-contracts';
import { createHermesClientFromEnv } from '../../../../lib/hermes';

export const runtime = 'nodejs';

const SESSION_COOKIE = 'errandos_voice_session';

export async function POST(request: Request): Promise<NextResponse<ChatResponse | ApiErrorResponse>> {
  try {
    const parsed = ChatRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Enter a short errand request and select a supported language.',
        category: 'invalid_request',
      }, { status: 400 });
    }

    const cookieStore = await cookies();
    const existingSessionId = cookieStore.get(SESSION_COOKIE)?.value;
    const sessionId = existingSessionId ?? randomUUID();
    const reply = await createHermesClientFromEnv().chat(
      parsed.data.message,
      parsed.data.languageCode,
      sessionId,
    );

    const response = NextResponse.json({ reply });
    if (!existingSessionId) {
      response.cookies.set(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 8,
        path: '/',
      });
    }
    return response;
  } catch (error) {
    return apiError(error);
  }
}
