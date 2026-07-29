const EMAIL_PATTERN =
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu;
const EXPLICIT_ADDRESS_MARKER_PATTERN =
  /(?:^| )(?:address|pin code|pincode|postal|zip|पता|સરનામું|ঠিকানা|முகவரி|చిరునామా|ವಿಳಾಸ|വിലാസം|ਪਤਾ)(?: |$)/iu;
const NUMBERED_LOCATION_MARKER_PATTERN =
  /(?:^| )(?:apartment|avenue|building|flat|floor|house|lane|near|road|sector|street|गली|फ्लैट|मकान|सड़क)(?: |$)/iu;

export function normalizeProductChoicePolicyTextV2(
  value: string,
): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D/gu, '');
}

function unicodeDigitCount(value: string): number {
  return [...value.matchAll(/\p{Nd}/gu)].length;
}

/**
 * Product-choice preferences contain category/brand/form metadata only.
 * Contact, payment, and address-like text has no valid role in this durable
 * policy record and must remain in its purpose-built private boundary.
 */
export function isSafeProductChoicePolicyTextV2(value: string): boolean {
  if (EMAIL_PATTERN.test(value)) return false;

  const digits = digitsOnly(value);
  const compact = value.replace(/[\s()+.-]/gu, '');
  const numericSeparatorsOnly = /^[\p{Nd}\s()+.-]+$/u.test(value);
  const digitCount = unicodeDigitCount(value);
  const looksLikeIndianPhone =
    (/^[6-9]\d{9}$/u.test(digits) && /^\+?[\d\s().-]+$/u.test(value))
    || (
      /^91[6-9]\d{9}$/u.test(digits)
      && /^\+?[\d\s().-]+$/u.test(value)
    )
    || (numericSeparatorsOnly && (digitCount === 10 || digitCount === 12));
  const looksLikePaymentCard =
    digitCount >= 13
    && digitCount <= 19
    && (
      /^\d+$/u.test(compact)
      || numericSeparatorsOnly
    );
  if (looksLikeIndianPhone || looksLikePaymentCard) return false;

  const normalized = normalizeProductChoicePolicyTextV2(value);
  const padded = ` ${normalized} `;
  if (EXPLICIT_ADDRESS_MARKER_PATTERN.test(padded)) return false;
  return !(
    digitCount > 0
    && NUMBERED_LOCATION_MARKER_PATTERN.test(padded)
  );
}
