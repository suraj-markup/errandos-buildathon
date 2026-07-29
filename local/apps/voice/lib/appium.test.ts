import { describe, expect, it, vi } from 'vitest';
import {
  AppiumHttpClient,
  AppiumSessionPool,
} from '@errandos/provider-connectors';
import { BlinkitExecutionService } from './blinkit-execution';
import { openBlinkit } from './appium';

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify({ value }), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

describe('shared Blinkit Appium session', () => {
  it('activates Blinkit when the pooled session is healthy but backgrounded', async () => {
    let currentPackage = 'com.android.settings';
    const activateApp = vi.fn(async () => {
      currentPackage = 'com.grofers.customerapp';
    });
    const close = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      activateApp,
      close,
      currentPackage: vi.fn(async () => currentPackage),
    }));
    const pool = new AppiumSessionPool({ createSession });

    await expect(openBlinkit(
      pool as unknown as AppiumSessionPool<AppiumHttpClient>,
    )).resolves.toMatchObject({ ok: true });

    expect(createSession).toHaveBeenCalledOnce();
    expect(activateApp).toHaveBeenCalledOnce();
    await pool.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('serializes open_blinkit and following phone work on one healthy session', async () => {
    const close = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({
      close,
      currentPackage: vi.fn(async () => 'com.grofers.customerapp'),
    }));
    const pool = new AppiumSessionPool({ createSession });
    const driver = {
      currentScreen: vi.fn(async () => ({
        kind: 'search_results' as const,
        searchAction: 'available' as const,
      })),
      search: vi.fn(async () => []),
    };
    const service = new BlinkitExecutionService({
      appiumSessionPool:
        pool as unknown as AppiumSessionPool<AppiumHttpClient>,
      createDriver: () => driver as never,
      publishStatus: vi.fn(async () => false),
    });

    await Promise.all([
      openBlinkit(
        pool as unknown as AppiumSessionPool<AppiumHttpClient>,
      ),
      service.searchProducts('milk'),
    ]);

    expect(createSession).toHaveBeenCalledOnce();
    expect(driver.search).toHaveBeenCalledOnce();
    await pool.dispose();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an activation-failed session before a later acquisition', async () => {
    let activationAttempts = 0;
    const deletedSessions: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/session') && init?.method === 'POST') {
        return response({ sessionId: `session-${activationAttempts + 1}` });
      }
      if (url.endsWith('/execute/sync')) {
        activationAttempts += 1;
        return activationAttempts === 1
          ? response({ error: 'activation failed' }, 500)
          : response(true);
      }
      if (init?.method === 'DELETE') {
        deletedSessions.push(url.split('/session/')[1]!);
        return response(null);
      }
      if (url.endsWith('/appium/device/current_package')) {
        return response('com.grofers.customerapp');
      }
      return response(true);
    };
    const createSession = vi.fn(() => AppiumHttpClient.open({
      fetch: fetcher,
      requestTimeoutMs: 1_000,
    }));
    const pool = new AppiumSessionPool({ createSession });

    await expect(
      openBlinkit(pool as AppiumSessionPool<AppiumHttpClient>),
    ).rejects.toThrow('Appium app_activate failed');
    await expect(
      openBlinkit(pool as AppiumSessionPool<AppiumHttpClient>),
    ).resolves.toMatchObject({ ok: true });

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(deletedSessions).toEqual(['session-1']);
    await pool.dispose();
    expect(deletedSessions).toEqual(['session-1', 'session-2']);
  });
});
