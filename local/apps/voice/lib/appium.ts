import {
  AppiumHttpClient,
  AppiumSessionPool,
} from '@errandos/provider-connectors';

const APPIUM_URL = process.env.APPIUM_URL ?? 'http://127.0.0.1:4723';
const DEVICE_UDID = process.env.ANDROID_DEVICE_UDID ?? '55221VDAQ000J1';
const BLINKIT_PACKAGE = 'com.grofers.customerapp';
export const BLINKIT_APPIUM_DEVICE_KEY = DEVICE_UDID;
type ActivatableAppiumClient = {
  activateApp(): Promise<void>;
};

type AppiumResponse<T> = {
  value: T;
};

const appiumGlobal = globalThis as typeof globalThis & {
  errandosBlinkitSessionPool?: AppiumSessionPool<AppiumHttpClient>;
};

async function appiumRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${APPIUM_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json() as AppiumResponse<T> & {
    value?: { error?: string; message?: string };
  };

  if (!response.ok || payload.value?.error) {
    throw new Error(
      payload.value?.message
        ?? `Appium request failed with ${response.status}.`,
    );
  }

  return payload.value as T;
}

export async function readPhoneStatus() {
  const status = await appiumRequest<Record<string, unknown>>('/status');
  return {
    appium: 'ready',
    device: DEVICE_UDID,
    details: status,
  };
}

export function blinkitAppiumSessionPool():
AppiumSessionPool<AppiumHttpClient> {
  appiumGlobal.errandosBlinkitSessionPool ??=
    new AppiumSessionPool<AppiumHttpClient>({
      createSession: () => AppiumHttpClient.open({
        appPackage: BLINKIT_PACKAGE,
        endpoint: APPIUM_URL,
        udid: DEVICE_UDID,
      }),
    });
  return appiumGlobal.errandosBlinkitSessionPool;
}

export async function openBlinkit(
  pool = blinkitAppiumSessionPool(),
) {
  await pool.withSession(BLINKIT_APPIUM_DEVICE_KEY, async (client) => {
    if ((await client.currentPackage()).trim() === BLINKIT_PACKAGE) return;
    await (client as unknown as ActivatableAppiumClient).activateApp();
    if ((await client.currentPackage()).trim() !== BLINKIT_PACKAGE) {
      throw new Error('Appium app_activate failed');
    }
  });

  return {
    action: 'open_blinkit',
    app: 'Blinkit',
    device: DEVICE_UDID,
    ok: true,
  };
}
