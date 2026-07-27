import { describe, expect, it } from 'vitest';
import { audioFilename, selectRecorderFormat } from '../lib/audio-recording';

describe('browser audio recording compatibility', () => {
  it('prefers Opus WebM when the browser supports it', () => {
    expect(selectRecorderFormat((type) => type === 'audio/webm;codecs=opus')).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      extension: 'webm',
    });
  });

  it('uses an M4A filename for Safari MP4 recordings', () => {
    expect(selectRecorderFormat((type) => type === 'audio/mp4')).toEqual({
      mimeType: 'audio/mp4',
      extension: 'm4a',
    });
    expect(audioFilename('audio/mp4;codecs=mp4a.40.2')).toBe('voice.m4a');
  });

  it('keeps matching extensions for other Sarvam-supported containers', () => {
    expect(audioFilename('audio/webm;codecs=opus')).toBe('voice.webm');
    expect(audioFilename('audio/ogg;codecs=opus')).toBe('voice.ogg');
    expect(audioFilename('audio/wav')).toBe('voice.wav');
  });
});
