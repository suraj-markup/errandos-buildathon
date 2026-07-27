import { NextResponse } from 'next/server';
import type { ApiErrorResponse } from './api-contracts';
import { UpstreamError } from './http';

export const apiError = (error: unknown): NextResponse<ApiErrorResponse> => {
  if (error instanceof UpstreamError) {
    if (error.service === 'sarvam' && (error.status === 400 || error.status === 422)) {
      return NextResponse.json({
        error: 'The recording could not be processed. Please speak for a little longer and try again.',
        category: 'invalid_request',
      }, { status: 422 });
    }
    return NextResponse.json({
      error: error.service === 'sarvam'
        ? 'The language service is temporarily unavailable. Please try again.'
        : 'Hermes is temporarily unavailable. Your request was not completed.',
      category: 'upstream_unavailable',
    }, { status: error.status === 429 ? 429 : 502 });
  }

  if (error instanceof Error && error.message.endsWith('is not configured.')) {
    return NextResponse.json({
      error: 'The voice interface is not configured on this server.',
      category: 'configuration',
    }, { status: 503 });
  }

  return NextResponse.json({
    error: 'The request could not be completed. Nothing was ordered.',
    category: 'operation_failed',
  }, { status: 500 });
};
