import { NextResponse } from 'next/server';
import { executePhoneAction } from '../../../../lib/phone-tool';
import {
  parseDirectPhoneTask,
  PhoneCommandValidationError,
} from '../../../../lib/phone-command';
import {
  buildOverlayPresentation,
  withAuthoritativeCartPresentationProof,
} from '../../../../lib/overlay-presentation-builder';
import {
  presentToolResult,
  type PresentableToolResult,
} from '../../../../lib/voice-presentation';
import {
  errorDetails,
  logEvent,
  newRequestId,
  withLogContext,
} from '../../../../lib/structured-logger';

export const runtime = 'nodejs';

type PhoneTask = {
  name?: string;
  arguments?: unknown;
};

export function presentationResultForDeviceTask(
  action: string,
  result: PresentableToolResult,
): PresentableToolResult {
  return action === 'inspect_cart'
    ? withAuthoritativeCartPresentationProof(result)
    : result;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = request.headers.get('x-request-id')?.trim() || newRequestId();
  return withLogContext(
    { requestId, route: 'device.task' },
    async () => {
      const startedAt = performance.now();
      logEvent('info', 'request.start', { method: request.method });
      const task = await request.json() as PhoneTask;
      if (task.name !== 'operate_phone') {
        logEvent('warn', 'request.rejected', {
          durationMs: Math.round(performance.now() - startedAt),
          reason: 'unsupported_tool_request',
          toolName: task.name,
        });
        return NextResponse.json({ error: 'Unsupported phone tool request.' }, { status: 400 });
      }

      try {
        const action = parseDirectPhoneTask(task.arguments, {
          protocolVersion: 2,
        });
        logEvent('info', 'tool.selected', {
          toolName: action.action,
          toolArguments: action,
        });
        const result = await executePhoneAction(action, {
          protocolVersion: 2,
        }) as PresentableToolResult;
        const reply = presentToolResult(result);
        const presentationResult = presentationResultForDeviceTask(
          action.action ?? '',
          result,
        );
        logEvent('info', 'request.complete', {
          durationMs: Math.round(performance.now() - startedAt),
          resultOk: result.ok,
          resultStatus: result.status,
          toolName: action.action,
        });
        return NextResponse.json({
          ...result,
          requestId,
          presentation: buildOverlayPresentation({
            languageCode: 'en-IN',
            result: presentationResult,
            spokenText: reply,
          }),
        });
      } catch (error) {
        const message = error instanceof PhoneCommandValidationError
          ? error.message
          : 'Unsupported phone tool request.';
        logEvent('error', 'request.error', {
          durationMs: Math.round(performance.now() - startedAt),
          ...errorDetails(error),
        });
        return NextResponse.json({ error: message, requestId }, { status: 400 });
      }
    },
  );
}
