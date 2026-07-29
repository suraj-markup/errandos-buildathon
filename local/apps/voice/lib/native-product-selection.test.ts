import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OverlayPresentationSchemaV1 } from '@errandos/contracts';

const androidRoot = resolve(process.cwd(), '../android-overlay');
const source = (name: string) => readFileSync(
  resolve(androidRoot, 'src/ai/errandos/overlay', name),
  'utf8',
);
const fixture = (name: string) => JSON.parse(readFileSync(
  resolve(androidRoot, 'fixtures', name),
  'utf8',
)) as unknown;

describe('native atomic product-selection bridge', () => {
  it('accepts the bound fixture and rejects a malformed selection identifier', () => {
    expect(OverlayPresentationSchemaV1.safeParse(
      fixture('product-choices.json'),
    ).success).toBe(true);
    expect(OverlayPresentationSchemaV1.safeParse(
      fixture('product-choices-invalid-selection.json'),
    ).success).toBe(false);
  });

  it('parses every task/interaction/selection binding field defensively', () => {
    const parser = source('OverlayPresentationParser.java');
    for (const field of [
      'clientId',
      'taskId',
      'taskRevision',
      'interactionId',
      'selectionId',
      'expiresAt',
    ]) {
      expect(parser).toContain(`"${field}"`);
    }
    expect(parser).toContain('Instant.parse(expiresAt)');
    expect(parser).toContain('requiredIdentifier');
  });

  it('implements explicit card states and disables repeated taps while submitting', () => {
    const state = source('ProductSelectionState.java');
    for (const value of [
      'IDLE',
      'SUBMITTING',
      'ACCEPTED',
      'REJECTED',
      'DUPLICATE',
      'EXPIRED',
      'WORKING',
    ]) {
      expect(state).toContain(value);
    }
    expect(state).toContain('status == Status.SUBMITTING');
    expect(state).toContain('status == Status.REJECTED && retryable');

    const card = source('OverlayCardView.java');
    expect(card).toContain('row.setEnabled(enabled)');
    expect(card).toContain('You can still speak');
  });

  it('posts taps only to the selection acknowledgement endpoint', () => {
    const service = source('OverlayService.java');
    expect(service).toContain(
      '"http://127.0.0.1:3100/api/device/selection"',
    );
    expect(service).toContain('request.put("source", "tap")');
    expect(service).toContain('applyProductSelectionOutcome');
    expect(service).not.toContain('productChoiceOfferId');
    expect(service).not.toMatch(/submitProductChoice[\\s\\S]{0,1200}VOICE_TURN_URL/);
  });

  it('keeps tap submission separate from voice-upload blocking', () => {
    const service = source('OverlayService.java');
    expect(service).toContain('private volatile boolean selectionSubmitting;');
    expect(service).toContain('if (uploading)');
    expect(service).not.toMatch(
      /submitProductChoice[\\s\\S]{0,500}uploading = true/,
    );
  });
});
