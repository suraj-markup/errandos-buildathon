import { NextResponse } from 'next/server';
import {
  getLocalizedProgressSpeechCache,
} from '../../../../lib/voice-turn/localized-progress-speech';
import {
  newRequestId,
  withLogContext,
} from '../../../../lib/structured-logger';

export const runtime = 'nodejs';

function safeIdentifier(
  value: string | null,
  maximum: number,
): string | undefined {
  return value
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    && value.length <= maximum
    ? value
    : undefined;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return withLogContext({
    requestId,
    route: 'voice.synthesis',
  }, () => {
    const url = new URL(request.url);
    const clientId = safeIdentifier(url.searchParams.get('clientId'), 80);
    const synthesisId = safeIdentifier(
      url.searchParams.get('synthesisId'),
      120,
    );
    if (!clientId || !synthesisId) {
      return NextResponse.json({
        error: 'Valid clientId and synthesisId values are required.',
        requestId,
      }, { status: 400 });
    }

    const result = getLocalizedProgressSpeechCache()
      ?.statusForClient(synthesisId, clientId);
    if (!result) {
      return NextResponse.json({
        error: 'Synthesis delivery was not found.',
        requestId,
      }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      requestId,
      audioSynthesis: {
        cacheStatus: result.metadata.cacheStatus,
        requestLatencyMs: result.metadata.requestLatencyMs,
        ...(result.metadata.synthesisLatencyMs === undefined
          ? {}
          : { synthesisLatencyMs: result.metadata.synthesisLatencyMs }),
        status: result.status,
        synthesisId: result.synthesisId,
      },
      ...(result.status === 'ready' ? result.audio : {}),
    });
  });
}
