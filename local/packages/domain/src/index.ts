export type ErrandState = 'draft' | 'awaiting_confirmation' | 'completed' | 'cancelled';
export interface Errand { readonly id: string; readonly summary: string; readonly state: ErrandState }

export const PROVIDER_SESSION_TRANSITIONS = {
  login_required: ['authenticating', 'revoked'], authenticating: ['challenge_required', 'active', 'error', 'revoked'],
  challenge_required: ['authenticating', 'active', 'error', 'revoked'], active: ['expired', 'revoked', 'error'],
  expired: ['authenticating', 'revoked'], error: ['authenticating', 'revoked'], revoked: [], missing: ['authenticating'],
} as const;
export function canTransition(from: keyof typeof PROVIDER_SESSION_TRANSITIONS, to: string): boolean { return (PROVIDER_SESSION_TRANSITIONS[from] as readonly string[]).includes(to); }
