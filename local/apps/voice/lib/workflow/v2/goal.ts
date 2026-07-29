import type { DesiredTerminalOutcomeV2 } from './contracts';

export type PreservedGoalRequestV2 = {
  kind: 'add';
  subject: string;
  quantity: number;
  constraints: string[];
};

export type PreservedUserGoalV2 = {
  originalGoal: string;
  goalKind: 'multi_item_acquisition';
  requests: PreservedGoalRequestV2[];
  desiredTerminalOutcome: DesiredTerminalOutcomeV2;
};

const quantities: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function desiredOutcome(goal: string): DesiredTerminalOutcomeV2 {
  const normalized = goal.toLocaleLowerCase('en-IN').replace(/\s+/g, ' ').trim();
  const cod = /\bcod\b|cash\s+on\s+delivery|pay\s+on\s+delivery/.test(normalized);
  const explicitOrder =
    /\b(?:place|submit|complete|confirm)\s+(?:the\s+)?order\b/.test(normalized)
    || /\border\s+(?:it|them|these|now)\b/.test(normalized);
  if (explicitOrder) {
    return {
      kind: 'order_placed',
      paymentPreference: cod ? 'cod' : 'ask_user',
    };
  }
  if (/\bcheckout\b|\breview\s+(?:the\s+)?(?:cart|order)\b/.test(normalized)) {
    return {
      kind: 'checkout_reviewed',
      paymentPreference: cod ? 'cod' : 'ask_user',
    };
  }
  if (
    /\bask\s+me\b|\bwhat\s+(?:to\s+do\s+)?next\b|\bthen\s+ask\b/.test(normalized)
  ) {
    return { kind: 'ask_next' };
  }
  return { kind: 'cart_ready' };
}

function actionClause(goal: string): string {
  return goal
    .replace(
      /\b(?:and\s+then|then)\s+(?:ask|review|open|go\s+to|proceed\s+to|place|submit|complete|confirm|order)\b[\s\S]*$/i,
      '',
    )
    .replace(
      /\b(?:and\s+)?(?:place|submit|complete|confirm)\s+(?:the\s+)?order\b[\s\S]*$/i,
      '',
    )
    .replace(/\b(?:and\s+)?order\s+(?:it|them|these|now)\b[\s\S]*$/i, '')
    .replace(
      /\b(?:and\s+)?(?:review|open|go\s+to|proceed\s+to)\s+(?:the\s+)?(?:cart|checkout|order)\b[\s\S]*$/i,
      '',
    )
    .replace(/\b(?:using|with|via)\s+(?:cod|cash\s+on\s+delivery)\b[\s\S]*$/i, '')
    .replace(/^\s*(?:please\s+)?(?:add|buy|get|put)\s+/i, '')
    .trim();
}

function parseRequest(fragment: string): PreservedGoalRequestV2 | undefined {
  const cleaned = fragment
    .replace(/\b(?:to|into)\s+(?:my\s+|the\s+)?cart\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  const match = /^(?:(\d+|[a-z]+)\s+)?(.+)$/i.exec(cleaned);
  if (!match) return undefined;
  const token = match[1]?.toLocaleLowerCase('en-IN');
  const numeric = token && /^\d+$/.test(token) ? Number(token) : quantities[token ?? ''];
  const quantity = numeric && numeric > 0 ? numeric : 1;
  const subject = (numeric ? match[2]! : cleaned).trim();
  if (!subject) return undefined;
  const constraints = [
    ...subject.matchAll(
      /\b\d+(?:\.\d+)?\s*(?:ml|l|lit(?:re|er)s?|g|gm|kg|pack(?:et)?s?|pieces?|pcs?)\b/gi,
    ),
  ].map((entry) => entry[0]!.trim());
  return {
    kind: 'add',
    subject,
    quantity,
    constraints,
  };
}

export function preserveUserGoalV2(originalGoal: string): PreservedUserGoalV2 {
  if (!originalGoal.trim()) throw new Error('A user goal cannot be empty.');
  const clause = actionClause(originalGoal);
  const requests = clause
    .split(/\s*,\s*|\s+\band\b\s+|\s+और\s+/i)
    .map(parseRequest)
    .filter((request): request is PreservedGoalRequestV2 => Boolean(request));
  if (requests.length === 0) {
    throw new Error('The user goal does not contain an actionable subject.');
  }
  return {
    originalGoal,
    goalKind: 'multi_item_acquisition',
    requests,
    desiredTerminalOutcome: desiredOutcome(originalGoal),
  };
}
