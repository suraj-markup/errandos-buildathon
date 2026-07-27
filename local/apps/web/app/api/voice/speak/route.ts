import { NextResponse } from 'next/server';
import { apiError } from '../../../../lib/api-errors';
import { SpeakRequestSchema, type ApiErrorResponse, type SpeakResponse } from '../../../../lib/api-contracts';
import { createSarvamClientFromEnv } from '../../../../lib/sarvam';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse<SpeakResponse | ApiErrorResponse>> {
  try {
    const parsed = SpeakRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({
        error: 'The response cannot be spoken in the selected language.',
        category: 'invalid_request',
      }, { status: 400 });
    }

    const sarvam = createSarvamClientFromEnv();
    const localizedText = await sarvam.translate(parsed.data.text, parsed.data.languageCode);
    const audioDataUrl = await sarvam.speak(localizedText, parsed.data.languageCode);
    return NextResponse.json({ localizedText, audioDataUrl });
  } catch (error) {
    return apiError(error);
  }
}
