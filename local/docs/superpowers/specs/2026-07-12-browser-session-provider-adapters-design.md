# Browser-Session Provider Adapters Design

**Date:** 2026-07-12

**Status:** Approved architecture; grocery implementation plan ready

**Execution map:** See [`docs/provider-adapter-scope.md`](../../provider-adapter-scope.md) for cross-session status, dependencies, evidence gates, and the complete delivery path.

## Objective

Make ErrandOS perform provider work through controlled Playwright browser sessions. The first production slice covers Blinkit and Zepto grocery discovery, authenticated cart preparation, COD review, trusted approval, one guarded order attempt, receipt detection, and read-only reconciliation. A future slice may apply the same transaction boundary to Rapido discovery, authentication, ride quotes, booking, status, and reconciliation.

Hermes remains the conversation and orchestration layer. ErrandOS remains the only component that owns browser sessions, provider state, exact proposals, approval verification, commit authority, receipts, and reconciliation.

## Scope and delivery sequence

The implementation is tracked as a full outcome path rather than stopping at adapter navigation. Each provider must progress through discovery, supervised authentication, preparation, immutable review, independent approval, exact revalidation, one final action, verified receipt or ambiguous state, and read-only reconciliation. A provider is not marked complete merely because its selectors work or it reaches a checkout/booking screen.

### Slice 1: shared browser runtime

- Principal-scoped provider profiles and account references.
- Supervised login sessions for Blinkit, Zepto, and Rapido.
- Short-lived isolated browser contexts for anonymous discovery.
- Persistent browser contexts for authenticated discovery and transactional work.
- Exclusive leases, stale-lock recovery, bounded timeouts, and guaranteed context cleanup.
- Sanitized provider fixtures and redacted drift diagnostics.

### Slice 2: Blinkit and Zepto COD

- Search both providers through their web interfaces.
- Select exact product variants and quantities.
- Prepare provider carts and reach the final review screen without ordering.
- Extract exact line items, fees, discounts, total, ETA, address summary, and COD availability.
- Produce immutable proposal revisions and a provider-state fingerprint.
- Commit only after independent trusted approval and exact pre-click revalidation.
- Attempt the final provider action once at most.
- Persist a verified order reference or enter `ambiguous` reconciliation.

### Slice 3: Rapido rides

- Search and quote through provider web interfaces rather than third-party ride APIs.
- Select exact pickup, destination, ride category, payment mode, fare, and ETA.
- Prepare without requesting a driver.
- Apply the same approval, revalidation, one-action, receipt, and reconciliation rules as grocery.

## Provider interaction policy

Every provider-side operation uses a typed provider adapter backed by Playwright. This includes search, login, preparation, commit, status, and reconciliation. Authenticated operations use persistent Chromium profiles isolated by principal, provider, and account key. Anonymous discovery may use a fresh temporary context, but it still runs through the same browser runtime and provider adapter boundary.

Cookies, storage state, OTPs, passwords, selectors, page handles, browser profile paths, screenshots, traces, and raw DOM are internal runtime data. Hermes and MCP never receive them. Operators may configure selectors and supervised profiles directly in the secured runtime, but those values are not accepted as chat inputs or generic MCP parameters.

ErrandOS will not reverse-engineer private mobile APIs, replay intercepted provider requests, bypass anti-bot or authentication controls, or expose generic click, JavaScript, navigation, or session tools. Each adapter interacts with the visible provider web experience and must be reviewed against the provider's terms before live use.

## Architecture

### Browser runtime

The shared runtime owns browser installation checks, context creation, profile directory resolution, profile leases, session timeouts, graceful shutdown, and diagnostics. A profile key is derived from `principalId + provider + accountKey` through an HMAC reference resolver. Raw identity data and filesystem paths never cross the runtime boundary.

Persistent Chromium profile data is credential-equivalent. ErrandOS restricts profile directories to mode `0700` and files to `0600`; production deployment places the data root on an encrypted volume with restricted operating-system access. The application does not claim to encrypt Chromium's live profile format itself.

The runtime exposes narrow internal operations such as opening an anonymous discovery context or running work inside an exclusively leased authenticated context. It does not expose a browser object to MCP.

### Provider adapters

Blinkit, Zepto, and Rapido each receive separate modules for login detection, selectors, extraction, preparation, commit, and reconciliation. Selectors are never shared merely because two sites look similar.

Each adapter implements only typed domain ports:

- Product discovery returns grounded offers with stable provider identity, title, variant, price, delivery claim, URL, image when present, and availability.
- Grocery preparation returns an exact grocery proposal snapshot plus an opaque provider-state reference and fingerprint.
- Ride preparation returns an exact ride proposal snapshot plus an opaque provider-state reference and fingerprint.
- Commit accepts only the already-authorized internal dispatch record; it does not accept arbitrary target or selector input.
- Reconciliation reads provider history or current activity without performing an order, booking, cancellation, or retry.

### Selector and extraction strategy

Selector candidates are ordered by stability: test identifiers, exact accessible role and name, label or input name, provider-specific scoped structure, and finally tightly scoped text. Every product, option, payment method, and final-action selector must resolve uniquely inside its intended container. A global `.first()` is forbidden for product choice, ride choice, payment selection, and final actions.

Selectors and extractors are derived from sanitized captures made during supervised sessions. Captures must remove names, phone numbers, full addresses, order IDs, vehicle identifiers, cookies, tokens, and payment data before entering the repository. If a selector is missing, non-unique, or inconsistent with the extracted review, the operation fails safely before commit.

### Durable transaction flow

1. Hermes invokes a typed search or preparation tool.
2. ErrandOS resolves the principal-scoped provider profile and obtains an exclusive lease.
3. The provider adapter navigates the visible provider web flow.
4. Preparation stops at the final review state and extracts exact material terms.
5. ErrandOS persists canonical proposal bytes, SHA-256 hash, expiry, provider-state reference, and provider fingerprint.
6. Hermes renders the exact proposal and trusted approval URL; normal chat text is not authorization.
7. The independent approval service binds a single-use authorization to principal, proposal ID, revision, hash, action, and expiry.
8. The commit service atomically consumes authorization, reserves dispatch, and writes an outbox event under the idempotency key.
9. A worker reacquires the provider session and re-extracts the review state.
10. Any material difference creates a stale proposal and stops the dispatch.
11. A unique final-action control is invoked at most once.
12. A verified provider order or ride reference creates a committed receipt. Any unverified outcome becomes `ambiguous`.
13. Reconciliation reads provider history/current activity and either attaches a verified reference or remains ambiguous; it never repeats the final action.

## Grocery behavior

Blinkit and Zepto adapters keep independent cart policies. Preparation verifies the active account and delivery location, searches each requested item, identifies an exact provider product and variant, applies the requested quantity, and extracts the complete review totals. COD must be visibly available and selected in the provider review before a COD proposal can be created.

The grocery fingerprint includes provider, account reference, delivery-location reference, provider cart identifiers when available, every product ID and variant, quantity, unit price, line total, fee and discount breakdown, grand total, ETA, payment mode, proposal revision, and quote expiry. Any change to those fields invalidates approval.

The final order control must be uniquely identified on the exact review page. After the single invocation, the adapter waits for an explicit confirmation reference or checks order history read-only. Timeout, browser crash, navigation interruption, duplicate-looking confirmation, or missing provider reference produces `ambiguous`, never an automatic retry.

## Ride behavior

Rapido adapters use their authenticated web experiences through persistent provider sessions. Preparation resolves pickup and destination through visible autocomplete results, extracts all offered ride categories, selects the requested category, verifies the payment method, and records the exact fare or fare range, pickup ETA, route summaries, and quote expiry.

The ride fingerprint includes provider, account reference, normalized pickup and destination references, ride category ID and name, fare bounds, fees, ETA, payment mode, revision, and expiry. Any material difference requires a fresh proposal and approval.

The booking control follows the same uniqueness and one-invocation rule. Reconciliation reads current ride or trip history and correlates only on a provider reference or a unique combination of route, ride category, fare, and time window. It never requests or cancels a ride.

## Authentication and supervised sessions

`provider_begin_login` opens a visible persistent context for the selected provider and account key. The user enters passwords, OTPs, or CAPTCHA responses only in that provider browser. ErrandOS persists redacted session lifecycle state such as `authenticating`, `challenge_required`, `active`, `expired`, `revoked`, or `error`.

An adapter verifies authentication using provider-specific visible account markers. It never returns cookies or account PII as proof. Login leases include process identity, process start time, and expiry so abandoned locks can be recovered without allowing concurrent profile use.

## Errors and lifecycle states

- Missing or expired authentication returns `login_required` or `challenge_required` without leaking provider details.
- Provider layout drift fails preparation before a proposal is issued.
- Unavailable COD, unavailable ride category, changed location, or changed material terms returns a precise non-commit result.
- Expired proposals become `stale`.
- Failed authorization consumption performs no provider action.
- A crash before dispatch reservation is safely retryable through the same idempotency key.
- A crash after entering `dispatching` becomes `ambiguous` and queues reconciliation.
- Provider throttling and temporary unavailability use bounded retries only for read-only navigation before the final action.

## Observability and data handling

Logs contain operation IDs, principal-scoped opaque references, provider names, lifecycle states, bounded error codes, and timings. They exclude search text when it may contain personal data, full addresses, phone numbers, cookies, tokens, raw HTML, screenshots, and browser paths.

Drift evidence is opt-in, redacted before persistence, stored outside source control, and deleted according to an operator retention policy. Metrics use bounded provider and operation labels and never contain user-supplied text.

## Testing and live verification

The automated suite uses sanitized provider fixtures and fake browser pages for deterministic selector, extraction, fingerprint, lifecycle, concurrency, and crash-recovery tests. It proves principal isolation, material-change hash changes, idempotent duplicate handling, single-use approval, one final-action invocation, ambiguous outcomes, and secret/PII redaction.

Live verification proceeds in explicit tiers:

1. Supervised login and read-only status on dedicated provider accounts.
2. Live discovery and read-only history with no cart or ride mutation.
3. Live Blinkit and Zepto cart preparation with commits disabled, followed by proof that no order was placed.
4. One low-value COD grocery canary per provider using independent approval and a spending ceiling.
5. Live Rapido quote preparation with booking disabled.
6. A ride booking canary only for a genuine needed ride, with independent approval and live commit explicitly enabled.

Ordinary CI never performs live provider actions. Both `ERRANDOS_LIVE_BROWSER_ACTIONS=true` and `ERRANDOS_LIVE_COMMIT=true` remain off by default and are separately required for a final action.

## Acceptance criteria

- Grocery product discovery for Blinkit and Zepto, plus ride discovery and quote preparation for Rapido, runs through typed Playwright adapters.
- Every authenticated provider action uses a principal/provider/account-isolated persistent session.
- Blinkit and Zepto can prepare exact COD proposals and stop before ordering.
- A trusted approved proposal can trigger at most one final grocery action after exact revalidation.
- Rapido can prepare exact ride proposals and stop before booking.
- A trusted approved proposal can trigger at most one final ride action after exact revalidation.
- Committed status always includes a verified provider reference; otherwise status is ambiguous or failed without a success claim.
- Reconciliation is read-only and cannot retry, order, book, or cancel.
- Hermes and MCP never receive secrets, selectors, raw browser controls, profile paths, or approval capabilities.
- Fixture, integration, concurrency, crash-recovery, and redaction tests pass, followed by the gated supervised live-test ladder.

## Preconditions for live use

Operators must provide dedicated test accounts, supervised login access, an encrypted deployment volume, PostgreSQL, trusted approval issuer keys, and explicit live-action environment gates. Provider terms and applicable authorization must be reviewed before live automation. Real purchases and rides are never used as routine automated tests.
