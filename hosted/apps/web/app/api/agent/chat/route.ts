import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiError } from '../../../../lib/api-errors';
import { ChatRequestSchema, type ApiErrorResponse, type ChatResponse } from '../../../../lib/api-contracts';
import { extractBlinkitHandoff } from '../../../../lib/blinkit-handoff';
import { createHermesClientFromEnv, isPublicCartHandoffEnabled } from '../../../../lib/hermes';
import { runPublicCartTurn } from '../../../../lib/public-cart-queue';

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
    const chat = (): Promise<string> => createHermesClientFromEnv().chat(
      parsed.data.message,
      parsed.data.languageCode,
      sessionId,
    );
    const publicCartHandoff = isPublicCartHandoffEnabled();
    const rawReply = publicCartHandoff ? await runPublicCartTurn(chat) : await chat();
    const handoff = publicCartHandoff ? extractBlinkitHandoff(rawReply) : { reply: rawReply };

    const response = NextResponse.json(handoff);
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
