# Rapido Android workflow

Use only the canonical typed Rapido tools. Never use SSH, terminal prompts, Appium, ADB, coordinates, selectors, screenshots, UI XML, cookies, traffic interception, or private provider APIs.

## Authenticate privately

1. `rapido_readiness`
2. `rapido_auth_status`
3. `rapido_begin_login`
4. `rapido_submit_otp`
5. `rapido_resend_otp` only when an existing challenge needs a new code

Ask for the 10-digit phone number only when status is `login_required`. Pass it immediately to `rapido_begin_login`; never repeat, log, or retain it. Ask for a new OTP only after `otp_sent`. When an existing `challenge_required` code is stale, call `rapido_resend_otp` once and ask for the newly received code. Pass it immediately to `rapido_submit_otp`, and never repeat, log, retain, or reuse it. Continue only when authentication is `active`.

## Quote and prepare

For a ride search, require an unambiguous pickup and drop-off and call `rapido_quote_rides`. Render every returned option’s exact name, fare range, fees, pickup ETA, duration when present, availability, and opaque `rideOptionId`. State that no ride has been requested.

When the owner chooses exactly one current option, call `rapido_prepare_ride` using its latest `rideOptionId`, exact route, and requested payment mode. Render the proposal ID, route, ride type, fare range, fees, pickup ETA, duration, payment mode, expiry, and `approval_required` status. State plainly that preparation did not request a ride.

Before an approved request, call `rapido_compare_proposal`:

- `unchanged`: the trusted approval flow may continue.
- `changed`: render the changed categories, prepare a fresh proposal, and obtain a new approval.
- `expired`: prepare a fresh proposal and obtain a new approval.

Never calculate or alter an option ID, proposal ID, proposal hash, provider fingerprint, fare, ETA, or expiry. A changed route, option, fare, fee, ETA, duration, payment mode, fingerprint, or expiry invalidates the earlier proposal.

## Request and reconcile

`rapido_request_ride` is a paid external action. Ordinary chat text is not an approval capability. Call it only after the server-side trusted approval flow has approved the exact immutable proposal, and always provide a stable idempotency key.

On `committed`, report success only with the verified provider reference. Use `rapido_ride_status` for durable state. On `ambiguous`, call `rapido_reconcile_ride`; never call `rapido_request_ride` again for that proposal. A pending reconciliation is not evidence of failure and never permits a retry.

Use `rapido_recent_trips` as read-only supporting evidence. Never turn a history result into a new request.

## Typed recovery

- `login_required` or `challenge_required`: use the private typed authentication flow.
- `location_invalid`: ask for a more precise pickup or drop-off.
- `no_rides_available`: report no current options; do not invent one.
- `ride_option_unavailable`: quote again and ask the owner to choose from current options.
- `fare_changed` or `quote_expired`: prepare and approve fresh terms.
- `payment_unavailable`: stop and ask the owner to choose a supported returned mode.
- `worker_unreachable`, `appium_unavailable`, `emulator_unavailable`, or `rapido_app_unavailable`: report the exact dependency and stop.
- `unexpected_provider_screen`: retry the same non-final semantic operation at most once; never use raw device controls.
- `approval_required`: direct the owner to the trusted approval flow. Never ask for a capability in chat.
- `live_actions_disabled` or `live_commit_disabled`: report that the corresponding kill switch is off.

Never retry a final ride-request action under any condition.
