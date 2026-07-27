import { createHash } from 'node:crypto';
import { AndroidCheckoutReviewSchemaV1, AndroidImportedCartSchemaV1, AndroidSharedCartSchemaV1, BlinkitShareUrlSchemaV1, type AndroidCartReviewV1, type AndroidCheckoutReviewV1, type AndroidCurrentScreenV1, type AndroidExpectedCheckoutV1, type AndroidImportedCartV1, type AndroidRecentOrderV1, type AndroidSavedAddressV1, type AndroidSharedCartV1, type BlinkitCartImportBehaviorV1 } from '@errandos/contracts';
import type { AndroidUiPort, UiElement } from '../android/appium-client.js';
import { BoundedScreenRecovery, KnownScreenRecoveryPlanner, type ScreenRecoveryPort } from '../android/screen-recovery.js';
import type { AndroidOrderCandidate } from './android-commit.js';
import { detectBlinkitAndroidStage, type BlinkitAndroidStage } from './android-stage.js';
import { classifyBlinkitAndroidScreen } from './android-screen.js';
import { buildLiveAndroidReview, hasCashOnDeliveryEvidence, parseAndroidOrderCandidates, parseLiveAndroidCart, type LiveReviewEvidence, type SelectedCheckoutItem } from './android-review.js';
import { parseRecentOrders, parseSavedAddresses, savedAddressFromLabel } from './android-safe-reads.js';
import { BlinkitCheckoutBlockedError, parseCodMinimumConstraint } from './android-constraints.js';

export interface RequestedItem {
  query: string;
  quantity: number;
  offerId?: string | undefined;
}

export interface AndroidSearchOffer {
  offerId: string;
  title: string;
  packSize?: string;
  price: { currency: 'INR'; amount: number };
  available: boolean;
  imageUrl?: string;
}

interface AndroidSearchCandidate extends AndroidSearchOffer {
  providerLocator: string;
}

export interface BlinkitAndroidDriverOptions {
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  recovery?: ScreenRecoveryPort;
}

type AttributeMap = Record<string, string>;

const money = (amount: number): { currency: 'INR'; amount: number } => ({ currency: 'INR', amount });
const minor = (amount: number): number => Math.round(amount * 100);
const SAVED_ADDRESS_STAGNANT_PAGE_LIMIT = 1;
const SAVED_ADDRESS_RESOURCE_IDS = [
  'com.grofers.customerapp:id/address_type',
  'com.grofers.customerapp:id/address_label',
  'com.grofers.customerapp:id/address_tag',
  'com.grofers.customerapp:id/location_title',
] as const;
const savedAddressPageSignature = (addresses: readonly AndroidSavedAddressV1[]): string => addresses
  .map(({ addressReference }) => addressReference)
  .sort()
  .join('|');

export class BlinkitAndroidDriver {
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly recovery: ScreenRecoveryPort;

  public constructor(private readonly ui: AndroidUiPort, options: BlinkitAndroidDriverOptions = {}) {
    this.wait = options.wait ?? ((milliseconds): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.pollAttempts = options.pollAttempts ?? 20;
    this.recovery = options.recovery ?? new BoundedScreenRecovery(ui, new KnownScreenRecoveryPlanner(), { wait: this.wait });
  }

  public async authStatus(): Promise<'active' | 'login_required' | 'challenge_required'> {
    let stage = (await this.waitForRecognizedScreen('auth_status')).stage;
    if (stage === 'review_prompt' || stage === 'location_permission' || stage === 'unknown') {
      stage = await this.recovery.recover('authenticate', ['login_required', 'otp_requested', 'storefront', 'address_picker', 'checkout', 'payment_sheet', 'confirmed']);
    }
    if (stage === 'login_required') return 'login_required';
    if (stage === 'otp_requested' || stage === 'review_prompt' || stage === 'location_permission' || stage === 'unknown') return 'challenge_required';
    return 'active';
  }

  public async currentScreen(): Promise<AndroidCurrentScreenV1> {
    return classifyBlinkitAndroidScreen(await this.safeSource('current_screen'));
  }

  public async beginLogin(phone: string): Promise<'otp_sent' | 'active'> {
    try {
      if (await this.authStatus() === 'active') return 'active';
      const fields = await this.ui.findClassName('android.widget.EditText');
      if (fields.length !== 1) throw new Error('unexpected phone controls');
      await this.ui.clear(fields[0]!);
      await this.ui.setValue(fields[0]!, phone);
      await this.clickExactlyOne('Continue');
      return await this.waitForStage(['otp_requested', 'storefront']) === 'storefront' ? 'active' : 'otp_sent';
    } catch {
      throw new Error('Blinkit login_begin failed');
    }
  }

  public async submitOtp(otp: string): Promise<'active' | 'challenge_required'> {
    try {
      const fields = await this.ui.findClassName('android.widget.EditText');
      if (fields.length === 1) {
        await this.ui.clear(fields[0]!);
        await this.ui.setValue(fields[0]!, otp);
      } else if (fields.length === otp.length) {
        for (const [index, digit] of [...otp].entries()) await this.ui.setValue(fields[index]!, digit);
      } else {
        throw new Error('unexpected otp controls');
      }
      const stage = await this.waitForStage(['storefront', 'otp_requested']);
      return stage === 'storefront' ? 'active' : 'challenge_required';
    } catch {
      throw new Error('Blinkit otp_submit failed');
    }
  }

  public async selectSavedAddress(label: string): Promise<void> {
    let source = await this.returnToAddressEntry(await this.safeSource('address_select'));
    if (detectBlinkitAndroidStage(source) !== 'address_picker') {
      const labels = addressPickerEntryLabels(source);
      const openedByControl = await this.activateSemanticLabel(['Change address', 'Change location', 'Select delivery location'], source);
      if (!openedByControl && !await this.activateAddressHeader(labels)) {
        throw new Error('Blinkit address_select failed');
      }
      if (await this.waitForStage(['address_picker']) !== 'address_picker') throw new Error('Blinkit address_select failed');
      source = await this.safeSource('address_select');
    }
    let matches = await this.ui.findExactText(label);
    if (matches.length === 0) matches = [await this.ui.scrollExactTextIntoView(label)];
    if (matches.length !== 1) throw new Error('Blinkit address_select failed');
    await this.ui.click(matches[0]!);
    await this.waitForStage(['storefront']);
  }

  public async listSavedAddresses(requestedLabel?: string): Promise<AndroidSavedAddressV1[]> {
    if (requestedLabel) {
      const requestedAddress = savedAddressFromLabel(requestedLabel);
      if (!requestedAddress) return [];
      let source = await this.returnToAddressEntry(await this.safeSource('address_list'));
      if (detectBlinkitAndroidStage(source) !== 'address_picker') {
        const labels = addressPickerEntryLabels(source);
        const openedByControl = await this.activateSemanticLabel(['Change address', 'Change location', 'Select delivery location'], source);
        if (!openedByControl && !await this.activateAddressHeader(labels)) {
          throw new Error('Blinkit address_list failed');
        }
        if (await this.waitForStage(['address_picker']) !== 'address_picker') throw new Error('Blinkit address_list failed');
        source = await this.safeSource('address_list');
      }
      const visibleMatches = parseSavedAddresses(source)
        .filter(({ addressReference }) => addressReference === requestedAddress.addressReference);
      if (visibleMatches.length === 1) return visibleMatches;
      if (visibleMatches.length > 1) return [];
      try {
        await this.ui.scrollExactTextIntoView(requestedAddress.label);
        return [requestedAddress];
      } catch {
        return [];
      }
    }
    let initialAddresses: AndroidSavedAddressV1[];
    let opened = false;
    if (await this.savedAddressPickerIsVisible()) {
      initialAddresses = await this.readVisibleSavedAddresses();
    } else {
      let source = await this.returnToAddressEntry(await this.safeSource('address_list'));
      if (detectBlinkitAndroidStage(source) !== 'address_picker') {
        const labels = addressPickerEntryLabels(source);
        const openedByControl = await this.activateSemanticLabel(['Change address', 'Change location', 'Select delivery location'], source);
        if (!openedByControl && !await this.activateAddressHeader(labels)) {
          throw new Error('Blinkit address_list failed');
        }
        opened = true;
        if (await this.waitForStage(['address_picker']) !== 'address_picker') throw new Error('Blinkit address_list failed');
        source = await this.safeSource('address_list');
      }
      initialAddresses = parseSavedAddresses(source);
    }
    const visibleAddresses = await this.rewindSavedAddressBook(initialAddresses);
    const addresses = await this.collectSavedAddresses(visibleAddresses);
    if (opened) await this.ui.back().catch(() => undefined);
    return addresses;
  }

  public async selectSavedAddressReference(addressReference: string): Promise<AndroidSavedAddressV1> {
    let initialAddresses: AndroidSavedAddressV1[];
    if (await this.savedAddressPickerIsVisible()) {
      initialAddresses = await this.readVisibleSavedAddresses();
    } else {
      let source = await this.returnToAddressEntry(await this.safeSource('address_select'));
      if (detectBlinkitAndroidStage(source) !== 'address_picker') {
        const labels = addressPickerEntryLabels(source);
        const openedByControl = await this.activateSemanticLabel(['Change address', 'Change location', 'Select delivery location'], source);
        if (!openedByControl && !await this.activateAddressHeader(labels)) {
          throw new Error('Blinkit address_select failed');
        }
        if (await this.waitForStage(['address_picker']) !== 'address_picker') throw new Error('Blinkit address_select failed');
        source = await this.safeSource('address_select');
      }
      initialAddresses = parseSavedAddresses(source);
    }
    const visibleAddresses = await this.rewindSavedAddressBook(initialAddresses);
    const selected = (await this.collectSavedAddresses(visibleAddresses, addressReference))
      .find((address) => address.addressReference === addressReference);
    if (!selected) throw new Error('Blinkit address_not_found failed');
    await this.selectSavedAddress(selected.label);
    return selected;
  }

  private async collectSavedAddresses(
    initialAddresses: readonly AndroidSavedAddressV1[],
    targetAddressReference?: string,
  ): Promise<AndroidSavedAddressV1[]> {
    const addresses = new Map<string, AndroidSavedAddressV1>();
    let visibleAddresses = initialAddresses;
    let stagnantPages = 0;
    for (let page = 0; page < 12; page += 1) {
      const previousSize = addresses.size;
      for (const address of visibleAddresses) {
        if (!addresses.has(address.addressReference)) addresses.set(address.addressReference, address);
        if (addresses.size === 20) return [...addresses.values()];
      }
      if (targetAddressReference && addresses.has(targetAddressReference)) return [...addresses.values()];
      stagnantPages = addresses.size === previousSize ? stagnantPages + 1 : 0;
      if (stagnantPages >= SAVED_ADDRESS_STAGNANT_PAGE_LIMIT) break;
      if (!await this.advanceSavedAddressBook()) break;
      visibleAddresses = await this.readVisibleSavedAddresses(savedAddressPageSignature(visibleAddresses));
    }
    return [...addresses.values()];
  }

  private async rewindSavedAddressBook(initialAddresses: readonly AndroidSavedAddressV1[]): Promise<AndroidSavedAddressV1[]> {
    let visibleAddresses = [...initialAddresses];
    if (!this.ui.scrollElementBackward || !this.ui.findScrollableElements) return visibleAddresses;
    let previousSignature = savedAddressPageSignature(visibleAddresses);
    let stagnantPages = 0;
    for (let page = 0; page < 12; page += 1) {
      const containers = await this.ui.findScrollableElements().catch(() => []);
      let moved = false;
      for (const container of [...containers].sort((left, right) => (
        right.rect.width * right.rect.height - left.rect.width * left.rect.height
      ))) {
        const scrolled = await this.ui.scrollElementBackward(container).catch(() => false);
        if (!scrolled) continue;
        await this.wait(300);
        const previousAddresses = await this.readVisibleSavedAddresses(previousSignature);
        const signature = savedAddressPageSignature(previousAddresses);
        stagnantPages = signature === previousSignature ? stagnantPages + 1 : 0;
        visibleAddresses = previousAddresses;
        previousSignature = signature;
        moved = true;
        break;
      }
      if (!moved || stagnantPages >= SAVED_ADDRESS_STAGNANT_PAGE_LIMIT) break;
    }
    return visibleAddresses;
  }

  private async advanceSavedAddressBook(): Promise<boolean> {
    const containers = this.ui.findScrollableElements
      ? await this.ui.findScrollableElements().catch(() => [])
      : [];
    if (this.ui.scrollElementForward) {
      for (const container of [...containers].sort((left, right) => (
        right.rect.width * right.rect.height - left.rect.width * left.rect.height
      ))) {
        const scrolled = await this.ui.scrollElementForward(container).catch(() => false);
        if (!scrolled) continue;
        await this.wait(300);
        return true;
      }
    }
    const scrolled = await this.ui.scrollForward().catch(() => false);
    if (scrolled) await this.wait(300);
    return scrolled;
  }

  private async readVisibleSavedAddresses(previousSignature?: string): Promise<AndroidSavedAddressV1[]> {
    const addresses = new Map<string, AndroidSavedAddressV1>();
    for (const resourceId of SAVED_ADDRESS_RESOURCE_IDS) {
      const elements = await this.ui.findResourceId(resourceId).catch(() => []);
      for (const element of elements) {
        const address = savedAddressFromLabel(element.text ?? element.contentDescription ?? '');
        if (address && !addresses.has(address.addressReference)) addresses.set(address.addressReference, address);
      }
    }
    const narrowAddresses = [...addresses.values()];
    if (narrowAddresses.length > 0 && savedAddressPageSignature(narrowAddresses) !== previousSignature) {
      return narrowAddresses;
    }
    const sourceAddresses = parseSavedAddresses(await this.safeSource('address_list'));
    return sourceAddresses.length > 0 ? sourceAddresses : narrowAddresses;
  }

  private async savedAddressPickerIsVisible(): Promise<boolean> {
    const headings = await this.ui.findExactText('Your saved addresses').catch(() => []);
    return headings.length === 1;
  }

  private async returnToAddressEntry(initialSource: string): Promise<string> {
    let source = await this.returnFromCheckout(initialSource, 'address_list');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const stage = detectBlinkitAndroidStage(source);
      const screen = classifyBlinkitAndroidScreen(source);
      if (stage === 'address_picker') return source;
      if (stage === 'storefront' && screen.kind === 'home' && !isSearchSurface(source)) return source;
      if (stage === 'login_required' || stage === 'otp_requested') throw new Error('Blinkit address_list failed');
      if (stage === 'review_prompt' || stage === 'location_permission') {
        const recovered = await this.recovery.recover('storefront', ['storefront', 'address_picker']);
        if (recovered === 'storefront' || recovered === 'address_picker') return this.safeSource('address_list');
      } else if (screen.kind === 'product_detail') {
        const usedVisibleBack = await this.activateSemanticLabel(['Navigate up', 'Go back'], source);
        if (!usedVisibleBack) {
          await this.ui.back();
          await this.wait(500);
        }
      } else {
        await this.ui.back();
        await this.wait(500);
      }
      source = await this.safeSource('address_list');
    }
    throw new Error('Blinkit address_list failed');
  }

  public async selectCashOnDelivery(itemSubtotal?: number): Promise<void> {
    const initialSource = await this.safeSource('payment_select');
    this.throwIfCodMinimumBlocked(initialSource, itemSubtotal);
    if (detectBlinkitAndroidStage(initialSource) === 'checkout' && hasCashOnDeliveryEvidence(initialSource)) return;
    let matches = await this.cashOnDeliveryTargets();
    if (matches.length === 0) {
      const paymentSelectors: UiElement[] = [];
      for (const label of ['PAY USING', 'Select payment option']) {
        paymentSelectors.push(...await this.ui.findClickableAncestorOfExactText(label));
      }
      const uniquePaymentSelectors = uniqueElements(paymentSelectors);
      if (uniquePaymentSelectors.length === 1) {
        await this.ui.click(uniquePaymentSelectors[0]!);
        await this.wait(500);
        matches = await this.cashOnDeliveryTargets();
      } else if (uniquePaymentSelectors.length > 1 || !isPaymentSurface(await this.safeSource('payment_select'))) {
        throw new Error('Blinkit payment_open failed');
      }
    }
    if (matches.length === 0) {
      await this.ui.scrollExactTextIntoView('Pay On Delivery').catch(() => undefined);
      await this.wait(1_500);
      matches = await this.cashOnDeliveryTargets();
    }
    for (let attempt = 0; matches.length === 0 && attempt < 5; attempt += 1) {
      const canContinue = await this.ui.scrollForward().catch(() => false);
      await this.wait(1_500);
      matches = await this.cashOnDeliveryTargets();
      if (!canContinue && matches.length === 0) break;
    }
    const paymentSource = await this.safeSource('payment_select');
    this.throwIfCodMinimumBlocked(paymentSource, itemSubtotal);
    if (isCashOnDeliveryUnavailable(paymentSource)) {
      throw new BlinkitCheckoutBlockedError('cod_unavailable');
    }
    if (matches.length !== 1) throw new Error('Blinkit payment_target failed');
    await this.ui.tap(matches[0]!);
    try {
      await this.waitForStage(['checkout']);
    } catch {
      const stalled = await this.safeSource('payment_return');
      if (!isPaymentSurface(stalled)) throw new Error('Blinkit payment_return failed');
      await this.ui.back();
      await this.wait(500);
      try {
        await this.waitForStage(['checkout']);
      } catch {
        throw new Error('Blinkit payment_return failed');
      }
    }
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      const source = await this.safeSource('payment_select');
      this.throwIfCodMinimumBlocked(source, itemSubtotal);
      if (hasCashOnDeliveryEvidence(source)) return;
      await this.wait(500);
    }
    throw new Error('Blinkit payment_verify failed');
  }

  private throwIfCodMinimumBlocked(source: string, itemSubtotal?: number): void {
    if (itemSubtotal === undefined) return;
    const constraint = parseCodMinimumConstraint(source, itemSubtotal);
    if (constraint) throw new BlinkitCheckoutBlockedError('cod_minimum_not_met', constraint);
  }

  public async openCart(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (detectBlinkitAndroidStage(await this.safeSource('cart_open')) === 'checkout') return;
      const matches = await this.cartTargets();
      if (matches.length > 1) throw new Error('Blinkit cart_open failed');
      if (matches.length === 1) {
        await this.ui.click(matches[0]!);
        await this.wait(1_500);
        await this.waitForStage(['checkout'], 4);
        return;
      }
      if (attempt < 3) {
        await this.ui.back();
        await this.wait(500);
      }
    }
    throw new Error('Blinkit cart_open failed');
  }

  public async inspectCart(): Promise<AndroidCartReviewV1 | undefined> {
    try {
      let screen = await this.waitForRecognizedScreen('cart_inspect');
      let stage = screen.stage;
      if (stage === 'review_prompt' || stage === 'location_permission') {
        stage = await this.recovery.recover('storefront', ['storefront', 'checkout']);
        screen = { stage, source: await this.safeSource('cart_inspect') };
      }
      if (stage === 'storefront') {
        const semanticTargets = semanticTargetRects(screen.source, 'View cart');
        if (semanticTargets.length > 1) throw new Error('Blinkit cart_open failed');
        if (semanticTargets.length === 1 && this.ui.tapRect) {
          await this.ui.tapRect(semanticTargets[0]!);
        } else {
          const targets = await this.cartTargets();
          if (targets.length === 0) return undefined;
          if (targets.length > 1) throw new Error('Blinkit cart_open failed');
          await this.ui.click(targets[0]!);
        }
        await this.wait(1_500);
        screen = await this.waitForStageScreen(['checkout'], 4);
      } else {
        await this.openCart();
        screen = { stage: 'checkout', source: await this.safeSource('cart_inspect') };
      }
      return parseLiveAndroidCart(screen.source);
    } catch (error) {
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit cart_inspect failed');
    }
  }

  public async shareCart(): Promise<AndroidSharedCartV1> {
    let shareOpened = false;
    try {
      await this.openCart();
      const before = parseLiveAndroidCart(await this.safeSource('cart_share'));
      if (!before) throw new Error('Blinkit cart_share_empty failed');

      const source = await this.safeSource('cart_share');
      const shareLabels = semanticLabelsMatching(source, /(?:^|\s)share$/i);
      const directShareTargets: UiElement[] = [];
      for (const label of shareLabels) {
        directShareTargets.push(
          ...(await this.ui.findExactDescription(label)),
          ...(await this.ui.findExactText(label)),
        );
      }
      let uniqueShareTargets = uniqueElements(directShareTargets.filter(({ clickable }) => clickable));
      if (uniqueShareTargets.length === 0) {
        const ancestorShareTargets: UiElement[] = [];
        for (const label of shareLabels) {
          ancestorShareTargets.push(
            ...(await this.ui.findClickableAncestorOfExactDescription(label)),
            ...(await this.ui.findClickableAncestorOfExactText(label)),
          );
        }
        uniqueShareTargets = uniqueElements(ancestorShareTargets.filter(({ clickable }) => clickable));
      }
      if (uniqueShareTargets.length === 0) {
        uniqueShareTargets = uniqueElements((await this.ui.findResourceId('com.grofers.customerapp:id/right_tag'))
          .filter(({ clickable }) => clickable));
      }
      if (uniqueShareTargets.length !== 1) throw new Error('Blinkit cart_share_control failed');
      await this.ui.click(uniqueShareTargets[0]!);
      shareOpened = true;
      await this.wait(700);

      let shareSource = await this.safeSource('cart_share');
      if (hasExactSemanticLabel(shareSource, 'Share your cart')) {
        let confirmed = await this.activateSemanticLabel(['Share your cart'], shareSource);
        if (!confirmed) {
          const confirmationTargets = uniqueElements((await this.ui.findResourceId('com.grofers.customerapp:id/bottom_button'))
            .filter(({ clickable }) => clickable));
          if (confirmationTargets.length === 1) {
            await this.ui.click(confirmationTargets[0]!);
            await this.wait(500);
            confirmed = true;
          }
        }
        if (!confirmed) throw new Error('Blinkit cart_share_confirm failed');
        shareSource = await this.safeSource('cart_share');
      }

      let shareUrl = extractBlinkitShareUrl(shareSource);
      if (!shareUrl) {
        let copied = await this.activateSemanticLabel(['Copy link', 'Copy to clipboard', 'Copy'], shareSource);
        if (!copied) {
          const copyTargets = uniqueElements([
            ...(await this.ui.findResourceId('android:id/copy')),
            ...(await this.ui.findResourceId('android:id/chooser_copy_button')),
          ]
            .filter(({ clickable }) => clickable));
          if (copyTargets.length === 1) {
            await this.ui.click(copyTargets[0]!);
            await this.wait(300);
            copied = true;
          }
        }
        if (!copied) throw new Error('Blinkit cart_share_copy failed');
        try {
          shareUrl = extractBlinkitShareUrl(await this.ui.readClipboardText());
        } finally {
          await this.ui.clearClipboard().catch(() => undefined);
        }
        if (!shareUrl) throw new Error('Blinkit cart_share_link failed');
        shareSource = await this.safeSource('cart_share');
      }

      let after = parseLiveAndroidCart(shareSource);
      for (let attempt = 0; !after && attempt < 3; attempt += 1) {
        await this.ui.back();
        await this.wait(500);
        shareSource = await this.safeSource('cart_share_verify');
        after = parseLiveAndroidCart(shareSource);
      }
      shareOpened = false;
      if (!after || after.providerFingerprint !== before.providerFingerprint) {
        throw new Error('Blinkit cart_share_verify failed');
      }
      return AndroidSharedCartSchemaV1.parse({
        shareUrl,
        cartFingerprint: before.providerFingerprint,
      });
    } catch (error) {
      if (shareOpened) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const source = await this.safeSource('cart_share_recover').catch(() => undefined);
          if (source && parseLiveAndroidCart(source)) break;
          await this.ui.back().catch(() => undefined);
          await this.wait(300);
        }
      }
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit cart_share failed');
    }
  }

  public async importSharedCart(shareUrl: string): Promise<AndroidImportedCartV1> {
    const parsedUrl = BlinkitShareUrlSchemaV1.safeParse(shareUrl);
    if (!parsedUrl.success) throw new Error('Blinkit cart_import_url failed');
    if (!this.ui.openBlinkitLink) throw new Error('Blinkit cart_import_unavailable failed');
    try {
      const before = await this.inspectCart();
      try {
        await this.ui.openBlinkitLink(parsedUrl.data);
      } catch {
        throw new Error('Blinkit cart_import_open failed');
      }
      await this.wait(1_500);

      let source = await this.safeSource('cart_import_source');
      const importPromptLabels = ['Add all items to cart', 'Add items to cart', 'Add all items', 'Import cart'];
      let confirmedImportPrompt = false;
      if (importPromptLabels.some((label) => hasExactSemanticLabel(source, label))) {
        if (!await this.activateSemanticLabel(importPromptLabels, source)) {
          throw new Error('Blinkit cart_import_confirm failed');
        }
        confirmedImportPrompt = true;
        source = await this.safeSource('cart_import_source');
      }

      const directCart = parseLiveAndroidCart(source);
      const after = directCart ?? await this.inspectCart();
      if (!after) throw new Error('Blinkit cart_import_verify failed');
      if (
        !directCart
        && !confirmedImportPrompt
        && before?.providerFingerprint === after.providerFingerprint
      ) {
        throw new Error('Blinkit cart_import_verify failed');
      }
      return AndroidImportedCartSchemaV1.parse({
        importBehavior: classifyCartImport(before, after),
        ...(before ? { previousCartFingerprint: before.providerFingerprint } : {}),
        cart: after,
      });
    } catch (error) {
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit cart_import failed');
    }
  }

  public async upsertCartItem(query: string, offerId: string, quantity: number): Promise<AndroidCartReviewV1> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Blinkit cart_item_upsert failed');
    try {
      const before = await this.inspectCart();
      const chosen = chooseOffer(query, await this.searchCandidates(query, 10), offerId);
      if (!chosen) throw new Error('Blinkit cart_item_offer failed');

      await this.setCartQuantity(chosen.providerLocator, quantity);
      const after = await this.inspectCart();
      if (!after) throw new Error('Blinkit cart_item_verify failed');

      const matchesChosen = (line: AndroidCartReviewV1['lines'][number]): boolean => (
        normalizeSearchText(line.name) === normalizeSearchText(chosen.title)
        && minor(line.unitPrice.amount) === minor(chosen.price.amount)
      );
      const selected = after.lines.filter(matchesChosen);
      if (selected.length !== 1 || selected[0]!.quantity !== quantity) throw new Error('Blinkit cart_item_verify failed');

      const preserved = before?.lines.filter((line) => !matchesChosen(line)) ?? [];
      if (after.lines.length !== preserved.length + 1 || preserved.some((line) => (
        !after.lines.some((candidate) => candidate.productId === line.productId && candidate.quantity === line.quantity)
      ))) throw new Error('Blinkit cart_preservation_verify failed');

      return after;
    } catch (error) {
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit cart_item_upsert failed');
    }
  }

  public async setExistingCartItemQuantity(productId: string, quantity: number): Promise<AndroidCartReviewV1 | undefined> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Blinkit cart_item_quantity failed');
    return this.editExistingCartItem(productId, quantity);
  }

  public async removeExistingCartItem(productId: string): Promise<AndroidCartReviewV1 | undefined> {
    return this.editExistingCartItem(productId, 0);
  }

  private async editExistingCartItem(productId: string, targetQuantity: number): Promise<AndroidCartReviewV1 | undefined> {
    try {
      await this.openCart();
      let cart = parseLiveAndroidCart(await this.safeSource('cart_item_edit'));
      if (!cart) throw new Error('Blinkit cart_item_target failed');
      let targetIndex = cart.lines.findIndex((line) => line.productId === productId);
      if (targetIndex < 0 || cart.lines.filter((line) => line.productId === productId).length !== 1) {
        throw new Error('Blinkit cart_item_target failed');
      }
      let currentQuantity = cart.lines[targetIndex]!.quantity;
      while (currentQuantity !== targetQuantity) {
        if (!cart) throw new Error('Blinkit cart_item_verify failed');
        const increasing = targetQuantity > currentQuantity;
        const control = increasing ? 'Increase quantity' : 'Decrease quantity';
        await this.ui.click(await this.cartLineControl(cart, targetIndex, control));
        const nextQuantity = currentQuantity + (increasing ? 1 : -1);
        cart = await this.waitForCartItemQuantity(productId, nextQuantity);
        currentQuantity = nextQuantity;
        if (currentQuantity > 0) {
          if (!cart) throw new Error('Blinkit cart_item_verify failed');
          targetIndex = cart.lines.findIndex((line) => line.productId === productId);
          if (targetIndex < 0) throw new Error('Blinkit cart_item_verify failed');
        }
      }
      return cart;
    } catch (error) {
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit cart_item_edit failed');
    }
  }

  private async waitForCartItemQuantity(productId: string, expectedQuantity: number): Promise<AndroidCartReviewV1 | undefined> {
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      let cart: AndroidCartReviewV1 | undefined;
      try {
        cart = parseLiveAndroidCart(await this.safeSource('cart_item_verify'));
      } catch {
        cart = undefined;
      }
      const line = cart?.lines.find((candidate) => candidate.productId === productId);
      if ((expectedQuantity === 0 && !line) || line?.quantity === expectedQuantity) return cart;
      if (attempt + 1 < this.pollAttempts) await this.wait(250);
    }
    throw new Error('Blinkit cart_item_verify failed');
  }

  private async cartLineControl(cart: AndroidCartReviewV1, targetIndex: number, description: 'Increase quantity' | 'Decrease quantity'): Promise<UiElement> {
    const controls = uniqueElements(await this.ui.findExactDescription(description));
    const line = cart.lines[targetIndex]!;
    const labels = uniqueElements([
      ...(await this.ui.findExactDescription(line.name)),
      ...(await this.ui.findExactText(line.name)),
    ]);
    const scoped = uniqueElements(labels.flatMap((label) => within(label, controls)));
    if (scoped.length === 1) return scoped[0]!;
    if (labels.length === 1) {
      const cartLabels = await Promise.all(cart.lines.map(async (cartLine) => uniqueElements([
        ...(await this.ui.findExactDescription(cartLine.name)),
        ...(await this.ui.findExactText(cartLine.name)),
      ])));
      if (cartLabels.every((matches) => matches.length === 1)) {
        const assigned = controls.filter((control) => nearestCartLineIndex(control, cartLabels.map(([label]) => label!)) === targetIndex);
        if (assigned.length === 1) return assigned[0]!;
      }
    }
    if (controls.length === cart.lines.length && controls[targetIndex]) return controls[targetIndex]!;
    if (labels.length === 1 && controls.length === 1) return controls[0]!;
    throw new Error('Blinkit cart_item_control failed');
  }

  private async cartTargets(): Promise<UiElement[]> {
    const directDescription = uniqueElements((await this.ui.findExactDescription('View cart'))
      .filter(({ clickable }) => clickable));
    if (directDescription.length > 0) return directDescription;
    const directText = uniqueElements((await this.ui.findExactText('View cart'))
      .filter(({ clickable }) => clickable));
    if (directText.length > 0) return directText;
    const descriptionAncestors = uniqueElements(await this.ui.findClickableAncestorOfExactDescription('View cart'));
    if (descriptionAncestors.length > 0) return descriptionAncestors;
    return uniqueElements(await this.ui.findClickableAncestorOfExactText('View cart'));
  }

  public async prepareExistingCheckout(): Promise<AndroidCheckoutReviewV1> {
    try {
      await this.openCart();
      const cartSource = await this.safeSource('cart_inspect');
      const cart = parseLiveAndroidCart(cartSource);
      if (!cart) throw new Error('empty cart');
      await this.selectCashOnDelivery(cart.subtotal.amount);
      const checkoutSource = await this.safeSource('checkout_review');
      return buildReview(`${cartSource}\n${checkoutSource}`, cart.addressReference, cart.addressLabel, {
        selectedItems: cart.lines.map((line) => ({
          offerId: line.productId,
          title: line.name,
          quantity: line.quantity,
          unitPrice: line.unitPrice.amount,
        })),
        unavailableItems: cart.unavailableItems,
      });
    } catch (error) {
      if (error instanceof BlinkitCheckoutBlockedError) throw error;
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit existing_checkout_prepare failed');
    }
  }

  public async clearCart(): Promise<void> {
    let source = await this.safeSource('cart_clear');
    for (let recovery = 0; recovery < 3; recovery += 1) {
      const stage = detectBlinkitAndroidStage(source);
      if (stage === 'checkout' || stage === 'storefront') break;
      await this.ui.back();
      await this.wait(300);
      source = await this.safeSource('cart_clear');
    }
    if (detectBlinkitAndroidStage(source) === 'storefront') {
      if ((await this.cartTargets()).length === 0) return;
      await this.openCart();
      source = await this.safeSource('cart_clear');
    }
    for (let action = 0; action < 100; action += 1) {
      const decreases = uniqueElements(await this.ui.findExactDescription('Decrease quantity'));
      if (decreases.length === 0) {
        if (detectBlinkitAndroidStage(await this.safeSource('cart_clear')) === 'checkout') {
          await this.ui.back();
          await this.waitForStage(['storefront']);
        }
        return;
      }
      await this.ui.click(decreases[0]!);
      await this.wait(200);
    }
    throw new Error('Blinkit cart_clear failed');
  }

  public async search(query: string, limit: number): Promise<AndroidSearchOffer[]> {
    return (await this.searchCandidates(query, limit)).map((candidate) => ({
      offerId: candidate.offerId,
      title: candidate.title,
      ...(candidate.packSize ? { packSize: candidate.packSize } : {}),
      price: candidate.price,
      available: candidate.available,
      ...(candidate.imageUrl ? { imageUrl: candidate.imageUrl } : {}),
    }));
  }

  private async searchCandidates(query: string, limit: number): Promise<AndroidSearchCandidate[]> {
    try {
      let source = await this.returnFromCheckout(await this.safeSource('search'), 'search');
      const stage = detectBlinkitAndroidStage(source);
      if (stage === 'review_prompt' || stage === 'location_permission') {
        const recovered = await this.recovery.recover('search', ['storefront']);
        if (recovered !== 'storefront') throw new Error('blocked search surface');
        source = await this.safeSource('search');
      }
      source = await this.leaveProductDetailForSearch(source);
      if (!isSearchSurface(source)) {
        let entries = await this.waitForSearchEntry();
        for (let recovery = 0; entries.length === 0 && recovery < 3; recovery += 1) {
          await this.ui.back();
          await this.wait(500);
          source = await this.safeSource('search');
          if (isSearchSurface(source)) break;
          entries = await this.waitForSearchEntry();
        }
        if (!isSearchSurface(source)) {
          if (entries.length !== 1) throw new Error('missing search entry');
          await this.ui.click(entries[0]!);
          await this.wait(500);
          source = await this.safeSource('search');
          if (!isSearchSurface(source)) {
            const storefrontFields = await this.ui.findClassName('android.widget.EditText');
            if (storefrontFields.length !== 1) throw new Error('missing storefront search field');
            await this.ui.click(storefrontFields[0]!);
            for (let attempt = 0; attempt < 5; attempt += 1) {
              await this.wait(500);
              source = await this.safeSource('search');
              if (isSearchSurface(source)) break;
            }
            if (!isSearchSurface(source)) throw new Error('missing dedicated search surface');
          }
        }
      }
      let fields: UiElement[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        fields = await this.ui.findClassName('android.widget.EditText');
        if (fields.length > 0) break;
        await this.wait(500);
      }
      for (let recovery = 0; fields.length === 0 && recovery < 2; recovery += 1) {
        let targets = await this.searchEntryTargets();
        if (targets.length === 0 && isSearchSurface(await this.safeSource('search'))) {
          await this.ui.back();
          await this.wait(500);
          targets = await this.searchEntryTargets();
        }
        if (targets.length !== 1) break;
        await this.ui.click(targets[0]!);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          fields = await this.ui.findClassName('android.widget.EditText');
          if (fields.length > 0) break;
          await this.wait(500);
        }
      }
      if (fields.length === 0) throw new Error('missing search field');
      await this.ui.clear(fields[0]!);
      await this.ui.setValue(fields[0]!, query);
      await this.wait(1_500);
      source = await this.safeSource('search');
      let candidates = relevantSearchCandidates(query, parseSearchCandidates(source));
      if (candidates.length === 0) {
        await this.ui.pressKey('ENTER');
        await this.wait(1_000);
        candidates = relevantSearchCandidates(query, parseSearchCandidates(await this.safeSource('search')));
      }
      return candidates.slice(0, limit);
    } catch {
      throw new Error('Blinkit search failed');
    }
  }

  public async setCartQuantity(productId: string, quantity: number): Promise<void> {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error('Blinkit cart_quantity failed');
    if (productId.startsWith('description:')) {
      const description = productId.slice('description:'.length);
      const cards = await this.ui.findExactDescription(description);
      const card = uniquelyDominantElement(cards);
      if (!card) throw new Error('Blinkit cart_quantity_card failed');

      let add: UiElement[] = [];
      for (let attempt = 0; attempt <= 20; attempt += 1) {
        const addControls = await this.ui.findExactDescription('ADD');
        add = within(card, addControls);
        if (add.length === 1) break;
        const decrease = controlsForLabel(card, await this.ui.findExactDescription('Decrease quantity'));
        if (decrease.length === 1) {
          await this.ui.click(decrease[0]!);
          await this.wait(200);
          continue;
        }
        add = controlsForLabel(card, addControls);
        if (add.length === 1) break;
        if (attempt === 20) throw new Error('Blinkit cart_quantity_add failed');
      }
      await this.ui.click(add[0]!);
      await this.wait(500);

      let activeCard = card;
      let decreases = controlsForLabel(activeCard, await this.ui.findExactDescription('Decrease quantity'));
      if (decreases.length === 0) {
        const variantAdds = await this.ui.findExactDescription('ADD');
        const variantCards = (await this.ui.findExactDescription(description))
          .map((candidate) => ({ candidate, adds: controlsForLabel(candidate, variantAdds) }))
          .filter(({ adds }) => adds.length === 1);
        if (variantCards.length !== 1) throw new Error('Blinkit cart_quantity_variant failed');
        activeCard = variantCards[0]!.candidate;
        await this.ui.click(variantCards[0]!.adds[0]!);
        await this.wait(500);
      }
      const quantityDecreases = await this.ui.findExactDescription('Decrease quantity');
      const quantityCards = (await this.ui.findExactDescription(description))
        .map((candidate) => ({ candidate, decreases: controlsForLabel(candidate, quantityDecreases) }))
        .filter(({ decreases: controls }) => controls.length === 1);
      if (quantityCards.length === 1) {
        activeCard = quantityCards[0]!.candidate;
        decreases = quantityCards[0]!.decreases;
      } else {
        decreases = controlsForLabel(activeCard, quantityDecreases);
      }
      if (decreases.length !== 1) throw new Error('Blinkit cart_quantity_verify failed');

      for (let count = 1; count < quantity; count += 1) {
        const increase = controlsForLabel(activeCard, await this.ui.findExactDescription('Increase quantity'));
        if (increase.length !== 1) throw new Error('Blinkit cart_quantity_increase failed');
        await this.ui.click(increase[0]!);
        await this.wait(200);
      }
      return;
    }
    const controls = await this.ui.findResourceId(productId);
    if (controls.length !== 1) throw new Error('Blinkit cart_quantity failed');
    for (let count = 0; count < quantity; count += 1) await this.ui.click(controls[0]!);
  }

  public async prepareCheckout(items: readonly RequestedItem[], addressReference: string, addressLabel: string): Promise<AndroidCheckoutReviewV1> {
    try {
      let source = await this.safeSource('checkout_prepare');
      if (!source.includes('screen="checkout-review"')) {
        if (/^address_[a-f0-9]{32}$/.test(addressReference)) {
          const selected = await this.selectSavedAddressReference(addressReference);
          if (selected.label !== addressLabel) throw new Error('Blinkit address_select failed');
        } else {
          await this.selectSavedAddress(addressLabel);
        }
        source = await this.safeSource('checkout_prepare');
      }
      const selectedItems: SelectedCheckoutItem[] = [];
      const unavailableItems: AndroidCheckoutReviewV1['unavailableItems'] = [];

      // A worker may resume on an already prepared review. Otherwise rebuild the
      // requested cart after address selection because Blinkit can change stores.
      if (!source.includes('screen="checkout-review"')) {
        await this.clearCart();
        for (const item of items) {
          const offers = await this.searchCandidates(item.query, 10);
          const chosen = chooseOffer(item.query, offers, item.offerId);
          if (!chosen) {
            unavailableItems.push({
              query: item.query,
              reason: offers.length === 0 ? 'not_found' : item.offerId ? 'out_of_stock' : 'ambiguous',
            });
            continue;
          }
          try {
            await this.setCartQuantity(chosen.providerLocator, item.quantity);
          } catch (error) {
            if (error instanceof Error && /Blinkit cart_quantity/.test(error.message)) {
              throw new BlinkitCheckoutBlockedError('quantity_unavailable');
            }
            throw error;
          }
          selectedItems.push({
            offerId: chosen.offerId,
            title: chosen.title,
            quantity: item.quantity,
            unitPrice: chosen.price.amount,
          });
        }
        if (selectedItems.length === 0) throw new BlinkitCheckoutBlockedError('product_unavailable');
        await this.openCart();
        source = await this.safeSource('checkout_prepare');
      }

      await this.waitForStage(['checkout']);
      const itemSubtotal = selectedItems.length > 0
        ? selectedItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
        : parseLiveAndroidCart(source)?.subtotal.amount;
      await this.selectCashOnDelivery(itemSubtotal);
      source = await this.safeSource('checkout_review');
      const reviewSources = [source];
      for (let attempt = 0; attempt < 5 && !hasSemanticLabel(reviewSources.at(-1)!, addressLabel); attempt += 1) {
        const canContinue = await this.ui.scrollBackward().catch(() => false);
        await this.wait(1_000);
        const nextSource = await this.safeSource('checkout_review');
        if (!reviewSources.includes(nextSource)) reviewSources.push(nextSource);
        if (!canContinue) break;
      }
      const billSource = await this.readBillDetails().catch(() => undefined);
      return buildReview(reviewSources.join('\n'), addressReference, addressLabel, { selectedItems, unavailableItems, billSource });
    } catch (error) {
      if (error instanceof BlinkitCheckoutBlockedError) throw error;
      if (error instanceof Error && /^Blinkit [a-z][a-z0-9_]+ failed$/.test(error.message)) throw error;
      throw new Error('Blinkit checkout_prepare failed');
    }
  }

  public async readCheckoutReview(
    addressReference: string,
    addressLabel: string,
    expected?: AndroidCheckoutReviewV1,
  ): Promise<AndroidCheckoutReviewV1> {
    if (expected?.lines[0]) await this.ui.scrollExactTextIntoView(expected.lines[0].name).catch(() => undefined);
    const source = await this.safeSource('checkout_review');
    const billSource = await this.readBillDetails().catch(() => undefined);
    if (!expected) return buildReview(source, addressReference, addressLabel, { billSource });
    return buildReview(source, addressReference, addressLabel, {
      selectedItems: expected.lines.map((line) => ({
        offerId: line.productId,
        title: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice.amount,
      })),
      unavailableItems: expected.unavailableItems,
      billSource,
    });
  }

  /** This is the only driver method permitted to perform the final provider action. */
  public async clickFinalOrderOnce(): Promise<void> {
    try {
      await this.clickExactlyOne('Place Order');
    } catch {
      throw new Error('Blinkit final_action failed');
    }
  }

  public async readConfirmation(): Promise<{ status: 'committed'; providerReference: string } | { status: 'unverified' }> {
    const source = await this.safeSource('confirmation_read');
    if (detectBlinkitAndroidStage(source) !== 'confirmed') return { status: 'unverified' };
    const taggedReference = parseTags(source, 'order')[0]?.['provider-reference'];
    const textReference = /(?:order\s*(?:id|number|#)\s*[:#-]?\s*)([A-Za-z0-9-]{4,100})/i.exec(source)?.[1];
    const providerReference = taggedReference ?? textReference;
    return providerReference ? { status: 'committed', providerReference } : { status: 'unverified' };
  }

  public async readOrderHistory(expected: AndroidExpectedCheckoutV1): Promise<AndroidOrderCandidate[]> {
    const initial = await this.safeSource('order_history');
    const immediate = parseAndroidOrderCandidates(initial, expected, new Date());
    if (immediate.length > 0) return immediate;
    return parseAndroidOrderCandidates(await this.openOrderHistory(initial), expected);
  }

  public async readRecentOrders(limit: number): Promise<AndroidRecentOrderV1[]> {
    const initial = await this.safeSource('recent_orders');
    const source = isOrderHistorySurface(initial)
      ? initial
      : await this.openOrderHistory(initial);
    return parseRecentOrders(source, limit);
  }

  private async openOrderHistory(initialSource: string): Promise<string> {
    let source = initialSource;
    if (isOrderHistorySurface(source)) return source;
    const initialStage = detectBlinkitAndroidStage(source);
    if (initialStage === 'address_picker' || initialStage === 'location_permission' || initialStage === 'review_prompt' || initialStage === 'unknown') {
      const recovered = await this.recovery.recover('storefront', ['storefront']);
      if (recovered !== 'storefront') throw new Error('Blinkit order_history failed');
      source = await this.safeSource('order_history');
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.activateSemanticLabel(['My orders', 'Your orders', 'Orders', 'Order History'], source)) {
        await this.wait(500);
        source = await this.safeSource('order_history');
        if (isOrderHistorySurface(source)) return source;
      }
      if (await this.activateSemanticLabel(['Go to profile', 'Account', 'Profile'], source)) {
        await this.wait(500);
        source = await this.safeSource('order_history');
        if (await this.activateSemanticLabel(['My orders', 'Your orders', 'Orders', 'Order History'], source)) {
          await this.wait(500);
          source = await this.safeSource('order_history');
          if (isOrderHistorySurface(source)) return source;
        }
      }
      await this.ui.back();
      await this.wait(500);
      source = await this.safeSource('order_history');
      if (isOrderHistorySurface(source)) return source;
    }
    throw new Error('Blinkit order_history failed');
  }

  private async clickExactlyOne(text: string): Promise<void> {
    const matches = await this.ui.findExactText(text);
    if (matches.length !== 1) throw new Error('unexpected exact text controls');
    await this.ui.click(matches[0]!);
  }

  private async returnFromCheckout(initialSource: string, operation: 'address_list' | 'search'): Promise<string> {
    let source = initialSource;
    for (let attempt = 0; attempt < 3 && detectBlinkitAndroidStage(source) === 'checkout'; attempt += 1) {
      const usedVisibleBack = await this.activateSemanticLabel(['Go back'], source);
      if (!usedVisibleBack) await this.ui.back();
      await this.wait(500);
      source = await this.safeSource(operation);
    }
    if (detectBlinkitAndroidStage(source) === 'checkout') throw new Error(`Blinkit ${operation} failed`);
    return source;
  }

  private async leaveProductDetailForSearch(initialSource: string): Promise<string> {
    if (classifyBlinkitAndroidScreen(initialSource).kind !== 'product_detail') return initialSource;
    if (await this.activateSemanticLabel(['Search'], initialSource)) {
      return this.safeSource('search');
    }
    const usedVisibleBack = await this.activateSemanticLabel(['Navigate up', 'Go back'], initialSource);
    if (!usedVisibleBack) {
      await this.ui.back();
      await this.wait(500);
    }
    return this.safeSource('search');
  }

  private async searchEntryTargets(): Promise<UiElement[]> {
    for (const label of ['Search for atta, dal, coke and more', 'Search']) {
      const strategies = [
        await this.ui.findClickableAncestorOfExactDescription(label),
        await this.ui.findClickableAncestorOfExactText(label),
        await this.ui.findExactDescription(label),
        await this.ui.findExactText(label),
      ].map((targets) => uniqueElements(targets.filter(({ clickable }) => clickable)));
      const exact = strategies.find((targets) => targets.length === 1);
      if (exact) return exact;
      const ambiguous = strategies.find((targets) => targets.length > 1);
      if (ambiguous) return ambiguous;
    }
    return [];
  }

  private async waitForSearchEntry(): Promise<UiElement[]> {
    let entries: UiElement[] = [];
    for (let attempt = 0; attempt < 5 && entries.length === 0; attempt += 1) {
      entries = await this.searchEntryTargets();
      if (entries.length === 0 && attempt < 4) await this.wait(500);
    }
    return entries;
  }

  private async cashOnDeliveryTargets(): Promise<UiElement[]> {
    const descriptionAncestors = uniqueElements((await this.ui.findClickableAncestorOfExactDescription('Cash on Delivery'))
      .filter(({ clickable }) => clickable));
    if (descriptionAncestors.length > 0) return descriptionAncestors;

    const textLabels = await this.ui.findExactText('Cash on Delivery');
    const textAncestors = uniqueElements((await this.ui.findClickableAncestorOfExactText('Cash on Delivery'))
      .filter((ancestor) => ancestor.clickable && textLabels.some((label) => isFullRowAncestor(ancestor, label))));
    if (textAncestors.length > 0) return textAncestors;
    return uniqueElements([
      ...textLabels,
      ...(await this.ui.findExactDescription('Cash on Delivery')),
    ].filter(({ clickable }) => clickable));
  }

  private async activateSemanticLabel(labels: readonly string[], source?: string): Promise<boolean> {
    const candidates = source ? labels.filter((label) => hasExactSemanticLabel(source, label)) : labels;
    for (const label of candidates) {
      const strategies = [
        await this.ui.findExactText(label),
        await this.ui.findExactDescription(label),
        await this.ui.findClickableAncestorOfExactText(label),
        await this.ui.findClickableAncestorOfExactDescription(label),
      ].map((targets) => uniqueElements(targets.filter(({ clickable }) => clickable)));
      const target = strategies.find((targets) => targets.length === 1)?.[0];
      if (!target) continue;
      await this.ui.click(target);
      await this.wait(500);
      return true;
    }
    return false;
  }

  private async activateAddressHeader(labels: readonly string[]): Promise<boolean> {
    for (const label of labels) {
      const matches = uniqueElements([
        ...(await this.ui.findExactText(label)),
        ...(await this.ui.findExactDescription(label)),
      ]);
      if (matches.length !== 1) continue;
      if (matches[0]!.clickable) await this.ui.click(matches[0]!);
      else await this.ui.tap(matches[0]!);
      await this.wait(500);
      return true;
    }
    return false;
  }

  private async safeSource(stage: string): Promise<string> {
    try { return await this.ui.source(); } catch { throw new Error(`Blinkit ${stage} failed`); }
  }

  private async waitForRecognizedScreen(failureStage: string): Promise<{ stage: BlinkitAndroidStage; source: string }> {
    let source = '';
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      source = await this.safeSource(failureStage);
      const stage = detectBlinkitAndroidStage(source);
      if (stage !== 'unknown') return { stage, source };
      if (attempt + 1 < this.pollAttempts) await this.wait(500);
    }
    return { stage: 'unknown', source };
  }

  private async waitForStage(expected: readonly BlinkitAndroidStage[], attempts = this.pollAttempts): Promise<BlinkitAndroidStage> {
    return (await this.waitForStageScreen(expected, attempts)).stage;
  }

  private async waitForStageScreen(
    expected: readonly BlinkitAndroidStage[],
    attempts = this.pollAttempts,
  ): Promise<{ stage: BlinkitAndroidStage; source: string }> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const source = await this.safeSource('stage_wait');
      const stage = detectBlinkitAndroidStage(source);
      if (expected.includes(stage)) return { stage, source };
      if (attempt + 1 < attempts) await this.wait(500);
    }
    throw new Error('Blinkit stage_wait failed');
  }

  private async readBillDetails(): Promise<string> {
    const direct = await this.ui.scrollExactTextIntoView('Bill details').then(async () => {
      await this.wait(300);
      return this.safeSource('checkout_bill');
    }).catch(() => undefined);
    if (direct) return direct;

    const mainScrollers = await this.ui.findResourceId('com.grofers.customerapp:id/cw_recycler_view');
    if (mainScrollers.length !== 1) throw new Error('Blinkit checkout_bill failed');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (this.ui.scrollElementForward) await this.ui.scrollElementForward(mainScrollers[0]!);
      else await this.ui.scrollForward();
      await this.wait(300);
      const source = await this.safeSource('checkout_bill');
      if (hasSemanticLabel(source, 'Bill details')) return source;
    }
    throw new Error('Blinkit checkout_bill failed');
  }
}

function isPaymentSurface(source: string): boolean {
  return /payment options|pay by any upi app|amazon pay balance|\bpay later\b|credit card|debit card|wallet/i.test(source);
}

function classifyCartImport(
  before: AndroidCartReviewV1 | undefined,
  after: AndroidCartReviewV1,
): BlinkitCartImportBehaviorV1 {
  if (!before) return 'created';
  if (before.providerFingerprint === after.providerFingerprint) return 'unchanged';
  const retained = before.lines.every((line) => {
    const current = after.lines.find(({ productId }) => productId === line.productId);
    return current !== undefined && current.quantity >= line.quantity;
  });
  const itemsAdded = after.lines.length > before.lines.length
    || before.lines.some((line) => after.lines.find(({ productId }) => productId === line.productId)!.quantity > line.quantity);
  return retained && itemsAdded ? 'merged' : 'updated';
}

function isOrderHistorySurface(source: string): boolean {
  return (hasSemanticLabel(source, 'Order History') && hasSemanticLabel(source, 'Search your grocery orders'))
    || /<order\b|\bno\s+(?:past\s+)?orders?\b|nothing\s+(?:has\s+been\s+)?ordered|\border\s*(?:id|number|no\.?|#)\s*[:#-]?\s*[A-Za-z0-9]|\bordered\s+on\b/i.test(source);
}

function isCashOnDeliveryUnavailable(source: string): boolean {
  return /cash\s+on\s+delivery\s+is\s+not\s+available/i.test(source);
}

function isSearchSurface(source: string): boolean {
  if (/recent searches|clear all/i.test(source)) return true;
  if (!/voice search/i.test(source)) return false;
  return detectBlinkitAndroidStage(source) !== 'storefront'
    || (hasExactSemanticLabel(source, 'Filters') && hasExactSemanticLabel(source, 'Sort'));
}

function hasSemanticLabel(source: string, expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  return parseElements(source).some((attributes) => [attributes['text'], attributes['content-desc']]
    .some((value) => value?.trim().toLowerCase().includes(normalized)));
}

function hasExactSemanticLabel(source: string, expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  return parseElements(source).some((attributes) => [attributes['text'], attributes['content-desc']]
    .some((value) => value?.trim().toLowerCase() === normalized));
}

function semanticTargetRects(source: string, expected: string): UiElement['rect'][] {
  const normalized = expected.trim().toLowerCase();
  const rects = parseElements(source).flatMap((attributes): UiElement['rect'][] => {
    const label = attributes['content-desc'] || attributes['text'];
    if (label?.trim().toLowerCase() !== normalized) return [];
    const rect = parseBounds(attributes['bounds']);
    return rect ? [rect] : [];
  });
  return rects.filter((rect, index) => !rects.slice(0, index).some((candidate) => sameVisualTarget(
    { id: 'candidate', rect: candidate, clickable: true },
    { id: 'rect', rect, clickable: true },
  )));
}

function parseBounds(value: string | undefined): UiElement['rect'] | undefined {
  const match = value ? /^\[(\d+),(\d+)]\[(\d+),(\d+)]$/.exec(value) : undefined;
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if ([left, top, right, bottom].some((coordinate) => !Number.isSafeInteger(coordinate))) return undefined;
  if (right! <= left! || bottom! <= top!) return undefined;
  return { x: left!, y: top!, width: right! - left!, height: bottom! - top! };
}

function isFullRowAncestor(ancestor: UiElement, label: UiElement): boolean {
  return ancestor.rect.width >= label.rect.width * 1.5
    && ancestor.rect.height >= label.rect.height * 1.5;
}

function uniqueElements(elements: readonly UiElement[]): UiElement[] {
  const unique: UiElement[] = [];
  for (const element of elements) {
    if (unique.some((candidate) => sameVisualTarget(candidate, element))) continue;
    unique.push(element);
  }
  return unique;
}

function sameVisualTarget(left: UiElement, right: UiElement): boolean {
  return Math.abs(left.rect.x - right.rect.x) <= 2
    && Math.abs(left.rect.y - right.rect.y) <= 2
    && Math.abs(left.rect.width - right.rect.width) <= 2
    && Math.abs(left.rect.height - right.rect.height) <= 2;
}

function within<T extends { rect: { x: number; y: number; width: number; height: number } }>(
  parent: { rect: { x: number; y: number; width: number; height: number } },
  elements: readonly T[],
): T[] {
  const right = parent.rect.x + parent.rect.width;
  const bottom = parent.rect.y + parent.rect.height;
  return elements.filter(({ rect }) => {
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    return centerX >= parent.rect.x && centerX <= right && centerY >= parent.rect.y && centerY <= bottom;
  });
}

function controlsForLabel(label: UiElement, controls: readonly UiElement[]): UiElement[] {
  const scoped = uniqueElements(within(label, controls));
  if (scoped.length === 1) return scoped;
  const candidates = scoped.length > 1 ? scoped : uniqueElements(controls);
  const ranked = candidates.map((control) => ({
    control,
    distance: centerDistance(label, control),
  })).sort((left, right) => left.distance - right.distance);
  const nearest = ranked[0];
  const next = ranked[1];
  if (!nearest || (next && Math.abs(next.distance - nearest.distance) <= 16)) return [];
  const labelDiagonal = Math.hypot(label.rect.width, label.rect.height);
  if (nearest.distance > Math.max(240, Math.min(480, labelDiagonal * 1.5))) return [];
  return [nearest.control];
}

function centerDistance(left: UiElement, right: UiElement): number {
  const x = left.rect.x + left.rect.width / 2 - (right.rect.x + right.rect.width / 2);
  const y = left.rect.y + left.rect.height / 2 - (right.rect.y + right.rect.height / 2);
  return Math.hypot(x, y);
}

function uniquelyDominantElement(elements: readonly UiElement[]): UiElement | undefined {
  const ranked = uniqueElements(elements)
    .map((element) => ({ element, area: element.rect.width * element.rect.height }))
    .filter(({ area }) => area > 0)
    .sort((left, right) => right.area - left.area);
  const largest = ranked[0];
  const next = ranked[1];
  if (!largest || (next && largest.area < next.area * 1.5)) return undefined;
  return largest.element;
}

function nearestCartLineIndex(control: UiElement, labels: readonly UiElement[]): number | undefined {
  const distances = labels.map((label, index) => ({
    index,
    distance: Math.abs(verticalCenter(control) - verticalCenter(label)),
  })).sort((left, right) => left.distance - right.distance);
  const nearest = distances[0];
  const next = distances[1];
  if (!nearest || (next && Math.abs(next.distance - nearest.distance) <= 8)) return undefined;
  const nearestOtherLine = labels
    .filter((_, index) => index !== nearest.index)
    .map((label) => Math.abs(verticalCenter(labels[nearest.index]!) - verticalCenter(label)))
    .sort((left, right) => left - right)[0];
  const maximumDistance = nearestOtherLine === undefined ? 240 : Math.max(80, nearestOtherLine / 2);
  if (nearest.distance > maximumDistance) return undefined;
  return nearest.index;
}

function verticalCenter(element: UiElement): number {
  return element.rect.y + element.rect.height / 2;
}

function parseSearchCandidates(source: string): AndroidSearchCandidate[] {
  const tagged = parseTags(source, 'offer').map((attributes) => {
    const title = required(attributes, 'title');
    const packSize = attributes['pack-size'];
    const price = money(parseAmount(required(attributes, 'price')));
    const imageUrl = safeProductImageUrl(attributes['image-url']);
    return {
      offerId: createOfferId(title, packSize, price.amount),
      providerLocator: required(attributes, 'product-id'),
      title,
      ...(packSize ? { packSize } : {}),
      price,
      available: attributes['available'] !== 'false',
      ...(imageUrl ? { imageUrl } : {}),
    };
  });
  if (tagged.length > 0) return dedupeSearchCandidates(tagged);

  const nodes = parseElements(source);
  const candidates: AndroidSearchCandidate[] = [];
  for (const [index, attributes] of nodes.entries()) {
    const description = attributes['content-desc'];
    if (!description) continue;
    const match = /^(.+?)\s+is\s+(available|unavailable|not available)\s+for\s+₹\s*([\d,.]+)$/i.exec(description);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const title = match[1].trim();
    const price = money(parseAmount(match[3]));
    const nearby = nodes.slice(index + 1)
      .map((node) => node['content-desc'] ?? node['text'] ?? '')
      .filter(Boolean)
      .slice(0, 8);
    const packSize = nearby.find((value) => /^\d+(?:\.\d+)?\s*(?:g|kg|ml|l|pcs?|pieces?|pack)$/i.test(value.trim()));
    const imageUrl = safeProductImageUrl(attributes['image-url'])
      ?? nodes.slice(index + 1, index + 9).map((node) => safeProductImageUrl(node['image-url'])).find(Boolean);
    candidates.push({
      offerId: createOfferId(title, packSize, price.amount),
      providerLocator: `description:${description}`,
      title,
      ...(packSize ? { packSize } : {}),
      price,
      available: match[2].toLowerCase() === 'available',
      ...(imageUrl ? { imageUrl } : {}),
    });
  }
  return dedupeSearchCandidates(candidates);
}

function dedupeSearchCandidates(candidates: readonly AndroidSearchCandidate[]): AndroidSearchCandidate[] {
  const unique = new Map<string, AndroidSearchCandidate>();
  for (const candidate of candidates) {
    const key = JSON.stringify([
      candidate.offerId,
      candidate.providerLocator,
      candidate.title,
      candidate.packSize ?? null,
      candidate.price.currency,
      minor(candidate.price.amount),
      candidate.available,
      candidate.imageUrl ?? null,
    ]);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()];
}

function safeProductImageUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'blinkit.com'
      || hostname.endsWith('.blinkit.com')
      || hostname === 'grofers.com'
      || hostname.endsWith('.grofers.com')
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function relevantSearchCandidates<T extends AndroidSearchOffer>(query: string, candidates: readonly T[]): T[] {
  const tokens = normalizeSearchText(query).split(' ').filter((token) => token.length >= 3);
  if (tokens.length === 0) return [];
  return candidates.filter((candidate) => {
    const title = normalizeSearchText(candidate.title);
    return tokens.some((token) => title.includes(token));
  });
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\blay['’]?s\b|\blayers\b/g, 'lays')
    .replace(/\bdoodh\b|\bdudh\b/g, 'milk')
    .replace(/\btazaa\b/g, 'taaza')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function addressPickerEntryLabels(source: string): string[] {
  const qualifiedSavedLabel = /^(?:home|work|office|other)\s*(?:[-–—,:]|\b(?:address|location)\b)\s*\S+/i;
  const splitSavedLabel = /^(?:home|work|office|other)\s*[-–—:]\s*$/i;
  return parseElements(source).flatMap((attributes): string[] => {
    const label = (attributes['content-desc'] || attributes['text'] || '').trim();
    const resourceId = attributes['resource-id']?.toLowerCase() ?? '';
    const providerSplitHeader = splitSavedLabel.test(label) && /subtitle2_left_tag$/.test(resourceId);
    if (!label || (!qualifiedSavedLabel.test(label)
      && !providerSplitHeader
      && !/(?:address|location|delivery).*header|header.*(?:address|location|delivery)/.test(resourceId))) return [];
    return [label];
  });
}

function parseElements(source: string): AttributeMap[] {
  const matches = source.matchAll(/<(?!\/|\?|!)[A-Za-z_][\w.:-]*\b([^>]*)\/?>/g);
  return [...matches].map((match) => parseAttributes(match[1] ?? ''));
}

function semanticLabelsMatching(source: string, pattern: RegExp): string[] {
  const labels = parseElements(source).flatMap((attributes) => [
    attributes['text'],
    attributes['content-desc'],
  ]).filter((value): value is string => Boolean(value?.trim()));
  return [...new Set(labels.filter((label) => pattern.test(label.trim())))];
}

function extractBlinkitShareUrl(value: string): string | undefined {
  const decoded = decodeXml(value);
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    const candidate = match[0].replace(/[),.;!?]+$/, '');
    const parsed = BlinkitShareUrlSchemaV1.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function chooseOffer<T extends AndroidSearchOffer>(query: string, offers: readonly T[], offerId?: string): T | undefined {
  if (offerId) {
    const selected = offers.filter((offer) => offer.available && offer.offerId === offerId);
    return selected.length === 1 ? selected[0] : undefined;
  }
  const normalized = query.trim().toLowerCase();
  const available = offers.filter((offer) => offer.available);
  const exact = available.filter((offer) => offer.title.trim().toLowerCase() === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const containing = available.filter((offer) => offer.title.toLowerCase().includes(normalized));
  return containing.length === 1 ? containing[0] : undefined;
}

function createOfferId(title: string, packSize: string | undefined, amount: number): string {
  const material = `${title.trim().toLowerCase()}\n${packSize?.trim().toLowerCase() ?? ''}\n${minor(amount)}`;
  return `offer_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

function buildReview(
  source: string,
  addressReference: string,
  addressLabel: string,
  live: LiveReviewEvidence = {},
): AndroidCheckoutReviewV1 {
  try {
    const taggedLines = parseTags(source, 'line');
    if (taggedLines.length === 0) return buildLiveAndroidReview(source, addressReference, addressLabel, live);
    const lines = taggedLines.map((attributes) => ({
      productId: required(attributes, 'product-id'),
      name: required(attributes, 'name'),
      quantity: parseInteger(required(attributes, 'quantity')),
      unitPrice: money(parseAmount(required(attributes, 'unit-price'))),
      lineTotal: money(parseAmount(required(attributes, 'line-total'))),
    }));
    const unavailableItems = parseTags(source, 'unavailable').map((attributes) => ({
      query: required(attributes, 'query'),
      reason: parseUnavailableReason(required(attributes, 'reason')),
    }));
    const fees = parseTags(source, 'fee').map((attributes) => ({
      kind: parseFeeKind(required(attributes, 'kind')),
      label: required(attributes, 'label'),
      amount: money(parseAmount(required(attributes, 'amount'))),
    }));
    const summary = parseTags(source, 'summary')[0];
    if (!summary || lines.length === 0) throw new Error('missing review');
    const total = money(parseAmount(required(summary, 'total')));
    for (const line of lines) {
      if (minor(line.lineTotal.amount) !== minor(line.unitPrice.amount) * line.quantity) throw new Error('invalid line total');
    }
    const expectedTotal = lines.reduce((sum, line) => sum + minor(line.lineTotal.amount), 0)
      + fees.reduce((sum, fee) => sum + (fee.kind === 'discount' ? -1 : 1) * minor(fee.amount.amount), 0);
    if (minor(total.amount) !== expectedTotal) throw new Error('invalid total');

    const material = {
      lines,
      unavailableItems,
      fees,
      total,
      addressReference,
      addressLabel,
      ...(summary['eta-minutes'] ? { etaMinutes: parseInteger(summary['eta-minutes']) } : {}),
      paymentMode: 'cod' as const,
    };
    return AndroidCheckoutReviewSchemaV1.parse({
      ...material,
      providerFingerprint: createHash('sha256').update(JSON.stringify(material)).digest('hex'),
    });
  } catch {
    throw new Error('Blinkit checkout_review failed');
  }
}

function parseTags(source: string, tag: string): AttributeMap[] {
  const matches = source.matchAll(new RegExp(`<${tag}\\b([^>]*)/?>`, 'gi'));
  return [...matches].map((match) => parseAttributes(match[1] ?? ''));
}

function parseAttributes(value: string): AttributeMap {
  const attributes: AttributeMap = {};
  for (const match of value.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]!] = decodeXml(match[2]!);
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function required(attributes: AttributeMap, key: string): string {
  const value = attributes[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

function parseAmount(value: string): number {
  const amount = Number(value.replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid amount');
  return amount;
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('invalid integer');
  return parsed;
}

function parseUnavailableReason(value: string): 'out_of_stock' | 'not_found' | 'ambiguous' {
  if (value === 'out_of_stock' || value === 'not_found' || value === 'ambiguous') return value;
  throw new Error('invalid unavailable reason');
}

function parseFeeKind(value: string): 'delivery' | 'handling' | 'platform' | 'surge' | 'booking' | 'tax' | 'discount' | 'other' {
  if (['delivery', 'handling', 'platform', 'surge', 'booking', 'tax', 'discount', 'other'].includes(value)) return value as ReturnType<typeof parseFeeKind>;
  throw new Error('invalid fee kind');
}
