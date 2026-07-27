# Product brief

## Problem

Assistants can understand “get groceries for dinner,” but real purchases need more than a plausible chat response. Prices change, products go out of stock, addresses differ, checkout can time out, and retrying a final action can create duplicate orders.

## Positioning

JaldiAI is a personal operations control plane for real-world errands in India. It gives Hermes a narrow, typed, and durable way to prepare and execute provider actions without moving credentials, provider sessions, or transaction safety into the conversation layer.

## User promise

Say what you need. Review the exact terms. Approve once. Know what happened.

## Demo story

1. The user asks Hermes for grocery items in natural language.
2. Hermes searches through an JaldiAI tool and resolves exact offers.
3. JaldiAI prepares a cart proposal and returns exact prices, fees, ETA, address label, payment mode, expiry, and a proposal hash.
4. The interface makes it explicit that nothing has been ordered yet.
5. The user approves the current immutable proposal.
6. JaldiAI uses an idempotency key, attempts the final action at most once, and returns a verified receipt or an ambiguous state requiring read-only reconciliation.

## Why it is different

The core artifact is not the chat UI. It is the safety boundary between AI reasoning and a paid external action:

- typed provider capabilities instead of generic device control;
- immutable proposal snapshots instead of conversational assumptions;
- exact-term comparison before commit;
- durable idempotency instead of retrying a click;
- reconciliation instead of claiming success after a timeout.

## Success criteria

- A judge can complete the deterministic flow without external account setup.
- Every state transition is visible and understandable.
- Replaying the same approval does not duplicate the action.
- Changing a material term invalidates the earlier approval.
- A simulated timeout produces `ambiguous`, never a false success.
- The repo contains tests and dated evidence for each claim made in the demo.
