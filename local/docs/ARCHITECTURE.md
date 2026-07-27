# Architecture

## Boundary

```text
User
  ↓
Hermes — conversation, intent, and orchestration
  ↓
JaldiAI tools — narrow typed capabilities
  ↓
Application layer — proposals, approval, idempotency, lifecycle
  ↓
Provider port
  ├── deterministic demo adapter
  └── optional Blinkit Android adapter
  ↓
Durable proposal, operation, and receipt records
```

Hermes owns language and decision-making. JaldiAI owns provider access and transaction correctness.

## Planned modules

- `contracts`: schemas for products, proposals, approvals, lifecycle states, and receipts.
- `application`: proposal creation, canonical hashing, approval checks, commit coordination, and reconciliation.
- `provider-demo`: deterministic search, preparation, commit, and failure simulation.
- `control-plane`: typed tools presented to Hermes.
- `web`: request, proposal review, and receipt/status experience.

## State model

```text
draft
  → prepared
  → approved
  → dispatching
  ├── committed
  ├── blocked
  └── ambiguous → reconciling → committed | failed
```

The transition to `dispatching` is durable and happens before the single final-action attempt. No automatic transition may repeat that attempt.

## Live-provider boundary

The deterministic adapter is the default buildathon path. Any live Blinkit work must use the official Android app through a provider-specific adapter, keep final commits disabled by default, and expose neither raw device controls nor credentials through the tool surface.
