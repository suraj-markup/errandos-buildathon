import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageContent } from '../components/message-content';
import { extractSpeakableText, hasRichMessageContent } from '../lib/message-content';

describe('assistant message content', () => {
  it('renders images, audio, tables, links, and formatting as elements', () => {
    const html = renderToStaticMarkup(
      <MessageContent content={[
        '**Current screen**',
        '',
        '![Blinkit cart](data:image/png;base64,iVBORw0KGgo=)',
        '',
        '![audio](data:audio/wav;base64,UklGRg==)',
        '',
        '| Item | Price |',
        '| --- | ---: |',
        '| Milk | ₹64 |',
        '',
        '[Open Blinkit](https://blinkit.com/cart/example)',
      ].join('\n')} />,
    );

    expect(html).toContain('<strong>Current screen</strong>');
    expect(html).toContain('<img');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).toContain('<audio');
    expect(html).toContain('<table');
    expect(html).toContain('href="https://blinkit.com/cart/example"');
    expect(html).not.toContain('![Blinkit cart]');
  });

  it('blocks unsafe link and active image schemes', () => {
    const html = renderToStaticMarkup(
      <MessageContent content={[
        '[unsafe](javascript:alert(1))',
        '![unsafe](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
      ].join('\n')} />,
    );

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:image/svg+xml');
  });

  it('creates short speech text without carrying media payloads', () => {
    const reply = [
      'Here is the current screen:',
      '![image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)',
      '| Item | Price |',
      '| --- | ---: |',
      '| Milk | ₹64 |',
      '[Open cart](https://blinkit.com/cart/example)',
    ].join('\n');

    expect(hasRichMessageContent(reply)).toBe(true);
    expect(extractSpeakableText(reply)).toBe(
      'Here is the current screen: Image attached. Item, Price. Milk, ₹64. Open cart',
    );
    expect(extractSpeakableText(reply)).not.toContain('base64');
  });
});
