import { NextResponse } from 'next/server';
import { activeRealtimeResponseRegistry } from '../../../../lib/realtime/active-response-registry';
import {
  logEvent,
  newRequestId,
  withLogContext,
} from '../../../../lib/structured-logger';
import {
  getLocalizedProgressSpeechCache,
} from '../../../../lib/voice-turn/localized-progress-speech';

export const runtime = 'nodejs';

function safeIdentifier(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    && value.length <= maximum
    ? value
    : undefined;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = newRequestId();
  return withLogContext({
    requestId,
    route: 'voice.cancel_response',
  }, async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON.', requestId }, {
        status: 400,
      });
    }
    const record = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const clientId = safeIdentifier(record.clientId, 80);
    const taskId = record.taskId === undefined
      ? undefined
      : safeIdentifier(record.taskId, 120);
    if (!clientId || (record.taskId !== undefined && !taskId)) {
      return NextResponse.json({
        error: 'A valid clientId and optional taskId are required.',
        requestId,
      }, { status: 400 });
    }
    const outcome = await activeRealtimeResponseRegistry.cancel({
      clientId,
      ...(taskId ? { taskId } : {}),
    });
    const obsoleteAudioDeliveries =
      getLocalizedProgressSpeechCache()?.cancelClient(clientId) ?? 0;
    logEvent('info', 'realtime.response_interrupt', {
      clientId,
      modelResponse: outcome,
      obsoleteAudioDeliveries,
      phoneOperation: 'unchanged',
      taskScoped: Boolean(taskId),
    });
    return NextResponse.json({
      modelResponse: outcome,
      obsoleteAudioDeliveries,
      ok: true,
      phoneOperation: 'unchanged',
      requestId,
    });
  });
}
