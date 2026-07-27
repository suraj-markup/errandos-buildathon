# Rapido Android implementation roadmap

**Updated:** 2026-07-26

| Step | Definition of done | Status | Evidence |
| --- | --- | --- | --- |
| 1. Official app and auth | Rapido Play build runs on the isolated worker; phone/OTP stay inside typed tools | In progress | Official Play package `com.rapido.passenger` is installed and the obsolete Ola app is removed; typed login deployment is pending |
| 2. Typed ride contracts | Readiness, quote, prepare, compare, request, status, reconcile, and recent-trip schemas reject raw device data | Complete locally | Contract tests |
| 3. Immutable ride proposal | Route, option, fare range, fees, ETA, payment, expiry, and fingerprint are hashed and owner-isolated | Complete locally | Application tests |
| 4. Android ride adapter | Provider-specific adapter and worker operations are gated and fail closed | Complete locally; deployment pending | Provider tests cover login, quote parsing, preparation, at-most-once commit, and reconciliation |
| 5. At-most-once request | Exact-term revalidation, durable dispatch reservation, idempotency, verified reference, and ambiguous handling | Complete locally; live commit disabled | Commit/reconciliation tests |
| 6. Hermes MCP surface | Twelve focused Rapido tools, including OTP challenge recovery, and safe rendering guidance | Complete locally; deployment pending | MCP discovery and invocation tests |
| 7. Prepare-only canary | Authenticate in the real app, quote a real route, and prepare without requesting | Waiting for typed login deployment | The owner supplied the phone number; it will be passed only through `rapido_begin_login` after deployment |
| 8. Low-risk request canary | Separately approve one exact proposal and verify provider reference | Not started | Requires Step 7 plus explicit owner authorization and both live gates |

The Rapido-specific `ERRANDOS_RAPIDO_LIVE_COMMIT` gate stays off until Step 7 passes, even when Blinkit’s shared live commit gate is on. A canary timeout or unverified result is never retried as a final action.
