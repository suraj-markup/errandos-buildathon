# Provider adapter scope

**Updated:** 2026-07-26

JaldiAI has two active provider-specific capabilities:

- Blinkit COD through the official Android app on the dedicated GCP emulator.
- Rapido authentication and transaction-safe ride tooling through the official Android app on the isolated Appium worker.

## Active path

`Hermes → typed MCP tool → durable transaction service → provider-specific Android adapter → typed SSH/IAP job → local Appium → official provider app`

`AndroidBlinkitAdapter` supports authentication, product/cart operations, exact checkout preparation, COD selection, at-most-once final ordering, verified receipts, and read-only reconciliation.

`AndroidRapidoAdapter` supports readiness, authentication, exact-route ride quotes, immutable ride preparation, exact-term comparison, externally approved at-most-once ride requests, durable status, recent-trip reads, and read-only reconciliation. Rapido commits remain disabled by the independent `ERRANDOS_RAPIDO_LIVE_COMMIT` kill switch until a prepare-only real-app canary has calibrated exact live screens and a separately approved low-risk request is authorized.

## Explicitly absent

- No Playwright or Chromium provider runtime.
- No persistent browser profiles or browser-login sessions.
- No other ride, grocery, courier, or product provider transaction adapter in the current slice.
- No private/mobile API reverse engineering, traffic interception, integrity bypass, or raw Appium/ADB access through MCP.
- No fallback from Android to a browser when Android is unavailable.

Adding another provider requires a separate typed adapter, fixtures, exact-term extraction, idempotency tests, ambiguous-outcome handling, and a supervised canary. It must not reuse Blinkit selectors or silently activate a browser runtime.

## Release evidence

Code and fixture tests do not prove a live app flow. Blinkit readiness requires its existing prepare-only canary. Rapido readiness requires an authenticated prepare-only canary that verifies route resolution, ride option identity, fare range, fees, pickup ETA, payment mode, and provider fingerprint. A real final action additionally requires trusted external approval, both live gates, and a verified provider reference.
