import { describe, expect, it } from 'vitest';
import { buildProductSpokenLabels } from './product-label';

describe('product spoken labels', () => {
  it('removes words shared by visible product options', () => {
    const labels = buildProductSpokenLabels([
      {
        offerId: 'magic',
        packSize: '58 g',
        title: "Lay's India's Magic Masala Potato Chips",
      },
      {
        offerId: 'classic',
        packSize: '52 g',
        title: "Lay's Classic Salted Potato Chips",
      },
    ]);

    expect(labels.get('magic')).toBe("India's Magic Masala");
    expect(labels.get('classic')).toBe('Classic Salted');
  });

  it('keeps a compact meaningful label for one product', () => {
    const labels = buildProductSpokenLabels([
      {
        offerId: 'milk',
        packSize: '500 ml',
        title: 'Amul Taaza Toned Milk',
      },
    ]);

    expect(labels.get('milk')).toBe('Amul Taaza Toned');
  });

  it('adds pack size when shortened labels collide', () => {
    const labels = buildProductSpokenLabels([
      {
        offerId: 'milk-500',
        packSize: '500 ml',
        title: 'Amul Taaza Toned Milk',
      },
      {
        offerId: 'milk-1l',
        packSize: '1 l',
        title: 'Amul Taaza Toned Milk',
      },
    ]);

    expect(labels.get('milk-500')).toBe('Taaza Toned Milk, 500 ml');
    expect(labels.get('milk-1l')).toBe('Taaza Toned Milk, 1 l');
  });
});
