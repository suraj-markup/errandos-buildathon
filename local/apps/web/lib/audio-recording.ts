interface RecorderFormat {
  extension: 'm4a' | 'ogg' | 'webm';
  mimeType: string;
}

const RECORDER_FORMATS: readonly RecorderFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/ogg', extension: 'ogg' },
];

export const selectRecorderFormat = (
  isTypeSupported: (mimeType: string) => boolean,
): RecorderFormat | undefined => RECORDER_FORMATS.find(({ mimeType }) => isTypeSupported(mimeType));

export const audioFilename = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase().split(';', 1)[0]?.trim();
  if (normalized === 'audio/mp4' || normalized === 'video/mp4' || normalized === 'audio/aac') {
    return 'voice.m4a';
  }
  if (normalized === 'audio/ogg') return 'voice.ogg';
  if (normalized === 'audio/mpeg') return 'voice.mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'voice.wav';
  return 'voice.webm';
};
