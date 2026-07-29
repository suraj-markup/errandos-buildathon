import {
  newRequestId,
  withLogContext,
} from '../../../../lib/structured-logger';
import {
  coordinateVoiceTurn,
  phoneActionForCall,
  type VoiceTurnCoordinatorDependencies,
} from '../../../../lib/voice-turn/coordinator';
import {
  ensurePhoneTaskRecoveryV2,
} from '../../../../lib/workflow/v2/runtime-recovery';

export const runtime = 'nodejs';

export { phoneActionForCall };

export async function handleVoiceTurnRequest(
  request: Request,
  dependencies: {
    coordinator?: VoiceTurnCoordinatorDependencies;
    recover?: typeof ensurePhoneTaskRecoveryV2;
  } = {},
): Promise<Response> {
  await (dependencies.recover ?? ensurePhoneTaskRecoveryV2)();
  const requestedId = request.headers.get('x-request-id')?.trim();
  const requestId = requestedId
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(requestedId)
    ? requestedId
    : newRequestId();

  return withLogContext(
    {
      requestId,
      route: 'voice.turn',
    },
    () => coordinateVoiceTurn(request, requestId, dependencies.coordinator),
  );
}

export async function POST(request: Request): Promise<Response> {
  return handleVoiceTurnRequest(request);
}
