CREATE TABLE provider_sessions (
  id text PRIMARY KEY, principal_id text NOT NULL, provider_kind text NOT NULL, provider_id text NOT NULL,
  account_key text NOT NULL, status text NOT NULL CHECK (status IN ('login_required','authenticating','active','challenge_required','expired','revoked','error')),
  auth_method text, encrypted_profile_reference bytea, account_display_label text, account_display_hint text,
  expires_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, provider_kind, provider_id, account_key)
);
CREATE TABLE login_challenges (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
  principal_id text NOT NULL, challenge_type text NOT NULL, status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_sessions_expiry_idx ON provider_sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX login_challenges_session_idx ON login_challenges(session_id, status);
