import { describe, expect, it } from 'vitest';
import { extractBlinkitHandoff } from '../lib/blinkit-handoff';

describe('Blinkit public cart handoff', () => {
  it('extracts an official Blinkit share URL and removes it from spoken prose', () => {
    expect(extractBlinkitHandoff(
      'Cart ready for [[fact:Amul Taaza 1 L × 2]]. Open [[fact:https://blinkit.com/s/abc123]]. Blinkit will recheck prices.',
    )).toEqual({
      reply: 'Cart ready for [[fact:Amul Taaza 1 L × 2]]. Open. Blinkit will recheck prices.',
      shareUrl: 'https://blinkit.com/s/abc123',
    });
  });

  it('accepts a Blinkit subdomain and excludes sentence punctuation', () => {
    expect(extractBlinkitHandoff('Use https://share.blinkit.com/cart/abc?source=errandos.').shareUrl)
      .toBe('https://share.blinkit.com/cart/abc?source=errandos');
  });

  it('does not turn lookalike, insecure, or absent links into handoff actions', () => {
    expect(extractBlinkitHandoff('https://evilblinkit.com/cart/abc')).toEqual({
      reply: 'https://evilblinkit.com/cart/abc',
    });
    expect(extractBlinkitHandoff('http://blinkit.com/cart/abc')).toEqual({
      reply: 'http://blinkit.com/cart/abc',
    });
    expect(extractBlinkitHandoff('The cart could not be shared.')).toEqual({
      reply: 'The cart could not be shared.',
    });
  });
});
