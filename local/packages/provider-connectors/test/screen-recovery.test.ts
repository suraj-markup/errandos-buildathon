import { describe, expect, it } from 'vitest';
import type { AndroidUiPort, UiElement } from '../src/android/appium-client.js';
import {
  BoundedScreenRecovery,
  KnownScreenRecoveryPlanner,
  sanitizeRecoveryElements,
  type ScreenRecoveryPlanner,
} from '../src/android/screen-recovery.js';

const button = (text: string): UiElement => ({ id: text, text, clickable: true, rect: { x: 1, y: 1, width: 20, height: 10 } });

class Ui implements AndroidUiPort {
  public sources: string[] = [];
  public clicks: string[] = [];
  public backs = 0;
  public textTargets = true;
  public descriptionAncestors = new Map<string, UiElement[]>();
  public async source(): Promise<string> { return this.sources.shift() ?? '<hierarchy/>'; }
  public async findExactText(text: string): Promise<UiElement[]> { return this.textTargets ? [button(text)] : []; }
  public async findExactDescription(): Promise<UiElement[]> { return []; }
  public async findClickableAncestorOfExactText(): Promise<UiElement[]> { return []; }
  public async findClickableAncestorOfExactDescription(description: string): Promise<UiElement[]> { return this.descriptionAncestors.get(description) ?? []; }
  public async findResourceId(): Promise<UiElement[]> { return []; }
  public async findClassName(): Promise<UiElement[]> { return []; }
  public async scrollExactTextIntoView(): Promise<UiElement> { throw new Error('unused'); }
  public async scrollForward(): Promise<boolean> { return false; }
  public async scrollBackward(): Promise<boolean> { return false; }
  public async click(element: UiElement): Promise<void> { this.clicks.push(element.text ?? ''); }
  public async tap(element: UiElement): Promise<void> { this.clicks.push(element.text ?? ''); }
  public async setValue(): Promise<void> {}
  public async clear(): Promise<void> {}
  public async pressKey(): Promise<void> {}
  public async back(): Promise<void> { this.backs += 1; }
  public async readClipboardText(): Promise<string> { return ''; }
  public async clearClipboard(): Promise<void> {}
}

describe('bounded screen recovery', () => {
  it('dismisses a known review overlay and stops at the expected stage', async () => {
    const ui = new Ui();
    ui.sources = [
      '<hierarchy><node text="Enjoying Blinkit?" clickable="false"/><node text="Not now" clickable="true"/><node text="Submit" clickable="true"/></hierarchy>',
      '<hierarchy><node text="Search for atta, dal, coke and more" clickable="true"/></hierarchy>',
    ];
    const recovery = new BoundedScreenRecovery(ui, new KnownScreenRecoveryPlanner(), { wait: async (): Promise<void> => undefined });

    await expect(recovery.recover('authenticate', ['storefront'])).resolves.toBe('storefront');
    expect(ui.clicks).toEqual(['Not now']);
  });

  it('uses the saved-location path when the location permission modal appears', async () => {
    const ui = new Ui();
    ui.textTargets = false;
    ui.descriptionAncestors.set('Select location manually', [button('Select location manually')]);
    ui.descriptionAncestors.set('Home', [button('Home')]);
    ui.sources = [
      '<hierarchy><android.view.View text="" content-desc="Location permission not enabled" clickable="false"/><android.view.View text="" content-desc="Enable device location" clickable="false"/><android.view.View text="" content-desc="Select location manually" clickable="false"/></hierarchy>',
      '<hierarchy><node text="Select delivery location"/><node text="Your saved addresses"/><node content-desc="Home" clickable="false"/></hierarchy>',
      '<hierarchy><node text="Search for atta, dal, coke and more" clickable="true"/></hierarchy>',
    ];
    const recovery = new BoundedScreenRecovery(ui, new KnownScreenRecoveryPlanner(), { wait: async (): Promise<void> => undefined });

    await expect(recovery.recover('search', ['storefront'])).resolves.toBe('storefront');
    expect(ui.clicks).toEqual(['Select location manually', 'Home']);
  });

  it('lets a fallback planner reason over sanitized semantic elements only', async () => {
    let observed = '';
    const fallback: ScreenRecoveryPlanner = { plan: async (observation) => { observed = JSON.stringify(observation); return { kind: 'stop' }; } };
    const ui = new Ui();
    ui.sources = ['<hierarchy><node text="Order AB12-9999" clickable="false"/><node text="Continue" clickable="true"/><node text="9999999999" clickable="false"/></hierarchy>'];

    await new BoundedScreenRecovery(ui, new KnownScreenRecoveryPlanner(fallback), { wait: async (): Promise<void> => undefined }).recover('checkout', ['checkout']);

    expect(observed).toContain('Continue');
    expect(observed).not.toMatch(/AB12-9999|9999999999|<node|bounds|coordinate/i);
  });

  it('rejects invented handles and enforces the action bound', async () => {
    const ui = new Ui();
    ui.sources = ['<hierarchy><node text="Continue" clickable="true"/></hierarchy>'];
    const planner: ScreenRecoveryPlanner = { plan: async () => ({ kind: 'activate', handle: 'invented' }) };

    await expect(new BoundedScreenRecovery(ui, planner, { maxActions: 1, wait: async (): Promise<void> => undefined }).recover('checkout', ['checkout']))
      .resolves.toBe('unknown');
    expect(ui.clicks).toEqual([]);
  });

  it('redacts sensitive labels before planning', () => {
    expect(sanitizeRecoveryElements('<node text="OTP 123456" clickable="false"/><node text="me@example.com" clickable="false"/>'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ label: 'OTP [redacted]' }), expect.objectContaining({ label: '[redacted]' })]));
  });
});
