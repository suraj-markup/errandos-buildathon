import { describe, expect, it, vi } from 'vitest';
import type { AndroidUiPort, UiElement } from '../src/android/appium-client.js';
import { BlinkitAndroidDriver } from '../src/blinkit/android-driver.js';
import { buildLiveAndroidReview, parseLiveAndroidCart } from '../src/blinkit/android-review.js';
import { parseSavedAddresses } from '../src/blinkit/android-safe-reads.js';

const element = (text: string, id = text): UiElement => ({
  id,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  text,
  clickable: true,
});

const positioned = (text: string, x: number, y: number, width = 100, height = 40): UiElement => ({
  ...element(text),
  rect: { x, y, width, height },
});

const expectedOrder = {
  proposalId: 'proposal-1',
  proposalHash: 'b'.repeat(64),
  idempotencyKey: 'message-1:proposal-1',
  preparedAt: '2026-07-20T10:00:00.000Z',
  expiresAt: '2026-07-20T10:05:00.000Z',
  checkout: {
    lines: [{
      productId: 'offer-bread',
      name: 'English Oven Brown Bread',
      quantity: 1,
      unitPrice: { currency: 'INR' as const, amount: 65 },
      lineTotal: { currency: 'INR' as const, amount: 65 },
    }],
    unavailableItems: [],
    fees: [{ kind: 'handling' as const, label: 'Handling charge', amount: { currency: 'INR' as const, amount: 22 } }],
    total: { currency: 'INR' as const, amount: 87 },
    addressReference: 'home',
    addressLabel: 'Home',
    paymentMode: 'cod' as const,
    etaMinutes: 8,
    providerFingerprint: 'a'.repeat(64),
  },
};

const liveCartSource = (lines: readonly { name: string; quantity: number; unitPrice: number }[]): string => [
  '<hierarchy>',
  `<node text="Shipment of ${lines.length} items" resource-id="com.grofers.customerapp:id/subtitle"/>`,
  ...lines.flatMap((line) => [
    `<node content-desc="${line.name}" resource-id="com.grofers.customerapp:id/title"/>`,
    `<node content-desc="quantity ${line.quantity}" resource-id="com.grofers.customerapp:id/tv_title"/>`,
    `<node content-desc="₹${line.quantity * line.unitPrice}" resource-id="com.grofers.customerapp:id/total_item_price"/>`,
  ]),
  '<node text="Delivering to Home" resource-id="com.grofers.customerapp:id/title"/>',
  '<node text="Select payment option" resource-id="com.grofers.customerapp:id/tv_action_text"/>',
  '</hierarchy>',
].join('');

class FakeUi implements AndroidUiPort {
  public readonly operations: string[] = [];
  public readonly clickedTexts: string[] = [];
  public readonly exactTextQueries: string[] = [];
  public readonly tappedRects: UiElement['rect'][] = [];
  public sourceCalls = 0;
  public sourceValue = '<hierarchy/>';
  public sourceValues: string[] = [];
  public exactTexts = new Map<string, UiElement[]>();
  public exactDescriptions = new Map<string, UiElement[]>();
  public clickableAncestors = new Map<string, UiElement[]>();
  public clickableDescriptionAncestors = new Map<string, UiElement[]>();
  public resourceIds = new Map<string, UiElement[]>();
  public classNames = new Map<string, UiElement[]>();
  public scrollableElements: UiElement[] = [];
  public offscreenTexts = new Set<string>();
  public onScrollForward?: () => boolean;
  public onScrollElementForward?: (target: UiElement) => boolean;
  public onScrollElementBackward?: (target: UiElement) => boolean;
  public onClick?: (target: UiElement) => void;
  public onSetValue?: (target: UiElement, value: string) => void;
  public onBack?: () => void;
  public clipboardText = '';
  public onOpenBlinkitLink?: (url: string) => void;

  public async source(): Promise<string> {
    this.sourceCalls += 1;
    return this.sourceValues.shift() ?? this.sourceValue;
  }
  public async findExactText(text: string): Promise<UiElement[]> {
    this.exactTextQueries.push(text);
    return this.exactTexts.get(text) ?? [];
  }
  public async findExactDescription(description: string): Promise<UiElement[]> { return this.exactDescriptions.get(description) ?? []; }
  public async findClickableAncestorOfExactText(text: string): Promise<UiElement[]> { return this.clickableAncestors.get(text) ?? []; }
  public async findClickableAncestorOfExactDescription(description: string): Promise<UiElement[]> { return this.clickableDescriptionAncestors.get(description) ?? []; }
  public async findResourceId(id: string): Promise<UiElement[]> { return this.resourceIds.get(id) ?? []; }
  public async findClassName(name: string): Promise<UiElement[]> { return this.classNames.get(name) ?? []; }
  public async findScrollableElements(): Promise<UiElement[]> { return this.scrollableElements; }
  public async scrollExactTextIntoView(text: string): Promise<UiElement> {
    this.operations.push(`scroll:${text}`);
    if (!this.offscreenTexts.has(text)) throw new Error('not offscreen');
    return element(text);
  }
  public async scrollForward(): Promise<boolean> {
    this.operations.push('scroll:forward');
    return this.onScrollForward?.() ?? false;
  }
  public async scrollBackward(): Promise<boolean> {
    this.operations.push('scroll:backward');
    return false;
  }
  public async scrollElementForward(target: UiElement): Promise<boolean> {
    this.operations.push(`scroll:element:${target.id}`);
    return this.onScrollElementForward?.(target) ?? false;
  }
  public async scrollElementBackward(target: UiElement): Promise<boolean> {
    this.operations.push(`scroll:element-backward:${target.id}`);
    return this.onScrollElementBackward?.(target) ?? false;
  }
  public async click(target: UiElement): Promise<void> {
    const label = target.text ?? target.contentDescription ?? target.id;
    this.operations.push(`click:${label}`);
    this.clickedTexts.push(label);
    this.onClick?.(target);
  }
  public async tap(target: UiElement): Promise<void> {
    const label = target.text ?? target.contentDescription ?? target.id;
    this.operations.push(`tap:${label}`);
    this.clickedTexts.push(label);
    this.onClick?.(target);
  }
  public async tapRect(rect: UiElement['rect']): Promise<void> {
    this.operations.push('tap:rect');
    this.tappedRects.push(rect);
    this.onClick?.({ id: 'rect', rect, clickable: true });
  }
  public async setValue(target: UiElement, value: string): Promise<void> {
    this.operations.push(`value:${target.id}`);
    this.onSetValue?.(target, value);
  }
  public async clear(target: UiElement): Promise<void> { this.operations.push(`clear:${target.id}`); }
  public async pressKey(key: 'ENTER'): Promise<void> { this.operations.push(`key:${key}`); }
  public async back(): Promise<void> { this.operations.push('back'); this.onBack?.(); }
  public async readClipboardText(): Promise<string> { this.operations.push('clipboard:read'); return this.clipboardText; }
  public async clearClipboard(): Promise<void> { this.operations.push('clipboard:clear'); this.clipboardText = ''; }
  public async openBlinkitLink(url: string): Promise<void> {
    this.operations.push('link:open');
    this.onOpenBlinkitLink?.(url);
  }
}

describe('Blinkit Android driver', () => {
  it('shares the verified cart through the native share action without changing it', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    const shareDescription = '뀀 Share';
    ui.sourceValue = `${cart}<node content-desc="${shareDescription}" clickable="true"/>`;
    ui.exactDescriptions.set(shareDescription, [{
      ...element('', 'share'),
      contentDescription: shareDescription,
    }]);
    ui.onClick = ({ id }): void => {
      if (id === 'share') {
        ui.sourceValue = '<hierarchy><node text="Share with"/><node text="https://blinkit.com/cart/share/example"/></hierarchy>';
      }
    };
    ui.onBack = (): void => { ui.sourceValue = cart; };

    const shared = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).shareCart();

    expect(shared).toEqual({
      shareUrl: 'https://blinkit.com/cart/share/example',
      cartFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(ui.operations).toEqual(['click:', 'back']);
  });

  it('prefers the directly clickable Share control over its larger clickable ancestor', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    const shareDescription = '뀀 Share';
    const direct = {
      ...positioned('share-direct', 861, 143, 187, 95),
      id: 'share-direct',
      contentDescription: shareDescription,
    };
    ui.sourceValue = `${cart}<node content-desc="${shareDescription}" clickable="true"/>`;
    ui.exactDescriptions.set(shareDescription, [direct]);
    ui.clickableDescriptionAncestors.set(shareDescription, [
      { ...positioned('share-ancestor', 820, 120, 240, 140), id: 'share-ancestor' },
    ]);
    ui.onClick = ({ id }): void => {
      if (id === 'share-direct') {
        ui.sourceValue = '<hierarchy><node text="Share with"/><node text="https://blinkit.com/cart/share/direct"/></hierarchy>';
      }
    };
    ui.onBack = (): void => { ui.sourceValue = cart; };

    const shared = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).shareCart();

    expect(shared.shareUrl).toBe('https://blinkit.com/cart/share/direct');
    expect(ui.clickedTexts).toEqual(['share-direct']);
  });

  it('confirms Blinkit Share your cart before reading the Android chooser link', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    const shareDescription = '뀀 Share';
    const confirmation = '<hierarchy><node text="Build your cart and share it with your friends &amp; family"/>'
      + '<node text="Share your cart" clickable="false"/></hierarchy>';
    const chooser = '<hierarchy><node text="Sharing text"/>'
      + '<node text="Please review https://blinkit.com/cart/share/two-stage"/></hierarchy>';
    ui.sourceValue = `${cart}<node content-desc="${shareDescription}" clickable="true"/>`;
    ui.exactDescriptions.set(shareDescription, [{ ...element('', 'share'), contentDescription: shareDescription }]);
    ui.clickableAncestors.set('Share your cart', [element('confirm-share', 'confirm-share')]);
    ui.onClick = ({ id }): void => {
      if (id === 'share') ui.sourceValue = confirmation;
      if (id === 'confirm-share') ui.sourceValue = chooser;
    };
    ui.onBack = (): void => {
      if (ui.sourceValue === chooser) ui.sourceValue = confirmation;
      else ui.sourceValue = cart;
    };

    const shared = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).shareCart();

    expect(shared.shareUrl).toBe('https://blinkit.com/cart/share/two-stage');
    expect(ui.operations).toEqual(['click:', 'click:confirm-share', 'back', 'back']);
  });

  it('uses Copy from the Android share sheet and returns only a Blinkit URL', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Diet Coke', quantity: 1, unitPrice: 40 }]);
    const shareDescription = '뀀 Share';
    ui.sourceValue = `${cart}<node content-desc="${shareDescription}" clickable="true"/>`;
    ui.exactDescriptions.set(shareDescription, [{ ...element('', 'share'), contentDescription: shareDescription }]);
    ui.exactTexts.set('Copy', [element('Copy', 'copy')]);
    ui.clipboardText = 'Build your Blinkit cart: https://blinkit.com/cart/share/copied';
    ui.onClick = ({ id }): void => {
      if (id === 'share') ui.sourceValue = '<hierarchy><node text="Share with"/><node text="Copy" clickable="true"/></hierarchy>';
    };
    ui.onBack = (): void => { ui.sourceValue = cart; };

    const shared = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).shareCart();

    expect(shared.shareUrl).toBe('https://blinkit.com/cart/share/copied');
    expect(ui.operations).toEqual(['click:', 'click:Copy', 'clipboard:read', 'clipboard:clear', 'back']);
    expect(ui.clipboardText).toBe('');
  });

  it('rejects non-Blinkit clipboard URLs and still returns from the share sheet', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Diet Coke', quantity: 1, unitPrice: 40 }]);
    const shareDescription = '뀀 Share';
    ui.sourceValue = `${cart}<node content-desc="${shareDescription}" clickable="true"/>`;
    ui.exactDescriptions.set(shareDescription, [{ ...element('', 'share'), contentDescription: shareDescription }]);
    ui.exactTexts.set('Copy', [element('Copy', 'copy')]);
    ui.clipboardText = 'https://evil.example/cart';
    ui.onClick = ({ id }): void => {
      if (id === 'share') ui.sourceValue = '<hierarchy><node text="Share with"/><node text="Copy" clickable="true"/></hierarchy>';
    };
    ui.onBack = (): void => { ui.sourceValue = cart; };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).shareCart())
      .rejects.toThrow('Blinkit cart_share_link failed');
    expect(ui.operations).toContain('clipboard:clear');
    expect(ui.operations.at(-1)).toBe('back');
  });

  it('imports an official Blinkit share link and returns the complete verified merged cart', async () => {
    const ui = new FakeUi();
    const before = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    const after = liveCartSource([
      { name: 'Brown Bread', quantity: 1, unitPrice: 45 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ]);
    ui.sourceValue = before;
    ui.onOpenBlinkitLink = (): void => { ui.sourceValue = after; };

    const imported = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .importSharedCart('https://blinkit.com/cart/share/example');

    expect(imported).toMatchObject({
      importBehavior: 'merged',
      previousCartFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      cart: {
        lines: [{ name: 'Brown Bread' }, { name: 'Diet Coke' }],
        providerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(ui.operations).toEqual(['link:open']);
  });

  it('rejects an untrusted shared-cart URL before opening anything', async () => {
    const ui = new FakeUi();
    ui.sourceValue = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);

    await expect(new BlinkitAndroidDriver(ui).importSharedCart('https://example.com/cart'))
      .rejects.toThrow('Blinkit cart_import_url failed');
    expect(ui.operations).toEqual([]);
  });

  it('reports a deep-link launch failure as a specific safe import stage', async () => {
    const ui = new FakeUi();
    ui.sourceValue = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    ui.onOpenBlinkitLink = (): void => { throw new Error('raw Appium detail'); };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .importSharedCart('https://blinkit.com/cart/share/example'))
      .rejects.toThrow('Blinkit cart_import_open failed');
    expect(ui.operations).toEqual(['link:open']);
  });

  it('does not misreport a generic Blinkit page as a successful cart import', async () => {
    const ui = new FakeUi();
    const cart = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    ui.sourceValue = cart;
    ui.onOpenBlinkitLink = (): void => {
      ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/>'
        + '<node text="View cart" bounds="[0,900][1080,1040]"/></hierarchy>';
    };
    ui.onClick = ({ id }): void => {
      if (id === 'rect') ui.sourceValue = cart;
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .importSharedCart('https://blinkit.com/'))
      .rejects.toThrow('Blinkit cart_import_verify failed');
    expect(ui.operations).toEqual(['link:open', 'tap:rect']);
  });

  it('dismisses the exact Play review prompt before reading auth state', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Enjoying Blinkit?"/><node text="Not now"/><node text="Submit"/></hierarchy>';
    ui.exactTexts.set('Not now', [element('Not now')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Not now') ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    const status = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).authStatus();

    expect(status).toBe('active');
    expect(ui.clickedTexts).toEqual(['Not now']);
  });

  it('selects the manual saved-location path before reading auth state', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Location permission not enabled"/><node text="Enable device location"/><node text="Select location manually" clickable="true"/></hierarchy>';
    ui.exactTexts.set('Select location manually', [element('Select location manually')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Select location manually') ui.sourceValue = '<hierarchy><node text="HOME"/><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    const status = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).authStatus();

    expect(status).toBe('active');
    expect(ui.clickedTexts).toEqual(['Select location manually']);
  });

  it('waits through the cold-start splash before recovering a location modal', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Everything you need, delivered at your doorstep"/></hierarchy>';
    ui.exactTexts.set('Select location manually', [element('Select location manually')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Select location manually') ui.sourceValue = '<hierarchy><node text="HOME"/><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };
    let waits = 0;

    const status = await new BlinkitAndroidDriver(ui, {
      wait: async (): Promise<void> => {
        waits += 1;
        if (waits === 1) {
          ui.sourceValue = '<hierarchy><node text="Location permission not enabled"/><node text="Select location manually" clickable="true"/></hierarchy>';
        }
      },
    }).authStatus();

    expect(status).toBe('active');
    expect(ui.clickedTexts).toEqual(['Select location manually']);
    expect(ui.operations).not.toContain('back');
  });

  it('uses exact Cash on Delivery rather than the Pay On Delivery heading', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Cash on Delivery"/></hierarchy>';
    ui.exactTexts.set('Pay On Delivery', [element('Pay On Delivery')]);
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Cash on Delivery') ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node content-desc="Cash on Delivery"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui).selectCashOnDelivery();

    expect(ui.clickedTexts).toEqual(['Cash on Delivery']);
  });

  it('keeps an already selected checkout COD method without reopening payment options', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Place Order"/><node text="Delivering to Home"/><node text="Cash on Delivery"/></hierarchy>';

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery();

    expect(ui.operations).toEqual([]);
  });

  it('returns opaque offer IDs without exposing provider UI locators', async () => {
    const ui = new FakeUi();
    const search = element('', 'search');
    ui.classNames.set('android.widget.EditText', [search]);
    ui.sourceValue = '<hierarchy><node content-desc="Recent searches"/><offer product-id="com.grofers.customerapp:id/raw_42" title="Brown Bread" pack-size="400 g" price="45" available="true" image-url="https://cdn.grofers.com/products/bread.png"/></hierarchy>';

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).search('brown bread', 5);

    expect(offers).toEqual([expect.objectContaining({
      offerId: expect.stringMatching(/^offer_[a-f0-9]{32}$/),
      title: 'Brown Bread',
      imageUrl: 'https://cdn.grofers.com/products/bread.png',
    })]);
    expect(JSON.stringify(offers)).not.toContain('raw_42');
  });

  it('never returns unrelated recommendation cards as search results', async () => {
    const ui = new FakeUi();
    ui.classNames.set('android.widget.EditText', [element('', 'search')]);
    ui.sourceValue = '<hierarchy><node content-desc="Recent searches"/><node content-desc="Desi Tomato is available for ₹16"/><node content-desc="500 g"/></hierarchy>';

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('English Oven Brown Bread', 5);

    expect(offers).toEqual([]);
    expect(ui.operations).toContain('key:ENTER');
  });

  it('activates the semantic Search control and parses live accessibility cards', async () => {
    const ui = new FakeUi();
    const search = element('', 'search-field');
    ui.classNames.set('android.widget.EditText', [search]);
    ui.sourceValue = [
      '<hierarchy>',
      '<android.view.View content-desc="Recent searches" clickable="false"/>',
      '<android.widget.EditText text="Search for atta, dal, coke and more" clickable="true"/>',
      '<android.view.View content-desc="English Oven Brown Bread is available for ₹50" clickable="true"/>',
      '<android.view.View clickable="false"><android.view.View/></android.view.View>',
      '<android.view.View clickable="false"/>',
      '<android.view.View content-desc="400 g" clickable="false"/>',
      '<android.view.View content-desc="ADD" clickable="true"/>',
      '<android.view.View content-desc="₹50" clickable="false"/>',
      '</hierarchy>',
    ].join('');

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).search('brown bread', 5);

    expect(ui.clickedTexts).toEqual([]);
    expect(offers).toEqual([expect.objectContaining({ title: 'English Oven Brown Bread', packSize: '400 g', price: { currency: 'INR', amount: 50 }, available: true })]);
    expect(JSON.stringify(offers)).not.toContain('is available for');
  });

  it('matches spoken Lays to the apostrophe in the live product title', async () => {
    const ui = new FakeUi();
    ui.classNames.set('android.widget.EditText', [element('', 'search-field')]);
    ui.sourceValue = [
      '<hierarchy>',
      '<android.view.View content-desc="Recent searches" clickable="false"/>',
      '<android.view.View content-desc="Lay&apos;s India&apos;s Magic Masala Potato Chips is available for ₹25" clickable="true"/>',
      '<android.view.View content-desc="58 g" clickable="false"/>',
      '</hierarchy>',
    ].join('');

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Lays', 5);

    expect(offers).toEqual([
      expect.objectContaining({ title: "Lay's India's Magic Masala Potato Chips" }),
    ]);
  });

  it('collapses identical duplicate accessibility cards before selecting an offer', async () => {
    const ui = new FakeUi();
    ui.classNames.set('android.widget.EditText', [element('', 'search-field')]);
    ui.sourceValue = [
      '<hierarchy>',
      '<android.view.View content-desc="Recent searches" clickable="false"/>',
      '<android.view.View content-desc="Amul Taaza Toned Milk is available for ₹29" clickable="true"/>',
      '<android.view.View content-desc="500 ml" clickable="false"/>',
      '<android.view.View content-desc="Amul Taaza Toned Milk is available for ₹29" clickable="true"/>',
      '<android.view.View content-desc="500 ml" clickable="false"/>',
      '</hierarchy>',
    ].join('');

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Amul Taaza Toned Milk 500 ml', 10);

    expect(offers).toEqual([expect.objectContaining({
      title: 'Amul Taaza Toned Milk',
      packSize: '500 ml',
      price: { currency: 'INR', amount: 29 },
      available: true,
    })]);
  });

  it('opens the Blinkit search surface before typing a query', async () => {
    const ui = new FakeUi();
    const search = element('', 'search-field');
    ui.classNames.set('android.widget.EditText', [search]);
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Search for atta, dal, coke and more" clickable="true"/><android.view.View content-desc="Voice search"/></hierarchy>';
    ui.exactDescriptions.set('Search for atta, dal, coke and more', [element('Search for atta, dal, coke and more')]);
    ui.onClick = (): void => {
      ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/><android.view.View content-desc="Brown Bread is available for ₹50"/><android.view.View content-desc="400 g"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).search('brown bread', 5);

    expect(ui.clickedTexts).toEqual(['Search for atta, dal, coke and more']);
    expect(ui.operations).toContain('value:search-field');
  });

  it('uses the visible checkout back control before opening storefront search', async () => {
    const ui = new FakeUi();
    const back = element('Go back', 'checkout-back');
    const searchEntry = element('Search for atta, dal, coke and more', 'storefront-search');
    const searchField = element('', 'dedicated-search');
    ui.sourceValue = '<hierarchy><node text="Checkout"/><node content-desc="Go back" clickable="true"/><node content-desc="Search" clickable="true"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Go back' && ui.sourceValue.includes('Checkout')) return [back];
      if (description === 'Search for atta, dal, coke and more' && !ui.sourceValue.includes('Checkout')) return [searchEntry];
      if (description === 'Search' && ui.sourceValue.includes('Checkout')) return [element('Search', 'checkout-search')];
      return [];
    };
    ui.classNames.set('android.widget.EditText', [searchField]);
    ui.onClick = ({ id }): void => {
      if (id === back.id) ui.sourceValue = '<hierarchy><node text="HOME"/><node content-desc="Search for atta, dal, coke and more" clickable="true"/></hierarchy>';
      if (id === searchEntry.id) ui.sourceValue = '<hierarchy><node content-desc="Recent searches"/></hierarchy>';
    };
    ui.onSetValue = (): void => {
      ui.sourceValue = '<hierarchy><node content-desc="Amul Gold Full Cream Milk is available for ₹34"/><node content-desc="500 ml"/></hierarchy>';
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).search('milk', 5);

    expect(ui.operations[0]).toBe('click:Go back');
    expect(ui.operations).not.toContain('click:Search');
    expect(offers).toEqual([expect.objectContaining({ title: 'Amul Gold Full Cream Milk', price: { currency: 'INR', amount: 34 } })]);
  });

  it('uses the product-detail navigation control before searching when the toolbar search action is absent', async () => {
    const ui = new FakeUi();
    const navigateUp = element('Navigate up', 'product-back');
    const searchEntry = element('Search for atta, dal, coke and more', 'home-search');
    const searchField = element('', 'search-field');
    ui.sourceValue = '<hierarchy><node content-desc="Navigate up" clickable="true"/><node content-desc="Select Unit"/><node resource-id="com.grofers.customerapp:id/title" content-desc="Magic Masala Chips"/><node content-desc="Add to cart"/></hierarchy>';
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Navigate up' && ui.sourceValue.includes('Select Unit')) return [navigateUp];
      if (description === 'Search for atta, dal, coke and more' && ui.sourceValue.includes('HOME')) return [searchEntry];
      return [];
    };
    ui.classNames.set('android.widget.EditText', [searchField]);
    ui.onClick = ({ id }): void => {
      if (id === navigateUp.id) {
        ui.sourceValue = '<hierarchy><node text="HOME"/><node content-desc="Search for atta, dal, coke and more" clickable="true"/></hierarchy>';
      }
      if (id === searchEntry.id) ui.sourceValue = '<hierarchy><node content-desc="Recent searches"/></hierarchy>';
    };
    ui.onSetValue = (): void => {
      ui.sourceValue = '<hierarchy><node content-desc="Magic Masala Chips is available for ₹25"/><node content-desc="58 g"/></hierarchy>';
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Magic Masala Chips', 5);

    expect(ui.operations[0]).toBe('click:Navigate up');
    expect(ui.operations).not.toContain('back');
    expect(offers).toEqual([expect.objectContaining({ title: 'Magic Masala Chips', packSize: '58 g' })]);
  });

  it('returns a sanitized semantic product-detail screen summary', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node content-desc="Navigate up" clickable="true"/><node content-desc="Select Unit"/><node resource-id="com.grofers.customerapp:id/title" content-desc="Lay&apos;s Magic Masala Chips"/><node text="58 g" resource-id="com.grofers.customerapp:id/tv_title2"/><node text="₹25" resource-id="com.grofers.customerapp:id/info_text"/><node text="View cart"/><node text="3 items"/><node content-desc="Search" clickable="true"/></hierarchy>';

    const screen = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).currentScreen();

    expect(screen).toEqual({
      kind: 'product_detail',
      searchAction: 'available',
      cartItemCount: 3,
      product: {
        name: "Lay's Magic Masala Chips",
        packSize: '58 g',
        price: { currency: 'INR', amount: 25 },
      },
    });
    expect(JSON.stringify(screen)).not.toMatch(/selector|coordinate|resource.?id|screenshot|xml|path|emulator/i);
  });

  it('prefers one clickable search ancestor when Blinkit also marks the nested label clickable', async () => {
    const ui = new FakeUi();
    const labelText = 'Search for atta, dal, coke and more';
    const nestedLabel = { ...positioned(labelText, 80, 100, 500, 60), id: 'nested-search-label' };
    const nestedDescription = { ...positioned(labelText, 90, 110, 480, 50), id: 'nested-search-description' };
    const textSearchContainer = { ...positioned('Text search container', 40, 80, 900, 100), id: 'text-search-container' };
    const descriptionSearchContainer = { ...positioned('Description search container', 30, 70, 920, 120), id: 'description-search-container' };
    const searchField = element('', 'search-field');
    ui.sourceValue = `<hierarchy><node text="${labelText}" clickable="true"/></hierarchy>`;
    ui.exactTexts.set(labelText, [nestedLabel]);
    ui.exactDescriptions.set(labelText, [nestedDescription]);
    ui.clickableAncestors.set(labelText, [textSearchContainer]);
    ui.clickableDescriptionAncestors.set(labelText, [descriptionSearchContainer]);
    ui.classNames.set('android.widget.EditText', [searchField]);
    ui.onClick = ({ id }): void => {
      if (id === descriptionSearchContainer.id) {
        ui.sourceValue = '<hierarchy><node content-desc="Recent searches"/><node content-desc="Magic Masala Chips is available for ₹25"/><node content-desc="48 g"/></hierarchy>';
      }
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).search('magic masala chips', 5);

    expect(ui.operations).toContain('click:Description search container');
    expect(ui.operations).not.toContain('click:Text search container');
    expect(ui.operations).not.toContain(`click:${labelText}`);
    expect(offers).toEqual([expect.objectContaining({ title: 'Magic Masala Chips', price: { currency: 'INR', amount: 25 } })]);
  });

  it('waits for the storefront search entry after returning from the cart', async () => {
    const ui = new FakeUi();
    const searchEntry = element('Search for atta, dal, coke and more');
    const searchField = element('', 'search-field');
    let entryReads = 0;
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Search for atta, dal, coke and more"/></hierarchy>';
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description !== 'Search for atta, dal, coke and more') return [];
      entryReads += 1;
      return entryReads < 3 ? [] : [searchEntry];
    };
    ui.classNames.set('android.widget.EditText', [searchField]);
    ui.onClick = (): void => {
      ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/><offer product-id="raw" title="Brown Bread" price="50" available="true"/></hierarchy>';
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Brown Bread', 5);

    expect(entryReads).toBe(3);
    expect(offers).toEqual([expect.objectContaining({ title: 'Brown Bread' })]);
  });

  it('refocuses the storefront field and reacquires the dedicated search input', async () => {
    const ui = new FakeUi();
    const storefrontField = element('', 'storefront-search');
    const dedicatedField = element('', 'dedicated-search');
    ui.classNames.set('android.widget.EditText', [storefrontField]);
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Search for atta, dal, coke and more" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('Search for atta, dal, coke and more', [element('Search for atta, dal, coke and more')]);
    ui.onClick = ({ id }): void => {
      if (id === storefrontField.id) {
        ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/></hierarchy>';
        ui.classNames.set('android.widget.EditText', [dedicatedField]);
      }
    };
    ui.onSetValue = ({ id }): void => {
      if (id === dedicatedField.id) {
        ui.sourceValue = '<hierarchy><android.view.View content-desc="Lay’s India’s Magic Masala Potato Chips is available for ₹20"/><android.view.View content-desc="52 g"/></hierarchy>';
      }
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Magic Masala chips', 5);

    expect(offers).toEqual([expect.objectContaining({ title: 'Lay’s India’s Magic Masala Potato Chips', price: { currency: 'INR', amount: 20 } })]);
    expect(ui.operations).toEqual([
      'click:Search for atta, dal, coke and more',
      'click:',
      'clear:dedicated-search',
      'value:dedicated-search',
    ]);
  });

  it('waits for the dedicated search input to become available after navigation', async () => {
    const ui = new FakeUi();
    const storefrontField = element('', 'storefront-search');
    const dedicatedField = element('', 'dedicated-search');
    let fieldReads = 0;
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Search for atta, dal, coke and more" clickable="true"/><android.view.View content-desc="Voice search"/></hierarchy>';
    ui.exactDescriptions.set('Search for atta, dal, coke and more', [element('Search for atta, dal, coke and more')]);
    ui.findClassName = async (): Promise<UiElement[]> => {
      fieldReads += 1;
      if (fieldReads === 1) return [storefrontField];
      if (fieldReads === 2) return [];
      return [dedicatedField];
    };
    ui.onClick = ({ id }): void => {
      if (id === storefrontField.id) ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/></hierarchy>';
    };
    ui.onSetValue = ({ id }): void => {
      if (id === dedicatedField.id) {
        ui.sourceValue = '<hierarchy><android.view.View content-desc="Lay’s India’s Magic Masala Potato Chips is available for ₹25"/><android.view.View content-desc="58 g"/></hierarchy>';
      }
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Magic Masala chips', 5);

    expect(offers).toEqual([expect.objectContaining({ packSize: '58 g', price: { currency: 'INR', amount: 25 } })]);
    expect(fieldReads).toBe(3);
  });

  it('refocuses a recognized search surface when its editable field is absent', async () => {
    const ui = new FakeUi();
    const searchEntry = element('Search for atta, dal, coke and more');
    const dedicatedField = element('', 'dedicated-search');
    let focused = false;
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/><android.view.View content-desc="Search for atta, dal, coke and more" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('Search for atta, dal, coke and more', [searchEntry]);
    ui.findClassName = async (): Promise<UiElement[]> => focused ? [dedicatedField] : [];
    ui.onClick = ({ id }): void => {
      if (id === searchEntry.id) focused = true;
    };
    ui.onSetValue = (): void => {
      ui.sourceValue = '<hierarchy><android.view.View content-desc="Brown Bread is available for ₹50"/><android.view.View content-desc="400 g"/></hierarchy>';
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Brown Bread', 5);

    expect(ui.clickedTexts).toContain('Search for atta, dal, coke and more');
    expect(offers).toEqual([expect.objectContaining({ title: 'Brown Bread' })]);
  });

  it('unwinds a post-add product surface before searching for the next requested item', async () => {
    const ui = new FakeUi();
    const dedicatedField = element('', 'dedicated-search');
    let returnedToSearch = false;
    ui.sourceValue = '<hierarchy><android.view.View content-desc="Choose a pack"/><android.view.View content-desc="ADD"/></hierarchy>';
    ui.findClassName = async (): Promise<UiElement[]> => returnedToSearch ? [dedicatedField] : [];
    ui.onBack = (): void => {
      returnedToSearch = true;
      ui.sourceValue = '<hierarchy><android.view.View content-desc="Recent searches"/></hierarchy>';
    };
    ui.onSetValue = (): void => {
      ui.sourceValue = '<hierarchy><android.view.View content-desc="Hocco Bix Chocolate Chips Ice Cream Sandwich is available for ₹70"/><android.view.View content-desc="125 ml"/></hierarchy>';
    };

    const offers = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .search('Hocco Bix Chocolate Chips Ice Cream Sandwich', 5);

    expect(ui.operations).toContain('back');
    expect(offers).toEqual([expect.objectContaining({ title: 'Hocco Bix Chocolate Chips Ice Cream Sandwich' })]);
  });

  it('scrolls Cash on Delivery into view before clicking', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Checkout"/></hierarchy>';
    ui.clickableAncestors.set('PAY USING', [element('PAY USING')]);
    ui.offscreenTexts.add('Pay On Delivery');
    ui.scrollExactTextIntoView = async (text: string): Promise<UiElement> => {
      ui.operations.push(`scroll:${text}`);
      if (!ui.offscreenTexts.has(text)) throw new Error('not offscreen');
      ui.clickableDescriptionAncestors.set('Cash on Delivery', [element('Cash on Delivery')]);
      return element(text);
    };
    ui.onClick = ({ text }): void => {
      if (text === 'Cash on Delivery') ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node content-desc="Cash on Delivery"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui).selectCashOnDelivery();

    expect(ui.operations).toEqual(['click:PAY USING', 'scroll:Pay On Delivery', 'tap:Cash on Delivery']);
  });

  it('opens the current PAY USING control before selecting Cash on Delivery', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Checkout"/></hierarchy>';
    const paymentSelector = element('PAY USING');
    ui.clickableAncestors.set('PAY USING', [paymentSelector]);
    ui.onClick = ({ text }): void => {
      if (text === 'PAY USING') ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
      if (text === 'Cash on Delivery') ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node content-desc="Cash on Delivery"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery();

    expect(ui.clickedTexts).toEqual(['PAY USING', 'Cash on Delivery']);
  });

  it('opens the current Select payment option control before selecting Cash on Delivery', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Select payment option"/><node text="Delivering to Home"/></hierarchy>';
    ui.clickableAncestors.set('Select payment option', [element('Select payment option')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Select payment option') ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
      if (text === 'Cash on Delivery') ui.sourceValue = '<hierarchy><node text="Place Order"/><node text="Delivering to Home"/><node content-desc="Cash on Delivery"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery();

    expect(ui.clickedTexts).toEqual(['Select payment option', 'Cash on Delivery']);
  });

  it('prefers the full clickable COD row over a clickable text fragment', async () => {
    const ui = new FakeUi();
    const fragment = positioned('Cash on Delivery', 220, 1990, 320, 50);
    const row = positioned('COD row', 30, 1930, 1020, 170);
    ui.sourceValue = '<hierarchy><node text="Payment Options"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [fragment]);
    ui.clickableAncestors.set('Cash on Delivery', [row]);
    ui.onClick = ({ id }): void => {
      if (id === row.id) ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node content-desc="Cash on Delivery"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery();

    expect(ui.clickedTexts).toEqual(['COD row']);
  });

  it('uses bounded forward gestures when the payment activity cannot scroll to exact text', async () => {
    const ui = new FakeUi();
    const waits: number[] = [];
    ui.sourceValue = '<hierarchy><node text="Payment Options"/></hierarchy>';
    let scrolls = 0;
    ui.onScrollForward = (): boolean => {
      scrolls += 1;
      if (scrolls === 2) ui.clickableDescriptionAncestors.set('Cash on Delivery', [element('Cash on Delivery')]);
      return scrolls < 3;
    };
    ui.onClick = ({ text }): void => {
      if (text === 'Cash on Delivery') ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node content-desc="Cash on Delivery"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (milliseconds): Promise<void> => { waits.push(milliseconds); } }).selectCashOnDelivery();

    expect(ui.operations).toEqual(['scroll:Pay On Delivery', 'scroll:forward', 'scroll:forward', 'tap:Cash on Delivery']);
    expect(waits).toEqual([1_500, 1_500, 1_500]);
  });

  it('reports a sanitized target stage when COD never appears', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/></hierarchy>';

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery())
      .rejects.toThrow('Blinkit payment_target failed');
  });

  it('reports provider COD unavailability before attempting selection', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/><node text="Cash on Delivery"/><node text="Cash on delivery is not available between 12:00 AM and 6:00 AM"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery())
      .rejects.toThrow('Blinkit checkout blocked: cod_unavailable');
    expect(ui.operations).toEqual([]);
  });

  it('reports a sanitized verification stage when the COD click does not return checkout', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onClick = (): void => {
      ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectCashOnDelivery())
      .rejects.toThrow('Blinkit payment_verify failed');
  });

  it('reports a sanitized return stage when COD does not navigate back to checkout', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined, pollAttempts: 1 }).selectCashOnDelivery())
      .rejects.toThrow('Blinkit payment_return failed');
  });

  it('returns from a persistent payment chooser after selecting COD', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/><node text="Cash on Delivery"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Place Order"/><node text="Delivering to Home"/><node content-desc="Cash on Delivery"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined, pollAttempts: 1 }).selectCashOnDelivery();

    expect(ui.operations).toEqual(['tap:Cash on Delivery', 'back']);
  });

  it('accepts Pay on Delivery as selected COD evidence on checkout', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Payment Options"/><node text="Cash on Delivery"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Place Order"/><node text="Delivering to Home"/><node content-desc="Pay on Delivery"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined, pollAttempts: 1 }).selectCashOnDelivery();

    expect(ui.operations).toEqual(['tap:Cash on Delivery', 'back']);
  });

  it('opens the one clickable View cart control', async () => {
    const ui = new FakeUi();
    ui.exactTexts.set('View cart', [
      { ...element('View cart', 'label'), clickable: false },
      element('View cart', 'button'),
    ]);
    ui.onClick = ({ text }): void => {
      if (text === 'View cart') ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).toEqual(['click:View cart']);
  });

  it('bounds checkout polling after opening the cart', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="View cart"/></hierarchy>';
    ui.exactTexts.set('View cart', [element('View cart')]);
    ui.onClick = (): void => {
      ui.sourceValue = '<hierarchy><node text="Loading cart"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined, pollAttempts: 20 }).openCart())
      .rejects.toThrow('Blinkit stage_wait failed');

    expect(ui.sourceCalls).toBe(5);
  });

  it('opens a View cart control exposed only as an accessibility description', async () => {
    const ui = new FakeUi();
    ui.exactDescriptions.set('View cart', [{
      ...element('', 'cart-description'),
      contentDescription: 'View cart',
    }]);
    ui.onClick = ({ id }): void => {
      if (id === 'cart-description') {
        ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
      }
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).toEqual(['click:']);
  });

  it('backs through the search keyboard and activity until View cart is available', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node content-desc="Voice search"/></hierarchy>';
    let backCount = 0;
    ui.onBack = (): void => {
      backCount += 1;
      if (backCount === 2) {
        ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="View cart"/></hierarchy>';
        ui.exactTexts.set('View cart', [element('View cart')]);
      }
    };
    ui.onClick = ({ text }): void => {
      if (text === 'View cart') {
        ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
      }
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).toEqual(['back', 'back', 'click:View cart']);
  });

  it('treats Back from checkout search as an already opened cart', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Recent searches"/></hierarchy>';
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).toEqual(['back']);
  });

  it('does not navigate back when the current Blinkit screen is already checkout', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Shipment of 2 items"/><node text="Delivering to Home"/><node text="Select payment option"/></hierarchy>';

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).not.toContain('back');
  });

  it('opens a recognized storefront cart without rediscovering the same control', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="View cart" clickable="true" bounds="[20,900][1060,1040]"/></hierarchy>';
    ui.exactTexts.set('View cart', [element('View cart')]);
    ui.onClick = ({ text, id }): void => {
      if (text === 'View cart' || id === 'rect') ui.sourceValue = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 45 }]);
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).inspectCart())
      .resolves.toMatchObject({ lines: [{ name: 'Brown Bread' }], subtotal: { amount: 45 } });
    expect(ui.tappedRects).toEqual([{ x: 20, y: 900, width: 1_040, height: 140 }]);
    expect(ui.exactTextQueries.filter((query) => query === 'View cart')).toHaveLength(0);
    expect(ui.sourceCalls).toBe(2);
  });

  it('reports an empty cart directly from the storefront when no cart control exists', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="HOME"/><node content-desc="Search for atta, dal, coke and more"/></hierarchy>';

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).inspectCart();

    expect(cart).toBeUndefined();
    expect(ui.operations).toEqual([]);
  });

  it('recovers a location prompt before reporting an empty storefront cart', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Location permission not enabled"/><node text="Enable device location"/><node text="Select location manually" clickable="true"/></hierarchy>';
    ui.exactTexts.set('Select location manually', [element('Select location manually')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Select location manually') {
        ui.sourceValue = '<hierarchy><node text="HOME"/><node content-desc="Search for atta, dal, coke and more"/></hierarchy>';
      }
    };

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).inspectCart();

    expect(cart).toBeUndefined();
    expect(ui.operations).toEqual(['click:Select location manually']);
  });

  it('waits through a cold-start screen before recovering and inspecting the cart', async () => {
    const ui = new FakeUi();
    const locationPrompt = '<hierarchy><node text="Location permission not enabled"/><node text="Enable device location"/><node text="Select location manually" clickable="true"/></hierarchy>';
    ui.sourceValues = [
      '<hierarchy><node text="Everything you need, delivered at your doorstep"/></hierarchy>',
      locationPrompt,
      locationPrompt,
      '<hierarchy><node text="HOME"/><node content-desc="Search for atta, dal, coke and more"/></hierarchy>',
    ];
    ui.exactTexts.set('Select location manually', [element('Select location manually')]);

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).inspectCart();

    expect(cart).toBeUndefined();
    expect(ui.operations).toEqual(['click:Select location manually']);
  });

  it('opens a deduplicated clickable ancestor when View cart labels are not clickable', async () => {
    const ui = new FakeUi();
    ui.exactTexts.set('View cart', [{ ...element('View cart', 'label-1'), clickable: false }, { ...element('View cart', 'label-2'), clickable: false }]);
    const parent: UiElement = {
      id: 'cart-parent',
      rect: { x: 0, y: 0, width: 100, height: 40 },
      clickable: true,
    };
    ui.clickableAncestors.set('View cart', [parent, {
      ...parent,
      id: 'cart-parent-duplicate',
      rect: { ...parent.rect, y: parent.rect.y + 1 },
    }]);
    ui.onClick = (): void => {
      ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).openCart();

    expect(ui.operations).toEqual(['click:cart-parent']);
  });

  it('clears every persisted cart quantity before rebuilding an exact order', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="Place Order"/><node text="PAY USING"/></hierarchy>';
    let quantity = 3;
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Decrease quantity' && quantity > 0) return [element('Decrease quantity')];
      return [];
    };
    ui.onClick = ({ text }): void => {
      if (text === 'Decrease quantity') quantity -= 1;
    };
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).clearCart();

    expect(quantity).toBe(0);
    expect(ui.clickedTexts).toEqual(['Decrease quantity', 'Decrease quantity', 'Decrease quantity']);
    expect(ui.operations.at(-1)).toBe('back');
  });

  it('backs out of an unknown payment overlay before clearing the cart', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Saved cards"/><node text="UPI"/></hierarchy>';
    let quantity = 1;
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Checkout"/><node text="Place Order"/><node text="PAY USING"/></hierarchy>';
    };
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Decrease quantity' && quantity > 0) return [element('Decrease quantity')];
      return [];
    };
    ui.onClick = ({ text }): void => {
      if (text === 'Decrease quantity') quantity -= 1;
    };
    const overlayBack = ui.onBack;
    ui.onBack = (): void => {
      if (ui.sourceValue.includes('Saved cards')) overlayBack?.();
      else ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).clearCart();

    expect(quantity).toBe(0);
    expect(ui.operations).toEqual(['back', 'click:Decrease quantity', 'back']);
  });

  it('changes only the selected existing cart line and verifies the refreshed quantity', async () => {
    const ui = new FakeUi();
    const lines = [
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ];
    const controls = {
      breadDecrease: { ...positioned('Decrease quantity', 700, 250, 40, 40), id: 'bread-decrease' },
      cokeDecrease: { ...positioned('Decrease quantity', 700, 650, 40, 40), id: 'coke-decrease' },
      breadIncrease: { ...positioned('Increase quantity', 800, 250, 40, 40), id: 'bread-increase' },
      cokeIncrease: { ...positioned('Increase quantity', 800, 650, 40, 40), id: 'coke-increase' },
    };
    const refresh = (): void => { ui.sourceValue = liveCartSource(lines.filter(({ quantity }) => quantity > 0)); };
    refresh();
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Decrease quantity') return [controls.breadDecrease, controls.cokeDecrease];
      if (description === 'Increase quantity') return [controls.breadIncrease, controls.cokeIncrease];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === controls.cokeIncrease.id) lines[1]!.quantity += 1;
      refresh();
    };
    const target = parseLiveAndroidCart(ui.sourceValue)!.lines[1]!;

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setExistingCartItemQuantity(target.productId, 3);

    expect(cart?.lines).toMatchObject([{ name: 'Brown Bread', quantity: 1 }, { name: 'Diet Coke', quantity: 3 }]);
    expect(ui.operations.filter((operation) => operation === 'click:Increase quantity')).toHaveLength(2);
  });

  it('associates an existing cart line with its nearest control when unrelated controls are visible', async () => {
    const ui = new FakeUi();
    const lines = [
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ];
    const breadLabel = positioned('Brown Bread', 80, 220, 300, 60);
    const cokeLabel = positioned('Diet Coke', 80, 620, 300, 60);
    const breadIncrease = { ...positioned('Increase quantity', 800, 250, 40, 40), id: 'bread-increase' };
    const cokeIncrease = { ...positioned('Increase quantity', 800, 650, 40, 40), id: 'coke-increase' };
    const unrelatedIncrease = { ...positioned('Increase quantity', 800, 1_050, 40, 40), id: 'unrelated-increase' };
    const refresh = (): void => { ui.sourceValue = liveCartSource(lines); };
    refresh();
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === 'Brown Bread') return [breadLabel];
      if (description === 'Diet Coke') return [cokeLabel];
      if (description === 'Increase quantity') return [breadIncrease, cokeIncrease, unrelatedIncrease];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === cokeIncrease.id) lines[1]!.quantity += 1;
      refresh();
    };
    const target = parseLiveAndroidCart(ui.sourceValue)!.lines[1]!;

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setExistingCartItemQuantity(target.productId, 2);

    expect(cart?.lines).toMatchObject([{ name: 'Brown Bread', quantity: 1 }, { name: 'Diet Coke', quantity: 2 }]);
    expect(ui.operations).toContain('click:Increase quantity');
    expect(ui.operations).not.toContain('click:unrelated-increase');
  });

  it('waits for Blinkit to expose the refreshed quantity after the cart click', async () => {
    const ui = new FakeUi();
    const before = liveCartSource([{ name: 'Brown Bread', quantity: 1, unitPrice: 50 }]);
    const after = liveCartSource([{ name: 'Brown Bread', quantity: 2, unitPrice: 50 }]);
    ui.sourceValue = before;
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => description === 'Increase quantity'
      ? [positioned('Increase quantity', 800, 250, 40, 40)]
      : [];
    ui.onClick = (): void => {
      ui.sourceValues = [before, after];
      ui.sourceValue = after;
    };
    const target = parseLiveAndroidCart(before)!.lines[0]!;

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setExistingCartItemQuantity(target.productId, 2);

    expect(cart?.lines[0]).toMatchObject({ name: 'Brown Bread', quantity: 2 });
  });

  it('removes only the selected opaque cart line and returns the remaining cart', async () => {
    const ui = new FakeUi();
    const lines = [
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ];
    const breadDecrease = { ...positioned('Decrease quantity', 700, 250, 40, 40), id: 'bread-decrease' };
    const cokeDecrease = { ...positioned('Decrease quantity', 700, 650, 40, 40), id: 'coke-decrease' };
    const refresh = (): void => { ui.sourceValue = liveCartSource(lines.filter(({ quantity }) => quantity > 0)); };
    refresh();
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description !== 'Decrease quantity') return [];
      return lines[0]!.quantity > 0 ? [breadDecrease, cokeDecrease] : [cokeDecrease];
    };
    ui.onClick = ({ id }): void => {
      if (id === breadDecrease.id) lines[0]!.quantity -= 1;
      refresh();
    };
    const target = parseLiveAndroidCart(ui.sourceValue)!.lines[0]!;

    const cart = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .removeExistingCartItem(target.productId);

    expect(cart?.lines).toMatchObject([{ name: 'Diet Coke', quantity: 1 }]);
    expect(ui.operations).toContain('click:Decrease quantity');
  });

  it('upserts one exact searched offer and preserves every other cart line', async () => {
    const ui = new FakeUi();
    const driver = new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined });
    const before = parseLiveAndroidCart(liveCartSource([
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ]))!;
    const after = parseLiveAndroidCart(liveCartSource([
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
      { name: "Lay's Magic Masala", quantity: 2, unitPrice: 25 },
    ]))!;
    vi.spyOn(driver, 'inspectCart').mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    vi.spyOn(driver as unknown as { searchCandidates(query: string, limit: number): Promise<unknown[]> }, 'searchCandidates').mockResolvedValue([{
      offerId: 'offer_lays', title: "Lay's Magic Masala", packSize: '48 g', price: { currency: 'INR', amount: 25 }, available: true, providerLocator: 'description:lays-card',
    }]);
    const setQuantity = vi.spyOn(driver, 'setCartQuantity').mockResolvedValue();

    const cart = await driver.upsertCartItem('magic masala chips', 'offer_lays', 2);

    expect(setQuantity).toHaveBeenCalledWith('description:lays-card', 2);
    expect(cart.lines).toMatchObject([
      { name: 'Brown Bread', quantity: 1 },
      { name: 'Diet Coke', quantity: 1 },
      { name: "Lay's Magic Masala", quantity: 2 },
    ]);
  });

  it('rejects an exact-offer upsert when another existing cart line disappears', async () => {
    const ui = new FakeUi();
    const driver = new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined });
    const before = parseLiveAndroidCart(liveCartSource([
      { name: 'Brown Bread', quantity: 1, unitPrice: 50 },
      { name: 'Diet Coke', quantity: 1, unitPrice: 40 },
    ]))!;
    const after = parseLiveAndroidCart(liveCartSource([
      { name: "Lay's Magic Masala", quantity: 1, unitPrice: 25 },
    ]))!;
    vi.spyOn(driver, 'inspectCart').mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    vi.spyOn(driver as unknown as { searchCandidates(query: string, limit: number): Promise<unknown[]> }, 'searchCandidates').mockResolvedValue([{
      offerId: 'offer_lays', title: "Lay's Magic Masala", price: { currency: 'INR', amount: 25 }, available: true, providerLocator: 'description:lays-card',
    }]);
    vi.spyOn(driver, 'setCartQuantity').mockResolvedValue();

    await expect(driver.upsertCartItem('magic masala chips', 'offer_lays', 1))
      .rejects.toThrow('Blinkit cart_preservation_verify failed');
  });

  it('sets an exact live cart quantity using controls scoped to the selected offer', async () => {
    const ui = new FakeUi();
    const card = positioned('Brown Bread is available for ₹50', 0, 100, 300, 300);
    const otherAdd = positioned('ADD', 400, 100);
    const selectedAdd = positioned('ADD', 100, 300);
    const decrease = positioned('Decrease quantity', 80, 300);
    const increase = positioned('Increase quantity', 180, 300);
    let current = 1;
    ui.exactDescriptions.set(card.text!, [card]);
    ui.findExactDescription = async (description: string): Promise<UiElement[]> => {
      if (description === card.text) return [card];
      if (description === 'ADD') return current === 0 ? [otherAdd, selectedAdd] : [otherAdd];
      if (description === 'Decrease quantity') return current > 0 ? [decrease] : [];
      if (description === 'Increase quantity') return current > 0 ? [increase] : [];
      return [];
    };
    ui.onClick = ({ text, rect }): void => {
      if (text === 'Decrease quantity') current -= 1;
      if (text === 'ADD' && rect.x === selectedAdd.rect.x) current = 1;
      if (text === 'Increase quantity') current += 1;
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${card.text}`, 3);

    expect(current).toBe(3);
    expect(ui.clickedTexts).toEqual(['Decrease quantity', 'ADD', 'Increase quantity', 'Increase quantity']);
  });

  it('uses the uniquely nearest ADD control when Blinkit renders it outside the product label bounds', async () => {
    const ui = new FakeUi();
    const description = 'Hocco Bix Chocolate Chips Ice Cream Sandwich is available for ₹70';
    const card = positioned(description, 80, 100, 220, 60);
    const selectedAdd = { ...positioned('ADD', 140, 240, 80, 40), id: 'selected-add' };
    const otherAdd = { ...positioned('ADD', 650, 240, 80, 40), id: 'other-add' };
    const decrease = positioned('Decrease quantity', 140, 240, 80, 40);
    let added = false;
    ui.findExactDescription = async (label: string): Promise<UiElement[]> => {
      if (label === description) return [card];
      if (label === 'ADD') return added ? [otherAdd] : [selectedAdd, otherAdd];
      if (label === 'Decrease quantity') return added ? [decrease] : [];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === selectedAdd.id) added = true;
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${description}`, 1);

    expect(added).toBe(true);
  });

  it('ignores a clipped duplicate accessibility card for the exact offer', async () => {
    const ui = new FakeUi();
    const description = 'Amul Taaza Toned Milk is available for ₹29';
    const visibleCard = positioned(description, 31, 621, 319, 778);
    const clippedDuplicate = positioned(description, 1022, 816, 58, 868);
    const selectedAdd = { ...positioned('ADD', 209, 1003, 141, 40), id: 'selected-add' };
    const otherAdd = { ...positioned('ADD', 908, 1003, 141, 40), id: 'other-add' };
    const decrease = positioned('Decrease quantity', 209, 1003, 141, 40);
    let added = false;
    ui.findExactDescription = async (label: string): Promise<UiElement[]> => {
      if (label === description) return [visibleCard, clippedDuplicate];
      if (label === 'ADD') return added ? [otherAdd] : [selectedAdd, otherAdd];
      if (label === 'Decrease quantity') return added ? [decrease] : [];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === selectedAdd.id) added = true;
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${description}`, 1);

    expect(added).toBe(true);
    expect(ui.operations).toContain('click:ADD');
  });

  it('rejects similarly visible duplicate cards instead of guessing an offer target', async () => {
    const ui = new FakeUi();
    const description = 'Amul Taaza Toned Milk is available for ₹29';
    ui.findExactDescription = async (label: string): Promise<UiElement[]> => label === description
      ? [positioned(description, 20, 500, 300, 700), positioned(description, 380, 500, 300, 700)]
      : [];

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${description}`, 1))
      .rejects.toThrow('Blinkit cart_quantity_card failed');

    expect(ui.operations).toEqual([]);
  });

  it('uses the uniquely nearest ADD when two controls fall inside one broad product card', async () => {
    const ui = new FakeUi();
    const description = "Lay's India's Magic Masala Potato Chips is available for ₹25";
    const card = positioned(description, 0, 100, 300, 300);
    const selectedAdd = { ...positioned('ADD', 100, 300, 100, 40), id: 'selected-add' };
    const otherContainedAdd = { ...positioned('ADD', 230, 120, 50, 40), id: 'other-contained-add' };
    const decrease = positioned('Decrease quantity', 100, 300, 100, 40);
    let added = false;
    ui.findExactDescription = async (label: string): Promise<UiElement[]> => {
      if (label === description) return [card];
      if (label === 'ADD') return added ? [otherContainedAdd] : [selectedAdd, otherContainedAdd];
      if (label === 'Decrease quantity') return added ? [decrease] : [];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === selectedAdd.id) added = true;
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${description}`, 1);

    expect(added).toBe(true);
    expect(ui.operations).toContain('click:ADD');
  });

  it('selects the exact offer from a Blinkit multi-option sheet', async () => {
    const ui = new FakeUi();
    const description = "Lay's India's Magic Masala Potato Chips is available for ₹25";
    const resultCard = positioned(description, 0, 100, 300, 300);
    const resultAdd = { ...positioned('ADD', 100, 300), id: 'result-add' };
    const variantCard = positioned(description, 0, 700, 500, 700);
    const variantAdd = { ...positioned('ADD', 250, 1100), id: 'variant-add' };
    const decrease = positioned('Decrease quantity', 250, 1100);
    let state: 'result' | 'sheet' | 'added' = 'result';
    ui.findExactDescription = async (label: string): Promise<UiElement[]> => {
      if (label === description) return state === 'result' ? [resultCard] : [variantCard];
      if (label === 'ADD') return state === 'result' ? [resultAdd] : state === 'sheet' ? [variantAdd] : [];
      if (label === 'Decrease quantity') return state === 'added' ? [decrease] : [];
      return [];
    };
    ui.onClick = ({ id }): void => {
      if (id === resultAdd.id) state = 'sheet';
      if (id === variantAdd.id) state = 'added';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .setCartQuantity(`description:${description}`, 1);

    expect(state).toBe('added');
    expect(ui.operations).toEqual(['click:ADD', 'click:ADD']);
  });

  it('selects Home after a saved-location prompt', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Select delivery location"/><node text="Your saved addresses"/><node text="Home"/></hierarchy>';
    ui.exactTexts.set('Home', [element('Home')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Home') ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).selectSavedAddress('Home');

    expect(ui.clickedTexts).toEqual(['Home']);
  });

  it('lists saved address labels without returning full address text', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('HOME - saved location', [element('HOME - saved location')]);
    ui.onClick = ({ text }): void => {
      if (text === 'HOME - saved location') {
        ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/><node resource-id="com.grofers.customerapp:id/full_address" text="42 Private Street, Bengaluru 560035"/><node resource-id="com.grofers.customerapp:id/address_label" text="AO house"/></hierarchy>';
      }
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home', 'AO house']);
    expect(JSON.stringify(addresses)).not.toMatch(/42 Private|560035/);
    expect(ui.clickedTexts).toEqual(['HOME - saved location']);
    expect(ui.operations).toContain('back');
  });

  it('scrolls through the saved-address book and returns off-screen labels', async () => {
    const ui = new FakeUi();
    const firstPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_label" text="Rajneesh Yadav"/>'
      + '<node resource-id="com.grofers.customerapp:id/full_address" text="Private home address"/></hierarchy>';
    const secondPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_label" text="Rajneesh Yadav"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Work"/>'
      + '<node resource-id="com.grofers.customerapp:id/full_address" text="6th floor Kothari Arena"/></hierarchy>';
    ui.sourceValue = firstPage;
    let scrolls = 0;
    ui.onScrollForward = (): boolean => {
      scrolls += 1;
      ui.sourceValue = secondPage;
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home', 'Rajneesh Yadav', 'Work']);
    expect(JSON.stringify(addresses)).not.toMatch(/Private home|6th floor|Kothari Arena/);
    expect(scrolls).toBe(2);
  });

  it('scrolls the address-book container when a viewport swipe cannot move the sheet', async () => {
    const ui = new FakeUi();
    const firstPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    const secondPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Work"/>'
      + '<node resource-id="com.grofers.customerapp:id/full_address" text="6th floor Kothari Arena"/></hierarchy>';
    ui.sourceValue = firstPage;
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.onScrollElementForward = (): boolean => {
      ui.sourceValue = secondPage;
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home', 'Work']);
    expect(ui.operations).toContain('scroll:element:address-list');
    expect(ui.operations).not.toContain('scroll:forward');
    expect(JSON.stringify(addresses)).not.toMatch(/6th floor|Kothari Arena/);
  });

  it('rewinds a previously scrolled address book before scanning forward', async () => {
    const ui = new FakeUi();
    const topPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Work"/></hierarchy>';
    const middlePage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_label" text="Rajneesh Yadav"/></hierarchy>';
    ui.sourceValue = middlePage;
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.onScrollElementBackward = (): boolean => {
      if (ui.sourceValue === topPage) return false;
      ui.sourceValue = topPage;
      return true;
    };
    ui.onScrollElementForward = (): boolean => {
      if (ui.sourceValue === middlePage) return false;
      ui.sourceValue = middlePage;
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Work', 'Home', 'Rajneesh Yadav']);
    expect(ui.operations).toContain('scroll:element-backward:address-list');
    expect(ui.operations.indexOf('scroll:element-backward:address-list'))
      .toBeLessThan(ui.operations.indexOf('scroll:element:address-list'));
  });

  it('stops address scrolling when safe labels remain unchanged despite successful gestures', async () => {
    const ui = new FakeUi();
    let backwardScrolls = 0;
    let forwardScrolls = 0;
    ui.sourceValue = '<hierarchy tick="0"><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.onScrollElementBackward = (): boolean => {
      backwardScrolls += 1;
      ui.sourceValue = `<hierarchy tick="${backwardScrolls}"><node text="Your saved addresses"/>`
        + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
      return true;
    };
    ui.onScrollElementForward = (): boolean => {
      forwardScrolls += 1;
      ui.sourceValue = `<hierarchy tick="${backwardScrolls + forwardScrolls}"><node text="Your saved addresses"/>`
        + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home']);
    expect(backwardScrolls).toBeLessThanOrEqual(2);
    expect(forwardScrolls).toBeLessThanOrEqual(2);
  });

  it('reads scrolled address pages through narrow label resources without repeated full sources', async () => {
    const ui = new FakeUi();
    const addressTypeId = 'com.grofers.customerapp:id/address_type';
    let position: 'middle' | 'top' = 'middle';
    ui.sourceValue = '<hierarchy><node text="Your saved addresses"/>'
      + `<node resource-id="${addressTypeId}" text="Home"/></hierarchy>`;
    ui.exactTexts.set('Your saved addresses', [element('Your saved addresses')]);
    ui.resourceIds.set(addressTypeId, [element('Home')]);
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.onScrollElementBackward = (): boolean => {
      if (position === 'top') return false;
      position = 'top';
      ui.resourceIds.set(addressTypeId, [element('Work')]);
      return true;
    };
    ui.onScrollElementForward = (): boolean => {
      if (position === 'middle') return false;
      position = 'middle';
      ui.resourceIds.set(addressTypeId, [element('Home')]);
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Work', 'Home']);
    expect(ui.sourceCalls).toBe(0);
  });

  it('falls back to one full source when a successful scroll keeps the same narrow labels', async () => {
    const ui = new FakeUi();
    const addressTypeId = 'com.grofers.customerapp:id/address_type';
    let scrolled = false;
    ui.sourceValue = '<hierarchy><node text="Your saved addresses"/>'
      + `<node resource-id="${addressTypeId}" text="Home"/></hierarchy>`;
    ui.exactTexts.set('Your saved addresses', [element('Your saved addresses')]);
    ui.resourceIds.set(addressTypeId, [element('Home')]);
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.onScrollElementBackward = (): boolean => false;
    ui.onScrollElementForward = (): boolean => {
      if (scrolled) return false;
      scrolled = true;
      ui.sourceValue = '<hierarchy><node text="Your saved addresses"/>'
        + `<node resource-id="${addressTypeId}" text="Work"/></hierarchy>`;
      return true;
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home', 'Work']);
    expect(ui.sourceCalls).toBe(1);
  });

  it('resolves one requested safe saved-address label with semantic scrolling', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    ui.offscreenTexts.add('Work');

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .listSavedAddresses('Work');

    expect(addresses).toEqual([{
      addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/),
      label: 'Work',
    }]);
    expect(ui.operations).toContain('scroll:Work');
    expect(ui.clickedTexts).toEqual([]);
    expect(ui.sourceCalls).toBe(1);
    expect(ui.exactTextQueries).toEqual([]);
  });

  it('rewinds before resolving an exact saved-address reference', async () => {
    const ui = new FakeUi();
    const topPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Work"/></hierarchy>';
    const middlePage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    const work = parseSavedAddresses(topPage)[0]!;
    ui.sourceValue = middlePage;
    ui.scrollableElements = [positioned('address-list', 0, 600, 1_080, 1_200)];
    ui.exactTexts.set('Work', [element('Work')]);
    ui.onScrollElementBackward = (): boolean => {
      if (ui.sourceValue === topPage) return false;
      ui.sourceValue = topPage;
      return true;
    };
    ui.onScrollElementForward = (): boolean => false;
    ui.onClick = ({ text }): void => {
      if (text === 'Work') ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/></hierarchy>';
    };

    const selected = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .selectSavedAddressReference(work.addressReference);

    expect(selected).toEqual(work);
    expect(ui.clickedTexts).toEqual(['Work']);
    expect(ui.operations).toContain('scroll:element-backward:address-list');
  });

  it('selects one saved address by its opaque reference', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('HOME - saved location', [element('HOME - saved location')]);
    ui.exactTexts.set('AO house', [element('AO house')]);
    ui.onClick = ({ text }): void => {
      if (text === 'HOME - saved location') {
        ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/><node resource-id="com.grofers.customerapp:id/address_label" text="AO house"/></hierarchy>';
      } else if (text === 'AO house') {
        ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="AO house - saved location"/></hierarchy>';
      }
    };
    const addresses = [
      { addressReference: `address_${'a'.repeat(32)}`, label: 'Home' },
      { addressReference: `address_${'b'.repeat(32)}`, label: 'AO house' },
    ];
    // References are deterministic hashes, so read the real opaque value first.
    const driver = new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined });
    const listed = await driver.listSavedAddresses();
    expect(listed.map(({ label }) => label)).toEqual(addresses.map(({ label }) => label));
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
    const selected = await driver.selectSavedAddressReference(listed[1]!.addressReference);

    expect(selected).toEqual(listed[1]);
    expect(ui.clickedTexts).toEqual(['HOME - saved location', 'HOME - saved location', 'AO house']);
    expect(JSON.stringify(selected)).not.toMatch(/Private|560035|selector|coordinate/i);
  });

  it('finds and selects a saved address by opaque reference after scrolling', async () => {
    const ui = new FakeUi();
    const firstPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    const secondPage = '<hierarchy><node text="Your saved addresses"/>'
      + '<node resource-id="com.grofers.customerapp:id/address_type" text="Work"/>'
      + '<node resource-id="com.grofers.customerapp:id/full_address" text="6th floor Kothari Arena"/></hierarchy>';
    ui.sourceValue = firstPage;
    ui.exactTexts.set('Work', [element('Work')]);
    ui.onScrollForward = (): boolean => {
      ui.sourceValue = secondPage;
      return true;
    };
    ui.onClick = ({ text }): void => {
      if (text === 'Work') {
        ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/>'
          + '<node content-desc="WORK - saved location"/></hierarchy>';
      }
    };
    const driver = new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined });
    const workReference = parseSavedAddresses(secondPage)[0]!.addressReference;

    const selected = await driver.selectSavedAddressReference(workReference);

    expect(selected).toEqual({ addressReference: workReference, label: 'Work' });
    expect(ui.clickedTexts).toEqual(['Work']);
    expect(ui.operations.filter((operation) => operation === 'scroll:forward')).toEqual(['scroll:forward']);
    expect(JSON.stringify(selected)).not.toMatch(/6th floor|Kothari Arena/);
  });

  it('fails safely when an opaque saved-address reference is unknown', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .selectSavedAddressReference(`address_${'f'.repeat(32)}`))
      .rejects.toThrow('Blinkit address_not_found failed');
  });

  it('does not mistake the bottom Home navigation tab for the address header', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="Home" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('Home', [element('Home')]);

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses())
      .rejects.toThrow('Blinkit address_list failed');

    expect(ui.operations).toEqual([]);
  });

  it('opens the current Blinkit address from its split non-clickable label', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME -" resource-id="com.grofers.customerapp:id/subtitle2_left_tag" clickable="false"/><node content-desc="Home tab" clickable="true"/></hierarchy>';
    ui.exactDescriptions.set('HOME -', [{ ...element('HOME -'), clickable: false }]);
    ui.onClick = ({ text }): void => {
      if (text === 'HOME -') {
        ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
      }
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses())
      .resolves.toEqual([{ addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'Home' }]);

    expect(ui.operations).toEqual(['tap:HOME -', 'scroll:forward', 'back']);
  });

  it('returns from live search results before listing saved addresses', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node content-desc="Search for atta, dal, coke and more"/><node content-desc="Voice search button"/><node content-desc="Filters"/><node content-desc="Sort"/></hierarchy>';
    ui.exactDescriptions.set('HOME - saved location', [element('HOME - saved location')]);
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
    };
    ui.onClick = ({ text }): void => {
      if (text === 'HOME - saved location') {
        ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
      }
    };

    const addresses = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses();

    expect(addresses.map(({ label }) => label)).toEqual(['Home']);
    expect(ui.operations).toEqual(['back', 'click:HOME - saved location', 'scroll:forward', 'back']);
  });

  it('returns from a product detail page before listing saved addresses', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node content-desc="Navigate up" clickable="true"/><node text="Select Unit"/><node resource-id="com.grofers.customerapp:id/info_text" text="₹25"/><node text="Search for atta, dal, coke and more"/></hierarchy>';
    ui.exactDescriptions.set('Navigate up', [element('Navigate up')]);
    ui.exactDescriptions.set('HOME - saved location', [element('HOME - saved location')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Navigate up') {
        ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
      } else if (text === 'HOME - saved location') {
        ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
      }
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses())
      .resolves.toEqual([{ addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'Home' }]);
    expect(ui.operations).toEqual(['click:Navigate up', 'click:HOME - saved location', 'scroll:forward', 'back']);
  });

  it('returns from order history before listing saved addresses', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="My orders"/><node text="No orders found"/></hierarchy>';
    ui.exactDescriptions.set('HOME - saved location', [element('HOME - saved location')]);
    ui.onBack = (): void => {
      ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="HOME - saved location" clickable="true"/></hierarchy>';
    };
    ui.onClick = ({ text }): void => {
      if (text === 'HOME - saved location') ui.sourceValue = '<hierarchy><node text="Your saved addresses"/><node resource-id="com.grofers.customerapp:id/address_type" text="Home"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).listSavedAddresses())
      .resolves.toEqual([{ addressReference: expect.stringMatching(/^address_[a-f0-9]{32}$/), label: 'Home' }]);
    expect(ui.operations).toEqual(['back', 'click:HOME - saved location', 'scroll:forward', 'back']);
  });

  it('enters login secrets ephemerally and never includes them in errors', async () => {
    const ui = new FakeUi();
    const phone = element('', 'phone');
    ui.sourceValue = '<hierarchy><node text="Log in or Sign up"/><node text="Continue"/></hierarchy>';
    ui.classNames.set('android.widget.EditText', [phone]);
    ui.exactTexts.set('Continue', [element('Continue')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Continue') ui.sourceValue = '<hierarchy><node text="Enter verification code"/></hierarchy>';
    };

    const driver = new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined });
    expect(await driver.beginLogin('9999999999')).toBe('otp_sent');
    expect(JSON.stringify(driver)).not.toContain('9999999999');

    ui.onSetValue = (): void => { throw new Error('provider leaked 123456'); };
    await expect(driver.submitOtp('123456')).rejects.toThrow('Blinkit otp_submit failed');
  });

  it('returns unavailable lines without substituting products', async () => {
    const ui = new FakeUi();
    ui.sourceValue = [
      '<hierarchy screen="checkout-review">',
      '<line product-id="crapido-1" name="Diet Coke" quantity="1" unit-price="40" line-total="40"/>',
      '<unavailable query="bread" reason="out_of_stock"/>',
      '<fee kind="handling" label="Handling charge" amount="5"/>',
      '<summary total="45" eta-minutes="9"/>',
      '<node text="PAY USING"/><node text="Place Order"/>',
      '</hierarchy>',
    ].join('');
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Cash on Delivery') ui.sourceValue += '<node content-desc="Cash on Delivery"/>';
    };

    const review = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).prepareCheckout(
      [{ query: 'bread', quantity: 1 }, { query: 'cola', quantity: 1 }],
      'home',
      'Home',
    );

    expect(review.unavailableItems).toEqual([{ query: 'bread', reason: 'out_of_stock' }]);
    expect(review.lines.some((line) => line.name.includes('substitute'))).toBe(false);
    expect(review.paymentMode).toBe('cod');
    expect(review.providerFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects inconsistent checkout arithmetic', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy screen="checkout-review"><line product-id="crapido-1" name="Diet Coke" quantity="2" unit-price="40" line-total="40"/><summary total="40"/><node text="PAY USING"/><node text="Place Order"/></hierarchy>';
    ui.exactTexts.set('Cash on Delivery', [element('Cash on Delivery')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Cash on Delivery') ui.sourceValue += '<node content-desc="Cash on Delivery"/>';
    };

    await expect(new BlinkitAndroidDriver(ui).prepareCheckout([{ query: 'cola', quantity: 2 }], 'home', 'Home'))
      .rejects.toThrow('Blinkit checkout_review failed');
  });

  it('extracts and reconciles exact terms from a live Android checkout screen', async () => {
    const ui = new FakeUi();
    ui.offscreenTexts.add('Bill details');
    ui.sourceValue = [
      '<hierarchy>',
      '<node text="Checkout"/>',
      '<node text="Delivery in 8 minutes"/>',
      '<node text="English Oven Brown Bread"/>',
      '<node text="400 g"/>',
      '<node text="quantity 1"/>',
      '<node text="₹65"/>',
      '<node text="Delivering to Home"/>',
      '<node text="Cash on Delivery"/>',
      '<node text="₹127"/>',
      '<node text="TOTAL"/>',
      '<node text="Bill details"/>',
      '<node text="Delivery charge"/>',
      '<node text="₹40"/>',
      '<node text="Handling charge ₹22"/>',
      '</hierarchy>',
    ].join('');
    const expected = {
      lines: [{
        productId: 'offer-bread',
        name: 'English Oven Brown Bread',
        quantity: 1,
        unitPrice: { currency: 'INR' as const, amount: 65 },
        lineTotal: { currency: 'INR' as const, amount: 65 },
      }],
      unavailableItems: [],
      fees: [],
      total: { currency: 'INR' as const, amount: 127 },
      addressReference: 'home',
      addressLabel: 'Home',
      paymentMode: 'cod' as const,
      etaMinutes: 8,
      providerFingerprint: 'a'.repeat(64),
    };

    const review = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined })
      .readCheckoutReview('home', 'Home', expected);

    expect(review.lines).toEqual(expected.lines);
    expect(review.fees).toEqual([
      { kind: 'delivery', label: 'Delivery charge', amount: { currency: 'INR', amount: 40 } },
      { kind: 'handling', label: 'Handling charge', amount: { currency: 'INR', amount: 22 } },
    ]);
    expect(review.total).toEqual({ currency: 'INR', amount: 127 });
    expect(review.etaMinutes).toBe(8);
    expect(review.providerFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('parses only current cart rows and excludes out-of-stock replacements and recommendations', () => {
    const source = [
      '<hierarchy>',
      '<node content-desc="2 items are not in stock" resource-id="com.grofers.customerapp:id/tv_title"/>',
      '<node text="Britannia Brown Bread" resource-id="com.grofers.customerapp:id/title"/>',
      '<node text="English Oven Brown Bread" resource-id="com.grofers.customerapp:id/title"/>',
      '<node content-desc="Add these items instead" resource-id="com.grofers.customerapp:id/tv_title"/>',
      '<node text="Replacement Bread" resource-id="com.grofers.customerapp:id/tv_name"/>',
      '<node text="Delivery in 8 minutes" resource-id="com.grofers.customerapp:id/title"/>',
      '<node text="Shipment of 2 items" resource-id="com.grofers.customerapp:id/subtitle"/>',
      '<node content-desc="Hocco Choco Brownie Ice Cream Tub" resource-id="com.grofers.customerapp:id/title"/>',
      '<node content-desc="quantity 1" resource-id="com.grofers.customerapp:id/tv_title"/>',
      '<node content-desc="₹280" resource-id="com.grofers.customerapp:id/total_mrp_price"/>',
      '<node content-desc="₹278" resource-id="com.grofers.customerapp:id/total_item_price"/>',
      '<node content-desc="Coca-Cola Original Taste Soft Drink - Pack of 8" resource-id="com.grofers.customerapp:id/title"/>',
      '<node content-desc="quantity 1" resource-id="com.grofers.customerapp:id/tv_title"/>',
      '<node content-desc="₹160" resource-id="com.grofers.customerapp:id/total_item_price"/>',
      '<node content-desc="You might also like" resource-id="com.grofers.customerapp:id/tv_title"/>',
      '<node text="Recommended Chips" resource-id="com.grofers.customerapp:id/tv_name"/>',
      '<node text="Delivering to Home" resource-id="com.grofers.customerapp:id/title"/>',
      '<node text="Select payment option" resource-id="com.grofers.customerapp:id/tv_action_text"/>',
      '</hierarchy>',
    ].join('');

    const cart = parseLiveAndroidCart(source);

    expect(cart).toMatchObject({
      lines: [
        { name: 'Hocco Choco Brownie Ice Cream Tub', quantity: 1, unitPrice: { amount: 278 }, lineTotal: { amount: 278 } },
        { name: 'Coca-Cola Original Taste Soft Drink - Pack of 8', quantity: 1, unitPrice: { amount: 160 }, lineTotal: { amount: 160 } },
      ],
      unavailableItems: [{ query: 'Britannia Brown Bread', reason: 'out_of_stock' }, { query: 'English Oven Brown Bread', reason: 'out_of_stock' }],
      subtotal: { currency: 'INR', amount: 438 },
      addressReference: 'saved:home', addressLabel: 'Home', paymentMode: 'unselected', etaMinutes: 8,
    });
    expect(JSON.stringify(cart)).not.toMatch(/Replacement Bread|Recommended Chips|280/);
  });

  it('parses Pay on Delivery as the selected COD method', () => {
    const source = liveCartSource([
      { name: "Lay's India's Magic Masala Potato Chips", quantity: 1, unitPrice: 25 },
    ]).replace('Select payment option', 'Pay on Delivery');

    expect(parseLiveAndroidCart(source)?.paymentMode).toBe('cod');
  });

  it('builds an exact checkout review from Pay on Delivery evidence', () => {
    const source = '<hierarchy><node text="Pay on Delivery"/><node text="Home"/><node text="Delivery in 8 minutes"/><node text="Chips"/><node text="quantity 1"/><node text="₹25"/><node text="₹37"/><node text="TOTAL"/><node text="Place Order"/></hierarchy>';

    const review = buildLiveAndroidReview(source, 'home', 'Home', {
      selectedItems: [{ offerId: 'offer-chips', title: 'Chips', quantity: 1, unitPrice: 25 }],
    });

    expect(review.paymentMode).toBe('cod');
    expect(review.total).toEqual({ currency: 'INR', amount: 37 });
  });

  it('derives exact residual charges when checkout exposes TOTAL without Bill details', () => {
    const source = '<hierarchy><node text="Cash on Delivery"/><node text="₹580"/><node text="TOTAL"/><node text="Place Order"/><node text="Delivery in 17 minutes"/><node text="Home"/><node text="Brown Bread"/><node text="quantity 2"/><node text="₹65"/><node text="Cola"/><node text="quantity 1"/><node text="₹438"/></hierarchy>';

    const review = buildLiveAndroidReview(source, 'saved:home', 'Home', { selectedItems: [
      { offerId: 'cart-bread', title: 'Brown Bread', quantity: 2, unitPrice: 65 },
      { offerId: 'cart-cola', title: 'Cola', quantity: 1, unitPrice: 438 },
    ] });

    expect(review.total).toEqual({ currency: 'INR', amount: 580 });
    expect(review.fees).toEqual([{ kind: 'other', label: 'Other provider charges', amount: { currency: 'INR', amount: 12 } }]);
    expect(review.paymentMode).toBe('cod');
  });

  it('accepts an exact line total when checkout omits the unit price', () => {
    const source = '<hierarchy><node text="Cash on Delivery"/><node text="Home"/><node text="Delivery in 8 minutes"/><node text="Lay\'s India\'s Magic Masala Potato Chips"/><node text="3"/><node text="₹75"/><node text="₹137"/><node text="TOTAL"/><node text="Place Order"/></hierarchy>';

    const review = buildLiveAndroidReview(source, 'home', 'Home', { selectedItems: [{
      offerId: 'offer-chips', title: "Lay's India's Magic Masala Potato Chips", quantity: 3, unitPrice: 25,
    }] });

    expect(review.lines[0]).toMatchObject({ quantity: 3, unitPrice: { amount: 25 }, lineTotal: { amount: 75 } });
    expect(review.total).toEqual({ currency: 'INR', amount: 137 });
    expect(review.fees).toEqual([{ kind: 'other', label: 'Other provider charges', amount: { currency: 'INR', amount: 62 } }]);
  });

  it('clicks exactly one exact Place Order control', async () => {
    const ui = new FakeUi();
    ui.exactTexts.set('Place Order', [element('Place Order')]);

    await new BlinkitAndroidDriver(ui).clickFinalOrderOnce();

    expect(ui.clickedTexts).toEqual(['Place Order']);
  });

  it('requires a provider reference before confirming an order', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Order is confirmed"/><order provider-reference="order-1"/></hierarchy>';
    expect(await new BlinkitAndroidDriver(ui).readConfirmation()).toEqual({ status: 'committed', providerReference: 'order-1' });

    ui.sourceValue = '<hierarchy><node text="Order is confirmed"/></hierarchy>';
    expect(await new BlinkitAndroidDriver(ui).readConfirmation()).toEqual({ status: 'unverified' });
  });

  it('reconciles only a uniquely fingerprinted order-history record', async () => {
    const ui = new FakeUi();
    ui.sourceValue = `<hierarchy><order provider-reference="order-1" ordered-at="2026-07-20T10:02:00.000Z" provider-fingerprint="${expectedOrder.checkout.providerFingerprint}"/></hierarchy>`;

    const orders = await new BlinkitAndroidDriver(ui).readOrderHistory(expectedOrder);

    expect(orders).toEqual([{ providerReference: 'order-1', orderedAt: '2026-07-20T10:02:00.000Z', checkout: expectedOrder.checkout }]);
    expect(ui.clickedTexts).toEqual([]);
  });

  it('uses read-only semantic navigation to reach order history', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="My orders"/></hierarchy>';
    ui.exactTexts.set('My orders', [element('My orders')]);
    ui.onClick = ({ text }): void => {
      if (text === 'My orders') {
        ui.sourceValue = `<hierarchy><node text="My orders"/><order provider-reference="order-1" ordered-at="2026-07-20T10:02:00.000Z" provider-fingerprint="${expectedOrder.checkout.providerFingerprint}"/></hierarchy>`;
      }
    };

    const orders = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readOrderHistory(expectedOrder);

    expect(orders).toHaveLength(1);
    expect(ui.clickedTexts).toEqual(['My orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });

  it('reads sanitized recent orders through semantic navigation only', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="My orders"/></hierarchy>';
    ui.exactTexts.set('My orders', [element('My orders')]);
    ui.onClick = ({ text }): void => {
      if (text === 'My orders') {
        ui.sourceValue = '<hierarchy><node text="My orders"/><node text="Order #BLK123456"/><node text="Delivered"/><node text="Ordered on 2026-07-22T15:30:00.000Z"/><node text="Brown Bread x 1"/><node text="Total ₹65"/><node text="Delivered to 42 Private Street, Bengaluru 560035"/></hierarchy>';
      }
    };

    const orders = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5);

    expect(orders).toEqual([expect.objectContaining({ orderReference: 'BLK123456', providerStatus: 'delivered', items: [{ name: 'Brown Bread', quantity: 1 }] })]);
    expect(JSON.stringify(orders)).not.toMatch(/42 Private|560035/);
    expect(ui.clickedTexts).toEqual(['My orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });

  it('opens Profile before My orders when the storefront exposes no order shortcut', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="Profile"/></hierarchy>';
    ui.exactTexts.set('Profile', [element('Profile')]);
    ui.exactTexts.set('My orders', [element('My orders')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Profile') ui.sourceValue = '<hierarchy><node text="Profile"/><node text="My orders"/></hierarchy>';
      if (text === 'My orders') {
        ui.sourceValue = '<hierarchy><node text="My orders"/><node text="Order #BLK123456"/><node text="Delivered"/><node text="Ordered on 2026-07-22T15:30:00.000Z"/><node text="Brown Bread x 1"/><node text="Total ₹65"/></hierarchy>';
      }
    };

    const orders = await new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5);

    expect(orders).toEqual([expect.objectContaining({ orderReference: 'BLK123456', providerStatus: 'delivered' })]);
    expect(ui.clickedTexts).toEqual(['Profile', 'My orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });

  it('uses the current Go to profile and Your orders accessibility labels', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node content-desc="Go to profile"/></hierarchy>';
    ui.exactDescriptions.set('Go to profile', [element('Go to profile')]);
    ui.clickableDescriptionAncestors.set('Go to profile', [positioned('profile-row', 0, 0, 300, 100)]);
    ui.exactTexts.set('Your orders', [element('Your orders')]);
    ui.onClick = ({ text }): void => {
      if (text === 'Go to profile') ui.sourceValue = '<hierarchy><node text="Profile"/><node text="Your orders"/></hierarchy>';
      if (text === 'Your orders') ui.sourceValue = '<hierarchy><node text="Your orders"/><node text="No orders"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5))
      .resolves.toEqual([]);
    expect(ui.clickedTexts).toEqual(['Go to profile', 'Your orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });

  it('recognizes the current Order History search surface without navigating away', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Navigate up"/><node text="Order History"/><node text="Search your grocery orders"/></hierarchy>';

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5))
      .resolves.toEqual([]);
    expect(ui.operations).toEqual([]);
  });

  it('recovers the manual saved-location prompt before opening recent orders', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Location permission not enabled"/><node text="Select location manually" clickable="true"/></hierarchy>';
    for (const label of ['Select location manually', 'Home', 'Profile', 'My orders']) {
      ui.exactTexts.set(label, [element(label)]);
    }
    ui.onClick = ({ text }): void => {
      if (text === 'Select location manually') {
        ui.sourceValue = '<hierarchy><node text="Select delivery location"/><node text="Your saved addresses"/><node text="Home" clickable="true"/></hierarchy>';
      }
      if (text === 'Home') ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="Profile"/></hierarchy>';
      if (text === 'Profile') ui.sourceValue = '<hierarchy><node text="Profile"/><node text="My orders"/></hierarchy>';
      if (text === 'My orders') ui.sourceValue = '<hierarchy><node text="My orders"/><node text="No orders"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5))
      .resolves.toEqual([]);
    expect(ui.clickedTexts).toEqual(['Select location manually', 'Home', 'Profile', 'My orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });

  it('selects Home from an already-open address picker before opening recent orders', async () => {
    const ui = new FakeUi();
    ui.sourceValue = '<hierarchy><node text="Select delivery location"/><node text="Your saved addresses"/><node text="Home" clickable="true"/></hierarchy>';
    for (const label of ['Home', 'Profile', 'My orders']) ui.exactTexts.set(label, [element(label)]);
    ui.onClick = ({ text }): void => {
      if (text === 'Home') ui.sourceValue = '<hierarchy><node text="Search for atta, dal, coke and more"/><node text="Profile"/></hierarchy>';
      if (text === 'Profile') ui.sourceValue = '<hierarchy><node text="Profile"/><node text="My orders"/></hierarchy>';
      if (text === 'My orders') ui.sourceValue = '<hierarchy><node text="My orders"/><node text="No orders"/></hierarchy>';
    };

    await expect(new BlinkitAndroidDriver(ui, { wait: async (): Promise<void> => undefined }).readRecentOrders(5))
      .resolves.toEqual([]);
    expect(ui.clickedTexts).toEqual(['Home', 'Profile', 'My orders']);
    expect(ui.clickedTexts).not.toContain('Place Order');
  });
});
