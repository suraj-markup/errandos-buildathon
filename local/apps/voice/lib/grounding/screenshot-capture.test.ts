import { describe, expect, it, vi } from 'vitest';
import type { ReadOnlyCapturePort } from './screenshot-capture';
import {
  captureReadOnlyScreenshot,
  captureSanitizedScreenshot,
} from './screenshot-capture';

const ordinarySource = `
  <hierarchy>
    <node package="com.grofers.customerapp" bounds="[0,80][1080,2400]" text="Milk" />
  </hierarchy>
`;

function port(overrides: Partial<ReadOnlyCapturePort> = {}): ReadOnlyCapturePort {
  return {
    close: vi.fn(async () => undefined),
    currentPackage: vi.fn(async () => 'com.grofers.customerapp'),
    orientation: vi.fn(async () => 'PORTRAIT' as const),
    screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
    source: vi.fn(async () => ordinarySource),
    windowRect: vi.fn(async () => ({
      x: 0,
      y: 0,
      width: 1080,
      height: 2400,
    })),
    ...overrides,
  };
}

describe('read-only screenshot capture', () => {
  it('captures in serialized ownership and returns orientation and provider content metadata', async () => {
    const calls: string[] = [];
    const device = port();
    const result = await captureReadOnlyScreenshot({
      now: () => 1_000,
      openPort: async () => {
        calls.push('open');
        return device;
      },
      serialize: async (work) => {
        calls.push('serialized-start');
        const value = await work();
        calls.push('serialized-end');
        return value;
      },
      setOverlaySuppressed: async (suppressed) => {
        calls.push(suppressed ? 'suppress' : 'restore');
        return true;
      },
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'captured',
      metadata: expect.objectContaining({
        capturedAt: 1_000,
        contentRect: { x: 0, y: 80, width: 1080, height: 2320 },
        orientation: 'PORTRAIT',
        packageName: 'com.grofers.customerapp',
        viewport: { x: 0, y: 0, width: 1080, height: 2400 },
      }),
    }));
    expect(calls).toEqual([
      'serialized-start',
      'suppress',
      'open',
      'restore',
      'serialized-end',
    ]);
    expect(device.screenshot).toHaveBeenCalledOnce();
    expect(device.source).toHaveBeenCalledTimes(2);
  });

  it('maps Appium failure without leaking provider details and restores the overlay', async () => {
    const suppression: boolean[] = [];
    const result = await captureReadOnlyScreenshot({
      openPort: async () => port({
        screenshot: vi.fn(async () => {
          throw new Error('Appium exposed private screen content');
        }),
      }),
      setOverlaySuppressed: async (value) => {
        suppression.push(value);
        return true;
      },
    });

    expect(result).toEqual({
      reason: 'appium_failure',
      status: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('private screen content');
    expect(suppression).toEqual([true, false]);
  });

  it('fails closed when overlay suppression or restoration is unavailable', async () => {
    const openPort = vi.fn(async () => port());
    await expect(captureReadOnlyScreenshot({
      openPort,
      setOverlaySuppressed: async () => false,
    })).resolves.toEqual({
      reason: 'overlay_suppression_failed',
      status: 'unavailable',
    });
    expect(openPort).not.toHaveBeenCalled();

    let calls = 0;
    await expect(captureReadOnlyScreenshot({
      openPort: async () => port(),
      setOverlaySuppressed: async () => ++calls === 1,
    })).resolves.toEqual({
      reason: 'overlay_restoration_failed',
      status: 'unavailable',
    });
  });

  it('rejects orientation and screen fingerprint races', async () => {
    const source = vi.fn()
      .mockResolvedValueOnce(ordinarySource)
      .mockResolvedValueOnce(ordinarySource.replace('Milk', 'Cart'));
    const result = await captureReadOnlyScreenshot({
      openPort: async () => port({ source }),
      setOverlaySuppressed: async () => true,
    });

    expect(result).toEqual({
      reason: 'screen_changed',
      status: 'unavailable',
    });

    const orientation = vi.fn()
      .mockResolvedValueOnce('PORTRAIT' as const)
      .mockResolvedValueOnce('LANDSCAPE' as const);
    await expect(captureReadOnlyScreenshot({
      openPort: async () => port({ orientation }),
      setOverlaySuppressed: async () => true,
    })).resolves.toEqual({
      reason: 'screen_changed',
      status: 'unavailable',
    });
  });

  it('returns only a safe fallback and wipes image bytes for restricted screens', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = '<hierarchy><node package="com.grofers.customerapp" bounds="[0,0][1080,2400]" text="Enter OTP" /></hierarchy>';
    const result = await captureSanitizedScreenshot({
      openPort: async () => port({
        screenshot: vi.fn(async () => bytes),
        source: vi.fn(async () => source),
      }),
      setOverlaySuppressed: async () => true,
    });

    expect(result).toEqual({
      privacy: expect.objectContaining({
        classes: ['otp'],
        restricted: true,
      }),
      status: 'restricted',
    });
    expect(JSON.stringify(result)).not.toMatch(/Enter OTP|image|source|1,2,3,4/);
  });
});
