import { NextResponse } from 'next/server';
import { apiError } from '../../../../lib/api-errors';
import type { ApiErrorResponse, TranscriptionResponse } from '../../../../lib/api-contracts';
import { AudioNormalizationError, normalizeBrowserAudio } from '../../../../lib/audio-normalization';
import { createSarvamClientFromEnv } from '../../../../lib/sarvam';

export const runtime = 'nodejs';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MIN_AUDIO_BYTES = 1_024;

export async function POST(request: Request): Promise<NextResponse<TranscriptionResponse | ApiErrorResponse>> {
  try {
    const form = await request.formData();
    const audio = form.get('audio');
    if (!(audio instanceof File) || audio.size < MIN_AUDIO_BYTES || audio.size > MAX_AUDIO_BYTES) {
      return NextResponse.json({
        error: 'Speak for at least one second and keep the recording smaller than 10 MB.',
        category: 'invalid_request',
      }, { status: 400 });
    }

    const normalizedAudio = await normalizeBrowserAudio(audio);
    const result = await createSarvamClientFromEnv().transcribe(normalizedAudio);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AudioNormalizationError) {
      return NextResponse.json({
        error: 'This browser recording could not be decoded. Please record again and speak for at least two seconds.',
        category: 'invalid_request',
      }, { status: 422 });
    }
    return apiError(error);
  }
}
