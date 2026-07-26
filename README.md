# JaldiAI

JaldiAI turns a spoken or written errand into a reviewable, transaction-safe
action. This repository contains two first-class ways to run it.



https://github.com/user-attachments/assets/bd348bae-bda7-484f-8857-7aa9803e283c


## Implementations

### Hosted

[`hosted/`](hosted/) is the Hermes-oriented hosted implementation. It contains
the web interface, control plane, workers, typed MCP tools, provider adapters,
durable transaction state, and remote Android-worker infrastructure.

See [the hosted overview](hosted/HOSTED.md) and
[hosted setup guide](hosted/README.md).

### Local

[`local/`](local/) is the phone-first implementation used for the buildathon
demo. A circular push-to-talk overlay records while held, uses Sarvam for
Indian-language speech recognition and speech generation, asks spoken
follow-up questions when a product is ambiguous, and drives the official app
through Appium on the Mac.

See [the local overview](local/LOCAL.md), [product description](local/docs/PRODUCT.md),
and [build log](local/docs/BUILD_LOG.md).

## Safety boundary

- Searching and cart preparation may interact with the provider app.
- A broad product request asks the user to choose instead of silently selecting
  a top result.
- Preparation never silently places an order.
- Exact cart and checkout terms are reviewed before any final action.
- Final paid actions require explicit confirmation, idempotency, and verified
  provider evidence.
- An uncertain result is recorded as ambiguous and checked read-only instead
  of blindly retried.

## Setup

Each implementation is an independent pnpm workspace:

```bash
pnpm --dir local install
pnpm --dir local test

pnpm --dir hosted install
pnpm --dir hosted test
```

Copy the relevant template before running:

- Hosted: `hosted/.env.example` → `hosted/.env`
- Local voice server: `local/apps/voice/.env.example` →
  `local/apps/voice/.env.local`

Real env files are intentionally ignored and stay only on the development
machine. Only safe `.env.example` templates are committed.
