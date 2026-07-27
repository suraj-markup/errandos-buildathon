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
        'appium:newCommandTimeout': 180,
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

  if (await appInstalled(sessionId)) {
    process.stdout.write('rapido_install=already_installed\n');
    process.exit(0);
  }
  const install = await findUniqueClickableLabel(sessionId, 'Install');
  if (install.length !== 1) fail(install.length === 0 ? 'install_action_unavailable' : 'install_action_ambiguous');
  await request(`/session/${sessionId}/element/${encodeURIComponent(install[0])}/click`, {
    method: 'POST',
    body: {},
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await wait(2_000);
    if (await appInstalled(sessionId)) {
      process.stdout.write('rapido_install=installed\n');
      process.exit(0);
    }
  }
  fail('install_timeout');
} finally {
  await request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
}

async function appInstalled(sessionId) {
  const result = await request(`/session/${sessionId}/execute/sync`, {
    method: 'POST',
    body: {
      script: 'mobile: queryAppState',
      args: [{ appId: rapidoPackage }],
    },
  });
  return typeof result === 'number' && result > 0;
}

async function findExactSemanticLabel(sessionId, text) {
  const byText = await request(`/session/${sessionId}/elements`, {
    method: 'POST',
    body: {
      using: '-android uiautomator',
      value: `new UiSelector().text(${JSON.stringify(text)})`,
    },
  });
  const byDescription = await request(`/session/${sessionId}/elements`, {
    method: 'POST',
    body: { using: 'accessibility id', value: text },
  });
  const byClickableAncestor = await request(`/session/${sessionId}/elements`, {
    method: 'POST',
    body: {
      using: 'xpath',
      value: "//*[@text='Install']/ancestor::*[@clickable='true'][1] | //*[@content-desc='Install']/ancestor::*[@clickable='true'][1]",
    },
  });
  const elements = [
    ...(Array.isArray(byText) ? byText : []),
    ...(Array.isArray(byDescription) ? byDescription : []),
    ...(Array.isArray(byClickableAncestor) ? byClickableAncestor : []),
  ];
  return [...new Set(elements.flatMap((element) => {
    const id = element?.['element-6066-11e4-a52e-4f735466cecf'];
    return typeof id === 'string' ? [id] : [];
  }))];
}

async function findUniqueClickableLabel(sessionId, text) {
  const candidates = await findExactSemanticLabel(sessionId, text);
  const clickable = [];
  for (const id of candidates) {
    const value = await request(`/session/${sessionId}/element/${encodeURIComponent(id)}/attribute/clickable`);
    if (value !== true && value !== 'true') continue;
    const rect = await request(`/session/${sessionId}/element/${encodeURIComponent(id)}/rect`);
    const key = rect && typeof rect === 'object'
      ? `${rect.x}:${rect.y}:${rect.width}:${rect.height}`
      : id;
    if (!clickable.some((entry) => entry.key === key)) clickable.push({ id, key });
  }
  return clickable.map(({ id }) => id);
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
  process.stderr.write(`rapido_install=${stage}\n`);
  process.exit(1);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
