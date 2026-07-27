#!/opt/node/bin/node

const endpoint = 'http://127.0.0.1:4723';
const rapidoPackage = 'com.rapido.passenger';
const session = await request('/session', {
  method: 'POST',
  body: {
    capabilities: {
      alwaysMatch: {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:appPackage': rapidoPackage,
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
      script: 'mobile: activateApp',
      args: [{ appId: rapidoPackage }],
    },
  });
  await wait(1_500);
  const source = await request(`/session/${sessionId}/source`);
  if (typeof source !== 'string') fail('app_unreadable');
  process.stdout.write(`rapido_state=${classify(source)}\n`);
} finally {
  await request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
}

function classify(source) {
  if (/enter (?:your )?(?:mobile|phone) number|mobile number|continue with phone/i.test(source)) return 'login_required';
  if (/enter (?:the )?(?:4|6)[-\s]?digit code|verification code|enter otp/i.test(source)) return 'otp_challenge';
  if (/where to\?|book a ride|select destination|search destination/i.test(source)) return 'active';
  if (/allow .* to access|while using the app|app permission/i.test(source)) return 'permission_required';
  if (/agree.*continue|terms (?:and|&) conditions|privacy policy/i.test(source)) return 'terms_required';
  if (/update.*required|update the app/i.test(source)) return 'update_required';
  return 'unknown';
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
  process.stderr.write(`rapido_state=${stage}\n`);
  process.exit(1);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
