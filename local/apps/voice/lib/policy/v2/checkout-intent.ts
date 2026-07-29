const checkoutContinuationPatterns = [
  /\bcash\s+on\s+delivery\b/i,
  /\bcod\b/i,
  /\bcheck\s*out\b/i,
  /\bplace\s+(?:the\s+)?order\b/i,
  /\border\s+(?:it|this|these|them|the\s+cart)\b/i,
  /\b(?:order|checkout)\s+kar\s+do\b/i,
  /\b(?:order|checkout)\s+kardo\b/i,
  /\bcod\s+(?:se|pe|par)\b/i,
  /(?:ऑर्डर|चेकआउट)\s*(?:कर|करना|कर दो|करदो)/iu,
  /कैश\s+ऑन\s+डिलीवरी/iu,
] as const;

export function isCheckoutContinuationIntentV2(
  transcript: string,
): boolean {
  const value = transcript.trim();
  return value.length > 0
    && checkoutContinuationPatterns.some((pattern) => pattern.test(value));
}

export function shouldForceCheckoutContinuationV2(input: {
  explicitProductChange: boolean;
  hasPendingCheckout: boolean;
  transcript: string;
}): boolean {
  return !input.hasPendingCheckout
    && !input.explicitProductChange
    && isCheckoutContinuationIntentV2(input.transcript);
}
