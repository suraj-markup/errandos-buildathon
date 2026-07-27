import { describe, expect, it } from 'vitest';
import {
  RapidoAndroidDriver,
  type AndroidUiPort,
  type UiElement,
} from '../src/index.js';

/* eslint-disable @typescript-eslint/explicit-function-return-type */

const element = (id: string, text?: string): UiElement => ({
  id,
  rect: { x: 0, y: 0, width: 100, height: 40 },
  ...(text ? { text } : {}),
  clickable: true,
});

function fakeUi(overrides: Partial<AndroidUiPort>): AndroidUiPort {
  const defaults: AndroidUiPort = {
    source: async () => '<hierarchy/>',
    findExactText: async () => [],
    findExactDescription: async () => [],
    findClickableAncestorOfExactText: async () => [],
    findClickableAncestorOfExactDescription: async () => [],
    findFirstFocusableAfterTextContaining: async () => [],
    findFirstFocusableAfterAnyTextContaining: async () => [],
    findTextContaining: async () => [],
    findClickableElements: async () => [],
    findResourceId: async () => [],
    findClassName: async () => [],
    scrollExactTextIntoView: async () => element('scroll'),
    scrollForward: async () => false,
    scrollBackward: async () => false,
    click: async () => undefined,
    tap: async () => undefined,
    setValue: async () => undefined,
    clear: async () => undefined,
    pressKey: async () => undefined,
    back: async () => undefined,
    readClipboardText: async () => '',
    clearClipboard: async () => undefined,
  };
  return { ...defaults, ...overrides };
}

describe('Rapido Android supervised login', () => {
  it('reports the sanitized device-verification blocker', async () => {
    const ui = fakeUi({
      source: async () => '<node text="Unable to verify this device"/>',
    });
    await expect(new RapidoAndroidDriver(ui).authStatus())
      .rejects.toThrow('Rapido device_verification_failed failed');
  });

  it('enters a phone only into the unique form and returns no private value', async () => {
    const values: string[] = [];
    const clicks: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => sourceRead++ === 0
        ? '<node text="Enter mobile number"/><node text="+91"/><node text="Next"/>'
        : '<node text="Enter 6 digit code"/>',
      findClassName: async () => [element('phone')],
      findExactText: async (text) => text === 'Next' ? [element('next', 'Next')] : [],
      clear: async () => undefined,
      setValue: async (_target, value) => { values.push(value); },
      click: async (target) => { clicks.push(target.id); },
    });
    const response = await new RapidoAndroidDriver(ui, { wait: async () => undefined }).beginLogin('9000000000');
    expect(response).toBe('otp_sent');
    expect(values).toEqual(['9000000000']);
    expect(clicks).toEqual(['next']);
    expect(JSON.stringify(response)).not.toContain('9000000000');
  });

  it('uses the sole clickable entry only after verifying the exact Rapido login label', async () => {
    const clicks: string[] = [];
    let sourceRead = 0;
    let fieldsRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node content-desc="Continue with phone number" clickable="true"/>',
        '<node text="Enter mobile number"/><node text="+91"/><node text="Next"/>',
        '<node text="Enter OTP"/>',
      ][sourceRead++]!,
      findClassName: async () => fieldsRead++ === 0 ? [] : [element('phone')],
      findClickableElements: async () => [element('entry')],
      findExactText: async (text) => text === 'Next' ? [element('next', 'Next')] : [],
      click: async (target) => { clicks.push(target.id); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).beginLogin('9000000000'))
      .resolves.toBe('otp_sent');
    expect(clicks).toEqual(['entry', 'next']);
  });

  it('dismisses the Android phone picker and uses the unique Rapido custom phone field', async () => {
    const clicks: string[] = [];
    const values: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node text="What&apos;s your number?"/><node text="Choose a phone number"/>',
        '<node text="What&apos;s your number?"/><node text="Next"/>',
        '<node text="Enter OTP"/>',
      ][sourceRead++]!,
      findFirstFocusableAfterTextContaining: async () => [element('phone-wrapper')],
      findClassName: async () => [],
      findExactText: async (text) => text === 'Next' ? [element('next', text)] : [],
      click: async (target) => { clicks.push(target.id); },
      typeText: async (value) => { values.push(value); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).beginLogin('9000000000'))
      .resolves.toBe('otp_sent');
    expect(clicks).toEqual(['phone-wrapper', 'next']);
    expect(values).toEqual(['9000000000']);
  });

  it('fails closed when the verified login-entry screen has multiple clickable targets', async () => {
    const ui = fakeUi({
      source: async () => '<node content-desc="Continue with phone number"/>',
      findClickableElements: async () => [element('one'), element('two')],
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).beginLogin('9000000000'))
      .rejects.toThrow('Rapido login_entry_ambiguous failed');
  });

  it('dismisses one exact invalid-OTP dialog and returns a reusable challenge state', async () => {
    const clicks: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node text="Enter OTP"/>',
        '<node text="Enter OTP"/><node text="Verify"/>',
        '<node text="OK"/>',
        '<node text="OK"/>',
        '<node text="Enter OTP"/>',
      ][sourceRead++]!,
      findClassName: async () => [
        element('otp-1'), element('otp-2'), element('otp-3'), element('otp-4'),
      ],
      findExactText: async (text) => text === 'Verify'
        ? [element('verify', 'Verify')]
        : text === 'OK'
          ? [element('ok', 'OK')]
          : [],
      click: async (target) => { clicks.push(target.id); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).submitOtp('1234'))
      .resolves.toBe('challenge_required');
    expect(clicks).toEqual(['verify', 'ok']);
  });

  it('types an OTP into the unique focused Rapido custom field', async () => {
    const clicks: string[] = [];
    const values: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node text="Enter 6 digit code"/>',
        '<node text="Enter 6 digit code"/><node text="Next"/>',
        '<node text="Where to?"/>',
      ][sourceRead++]!,
      findClassName: async () => [],
      findFirstFocusableAfterAnyTextContaining: async () => [element('otp-wrapper')],
      findExactText: async (text) => text === 'Next' ? [element('next', text)] : [],
      click: async (target) => { clicks.push(target.id); },
      typeText: async (value) => { values.push(value); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).submitOtp('123456'))
      .resolves.toBe('active');
    expect(clicks).toEqual(['otp-wrapper', 'next']);
    expect(values).toEqual(['123456']);
  });

  it('requests one fresh OTP through an exact semantic challenge control', async () => {
    const clicks: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node text="Enter OTP"/>',
        '<node text="Enter OTP"/><node text="Resend OTP"/>',
        '<node text="Enter OTP"/>',
      ][sourceRead++]!,
      findExactText: async (text) => text === 'Resend OTP' ? [element('resend', text)] : [],
      click: async (target) => { clicks.push(target.id); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).resendOtp())
      .resolves.toBe('otp_sent');
    expect(clicks).toEqual(['resend']);
  });

  it('taps one unique Rapido resend text span when it is not a clickable element', async () => {
    const taps: string[] = [];
    let sourceRead = 0;
    const ui = fakeUi({
      source: async () => [
        '<node text="Enter OTP"/>',
        '<node text="Did not receive it? Resend"/>',
        '<node text="Enter OTP"/>',
      ][sourceRead++]!,
      findTextContaining: async () => [element('resend-span')],
      tap: async (target) => { taps.push(target.id); },
    });
    await expect(new RapidoAndroidDriver(ui, { wait: async () => undefined }).resendOtp())
      .resolves.toBe('otp_sent');
    expect(taps).toEqual(['resend-span']);
  });
});
