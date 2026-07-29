import { NextResponse } from 'next/server';
import {
  collectDeviceDiagnosticsV2,
  productionDeviceDiagnosticsDependencies,
  type DeviceDiagnosticsDependencies,
  type DeviceDiagnosticsOptions,
} from '../../../../lib/device-diagnostics';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function handleDeviceDiagnosticsRequest(
  _request: Request,
  dependencies: DeviceDiagnosticsDependencies =
    productionDeviceDiagnosticsDependencies(),
  options: DeviceDiagnosticsOptions = {},
): Promise<Response> {
  const snapshot = await collectDeviceDiagnosticsV2(
    dependencies,
    options,
  );
  return NextResponse.json(snapshot, {
    headers: {
      'cache-control': 'no-store, max-age=0',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  return handleDeviceDiagnosticsRequest(request);
}
