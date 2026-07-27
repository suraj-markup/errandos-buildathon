CREATE TABLE proposal_revisions (
  proposal_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  principal_id text NOT NULL,
  idempotency_key text NOT NULL,
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_id, revision),
  UNIQUE (principal_id, idempotency_key),
  UNIQUE (proposal_id, revision, principal_id, proposal_hash)
);

CREATE TABLE approval_requests (
  id text PRIMARY KEY,
  principal_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_revision integer NOT NULL,
  proposal_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  request_token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, principal_id, proposal_id, proposal_revision, proposal_hash),
  FOREIGN KEY (proposal_id, proposal_revision, principal_id, proposal_hash)
    REFERENCES proposal_revisions(proposal_id, revision, principal_id, proposal_hash)
);

CREATE TABLE approval_decisions (
  id text PRIMARY KEY,
  approval_request_id text NOT NULL UNIQUE,
  principal_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_revision integer NOT NULL,
  proposal_hash text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (approval_request_id, principal_id, proposal_id, proposal_revision, proposal_hash)
    REFERENCES approval_requests(id, principal_id, proposal_id, proposal_revision, proposal_hash)
);

CREATE TABLE authorization_capabilities (
  jti text PRIMARY KEY,
  approval_request_id text NOT NULL,
  principal_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_revision integer NOT NULL,
  proposal_hash text NOT NULL,
  action text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > issued_at),
  FOREIGN KEY (approval_request_id, principal_id, proposal_id, proposal_revision, proposal_hash)
    REFERENCES approval_requests(id, principal_id, proposal_id, proposal_revision, proposal_hash)
);

CREATE TABLE commit_attempts (
  id text PRIMARY KEY,
  principal_id text NOT NULL,
  proposal_id text NOT NULL,
  proposal_revision integer NOT NULL,
  proposal_hash text NOT NULL,
  capability_jti text NOT NULL REFERENCES authorization_capabilities(jti),
  status text NOT NULL CHECK (status IN ('reserved','dispatching','committed','ambiguous','failed_terminal','cancelled')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, principal_id),
  FOREIGN KEY (proposal_id, proposal_revision, principal_id, proposal_hash)
    REFERENCES proposal_revisions(proposal_id, revision, principal_id, proposal_hash)
);
CREATE UNIQUE INDEX commit_attempts_one_active_revision
  ON commit_attempts(proposal_id, proposal_revision)
  WHERE status IN ('reserved','dispatching','ambiguous');

CREATE TABLE transaction_receipts (
  id text PRIMARY KEY,
  commit_attempt_id text NOT NULL UNIQUE,
  principal_id text NOT NULL,
  provider_reference text,
  status text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (commit_attempt_id, principal_id) REFERENCES commit_attempts(id, principal_id)
);

CREATE TABLE transaction_runtime_proposals (
  proposal_id text PRIMARY KEY,
  principal_id text NOT NULL,
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transaction_runtime_proposals_owner ON transaction_runtime_proposals(principal_id);

CREATE TABLE transaction_runtime_idempotency (
  principal_id text NOT NULL,
  idempotency_key text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(principal_id,idempotency_key)
);

CREATE TABLE transaction_outbox (
  id text PRIMARY KEY,
  principal_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX transaction_outbox_pending ON transaction_outbox(available_at, created_at) WHERE delivered_at IS NULL;

CREATE TABLE reconciliation_attempts (
  id text PRIMARY KEY,
  commit_attempt_id text NOT NULL,
  principal_id text NOT NULL,
  status text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (commit_attempt_id, principal_id) REFERENCES commit_attempts(id, principal_id)
);

CREATE TABLE lifecycle_events (
  event_id text PRIMARY KEY,
  operation_id text NOT NULL,
  principal_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  kind text NOT NULL,
  phase text NOT NULL,
  terminal boolean NOT NULL,
  retryable boolean NOT NULL,
  display jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (principal_id, operation_id, sequence)
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  principal_id text NOT NULL,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  metadata jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE TRIGGER proposal_revisions_append_only BEFORE UPDATE OR DELETE ON proposal_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
