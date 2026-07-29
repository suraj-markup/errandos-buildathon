# GCP Android Worker Design

**Date:** 2026-07-18  
**Status:** Approved architecture; revised for mobile-only Blinkit execution

## Decision

ErrandOS will keep Hermes and the durable transaction control plane on the existing VPC while moving mobile-provider execution to a persistent Android emulator on Google Compute Engine. The owner has authorized deployment inside the existing billing-enabled GCP project. ErrandOS resources are isolated there by a dedicated VPC, subnet, service account, VM, disk, labels, and local state; unrelated existing resources are not modified.

The first release runs one Blinkit account on one emulator. All Blinkit provider interaction uses the official Android application through a provider-specific Appium adapter. Playwright sessions are not used for Blinkit login, search, cart preparation, checkout, commit, status, or reconciliation. The release proves login, session persistence, search, reversible cart preparation, checkout extraction, COD selection, guarded commit, receipt verification, and read-only reconciliation before adding providers or concurrency.

## Project and infrastructure

Use the owner's currently configured, billing-enabled GCP project. Enable only APIs needed for Compute Engine, logging, monitoring, and optional IAP administration. Every created resource uses the `errandos-android` prefix or equivalent ErrandOS labels, and every mutating command explicitly names the authorized project.

The initial worker uses:

- region `asia-south1` and an available Mumbai zone;
- an Intel `n2-standard-8` VM with 8 vCPUs and 32 GB RAM;
- Ubuntu 24.04 x86-64;
- nested virtualization enabled and verified through `/dev/kvm`;
- a 200 GB persistent SSD-backed disk for the OS, Android SDK, emulator data, and encrypted operational state;
- one persistent x86-64 Android virtual device with Google Play services;
- headless graphics through SwiftShader;
- Appium and UiAutomator2 reachable only on the local host;
- automatic restart of the worker and emulator, but never automatic retry of a final provider action.

The owner has authorized the canary VM to remain running while implementation is actively progressing toward a working mobile flow. The VM is stopped if progress becomes blocked on external input or when the owner requests it. Compute, persistent disks, and network usage remain billable while provisioned.

## Topology and trust boundary

```text
Private Telegram / Hermes
          |
          v
ErrandOS control plane on existing VPC
  - typed MCP tools
  - proposals and hashes
  - idempotency and dispatch state
  - receipts and reconciliation
          |
          | authenticated typed jobs
          v
GCP Android worker in dedicated project
  - one-job-at-a-time lease
  - Blinkit Android adapter
  - sanitized observations
          |
          v
Persistent Android emulator
  - official Blinkit app
  - owner session
```

The GCP worker initiates its authenticated connection to the control plane. Appium, ADB, emulator consoles, screenshots, UI XML, and arbitrary device commands are never exposed publicly or through MCP. Administration uses OS Login and IAP or an equivalently restricted management path; no service-account JSON key is created.

## Provider boundary

The current repository policy requires Playwright for every provider interaction. The owner has explicitly reopened that policy for the mobile-first Blinkit slice. Repository guidance, documentation, runtime wiring, and tests must be amended before live product execution so the only active Blinkit provider path is:

```text
BlinkitProviderPort
  `- AndroidBlinkitAdapter
```

Existing Playwright connector code may remain temporarily for migration and test comparison, but it is not instantiated, deployed, or used for any live Blinkit operation. Removing unrelated browser code is not required for the canary; eliminating the active Playwright dependency is required.

Hermes receives only narrow typed provider operations. It never receives raw clicks, coordinates, selectors, JavaScript, ADB commands, screenshots, OTP values, cookies, or profile paths.

The Android adapter owns semantic operations such as authentication status, product search, exact product selection, cart preparation, checkout review, COD selection, one guarded final action, order-status reads, and reconciliation. Provider-specific UI knowledge remains inside the adapter.

## Authentication and sensitive data

The Blinkit application is installed from an official distribution source and logged into the owner's account. Phone and OTP values may pass through typed, short-lived login commands. They are held only long enough to complete the active challenge and are never echoed, logged, persisted, traced, or screenshotted.

Emulator data and provider sessions remain on the dedicated persistent disk. Logs contain operation IDs and sanitized stages, not UI dumps or account details. Any diagnostic screenshot containing personal information is local, short-lived, excluded from source control, and deleted after the diagnostic step.

## Transaction flow

1. Hermes sends an intent to a narrow ErrandOS tool.
2. ErrandOS creates or loads the durable operation and dispatches a typed job.
3. The Android worker acquires the single emulator lease.
4. The Blinkit adapter performs the semantic operation and returns sanitized structured facts.
5. Cart preparation extracts exact item identity, quantity, price, fees, ETA, address label, payment mode, and provider fingerprint.
6. ErrandOS creates an immutable proposal hash.
7. Commit revalidates the exact terms and requires an idempotency key. Personal owner-autonomous mode permits Blinkit COD only.
8. The final provider action is attempted at most once.
9. A verified provider reference produces a committed receipt. Any unverified outcome becomes `ambiguous` and enters read-only reconciliation.

The worker processes only one mutating job per emulator at a time. Reads may be queued but do not bypass the emulator lease.

## Availability and recovery

Worker restarts may repeat safe reads and restart incomplete preparation. They may not repeat a dispatched final action. Dispatch state is durably recorded before the final provider interaction. If the worker disconnects after dispatch, the operation becomes ambiguous until order history provides a unique matching reference.

The emulator disk is persistent across VM restarts. Health checks distinguish VM reachability, KVM availability, emulator boot, Appium readiness, Blinkit installation, authentication state, and provider usability. A failed layer is reported precisely rather than presented as a generic provider failure.

## Canary sequence

The infrastructure canary runs in this order:

1. Verify project authorization, resource isolation, billing status, region, firewall, and service-account scope.
2. Verify Intel virtualization flags, `/dev/kvm`, and Android emulator acceleration.
3. Boot the emulator twice and confirm persistent data.
4. Install or restore the official Blinkit app and confirm Google Play services.
5. Complete owner-supervised phone and OTP login without retaining either value.
6. Restart the VM and confirm the Blinkit session survives.
7. Run product search and extract sanitized results.
8. Add one low-value item, inspect the cart and checkout, and remove it.
9. Detect COD availability and select it only when the provider enables it.
10. Keep live commit disabled and prove that no order was placed.

A later explicitly authorized low-value COD canary may enable commit for one operation. It must preserve proposal hashing, idempotency, exact-term revalidation, at-most-once dispatch, verified receipt requirements, and read-only reconciliation.

## Test and acceptance criteria

Offline tests cover typed contracts, semantic adapter state transitions, redaction, product ambiguity, material-term changes, principal isolation, idempotency, single dispatch, ambiguous outcomes, and reconciliation. Recorded sanitized accessibility fixtures may be used, but raw personal UI state is not committed.

The GCP canary succeeds only when:

- nested KVM acceleration is confirmed;
- the emulator survives restart with its authenticated session;
- Blinkit search and reversible cart preparation work without manual screen interaction;
- exact checkout terms are extracted and reconciled mathematically;
- COD availability is represented truthfully, including provider time restrictions;
- no secret or personal data appears in worker responses or retained diagnostics;
- no order is claimed without a verified provider reference.

If Blinkit blocks the emulator through device-integrity or provider controls, the canary stops. ErrandOS does not bypass device integrity, reverse-engineer private APIs, or misrepresent the device. The fallback is a dedicated physical Android worker, not an unsafe emulator workaround.

## Explicit non-goals

- No modification of unrelated resources in the authorized existing GCP project.
- No Jetson Nano or personal-phone dependency.
- No Zepto, Instamart, Rapido, or additional provider in the first slice.
- No parallel provider sessions in the first slice.
- No live Playwright session or browser-profile dependency for Blinkit.
- No custom ErrandOS Android application; automation targets the official Blinkit app.
- No card, UPI, wallet, or bank-challenge automation.
- No public Appium, ADB, VNC, or emulator-console endpoint.
- No generic browser or device-control MCP tool.
