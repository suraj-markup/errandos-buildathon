import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const documentUrl = new URL(
  '../../docs/2026-07-28-local-production-demo-profile.md',
  import.meta.url,
);
const document = await readFile(documentUrl, 'utf8');
const bashBlocks = [...document.matchAll(/```bash\n([\s\S]*?)```/gu)]
  .map((match) => match[1])
  .join('\n');

test('documents the isolated production build and start contract', () => {
  assert.match(
    document,
    /pnpm --filter @errandos\/voice build/u,
  );
  assert.match(
    document,
    /pnpm --filter @errandos\/voice start -- --port 3100/u,
  );
  assert.match(
    document,
    /scripts\/validate-production-profile\.ts/u,
  );
  assert.match(
    document,
    /node --env-file=\.env\.local --no-warnings --experimental-strip-types[\s\S]*scripts\/validate-production-profile\.ts/u,
  );
  assert.ok(
    document.match(/\benv -i\b/gu)?.length >= 3,
    'validation, build, and start must each clear inherited environment keys',
  );
  assert.match(document, /Do not use `next dev`/u);
  assert.doesNotMatch(bashBlocks, /\bsource\s+.*\.env\.local\b/u);
  assert.doesNotMatch(bashBlocks, /(?:^|\s)\.\s+.*\.env\.local\b/u);
  assert.doesNotMatch(
    bashBlocks,
    /\b(?:cat|env|printenv)\s+(?:apps\/voice\/)?\.env\.local\b/u,
  );
});

test('pins one exact Android transport without an implicit adb target', () => {
  assert.match(document, /adb devices -l/u);
  assert.match(document, /adb -s '55221VDAQ000J1' get-state/u);
  assert.match(
    document,
    /USB serial[\s\S]*wireless serial[\s\S]*different transports/u,
  );
  assert.match(
    document,
    /Never rely on adb's implicit device selection/u,
  );
  assert.match(
    document,
    /ANDROID_DEVICE_UDID='55221VDAQ000J1'/u,
  );
});

test('keeps preflight and keep-alive read-only, bounded, and secret-safe', () => {
  for (const required of [
    'bounded GET or HEAD health probes',
    'never create an Appium session',
    'invoke inference',
    'transcribe',
    'synthesize',
    'bounded interval/count',
    'abort support',
    'redact credentials',
  ]) {
    assert.ok(
      document.includes(required),
      `missing keep-alive contract: ${required}`,
    );
  }
  assert.match(
    document,
    /h092-h095-readiness-canary\.sh --h092-preflight/u,
  );
  assert.match(
    document,
    /scripts\/run-ux079-connectivity-preflight\.ts[\s\S]*--keep-alive --interval-ms=30000 --max-iterations=10/u,
  );
  assert.ok(
    document.match(/node --env-file=\.env\.local/gu)?.length >= 3,
    'validator, preflight, and keep-alive must load only the reviewed env file',
  );
  assert.match(
    document,
    /RESULT h092_preflight=ALLOWED blocked=0/u,
  );
  assert.doesNotMatch(
    bashBlocks,
    /https:\/\/api\.(?:openai|sarvam)\./u,
  );
});

test('hard-stops all live shopping and final-dispatch activity', () => {
  assert.match(document, /ERRANDOS_LIVE_BROWSER_ACTIONS=false/u);
  assert.match(document, /ERRANDOS_LIVE_COMMIT=false/u);
  assert.match(document, /do not press push-to-talk or submit audio/u);
  assert.match(
    document,
    /do not call any task, selection, interaction, operation, phone, cart,[\s\S]*checkout, confirmation, or order endpoint/u,
  );
  assert.match(
    document,
    /no live shopping action is permitted/u,
  );
  assert.match(
    document,
    /does not authorize live shopping, an Appium session, a phone action,[\s\S]*checkout, confirmation, or ordering/u,
  );
});
