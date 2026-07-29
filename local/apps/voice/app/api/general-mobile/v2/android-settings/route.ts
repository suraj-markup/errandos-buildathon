import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  androidSettingsReadOnlyAdapterIdV2,
  authoritativeGeneralMobileProductionServiceV2,
  type GeneralMobileAdapterControlEvidenceV2,
  type GeneralMobileProductionServiceV2,
} from '../../../../../lib/general-mobile/v2';
import { logEvent } from '../../../../../lib/structured-logger';

export const runtime = 'nodejs';

type AndroidSettingsControlRouteDependenciesV2 = {
  authorize: (request: Request) => boolean;
  logControl: (evidence: GeneralMobileAdapterControlEvidenceV2) => void;
  service: GeneralMobileProductionServiceV2;
};

function defaultAuthorize(request: Request): boolean {
  const expected = process.env.GENERAL_MOBILE_CONTROL_TOKEN?.trim();
  const authorization = request.headers.get('authorization');
  if (
    !expected
    || expected.length < 16
    || !authorization?.startsWith('Bearer ')
  ) {
    return false;
  }
  const provided = authorization.slice('Bearer '.length);
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

function defaultDependencies(): AndroidSettingsControlRouteDependenciesV2 {
  return {
    authorize: defaultAuthorize,
    logControl(evidence) {
      logEvent(
        evidence.action === 'enable' ? 'info' : 'warn',
        'general_mobile.adapter_control',
        evidence,
      );
    },
    service: authoritativeGeneralMobileProductionServiceV2(),
  };
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)
    ? value
    : undefined;
}

function statusResponse(
  service: GeneralMobileProductionServiceV2,
): Response {
  const adapter = service.adapterStatus(androidSettingsReadOnlyAdapterIdV2);
  if (!adapter) {
    return NextResponse.json({
      error: 'Android Settings adapter is unavailable.',
      version: 2,
    }, { status: 404 });
  }
  return NextResponse.json({
    adapter,
    evidence: service.controlHistory({
      adapterId: androidSettingsReadOnlyAdapterIdV2,
      limit: 20,
    }),
    version: 2,
  });
}

export async function handleAndroidSettingsAdapterControlV2(
  request: Request,
  dependencies: AndroidSettingsControlRouteDependenciesV2 =
    defaultDependencies(),
): Promise<Response> {
  if (!dependencies.authorize(request)) {
    return NextResponse.json({
      error: 'Unauthorized adapter control request.',
      version: 2,
    }, { status: 401 });
  }
  if (request.method === 'GET') {
    return statusResponse(dependencies.service);
  }
  if (request.method !== 'POST') {
    return NextResponse.json({
      error: 'Unsupported adapter control method.',
      version: 2,
    }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({
      error: 'Invalid adapter control request.',
      version: 2,
    }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({
      error: 'Invalid adapter control request.',
      version: 2,
    }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const action = input['action'];
  const actorId = safeIdentifier(input['actorId']);
  const reason = typeof input['reason'] === 'string'
    && input['reason'].trim() === input['reason']
    && input['reason'].length >= 3
    && input['reason'].length <= 160
    ? input['reason']
    : undefined;
  if (
    input['version'] !== 2
    || !['disable', 'enable', 'rollback'].includes(String(action))
    || !actorId
    || !reason
    || Object.keys(input).some(
      (key) => !['action', 'actorId', 'reason', 'version'].includes(key),
    )
  ) {
    return NextResponse.json({
      error: 'Invalid adapter control request.',
      version: 2,
    }, { status: 400 });
  }

  const evidence = dependencies.service.controlAdapter({
    action: action as 'disable' | 'enable' | 'rollback',
    actorId,
    adapterId: androidSettingsReadOnlyAdapterIdV2,
    reason,
  });
  if (!evidence) {
    return NextResponse.json({
      error: 'Android Settings adapter is unavailable.',
      version: 2,
    }, { status: 404 });
  }
  dependencies.logControl(evidence);
  return NextResponse.json({
    adapter: dependencies.service.adapterStatus(
      androidSettingsReadOnlyAdapterIdV2,
    ),
    evidence,
    version: 2,
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleAndroidSettingsAdapterControlV2(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleAndroidSettingsAdapterControlV2(request);
}
