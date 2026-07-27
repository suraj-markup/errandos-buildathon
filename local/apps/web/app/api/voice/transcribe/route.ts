import { NextResponse } from 'next/server';
import { apiError } from '../../../../lib/api-errors';
import type { ApiErrorResponse, TranscriptionResponse } from '../../../../lib/api-contracts';
import { createSarvamClientFromEnv } from '../../../../lib/sarvam';

export const runtime = 'nodejs';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request): Promise<NextResponse<TranscriptionResponse | ApiErrorResponse>> {
  try {
    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size === 0 || audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({
        error: 'Attach one voice recording smaller than 10 MB.',
        category: 'invalid_request',
      }, { status: 400 });
    }

    const result = await createSarvamClientFromEnv().transcribe(audio);
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
