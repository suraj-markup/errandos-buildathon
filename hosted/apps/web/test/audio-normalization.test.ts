import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AudioNormalizationError, normalizeBrowserAudio } from '../lib/audio-normalization';

describe('browser audio normalization', () => {
  it('returns a safe typed error and removes temporary input when decoding fails', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'jaldiai-audio-test-'));

    try {
      await expect(normalizeBrowserAudio(
        new File(['not audio'], 'voice.webm', { type: 'audio/webm' }),
        {
          ffmpegPath: join(tmpdir(), 'missing-jaldiai-ffmpeg'),
          temporaryRoot,
        },
      )).rejects.toBeInstanceOf(AudioNormalizationError);
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
