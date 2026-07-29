import { describe, expect, it } from 'vitest';
import { resolvePendingProductChoice } from './product-choice';

const options = [
  {
    offerId: 'cream-onion',
    product: "Lay's American Style Cream & Onion Potato Chips",
    size: '58 g',
    spokenLabel: 'Cream Onion',
  },
  {
    offerId: 'classic',
    product: "Lay's Classic Salted Potato Chips",
    size: '52 g',
    spokenLabel: 'Classic Salted',
  },
  {
    offerId: 'masala',
    product: "Lay's India's Magic Masala Potato Chips",
    size: '58 g',
    spokenLabel: 'Magic Masala',
  },
];

describe('deterministic pending product choice', () => {
  it.each([
    ['first one', 'cream-onion'],
    ['दूसरा वाला', 'classic'],
    ['teesra', 'masala'],
    ['last one', 'masala'],
  ])('resolves ordinal “%s” without model ranking', (transcript, offerId) => {
    const result = resolvePendingProductChoice(transcript, options);
    expect(result.kind).toBe('selected');
    if (result.kind === 'selected') expect(result.option.offerId).toBe(offerId);
  });

  it('resolves a unique flavor or size phrase', () => {
    expect(resolvePendingProductChoice('add classic salted', options))
      .toMatchObject({ kind: 'selected', option: { offerId: 'classic' } });
    expect(resolvePendingProductChoice('cream onion 58 grams', options))
      .toMatchObject({ kind: 'selected', option: { offerId: 'cream-onion' } });
  });

  it('allows multilingual filler around one distinctive visible option', () => {
    expect(resolvePendingProductChoice('Classic वाला add कर दो', options))
      .toMatchObject({ kind: 'selected', option: { offerId: 'classic' } });
  });

  it('does not relax onto a word shared by multiple visible options', () => {
    expect(resolvePendingProductChoice('Lay’s वाला add कर दो', options))
      .toEqual({ kind: 'ambiguous' });
  });

  it('does not choose when the answer still matches multiple options', () => {
    expect(resolvePendingProductChoice('58 grams', options))
      .toEqual({ kind: 'ambiguous' });
  });

  it.each([
    ['skip this product', 'skip'],
    ['isko chhodo', 'skip'],
    ['try again', 'retry'],
    ['cancel the list', 'cancel'],
  ] as const)('recognizes “%s” as %s', (transcript, kind) => {
    expect(resolvePendingProductChoice(transcript, options)).toEqual({ kind });
  });

  it('rejects an ordinal outside the visible options', () => {
    expect(resolvePendingProductChoice('fifth one', options))
      .toEqual({ kind: 'no_match' });
  });
});
