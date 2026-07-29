export type RestrictedScreenClass =
  | 'account_details'
  | 'address'
  | 'authentication'
  | 'notification'
  | 'otp'
  | 'payment_credentials'
  | 'phone_number';

export type RestrictedScreenAssessment = {
  classes: RestrictedScreenClass[];
  restricted: boolean;
  safeFallback?: {
    kind: 'restricted_screen';
    message: string;
  };
};

const xmlEntity = /&(amp|apos|gt|lt|quot|#39|#x27);/g;
const attributeValue = /\b(?:content-desc|hint|text)="([^"]*)"/g;
const sensitiveValuePatterns = [
  /\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/i,
  /\b\d{4}[\s-]\d{4}[\s-]\d{4}(?:[\s-]\d{4})?\b/,
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  /\b(?:cvv|cvc|otp|one[ -]?time password|upi pin)\b/i,
  /\b(?:house|flat|apartment|door)\s*(?:no|number|#)?\s*[:.-]?\s*[a-z0-9/-]+\b/i,
  /\b\d{1,5}\s+[\w .'-]+\s(?:road|rd|street|st|nagar|layout|colony)\b/i,
  /\b[1-9]\d{5}\b/,
];

function decodeXml(value: string): string {
  return value.replace(xmlEntity, (entity, name: string) => {
    switch (name) {
      case 'amp': return '&';
      case 'apos':
      case '#39':
      case '#x27': return "'";
      case 'gt': return '>';
      case 'lt': return '<';
      case 'quot': return '"';
      default: return entity;
    }
  });
}

function normalizedVisibleText(source: string): string {
  const values: string[] = [];
  for (const match of source.matchAll(attributeValue)) {
    const value = decodeXml(match[1] ?? '').replace(/\s+/g, ' ').trim();
    if (value) values.push(value);
  }
  return values.join(' ').slice(0, 40_000);
}

function has(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function assessRestrictedScreen(input: {
  packageName: string;
  source: string;
}): RestrictedScreenAssessment {
  const text = normalizedVisibleText(input.source);
  const classes = new Set<RestrictedScreenClass>();

  if (has(text, /\b(?:log[ -]?in|sign[ -]?in|sign up|create account|authentication)\b/i)) {
    classes.add('authentication');
  }
  if (has(text, /\b(?:otp|one[ -]?time password|verification code|enter (?:the )?\d{4,6}[ -]?digit code)\b/i)) {
    classes.add('otp');
  }
  if (has(text, /\b(?:cvv|cvc|upi pin|card number|expiry date|debit card|credit card)\b/i)) {
    classes.add('payment_credentials');
  }
  if (
    has(text, /\b(?:address details|house no|flat no|landmark|pincode)\b/i)
    || sensitiveValuePatterns[4]!.test(text)
    || sensitiveValuePatterns[5]!.test(text)
  ) {
    classes.add('address');
  }
  if (
    has(text, /\b(?:(?:phone|mobile) number|enter (?:your )?(?:phone|mobile))\b/i)
    || sensitiveValuePatterns[0]!.test(text)
  ) {
    classes.add('phone_number');
  }
  if (input.packageName === 'com.android.systemui') {
    classes.add('notification');
  }
  if (
    has(text, /\b(?:account details|profile details|personal information|manage account)\b/i)
    || (
      has(text, /\b(?:account|profile)\b/i)
      && has(text, /\b(?:email|phone|mobile|address)\b/i)
    )
  ) {
    classes.add('account_details');
  }

  const sorted = [...classes].sort();
  return sorted.length === 0
    ? { classes: [], restricted: false }
    : {
        classes: sorted,
        restricted: true,
        safeFallback: {
          kind: 'restricted_screen',
          message: 'This screen contains private information, so visual context was not captured.',
        },
      };
}

export function sanitizeSemanticText(value: string): string | undefined {
  const normalized = decodeXml(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  if (sensitiveValuePatterns.some((pattern) => pattern.test(normalized))) {
    return undefined;
  }
  return normalized.slice(0, 120);
}
