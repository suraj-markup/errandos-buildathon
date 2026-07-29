import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 15_000;

export class AudioNormalizationError extends Error {
  constructor() {
    super('The browser recording could not be decoded.');
    this.name = 'AudioNormalizationError';
  }
}

interface AudioNormalizationOptions {
  ffmpegPath?: string;
  temporaryRoot?: string;
}

export async function normalizeBrowserAudio(
  audio: File,
  options: AudioNormalizationOptions = {},
): Promise<File> {
  const workDirectory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'jaldiai-audio-'));
  const inputPath = join(workDirectory, 'input');
  const outputPath = join(workDirectory, 'voice.wav');

  try {
    await writeFile(inputPath, new Uint8Array(await audio.arrayBuffer()), { mode: 0o600 });
    await execFileAsync(options.ffmpegPath ?? process.env['FFMPEG_PATH'] ?? 'ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ], {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const normalized = await readFile(outputPath);
    if (normalized.byteLength <= 44) throw new AudioNormalizationError();
    return new File([new Uint8Array(normalized)], 'voice.wav', { type: 'audio/wav' });
  } catch (error) {
    if (error instanceof AudioNormalizationError) throw error;
    throw new AudioNormalizationError();
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
