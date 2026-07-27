export interface UiElement {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  text?: string;
  contentDescription?: string;
  clickable: boolean;
}

export interface AndroidUiPort {
  source(): Promise<string>;
  findExactText(text: string): Promise<UiElement[]>;
  findExactDescription(description: string): Promise<UiElement[]>;
  findClickableAncestorOfExactText(text: string): Promise<UiElement[]>;
  findClickableAncestorOfExactDescription(description: string): Promise<UiElement[]>;
  findFirstFocusableAfterTextContaining?(text: string): Promise<UiElement[]>;
  findFirstFocusableAfterAnyTextContaining?(texts: string[]): Promise<UiElement[]>;
  findTextContaining?(text: string): Promise<UiElement[]>;
  findClickableElements?(): Promise<UiElement[]>;
  findScrollableElements?(): Promise<UiElement[]>;
  findResourceId(id: string): Promise<UiElement[]>;
  findClassName(name: string): Promise<UiElement[]>;
  scrollExactTextIntoView(text: string): Promise<UiElement>;
  scrollForward(): Promise<boolean>;
  scrollBackward(): Promise<boolean>;
  scrollElementForward?(element: UiElement): Promise<boolean>;
  scrollElementBackward?(element: UiElement): Promise<boolean>;
  click(element: UiElement): Promise<void>;
  tap(element: UiElement): Promise<void>;
  tapRect?(rect: UiElement['rect']): Promise<void>;
  setValue(element: UiElement, value: string): Promise<void>;
  typeText?(value: string): Promise<void>;
  clear(element: UiElement): Promise<void>;
  pressKey(key: 'ENTER'): Promise<void>;
  back(): Promise<void>;
  openBlinkitLink?(url: string): Promise<void>;
  readClipboardText(): Promise<string>;
  clearClipboard(): Promise<void>;
}

export interface AppiumOpenOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  udid?: string;
  appPackage?: 'com.grofers.customerapp' | 'com.rapido.passenger';
  appActivity?: string;
}

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class AppiumHttpClient implements AndroidUiPort {
  private closed = false;

  private constructor(
    private readonly endpoint: string,
    private readonly sessionId: string,
    private readonly fetcher: typeof fetch,
    private readonly requestTimeoutMs: number,
    private readonly appPackage: 'com.grofers.customerapp' | 'com.rapido.passenger',
  ) {}

  public static async isReady(options: AppiumOpenOptions = {}): Promise<boolean> {
    const endpoint = (options.endpoint ?? 'http://127.0.0.1:4723').replace(/\/$/, '');
    const fetcher = options.fetch ?? fetch;
    const requestTimeoutMs = validRequestTimeout(options.requestTimeoutMs);
    try {
      const response = await fetcher(`${endpoint}/status`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) return false;
      const body = await response.json() as unknown;
      if (typeof body !== 'object' || body === null) return false;
      const value = (body as { value?: unknown }).value;
      return typeof value === 'object'
        && value !== null
        && (value as { ready?: unknown }).ready === true;
    } catch {
      return false;
    }
  }

  public static async open(options: AppiumOpenOptions = {}): Promise<AppiumHttpClient> {
    const endpoint = (options.endpoint ?? 'http://127.0.0.1:4723').replace(/\/$/, '');
    const fetcher = options.fetch ?? fetch;
    const requestTimeoutMs = validRequestTimeout(options.requestTimeoutMs);
    const appPackage = options.appPackage ?? 'com.grofers.customerapp';
    const appActivity = options.appActivity ?? (appPackage === 'com.grofers.customerapp' ? '.DEFAULT' : undefined);
    const value = await AppiumHttpClient.request(fetcher, endpoint, '/session', 'session_start', {
      method: 'POST',
      body: JSON.stringify({ capabilities: { alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        ...(options.udid ? { 'appium:udid': options.udid } : {}),
        'appium:appPackage': appPackage,
        ...(appActivity ? { 'appium:appActivity': appActivity } : {}),
        'appium:noReset': true,
        'appium:autoLaunch': false,
        'appium:dontStopAppOnReset': true,
        'appium:shouldTerminateApp': false,
        'appium:settings[enableMultiWindows]': true,
        'appium:settings[enableTopmostWindowFromActivePackage]': true,
        'appium:settings[ignoreUnimportantViews]': false,
        'appium:settings[allowInvisibleElements]': true,
        'appium:settings[alwaysTraversableViewClasses]': 'androidx.compose.*',
        'appium:newCommandTimeout': 120,
      } } }),
    }, requestTimeoutMs);
    const sessionId = typeof value === 'object' && value !== null && typeof (value as { sessionId?: unknown }).sessionId === 'string'
      ? (value as { sessionId: string }).sessionId
      : undefined;
    if (!sessionId) throw new Error('Appium session_start failed');
    const client = new AppiumHttpClient(endpoint, sessionId, fetcher, requestTimeoutMs, appPackage);
    try {
      await client.activateApp();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private async activateApp(): Promise<void> {
    await this.call('/execute/sync', 'app_activate', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: activateApp',
        args: [{ appId: this.appPackage }],
      }),
    });
  }

  public async source(): Promise<string> {
    const value = await this.call('/source', 'source_read');
    if (typeof value !== 'string') throw new Error('Appium source_read failed');
    return value;
  }

  public async findExactText(text: string): Promise<UiElement[]> {
    return this.findElements('-android uiautomator', `new UiSelector().text(${JSON.stringify(text)})`, 'find_exact_text');
  }

  public async findExactDescription(description: string): Promise<UiElement[]> {
    return this.findElements('accessibility id', description, 'find_exact_description');
  }

  public async findClickableAncestorOfExactText(text: string): Promise<UiElement[]> {
    const literal = xpathLiteral(text);
    return this.findElements('xpath', `//*[@text=${literal}]/ancestor::*[@clickable='true'][1]`, 'find_clickable_ancestor');
  }

  public async findClickableAncestorOfExactDescription(description: string): Promise<UiElement[]> {
    const literal = xpathLiteral(description);
    return this.findElements('xpath', `//*[@content-desc=${literal}]/ancestor::*[@clickable='true'][1]`, 'find_clickable_description_ancestor');
  }

  public async findFirstFocusableAfterTextContaining(text: string): Promise<UiElement[]> {
    const literal = xpathLiteral(text);
    return this.findElements(
      'xpath',
      `//*[contains(@text,${literal}) or contains(@content-desc,${literal})]/following::*[@focusable='true'][1]`,
      'find_following_focusable',
    );
  }

  public async findFirstFocusableAfterAnyTextContaining(texts: string[]): Promise<UiElement[]> {
    if (texts.length === 0 || texts.length > 5) throw new Error('Appium semantic_texts_invalid failed');
    const conditions = texts.flatMap((text) => {
      const literal = xpathLiteral(text);
      return [`contains(@text,${literal})`, `contains(@content-desc,${literal})`];
    }).join(' or ');
    return this.findElements(
      'xpath',
      `//*[${conditions}]/following::*[@focusable='true'][1]`,
      'find_following_focusable',
    );
  }

  public async findTextContaining(text: string): Promise<UiElement[]> {
    const literal = xpathLiteral(text);
    return this.findElements(
      'xpath',
      `//*[contains(@text,${literal}) or contains(@content-desc,${literal})]`,
      'find_text_containing',
    );
  }

  public async findClickableElements(): Promise<UiElement[]> {
    return this.findElements('xpath', '//*[@clickable="true"]', 'find_clickable_elements');
  }

  public async findScrollableElements(): Promise<UiElement[]> {
    return this.findElements('xpath', '//*[@scrollable="true"]', 'find_scrollable_elements');
  }

  public async findResourceId(id: string): Promise<UiElement[]> {
    return this.findElements('id', id, 'find_resource_id');
  }

  public async findClassName(name: string): Promise<UiElement[]> {
    return this.findElements('class name', name, 'find_class_name');
  }

  public async scrollExactTextIntoView(text: string): Promise<UiElement> {
    const selector = `new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text(${JSON.stringify(text)}))`;
    const elements = await this.findElements('-android uiautomator', selector, 'scroll_exact_text');
    if (elements.length !== 1) throw new Error('Appium scroll_exact_text failed');
    return elements[0]!;
  }

  public async scrollForward(): Promise<boolean> {
    return this.swipe('up');
  }

  public async scrollBackward(): Promise<boolean> {
    return this.swipe('down');
  }

  public async scrollElementForward(element: UiElement): Promise<boolean> {
    return this.scrollElement(element, 'up');
  }

  public async scrollElementBackward(element: UiElement): Promise<boolean> {
    return this.scrollElement(element, 'down');
  }

  private async scrollElement(element: UiElement, direction: 'up' | 'down'): Promise<boolean> {
    const insetX = Math.max(1, Math.round(element.rect.width * 0.05));
    const insetY = Math.max(1, Math.round(element.rect.height * 0.05));
    const canScrollMore = await this.call('/execute/sync', direction === 'up' ? 'scroll_element_forward' : 'scroll_element_backward', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: scrollGesture',
        args: [{
          left: element.rect.x + insetX,
          top: element.rect.y + insetY,
          width: Math.max(1, element.rect.width - insetX * 2),
          height: Math.max(1, element.rect.height - insetY * 2),
          direction,
          percent: 0.8,
        }],
      }),
    });
    return canScrollMore === true;
  }

  private async swipe(direction: 'up' | 'down'): Promise<boolean> {
    const rect = await this.call('/window/rect', 'window_rect');
    if (!isRect(rect)) throw new Error('Appium window_rect failed');
    await this.call('/execute/sync', 'scroll_forward', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: swipeGesture',
        args: [{
          left: Math.round(rect.width * 0.05),
          top: Math.round(rect.height * 0.15),
          width: Math.round(rect.width * 0.9),
          height: Math.round(rect.height * 0.7),
          direction,
          percent: 0.8,
        }],
      }),
    });
    return true;
  }

  public async click(element: UiElement): Promise<void> {
    await this.call(`/element/${encodeURIComponent(element.id)}/click`, 'element_click', { method: 'POST', body: '{}' });
  }

  public async tap(element: UiElement): Promise<void> {
    await this.call('/execute/sync', 'element_tap', {
      method: 'POST',
      body: JSON.stringify({ script: 'mobile: clickGesture', args: [{ elementId: element.id }] }),
    });
  }

  public async tapRect(rect: UiElement['rect']): Promise<void> {
    await this.call('/execute/sync', 'rect_tap', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: clickGesture',
        args: [{
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        }],
      }),
    });
  }

  public async typeText(value: string): Promise<void> {
    await this.call('/execute/sync', 'type_text', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: type',
        args: [{ text: value }],
      }),
    });
  }

  public async setValue(element: UiElement, value: string): Promise<void> {
    await this.call(`/element/${encodeURIComponent(element.id)}/value`, 'element_value', {
      method: 'POST',
      body: JSON.stringify({ text: value, value: [...value] }),
    });
  }

  public async clear(element: UiElement): Promise<void> {
    await this.call(`/element/${encodeURIComponent(element.id)}/clear`, 'element_clear', { method: 'POST', body: '{}' });
  }

  public async pressKey(key: 'ENTER'): Promise<void> {
    const keycode = key === 'ENTER' ? 66 : 0;
    await this.call('/appium/device/press_keycode', 'key_press', {
      method: 'POST',
      body: JSON.stringify({ keycode }),
    });
  }

  public async back(): Promise<void> {
    await this.call('/back', 'navigate_back', { method: 'POST', body: '{}' });
  }

  public async openBlinkitLink(url: string): Promise<void> {
    await this.call('/execute/sync', 'blinkit_link_open', {
      method: 'POST',
      body: JSON.stringify({
        script: 'mobile: deepLink',
        args: [{
          url,
          waitForLaunch: false,
        }],
      }),
    });
  }

  public async readClipboardText(): Promise<string> {
    const value = await this.call('/appium/device/get_clipboard', 'clipboard_read', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'plaintext' }),
    });
    if (typeof value !== 'string') throw new Error('Appium clipboard_read failed');
    try {
      return Buffer.from(value, 'base64').toString('utf8');
    } catch {
      throw new Error('Appium clipboard_read failed');
    }
  }

  public async clearClipboard(): Promise<void> {
    await this.call('/appium/device/set_clipboard', 'clipboard_clear', {
      method: 'POST',
      body: JSON.stringify({
        content: Buffer.from('', 'utf8').toString('base64'),
        contentType: 'plaintext',
      }),
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await AppiumHttpClient.request(
      this.fetcher,
      this.endpoint,
      `/session/${encodeURIComponent(this.sessionId)}`,
      'session_close',
      { method: 'DELETE', body: '{}' },
      this.requestTimeoutMs,
    ).catch(() => undefined);
  }

  private async findElements(using: string, value: string, stage: string): Promise<UiElement[]> {
    const raw = await this.call('/elements', stage, { method: 'POST', body: JSON.stringify({ using, value }) });
    if (!Array.isArray(raw)) throw new Error(`Appium ${stage} failed`);
    const elements: UiElement[] = [];
    for (const item of raw) {
      const id = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)[ELEMENT_KEY] : undefined;
      if (typeof id !== 'string') throw new Error(`Appium ${stage} failed`);
      elements.push(await this.describeElement(id, stage));
    }
    return elements;
  }

  private async describeElement(id: string, stage: string): Promise<UiElement> {
    const prefix = `/element/${encodeURIComponent(id)}`;
    const [rect, text, contentDescription, clickable] = await Promise.all([
      this.call(`${prefix}/rect`, stage),
      this.call(`${prefix}/attribute/text`, stage),
      this.call(`${prefix}/attribute/contentDescription`, stage),
      this.call(`${prefix}/attribute/clickable`, stage),
    ]);
    if (!isRect(rect)) throw new Error(`Appium ${stage} failed`);
    return {
      id,
      rect,
      ...(typeof text === 'string' && text ? { text } : {}),
      ...(typeof contentDescription === 'string' && contentDescription ? { contentDescription } : {}),
      clickable: clickable === true || clickable === 'true',
    };
  }

  private call(path: string, stage: string, init?: RequestInit): Promise<unknown> {
    return AppiumHttpClient.request(
      this.fetcher,
      this.endpoint,
      `/session/${encodeURIComponent(this.sessionId)}${path}`,
      stage,
      init,
      this.requestTimeoutMs,
    );
  }

  private static async request(
    fetcher: typeof fetch,
    endpoint: string,
    path: string,
    stage: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    try {
      const response = await fetcher(`${endpoint}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
      const body = await response.json() as { value?: unknown };
      const providerError = typeof body.value === 'object' && body.value !== null && 'error' in body.value;
      if (!response.ok || providerError) throw new Error('provider error');
      return body.value;
    } catch {
      throw new Error(`Appium ${stage} failed`);
    }
  }
}

function validRequestTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error('Appium request timeout must be an integer between 1000 and 120000 milliseconds');
  }
  return timeout;
}

function isRect(value: unknown): value is UiElement['rect'] {
  if (typeof value !== 'object' || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number');
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'").map((part) => `'${part}'`);
  return `concat(${parts.join(', "\'", ')})`;
}
