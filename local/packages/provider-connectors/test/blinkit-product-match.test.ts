import { describe, expect, it } from 'vitest';
import { selectUniqueProductCandidate } from '../src/blinkit/product-match.js';

const candidates = [
  { productId: 'bingo-masala-90g', title: 'Bingo Mad Angles Masala', variant: '90 g' },
  { productId: 'lays-classic-52g', title: "Lay's Classic Salted Potato Chips", variant: '52 g' },
  { productId: 'lays-magic-52g', title: "Lay's India's Magic Masala Potato Chips", variant: '52 g' },
];

describe('deterministic Blinkit product matching', () => {
  it('normalizes apostrophes and selects exact title evidence', () => {
    expect(selectUniqueProductCandidate("Lay's Classic", candidates).productId).toBe('lays-classic-52g');
  });

  it('uses variant evidence to distinguish otherwise similar products', () => {
    const milk = [
      { productId: 'milk-500', title: 'Amul Taaza Milk', variant: '500 ml' },
      { productId: 'milk-1l', title: 'Amul Taaza Milk', variant: '1 L' },
    ];
    expect(selectUniqueProductCandidate('Amul Taaza Milk 1L', milk).productId).toBe('milk-1l');
  });

  it('rejects unrelated and ambiguous results', () => {
    expect(() => selectUniqueProductCandidate('milk', candidates)).toThrow('no Blinkit result matches');
    expect(() => selectUniqueProductCandidate('milk', [
      { productId: 'milk-a', title: 'Fresh Milk', variant: '500 ml' },
      { productId: 'milk-b', title: 'Fresh Milk', variant: '500 ml' },
    ])).toThrow('ambiguous Blinkit product match');
  });

  it('rejects candidates without a stable provider identity', () => {
    expect(() => selectUniqueProductCandidate('milk', [{ productId: '', title: 'Fresh Milk', variant: '500 ml' }])).toThrow('stable product identity');
  });
});
