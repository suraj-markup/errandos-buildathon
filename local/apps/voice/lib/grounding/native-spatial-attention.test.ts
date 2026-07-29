import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const nativeRootCandidates = [
  resolve(process.cwd(), 'apps/android-overlay/src/ai/errandos/overlay'),
  resolve(process.cwd(), '../android-overlay/src/ai/errandos/overlay'),
];
const nativeRoot = nativeRootCandidates.find(existsSync)
  ?? nativeRootCandidates[0]!;
const service = readFileSync(resolve(nativeRoot, 'OverlayService.java'), 'utf8');
const view = readFileSync(resolve(nativeRoot, 'SpatialAttentionView.java'), 'utf8');
const command = readFileSync(
  resolve(nativeRoot, 'SpatialAttentionCommand.java'),
  'utf8',
);

describe('native precise spatial attention invariants', () => {
  it('keeps the full-screen attention window non-touchable', () => {
    const attentionWindow = service.slice(
      service.indexOf('attentionLayoutParams = new WindowManager.LayoutParams'),
      service.indexOf('windowManager.addView(attentionView'),
    );
    expect(attentionWindow).toContain(
      'WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE',
    );
    expect(attentionWindow).toContain(
      'WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE',
    );
  });

  it('clears exact attention on expiry, configuration change, and new presentation state', () => {
    expect(service).toContain('attentionExpiryRunnable');
    expect(service).toMatch(
      /onConfigurationChanged[\s\S]*?clearSpatialAttention\(\)/,
    );
    expect(service).toMatch(
      /clearExactAttention\(\);\s*broadAttentionOverride = null;\s*if \(attentionView != null\) attentionView\.hide\(\)/,
    );
  });

  it('validates version, expiry, display binding, and normalized geometry', () => {
    expect(command).toContain('optInt("version", -1) != VERSION');
    expect(command).toContain('expiresAt > nowEpochMs + 10000L');
    expect(command).toContain('matchesDisplay');
    expect(command).toContain('validNormalized');
    expect(command).not.toMatch(/Log\.[diewv]\(/);
  });

  it('renders exact ring, underline, arrow, and reduced-motion-safe pulse', () => {
    expect(view).toContain('showExact');
    expect(view).toContain('canvas.drawRoundRect');
    expect(view).toContain('canvas.drawLine');
    expect(view).toContain('drawArrow(canvas, target)');
    expect(view).toContain('Settings.Global.ANIMATOR_DURATION_SCALE');
    expect(view).toMatch(/scale <= 0f[\s\S]*?pulseValue = 1f/);
  });
});
