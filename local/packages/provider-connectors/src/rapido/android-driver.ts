import { createHash } from 'node:crypto';
import type {
  RapidoAndroidRideReviewV1,
  RapidoAndroidTripV1,
  RapidoRideOptionV1,
} from '@errandos/contracts';
import type { AndroidUiPort, UiElement } from '../android/appium-client.js';

export type RapidoAuthenticationStatus = 'active' | 'login_required' | 'challenge_required';

export interface RapidoAndroidDriverOptions {
  wait?: (milliseconds: number) => Promise<void>;
}

export class RapidoAndroidDriver {
  private readonly wait: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly ui: AndroidUiPort,
    options: RapidoAndroidDriverOptions = {},
  ) {
    this.wait = options.wait ?? ((milliseconds): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  public async authStatus(): Promise<RapidoAuthenticationStatus> {
    return classifyRapidoAuthentication(await this.source('auth_status'));
  }

  public async beginLogin(phone: string): Promise<'otp_sent' | 'active'> {
    let initialSource = await this.source('begin_login');
    if (hasExactSemanticValue(initialSource, 'Choose a phone number')) {
      await this.ui.back();
      await this.wait(400);
      initialSource = await this.source('phone_picker_dismissal');
    }
    const initial = classifyRapidoAuthentication(initialSource);
    if (initial === 'active') return 'active';
    if (initial === 'challenge_required') throw new Error('Rapido existing_challenge failed');

    let fields = await this.ui.findClassName('android.widget.EditText');
    let phoneField: UiElement | undefined;
    let useFocusedTyping = false;
    if (fields.length === 0 && /what(?:'|&apos;)s your number/i.test(initialSource)) {
      const findPhoneField = this.ui.findFirstFocusableAfterTextContaining;
      if (!findPhoneField) throw new Error('Rapido phone_field_unavailable failed');
      const candidates = uniqueElements(await findPhoneField.call(this.ui, 'your number'));
      if (candidates.length !== 1) throw new Error('Rapido phone_field_ambiguous failed');
      await this.ui.click(candidates[0]!);
      await this.wait(250);
      fields = await this.ui.findClassName('android.widget.EditText');
      if (fields.length > 1) throw new Error('Rapido phone_field_ambiguous failed');
      phoneField = fields[0] ?? candidates[0]!;
      useFocusedTyping = fields.length === 0;
    }
    if (!phoneField && fields.length === 0) {
      await this.clickLoginEntry(initialSource);
      await this.wait(500);
      const phoneSource = await this.source('phone_form');
      if (classifyRapidoAuthentication(phoneSource) !== 'login_required' || !hasExactSemanticValue(phoneSource, '+91')) {
        throw new Error('Rapido phone_form_unavailable failed');
      }
      fields = await this.ui.findClassName('android.widget.EditText');
    }
    phoneField ??= fields.length === 1 ? fields[0] : undefined;
    if (!phoneField) throw new Error('Rapido phone_field_ambiguous failed');

    if (useFocusedTyping) {
      if (!this.ui.typeText) throw new Error('Rapido phone_input_unavailable failed');
      await this.ui.typeText(phone);
      await this.wait(250);
    } else {
      await this.replace(phoneField, phone);
    }
    await this.clickExact('Next');
    await this.wait(800);
    const status = await this.authStatus();
    if (status === 'challenge_required') return 'otp_sent';
    if (status === 'active') return 'active';
    throw new Error('Rapido otp_request_unverified failed');
  }

  public async submitOtp(otp: string): Promise<'active' | 'challenge_required'> {
    if (await this.authStatus() !== 'challenge_required') throw new Error('Rapido otp_screen_unavailable failed');
    let fields = await this.ui.findClassName('android.widget.EditText');
    let useFocusedTyping = false;
    if (fields.length === 0) {
      const findOtpField = this.ui.findFirstFocusableAfterAnyTextContaining;
      if (!findOtpField) throw new Error('Rapido otp_field_unavailable failed');
      const candidates = uniqueElements(await findOtpField.call(
        this.ui,
        ['digit code', 'verification code', 'OTP'],
      ));
      if (candidates.length !== 1) throw new Error('Rapido otp_fields_ambiguous failed');
      await this.ui.click(candidates[0]!);
      await this.wait(250);
      fields = await this.ui.findClassName('android.widget.EditText');
      if (fields.length > 1 && fields.length !== otp.length) {
        throw new Error('Rapido otp_fields_ambiguous failed');
      }
      useFocusedTyping = fields.length === 0;
    }
    if (useFocusedTyping) {
      if (!this.ui.typeText) throw new Error('Rapido otp_input_unavailable failed');
      await this.ui.typeText(otp);
      await this.wait(250);
    } else if (fields.length === 1) {
      await this.replace(fields[0]!, otp);
    } else if (fields.length === otp.length) {
      for (const [index, field] of fields.entries()) await this.replace(field, otp[index]!);
    } else {
      throw new Error('Rapido otp_fields_ambiguous failed');
    }

    const source = await this.source('otp_submit');
    for (const label of ['Verify', 'Next', 'Continue']) {
      if (hasExactSemanticValue(source, label)) {
        await this.clickExact(label);
        break;
      }
    }
    await this.wait(800);
    let status: RapidoAuthenticationStatus;
    try {
      status = await this.authStatus();
    } catch (error) {
      if (error instanceof Error && /Rapido device_verification_failed failed/.test(error.message)) throw error;
      const resultSource = await this.source('otp_result');
      if (!hasExactSemanticValue(resultSource, 'OK')) throw new Error('Rapido otp_result failed');
      await this.clickExact('OK');
      await this.wait(400);
      status = await this.authStatus();
    }
    return status === 'active' ? 'active' : 'challenge_required';
  }

  public async resendOtp(): Promise<'otp_sent' | 'active'> {
    const status = await this.authStatus();
    if (status === 'active') return 'active';
    if (status !== 'challenge_required') throw new Error('Rapido otp_screen_unavailable failed');
    const source = await this.source('otp_resend');
    const label = ['Resend OTP', 'Resend code', 'Send again']
      .find((candidate) => hasExactSemanticValue(source, candidate));
    if (label) {
      await this.clickExact(label);
    } else {
      const findResend = this.ui.findTextContaining;
      if (!findResend || !/resend/i.test(source)) throw new Error('Rapido otp_resend_unavailable failed');
      const targets = uniqueElements(await findResend.call(this.ui, 'Resend'));
      if (targets.length !== 1) throw new Error('Rapido otp_resend_ambiguous failed');
      await this.ui.tap(targets[0]!);
    }
    await this.wait(800);
    return await this.authStatus() === 'active' ? 'active' : 'otp_sent';
  }

  public async quoteRides(
    pickup: { query: string },
    dropoff: { query: string },
    limit: number,
  ): Promise<{
    pickupSummary: string;
    dropoffSummary: string;
    options: RapidoRideOptionV1[];
  }> {
    await this.enterRoute(pickup.query, dropoff.query);
    const options = parseRapidoRideOptions(await this.source('ride_quotes')).slice(0, limit);
    if (options.length === 0) throw new Error('Rapido no_rides_available failed');
    return {
      pickupSummary: pickup.query.trim(),
      dropoffSummary: dropoff.query.trim(),
      options,
    };
  }

  public async prepareRide(
    pickup: { query: string },
    dropoff: { query: string },
    selector: { rideOptionId?: string; rideType?: string },
    paymentMode: 'cash' | 'provider_saved',
  ): Promise<RapidoAndroidRideReviewV1> {
    const quote = await this.quoteRides(pickup, dropoff, 10);
    const options = quote.options.filter((option) => selector.rideOptionId
      ? option.rideOptionId === selector.rideOptionId
      : normalize(option.name) === normalize(selector.rideType ?? ''));
    if (options.length !== 1 || !options[0]!.available) throw new Error('Rapido ride_option_unavailable failed');
    const option = options[0]!;
    await this.clickExact(option.name);
    await this.wait(500);
    await this.selectPayment(paymentMode);
    return this.readRideReview({
      pickupSummary: quote.pickupSummary,
      dropoffSummary: quote.dropoffSummary,
      option,
      paymentMode,
    });
  }

  public async readRideReview(expected: {
    pickupSummary: string;
    dropoffSummary: string;
    option: RapidoRideOptionV1;
    paymentMode: 'cash' | 'provider_saved';
  }): Promise<RapidoAndroidRideReviewV1> {
    const source = await this.source('ride_review');
    const current = parseRapidoRideOptions(source).filter((option) => normalize(option.name) === normalize(expected.option.name));
    if (current.length !== 1) throw new Error('Rapido ride_review_unreadable failed');
    const option = current[0]!;
    const semantic = semanticValues(source).map(normalize);
    const paymentLabel = expected.paymentMode === 'cash' ? 'cash' : 'online';
    if (!semantic.some((value) => value === paymentLabel || value.includes(`${paymentLabel} payment`))) {
      throw new Error('Rapido payment_unavailable failed');
    }
    const base = {
      pickupReference: stableReference('pickup', expected.pickupSummary),
      pickupSummary: expected.pickupSummary,
      dropoffReference: stableReference('dropoff', expected.dropoffSummary),
      dropoffSummary: expected.dropoffSummary,
      rideOption: { id: option.rideOptionId, name: option.name },
      fareMinimum: option.fareMinimum,
      fareMaximum: option.fareMaximum,
      fees: option.fees,
      ...(option.pickupEtaMinutes !== undefined ? { pickupEtaMinutes: option.pickupEtaMinutes } : {}),
      ...(option.durationMinutes !== undefined ? { durationMinutes: option.durationMinutes } : {}),
      paymentMode: expected.paymentMode,
    };
    return { ...base, providerFingerprint: fingerprint(base) };
  }

  public async clickFinalRideOnce(rideType: string): Promise<void> {
    const source = await this.source('ride_commit');
    const labels = semanticValues(source).filter((value) => {
      const normalized = normalize(value);
      return normalized === 'confirm booking'
        || normalized === 'book ride'
        || normalized === `book ${normalize(rideType)}`;
    });
    const unique = [...new Set(labels)];
    if (unique.length !== 1) throw new Error('Rapido final_action_ambiguous failed');
    await this.clickExact(unique[0]!);
  }

  public async readRideConfirmation(): Promise<{ status: 'committed'; providerReference: string } | { status: 'unverified' }> {
    const source = await this.source('ride_confirmation');
    if (!/driver (?:is )?(?:on the way|assigned)|ride (?:booked|confirmed)|booking confirmed/i.test(source)) {
      return { status: 'unverified' };
    }
    const reference = /(?:booking|ride)\s*(?:id|number|#)\s*[:#-]?\s*([A-Z0-9-]{5,40})/i.exec(source)?.[1];
    return reference ? { status: 'committed', providerReference: reference } : { status: 'unverified' };
  }

  public async recentTrips(limit: number): Promise<RapidoAndroidTripV1[]> {
    let source = await this.source('recent_trips');
    if (!/your rides|my rides|ride history|booking\s*(?:id|number|#)/i.test(source)) {
      const label = ['Your rides', 'My rides', 'Ride history'].find((candidate) => hasExactSemanticValue(source, candidate));
      if (!label) throw new Error('Rapido recent_trips_unavailable failed');
      await this.clickExact(label);
      await this.wait(500);
      source = await this.source('recent_trips');
    }
    if (!/your rides|my rides|ride history|booking\s*(?:id|number|#)|no rides/i.test(source)) {
      throw new Error('Rapido recent_trips_unavailable failed');
    }
    return parseRapidoRecentTrips(source).slice(0, limit);
  }

  private async enterRoute(pickup: string, dropoff: string): Promise<void> {
    if (await this.authStatus() !== 'active') throw new Error('Rapido login_required failed');
    const entryLabels = ['Where to?', 'Select destination', 'Search destination'];
    const source = await this.source('route_entry');
    const label = entryLabels.find((candidate) => hasExactSemanticValue(source, candidate));
    if (!label) throw new Error('Rapido route_entry_unavailable failed');
    await this.clickExact(label);
    await this.wait(400);
    await this.enterLocation(0, pickup);
    await this.enterLocation(1, dropoff);
    await this.wait(700);
  }

  private async enterLocation(index: number, query: string): Promise<void> {
    const fields = [...await this.ui.findClassName('android.widget.EditText')]
      .sort((left, right) => left.rect.y - right.rect.y);
    if (fields.length !== 2) throw new Error('Rapido location_fields_ambiguous failed');
    await this.replace(fields[index]!, query);
    await this.wait(500);
    const targets = await this.semanticTargets(query);
    if (targets.length !== 1) throw new Error('Rapido location_result_ambiguous failed');
    await this.ui.click(targets[0]!);
    await this.wait(400);
  }

  private async selectPayment(paymentMode: 'cash' | 'provider_saved'): Promise<void> {
    const desired = paymentMode === 'cash' ? 'Cash' : 'Online';
    const source = await this.source('payment_selection');
    if (!hasExactSemanticValue(source, desired)) throw new Error('Rapido payment_unavailable failed');
    const targets = await this.semanticTargets(desired);
    if (targets.length === 1) {
      await this.ui.click(targets[0]!);
      await this.wait(300);
    }
  }

  private async clickLoginEntry(source: string): Promise<void> {
    const label = 'Continue with phone number';
    if (!hasExactSemanticValue(source, label)) throw new Error('Rapido login_entry_unavailable failed');
    const semanticTargets = await this.semanticTargets(label);
    if (semanticTargets.length === 1) {
      await this.ui.click(semanticTargets[0]!);
      return;
    }
    const findClickableElements = this.ui.findClickableElements;
    if (!findClickableElements) throw new Error('Rapido login_entry_ambiguous failed');
    const clickable = uniqueElements(await findClickableElements.call(this.ui));
    if (clickable.length !== 1) throw new Error('Rapido login_entry_ambiguous failed');
    await this.ui.click(clickable[0]!);
  }

  private async clickExact(label: string): Promise<void> {
    const targets = await this.semanticTargets(label);
    if (targets.length !== 1) throw new Error('Rapido semantic_target_ambiguous failed');
    await this.ui.click(targets[0]!);
  }

  private async semanticTargets(label: string): Promise<UiElement[]> {
    return uniqueElements([
      ...(await this.ui.findExactText(label)),
      ...(await this.ui.findExactDescription(label)),
      ...(await this.ui.findClickableAncestorOfExactText(label)),
      ...(await this.ui.findClickableAncestorOfExactDescription(label)),
    ].filter(({ clickable }) => clickable));
  }

  private async replace(field: UiElement, value: string): Promise<void> {
    await this.ui.clear(field);
    await this.ui.setValue(field, value);
    await this.wait(250);
  }

  private async source(stage: string): Promise<string> {
    try {
      const source = await this.ui.source();
      if (!source.trim()) throw new Error('empty');
      return source;
    } catch {
      throw new Error(`Rapido ${stage} failed`);
    }
  }
}

export function parseRapidoRideOptions(source: string): RapidoRideOptionV1[] {
  const values = semanticValues(source);
  const options: RapidoRideOptionV1[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index]!;
    if (!looksLikeRideName(name)) continue;
    const nearby = values.slice(index + 1, index + 7);
    const fareText = nearby.find((value) => /₹\s*[\d,]+(?:\.\d{1,2})?(?:\s*[-–]\s*₹?\s*[\d,]+(?:\.\d{1,2})?)?/.test(value));
    if (!fareText) continue;
    const fare = parseFare(fareText);
    if (!fare) continue;
    const etaText = nearby.find((value) => /\b\d+\s*(?:min|mins|minutes)\b/i.test(value));
    const eta = etaText ? Number(/\d+/.exec(etaText)?.[0]) : undefined;
    const unavailable = nearby.some((value) => /unavailable|sold out|not available/i.test(value));
    const normalizedName = name.trim();
    const rideOptionId = stableReference('option', `${normalizedName}:${fare.minimum}:${fare.maximum}`);
    options.push({
      rideOptionId,
      name: normalizedName,
      fareMinimum: { currency: 'INR', amount: fare.minimum },
      fareMaximum: { currency: 'INR', amount: fare.maximum },
      fees: [],
      ...(eta !== undefined && Number.isFinite(eta) ? { pickupEtaMinutes: eta } : {}),
      available: !unavailable,
    });
  }
  return [...new Map(options.map((option) => [option.rideOptionId, option])).values()];
}

export function parseRapidoRecentTrips(source: string): RapidoAndroidTripV1[] {
  const values = semanticValues(source);
  const trips: RapidoAndroidTripV1[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const reference = /(?:booking|ride)\s*(?:id|number|#)\s*[:#-]?\s*([A-Z0-9-]{5,40})/i.exec(values[index]!)?.[1];
    if (!reference) continue;
    const nearby = values.slice(index, index + 12);
    const route = nearby.find((value) => value.includes('→') || /\bto\b/i.test(value));
    const rideType = nearby.find(looksLikeRideName);
    const date = nearby.find((value) => Number.isFinite(Date.parse(value)));
    const status = nearby.find((value) => /completed|cancelled|ongoing|confirmed/i.test(value));
    if (!route || !rideType || !date || !status) continue;
    const [pickupSummary, dropoffSummary] = route.includes('→')
      ? route.split('→', 2).map((value) => value.trim())
      : route.split(/\bto\b/i, 2).map((value) => value.trim());
    if (!pickupSummary || !dropoffSummary) continue;
    const fareText = nearby.find((value) => /₹\s*[\d,]+(?:\.\d{1,2})?/.test(value));
    const fare = fareText ? parseFare(fareText) : undefined;
    trips.push({
      tripReference: reference,
      pickupSummary,
      dropoffSummary,
      rideType,
      ...(fare ? { fare: { currency: 'INR', amount: fare.maximum } } : {}),
      requestedAt: new Date(date).toISOString(),
      providerStatus: status,
    });
  }
  return trips;
}

export function classifyRapidoAuthentication(source: string): RapidoAuthenticationStatus {
  if (/unable/i.test(source)) {
    throw new Error('Rapido device_verification_failed failed');
  }
  if (/enter (?:the )?(?:4|6)[-\s]?digit code|verification code|enter otp|verify otp/i.test(source)) {
    return 'challenge_required';
  }
  if (/choose a phone number|what(?:'|&apos;)s your number|enter (?:your )?(?:mobile|phone) number|mobile number|continue with phone/i.test(source)) {
    return 'login_required';
  }
  if (/where to\?|book a ride|select destination|search destination/i.test(source)) return 'active';
  if (/allow .* to access|while using the app|agree.*continue|terms (?:and|&) conditions/i.test(source)) {
    return 'challenge_required';
  }
  throw new Error('Rapido unexpected_provider_screen failed');
}

function hasExactSemanticValue(source: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:text|content-desc)="${escaped}"`, 'i').test(source);
}

function uniqueElements(elements: UiElement[]): UiElement[] {
  return [...new Map(elements.map((element) => [element.id, element])).values()];
}

function semanticValues(source: string): string[] {
  const values: string[] = [];
  const pattern = /(?:text|content-desc)="([^"]+)"/g;
  for (const match of source.matchAll(pattern)) {
    const decoded = decodeXml(match[1]!).trim();
    if (decoded) values.push(...decoded.split(/\n+/).map((value) => value.trim()).filter(Boolean));
  }
  return values;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function looksLikeRideName(value: string): boolean {
  const normalized = normalize(value);
  if (normalized.length < 2 || normalized.length > 60) return false;
  return /\b(auto|bike|cab|mini|sedan|suv|prime|economy|luxury|share)\b/i.test(normalized)
    && !/\b(book|choose|select|search|ride id|booking id)\b/i.test(normalized);
}

function parseFare(value: string): { minimum: number; maximum: number } | undefined {
  const range = /₹\s*([\d,]+(?:\.\d{1,2})?)\s*[-–]\s*₹?\s*([\d,]+(?:\.\d{1,2})?)/.exec(value);
  if (range) {
    const minimum = Number(range[1]!.replace(/,/g, ''));
    const maximum = Number(range[2]!.replace(/,/g, ''));
    return Number.isFinite(minimum) && Number.isFinite(maximum) ? { minimum, maximum } : undefined;
  }
  const amounts = [...value.matchAll(/₹\s*([\d,]+(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1]!.replace(/,/g, '')))
    .filter(Number.isFinite);
  if (amounts.length === 0) return undefined;
  return { minimum: Math.min(...amounts), maximum: Math.max(...amounts) };
}

function stableReference(kind: string, value: string): string {
  return `${kind}_${createHash('sha256').update(normalize(value)).digest('hex').slice(0, 24)}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-IN').replace(/\s+/g, ' ');
}
