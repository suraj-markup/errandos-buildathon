#!/opt/node/bin/node

const endpoint = 'http://127.0.0.1:4723';
const rapidoPackage = 'com.rapido.passenger';
const playStorePackage = 'com.android.vending';
const session = await request('/session', {
  method: 'POST',
  body: {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': playStorePackage,
        'appium:noReset': true,
        'appium:autoLaunch': false,
        'appium:dontStopAppOnReset': true,
        'appium:newCommandTimeout': 120,
      },
    },
  },
});
const sessionId = session?.sessionId;
if (typeof sessionId !== 'string') fail('session_unavailable');

try {
  await request(`/session/${sessionId}/execute/sync`, {
    method: 'POST',
    body: {
      script: 'mobile: deepLink',
      args: [{
        url: `market://details?id=${rapidoPackage}`,
        package: playStorePackage,
        waitForLaunch: false,
      }],
    },
  });
  await wait(1_500);

  const source = await request(`/session/${sessionId}/source`);
  if (typeof source !== 'string') fail('play_store_unreadable');
  if (/(?:text|content-desc)="Open"/i.test(source)) {
    process.stdout.write('rapido_play_store=already_installed\n');
    process.exit(0);
  }
  if (/(?:text|content-desc)="Install"/i.test(source)) {
    process.stdout.write('rapido_play_store=compatible\n');
    process.exit(0);
  }
  if (/not compatible|isn.t available for your device/i.test(source)) fail('device_incompatible');
  if (/sign in|add a google account/i.test(source)) fail('play_store_login_required');
  if (/try again|check your connection|you.re offline/i.test(source)) fail('play_store_network_error');
  fail('compatibility_unverified');
} finally {
  await request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
}

async function request(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method: options.method ?? 'GET',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail('appium_request_failed');
  const body = await response.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || !('value' in body)) fail('appium_response_invalid');
  if (body.value?.error) fail('appium_operation_failed');
  return body.value;
}

function fail(stage) {
  process.stderr.write(`rapido_play_store=${stage}\n`);
  process.exit(1);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
