#!/opt/node/bin/node

const endpoint = 'http://127.0.0.1:4723';
const rapidoPackage = 'com.rapido.passenger';
const allowedControls = [
  'Continue',
  'Next',
  'Proceed',
  'Login',
  'Log in',
  'Continue with phone',
  'Continue with phone number',
  'Login with phone',
  'Login with phone number',
  'Verify',
  'Resend OTP',
  'Resend code',
  'Send again',
  'Allow',
  'Allow while using app',
  'While using the app',
  'Only this time',
  'Enable location',
  'Turn on location',
  'Use current location',
  'Set location',
  'Got it',
  'Okay',
  'OK',
  'Skip',
  'Not now',
  'Maybe later',
  'Get started',
  'Try again',
  'Retry',
  'Close',
  'Dismiss',
  'Accept',
  'Agree',
  'Understood',
  'Continue anyway',
  'Agree and continue',
];

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
        'appium:shouldTerminateApp': false,
        'appium:settings[enableMultiWindows]': true,
        'appium:settings[enableTopmostWindowFromActivePackage]': true,
        'appium:settings[ignoreUnimportantViews]': false,
        'appium:settings[allowInvisibleElements]': true,
        'appium:settings[alwaysTraversableViewClasses]': 'androidx.compose.*',
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
  let source = await request(`/session/${sessionId}/source`);
  if (typeof source !== 'string') fail('app_unreadable');
  const initialState = classify(source);

  if (hasExactSemanticValue(source, 'Choose a phone number')) {
    await request(`/session/${sessionId}/back`, {
      method: 'POST',
      body: {},
    });
    await wait(500);
    source = await request(`/session/${sessionId}/source`);
    if (typeof source !== 'string') fail('phone_picker_dismissal_unreadable');
  }

  if (
    initialState === 'login_required'
    && !source.includes('class="android.widget.EditText"')
    && hasExactSemanticValue(source, 'Continue with phone number')
  ) {
    const entryGroups = await Promise.all([
      findElements('xpath', '//*[@text="Continue with phone number"]/ancestor::*[@clickable="true"][1]'),
      findElements('xpath', '//*[@content-desc="Continue with phone number"]/ancestor::*[@clickable="true"][1]'),
      findElements('accessibility id', 'Continue with phone number'),
      findElements('-android uiautomator', 'new UiSelector().text("Continue with phone number")'),
      findElements('xpath', '//*[@clickable="true"]'),
    ]);
    const candidateGroup = entryGroups.find((group) => group.length === 1);
    const targetId = candidateGroup?.map(readElementId).filter(Boolean)[0];
    if (typeof targetId !== 'string') fail('login_entry_ambiguous');
    await request(`/session/${sessionId}/element/${encodeURIComponent(targetId)}/click`, {
      method: 'POST',
      body: {},
    });
    await wait(1_000);
    source = await request(`/session/${sessionId}/source`);
    if (typeof source !== 'string') fail('phone_form_unreadable');
  }
  if (initialState === 'unknown' && hasExactSemanticValue(source, 'OK')) {
    const okGroups = await Promise.all([
      findElements('xpath', '//*[@text="OK"]/ancestor::*[@clickable="true"][1]'),
      findElements('xpath', '//*[@content-desc="OK"]/ancestor::*[@clickable="true"][1]'),
      findElements('-android uiautomator', 'new UiSelector().text("OK")'),
      findElements('accessibility id', 'OK'),
      findElements('xpath', '//*[@clickable="true"]'),
    ]);
    const candidateGroup = okGroups.find((group) => group.length === 1);
    const targetId = candidateGroup?.map(readElementId).filter(Boolean)[0];
    if (typeof targetId !== 'string') fail('ok_action_ambiguous');
    await request(`/session/${sessionId}/element/${encodeURIComponent(targetId)}/click`, {
      method: 'POST',
      body: {},
    });
    await wait(1_000);
    source = await request(`/session/${sessionId}/source`);
    if (typeof source !== 'string') fail('post_ok_screen_unreadable');
  }

  const editTextCount = (source.match(/class="android\.widget\.EditText"/g) ?? []).length;
  const clickableCount = (source.match(/clickable="true"/g) ?? []).length;
  const controls = allowedControls.filter((control) => hasExactSemanticValue(source, control));
  const nextGroups = await Promise.all([
    findElements('-android uiautomator', 'new UiSelector().text("Next")'),
    findElements('accessibility id', 'Next'),
    findElements('xpath', '//*[@text="Next"]/ancestor::*[@clickable="true"][1]'),
    findElements('xpath', '//*[@content-desc="Next"]/ancestor::*[@clickable="true"][1]'),
  ]);
  const verifyGroups = await Promise.all([
    findElements('-android uiautomator', 'new UiSelector().text("Verify")'),
    findElements('accessibility id', 'Verify'),
    findElements('xpath', '//*[@text="Verify"]/ancestor::*[@clickable="true"][1]'),
    findElements('xpath', '//*[@content-desc="Verify"]/ancestor::*[@clickable="true"][1]'),
  ]);
  const resendGroups = await Promise.all([
    findElements('-android uiautomator', 'new UiSelector().text("Resend OTP")'),
    findElements('accessibility id', 'Resend OTP'),
    findElements('xpath', '//*[@text="Resend OTP"]/ancestor::*[@clickable="true"][1]'),
    findElements('xpath', '//*[@content-desc="Resend OTP"]/ancestor::*[@clickable="true"][1]'),
  ]);
  const phoneFieldGroups = await Promise.all([
    findElements('-android uiautomator', 'new UiSelector().text("0000000000")'),
    findElements('accessibility id', '0000000000'),
    findElements('xpath', '//*[@text="0000000000"]'),
    findElements('xpath', '//*[@content-desc="0000000000"]'),
    findElements('-android uiautomator', 'new UiSelector().textContains("0000000000")'),
    findElements('xpath', '//*[contains(@text,"0000000000") or contains(@content-desc,"0000000000")]'),
  ]);
  const focusableGroups = await Promise.all([
    findElements('xpath', '//*[@focusable="true"]'),
    findElements('xpath', '//*[@focusable="true" and @clickable="true"]'),
    findElements('xpath', '//*[@focusable="true" and @enabled="true"]'),
    findElements('xpath', '//*[contains(@text,"your number") or contains(@content-desc,"your number")]'),
  ]);
  const relativePhoneGroups = await Promise.all([
    findElements('xpath', '//*[contains(@text,"your number") or contains(@content-desc,"your number")]/following::*[@focusable="true"][1]'),
    findElements('xpath', '//*[contains(@text,"your number") or contains(@content-desc,"your number")]/following::*[@clickable="true"][1]'),
    findElements('xpath', '//*[contains(@text,"your number") or contains(@content-desc,"your number")]/parent::*//*[@focusable="true"]'),
    findElements('xpath', '//*[contains(@text,"your number") or contains(@content-desc,"your number")]/parent::*//*[@clickable="true"]'),
  ]);
  const relativeOtpGroups = await Promise.all([
    findElements('xpath', '//*[contains(@text,"digit code") or contains(@content-desc,"digit code") or contains(@text,"verification code") or contains(@content-desc,"verification code") or contains(@text,"OTP") or contains(@content-desc,"OTP")]/following::*[@focusable="true"][1]'),
    findElements('xpath', '//*[contains(@text,"digit code") or contains(@content-desc,"digit code") or contains(@text,"verification code") or contains(@content-desc,"verification code") or contains(@text,"OTP") or contains(@content-desc,"OTP")]/following::*[@clickable="true"][1]'),
    findElements('xpath', '//*[contains(@text,"digit code") or contains(@content-desc,"digit code") or contains(@text,"verification code") or contains(@content-desc,"verification code") or contains(@text,"OTP") or contains(@content-desc,"OTP")]'),
  ]);
  const resendPatternGroups = await Promise.all([
    findElements('xpath', '//*[contains(@text,"Resend") or contains(@content-desc,"Resend")]'),
    findElements('xpath', '//*[contains(@text,"resend") or contains(@content-desc,"resend")]'),
    findElements('xpath', '//*[contains(@text,"again") or contains(@content-desc,"again")]'),
    findElements('xpath', '//*[contains(@text,"receive") or contains(@content-desc,"receive")]'),
    findElements('xpath', '//*[(contains(@text,"Resend") or contains(@content-desc,"Resend")) and @clickable="true"]'),
    findElements('xpath', '//*[contains(@text,"Resend") or contains(@content-desc,"Resend")]/ancestor::*[@clickable="true"][1]'),
  ]);

  process.stdout.write([
    `initial_state=${initialState}`,
    `rapido_state=${classify(source)}`,
    `edit_text_count=${editTextCount}`,
    `clickable_count=${clickableCount}`,
    `country_code_present=${hasExactSemanticValue(source, '+91')}`,
    `allowed_controls=${controls.length === 0 ? 'none' : controls.join(',')}`,
    `next_semantic_counts=${nextGroups.map((group) => group.length).join(',')}`,
    `verify_semantic_counts=${verifyGroups.map((group) => group.length).join(',')}`,
    `resend_semantic_counts=${resendGroups.map((group) => group.length).join(',')}`,
    `phone_field_semantic_counts=${phoneFieldGroups.map((group) => group.length).join(',')}`,
    `focusable_semantic_counts=${focusableGroups.map((group) => group.length).join(',')}`,
    `relative_phone_counts=${relativePhoneGroups.map((group) => group.length).join(',')}`,
    `relative_otp_counts=${relativeOtpGroups.map((group) => group.length).join(',')}`,
    `resend_pattern_counts=${resendPatternGroups.map((group) => group.length).join(',')}`,
    `category_signals=${categorySignals(source).join(',') || 'none'}`,
    `provider_error_signals=${providerErrorSignals(source).join(',') || 'none'}`,
  ].join('\n') + '\n');
} finally {
  await request(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
}

async function findElements(using, value) {
  const result = await request(`/session/${sessionId}/elements`, {
    method: 'POST',
    body: { using, value },
  });
  return Array.isArray(result) ? result : [];
}

function readElementId(value) {
  const id = value?.['element-6066-11e4-a52e-4f735466cecf'];
  return typeof id === 'string' ? id : undefined;
}

function hasExactSemanticValue(source, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:text|content-desc)="${escaped}"`, 'i').test(source);
}

function classify(source) {
  if (/what(?:'|&apos;)s your number|enter (?:your )?(?:mobile|phone) number|mobile number|continue with phone/i.test(source)) return 'login_required';
  if (/enter (?:the )?(?:4|6)[-\s]?digit code|verification code|enter otp/i.test(source)) return 'otp_challenge';
  if (/where to\?|book a ride|select destination|search destination/i.test(source)) return 'active';
  if (/allow .* to access|while using the app|app permission/i.test(source)) return 'permission_required';
  if (/agree.*continue|terms (?:and|&) conditions|privacy policy/i.test(source)) return 'terms_required';
  if (/update.*required|update the app/i.test(source)) return 'update_required';
  return 'unknown';
}

function categorySignals(source) {
  const categories = {
    location: /location|gps|precise|pickup|map/i,
    notification: /notification/i,
    profile: /profile|your name|email/i,
    terms: /terms|privacy|consent/i,
    language: /language/i,
    permission: /permission|allow .*access|while using/i,
    provider_error: /try again|something went wrong|network error|unable to/i,
    update: /update (?:the )?app|new version/i,
    safety: /safety|emergency/i,
  };
  return Object.entries(categories)
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name);
}

function providerErrorSignals(source) {
  const categories = {
    generic_error: /something went wrong|oops/i,
    retry_later: /try again|try (?:again )?later|after some time/i,
    network: /network|internet|connection|offline/i,
    unable: /unable to|could not|cannot/i,
    device: /device|security|root|emulator/i,
    unsupported: /unsupported|not supported|blocked/i,
  };
  return Object.entries(categories)
    .filter(([, pattern]) => pattern.test(source))
    .map(([name]) => name);
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
