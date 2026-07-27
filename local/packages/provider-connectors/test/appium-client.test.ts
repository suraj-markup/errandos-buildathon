import { describe, expect, it } from 'vitest';
import { AppiumHttpClient } from '../src/android/appium-client.js';

const jsonResponse = (value: unknown, status = 200): Response => new Response(JSON.stringify({ value }), { status, headers: { 'content-type': 'application/json' } });

describe('Appium HTTP client', () => {
  it('probes local Appium readiness without creating a device session', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return jsonResponse({ ready: true });
    };

    await expect(AppiumHttpClient.isReady({ fetch: fetcher })).resolves.toBe(true);
    expect(requests).toEqual(['http://127.0.0.1:4723/status']);
  });

  it('foregrounds Blinkit without restarting the persistent owner session', async () => {
    let sessionBody: unknown;
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (!url.endsWith('/session')) return jsonResponse(true);
      sessionBody = JSON.parse(String(init?.body));
      return jsonResponse({ sessionId: 'session-1' });
    };

    const client = await AppiumHttpClient.open({ fetch: fetcher });

    expect(sessionBody).toEqual(expect.objectContaining({
      capabilities: {
        alwaysMatch: expect.objectContaining({
          'appium:appPackage': 'com.grofers.customerapp',
          'appium:noReset': true,
          'appium:autoLaunch': false,
          'appium:dontStopAppOnReset': true,
          'appium:shouldTerminateApp': false,
          'appium:settings[enableMultiWindows]': true,
          'appium:settings[enableTopmostWindowFromActivePackage]': true,
          'appium:settings[ignoreUnimportantViews]': false,
          'appium:settings[allowInvisibleElements]': true,
          'appium:settings[alwaysTraversableViewClasses]': 'androidx.compose.*',
        }),
      },
    }));
    expect(JSON.stringify(sessionBody)).not.toContain('forceAppLaunch');
    expect(requests.some(({ url, init }) => {
      if (!url.endsWith('/execute/sync')) return false;
      return JSON.parse(String(init?.body)).script === 'mobile: activateApp';
    })).toBe(true);
    await client.close();
  });

  it('activates a semantic source rectangle with one Appium gesture', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith('/session') ? jsonResponse({ sessionId: 'session-1' }) : jsonResponse(true);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });

    await client.tapRect({ x: 20, y: 900, width: 1_040, height: 140 });

    const gesture = requests.find(({ url, init }) => {
      if (!url.endsWith('/execute/sync')) return false;
      const body = JSON.parse(String(init?.body)) as { script?: string; args?: unknown[] };
      return body.script === 'mobile: clickGesture' && JSON.stringify(body.args) === JSON.stringify([{ x: 540, y: 970 }]);
    });
    expect(gesture).toBeDefined();
    await client.close();
  });

  it('opens an official Blinkit link in the fixed Blinkit package', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith('/session') ? jsonResponse({ sessionId: 'session-1' }) : jsonResponse(true);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });

    await client.openBlinkitLink('https://blinkit.com/cart/share/example');

    const deepLink = requests.filter(({ url }) => url.endsWith('/execute/sync')).find(({ init }) => {
      const body = JSON.parse(String(init?.body)) as { script?: string };
      return body.script === 'mobile: deepLink';
    });
    expect(JSON.parse(String(deepLink?.init?.body))).toEqual({
      script: 'mobile: deepLink',
      args: [{
        url: 'https://blinkit.com/cart/share/example',
        waitForLaunch: false,
      }],
    });
    await client.close();
  });

  it('redacts provider response details from errors', async () => {
    const fetcher: typeof fetch = async () => jsonResponse({ error: 'unknown error', message: 'phone 9999999999 otp 123456' }, 500);
    let message = '';
    try {
      await AppiumHttpClient.open({ fetch: fetcher });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Appium session_start failed');
    expect(message).not.toMatch(/9999999999|123456/);
  });

  it('puts a bounded abort signal on every Appium request', async () => {
    let signal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      signal = init?.signal;
      return jsonResponse({ error: 'provider error' }, 500);
    };

    await expect(AppiumHttpClient.open({ fetch: fetcher, requestTimeoutMs: 1_000 }))
      .rejects.toThrow('Appium session_start failed');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    await expect(AppiumHttpClient.open({ fetch: fetcher, requestTimeoutMs: 999 }))
      .rejects.toThrow('Appium request timeout');
  });

  it('finds exact text and exposes only semantic element data', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/session')) return jsonResponse({ sessionId: 'session-1' });
      if (url.endsWith('/elements')) return jsonResponse([{ 'element-6066-11e4-a52e-4f735466cecf': 'element-1' }]);
      if (url.endsWith('/rect')) return jsonResponse({ x: 10, y: 20, width: 100, height: 40 });
      if (url.endsWith('/attribute/text')) return jsonResponse('Cash on Delivery');
      if (url.endsWith('/attribute/contentDescription')) return jsonResponse('');
      if (url.endsWith('/attribute/clickable')) return jsonResponse('true');
      return jsonResponse(null);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });
    const elements = await client.findExactText('Cash on Delivery');
    const descriptions = await client.findExactDescription('Search');
    const ancestors = await client.findClickableAncestorOfExactText('View cart');
    const descriptionAncestors = await client.findClickableAncestorOfExactDescription('Account');
    const scrollable = await client.findScrollableElements();
    await client.tap(elements[0]!);
    expect(elements).toEqual([{ id: 'element-1', rect: { x: 10, y: 20, width: 100, height: 40 }, text: 'Cash on Delivery', clickable: true }]);
    expect(descriptions).toHaveLength(1);
    expect(ancestors).toHaveLength(1);
    expect(descriptionAncestors).toHaveLength(1);
    expect(scrollable).toHaveLength(1);
    expect(String(requests.find(({ url }) => url.endsWith('/elements'))?.init?.body)).toContain('Cash on Delivery');
    expect(requests.filter(({ url }) => url.endsWith('/elements')).some(({ init }) => String(init?.body).includes('accessibility id'))).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith('/elements')).some(({ init }) => String(init?.body).includes('ancestor'))).toBe(true);
    expect(requests.filter(({ url }) => url.endsWith('/elements')).some(({ init }) => String(init?.body).includes('scrollable'))).toBe(true);
    expect(requests.some(({ url, init }) => url.endsWith('/execute/sync') && String(init?.body).includes('mobile: clickGesture'))).toBe(true);
    await client.close();
  });

  it('uses bounded viewport-relative gestures for forward and backward scrolling', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/session')) return jsonResponse({ sessionId: 'session-1' });
      if (url.endsWith('/window/rect')) return jsonResponse({ x: 0, y: 0, width: 1080, height: 2400 });
      if (url.endsWith('/execute/sync')) return jsonResponse(true);
      return jsonResponse(null);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });

    expect(await client.scrollForward()).toBe(true);
    const request = requests.find(({ url, init }) =>
      url.endsWith('/execute/sync') && String(init?.body).includes('mobile: swipeGesture'));
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      script: 'mobile: swipeGesture',
      args: [{ left: 54, top: 360, width: 972, height: 1680, direction: 'up', percent: 0.8 }],
    });
    expect(await client.scrollBackward()).toBe(true);
    const backward = requests.filter(({ url }) => url.endsWith('/execute/sync')).at(-1);
    expect(JSON.parse(String(backward?.init?.body))).toEqual({
      script: 'mobile: swipeGesture',
      args: [{ left: 54, top: 360, width: 972, height: 1680, direction: 'down', percent: 0.8 }],
    });
    await client.close();
  });

  it('uses the provider scroll result to stop element-scoped address scans at a boundary', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let scrollCalls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/session')) return jsonResponse({ sessionId: 'session-1' });
      if (url.endsWith('/elements')) return jsonResponse([{ 'element-6066-11e4-a52e-4f735466cecf': 'address-list' }]);
      if (url.endsWith('/rect')) return jsonResponse({ x: 0, y: 600, width: 1080, height: 1200 });
      if (url.endsWith('/attribute/text') || url.endsWith('/attribute/contentDescription')) return jsonResponse('');
      if (url.endsWith('/attribute/clickable')) return jsonResponse('false');
      if (url.endsWith('/execute/sync')) {
        const body = JSON.parse(String(init?.body)) as { script?: string };
        if (body.script === 'mobile: scrollGesture') {
          scrollCalls += 1;
          return jsonResponse(scrollCalls === 1);
        }
        return jsonResponse(true);
      }
      return jsonResponse(null);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });
    const container = (await client.findScrollableElements())[0]!;

    await expect(client.scrollElementForward(container)).resolves.toBe(true);
    await expect(client.scrollElementBackward(container)).resolves.toBe(false);

    const gestures = requests
      .filter(({ url }) => url.endsWith('/execute/sync'))
      .map(({ init }) => JSON.parse(String(init?.body)) as { script?: string; args?: Array<{ direction?: string }> })
      .filter(({ script }) => script === 'mobile: scrollGesture');
    expect(gestures.map(({ args }) => args?.[0]?.direction)).toEqual(['up', 'down']);
    await client.close();
  });

  it('reads and clears text clipboard content through local Appium only', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/session')) return jsonResponse({ sessionId: 'session-1' });
      if (url.endsWith('/appium/device/get_clipboard')) {
        return jsonResponse(Buffer.from('https://blinkit.com/cart/share/example').toString('base64'));
      }
      return jsonResponse(null);
    };
    const client = await AppiumHttpClient.open({ fetch: fetcher });

    await expect(client.readClipboardText()).resolves.toBe('https://blinkit.com/cart/share/example');
    await client.clearClipboard();

    expect(requests.some(({ url, init }) => (
      url.endsWith('/appium/device/get_clipboard')
      && JSON.parse(String(init?.body)).contentType === 'plaintext'
    ))).toBe(true);
    const clear = requests.find(({ url }) => url.endsWith('/appium/device/set_clipboard'));
    expect(JSON.parse(String(clear?.init?.body))).toEqual({
      content: '',
      contentType: 'plaintext',
    });
    await client.close();
  });

});
