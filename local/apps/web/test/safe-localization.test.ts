import { describe, expect, it, vi } from 'vitest';
import { localizePreservingFacts, splitProtectedFacts, stripFactMarkers } from '../lib/safe-localization';

describe('safe localization', () => {
  it('splits protected provider facts from translatable prose', () => {
    expect(splitProtectedFacts('Total [[fact:₹148]] for [[fact:Amul Taaza 1 L]].')).toEqual([
      { kind: 'prose', text: 'Total ' },
      { kind: 'fact', text: '₹148' },
      { kind: 'prose', text: ' for ' },
      { kind: 'fact', text: 'Amul Taaza 1 L' },
      { kind: 'prose', text: '.' },
    ]);
  });

  it('translates prose while copying exact facts byte-for-byte', async () => {
    const translate = vi.fn(async (text: string) => `ಕನ್ನಡ(${text})`);
    const result = await localizePreservingFacts(
      'Your total is [[fact:₹148.00]]. Nothing has been ordered.',
      translate,
    );

    expect(result).toContain('₹148.00');
    expect(result).toBe('ಕನ್ನಡ(Your total is) ₹148.00ಕನ್ನಡ(. Nothing has been ordered.)');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('restores whitespace that translation services trim around exact facts', async () => {
    const result = await localizePreservingFacts(
      'Control plane: [[fact:ok]]\nWorker: [[fact:ready]]',
      async (text) => text.trim().toUpperCase(),
    );

    expect(result).toBe('CONTROL PLANE: ok\nWORKER: ready');
  });

  it('removes markers without altering their values', () => {
    expect(stripFactMarkers('Status: [[fact:prepared]] · [[fact:proposal_123]]'))
      .toBe('Status: prepared · proposal_123');
  });
});
