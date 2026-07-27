---
name: errandos
description: Operate the owner's Blinkit and Rapido accounts through typed ErrandOS tools. Use for private provider login, Blinkit grocery workflows, and Rapido ride workflows.
---

# ErrandOS

Use only typed provider-specific ErrandOS MCP tools. Interpret the owner's intent and present results; let ErrandOS own provider sessions, proposal hashes, idempotency, final actions, receipts, and reconciliation.

## Tool boundary

Call the native ErrandOS MCP tools directly. Never use the terminal, `mcporter`, `gcloud`, SSH, Appium, ADB, deployment scripts, or the Android worker command to perform or diagnose a Blinkit operation. Those are private transport and deployment details owned by ErrandOS.

If a canonical ErrandOS tool is not initially visible and the host exposes tool discovery, search the deferred tool catalog once for its exact name. Report that the ErrandOS MCP integration is unavailable only when the canonical tool is still not callable after discovery. If a callable tool returns an error, report the exact safe error category instead; never misstate a failed provider operation as missing tools. Apply only the bounded semantic recovery documented below. Do not fall back to provider automation or cloud administration, and do not ask the owner to refresh Google Cloud authentication.

Read [references/blinkit-android-workflow.md](references/blinkit-android-workflow.md) before preparing or placing a Blinkit order. Read [references/rapido-android-workflow.md](references/rapido-android-workflow.md) before authenticating or operating Rapido. Read [references/architecture.md](references/architecture.md) when explaining proposal hashes, recovery, or uncertain outcomes. Use [references/rendering-examples.md](references/rendering-examples.md) when formatting results. See [references/sarvam-telegram-voice.md](references/sarvam-telegram-voice.md) for multilingual Sarvam voice-wrapper handling and search-retry examples.

## Rapido authentication

Use `rapido_auth_status` → `rapido_begin_login` → `rapido_submit_otp`. Ask for the phone and OTP only in the private owner conversation and pass each value immediately to its typed tool. Never repeat either value, retain it in memory or notes, include it in ordinary responses, or use a terminal/SSH/Appium fallback. Continue only when `rapido_auth_status` or `rapido_submit_otp` returns `active`. If an existing challenge needs a new code, call `rapido_resend_otp` once and ask for the newly received OTP; never reuse the old value.

## Rapido rides

Call `rapido_readiness` before the first Rapido ride operation. Use `rapido_quote_rides` for an exact pickup/drop-off, present all exact returned terms, and use the latest opaque `rideOptionId` with `rapido_prepare_ride`. Preparation never requests a ride. Render the immutable proposal and its expiry, then use `rapido_compare_proposal` before any approved request.

`rapido_request_ride` always requires trusted server-side approval and a stable idempotency key; chat text alone is not approval. On an uncertain final action, call `rapido_reconcile_ride` and never request the ride again. Use `rapido_ride_status` and `rapido_recent_trips` only as read-only evidence. Follow every detailed rule in [references/rapido-android-workflow.md](references/rapido-android-workflow.md).

## Multilingual / Sarvam voice turns

The owner may send Telegram text that begins with a Sarvam STT wrapper such as `[Voice input transcribed by Sarvam. Detected language: Marathi (mr-IN), probability: 1.0. Reply in this same language ...]` followed by an English transcript. Treat the wrapper as user context, not provider/tool output: answer in the detected language unless the owner asks otherwise, but keep exact Blinkit facts (product names, pack sizes, quantities, prices, fees, totals, ETA, address labels, proposal/order IDs, statuses) unmodified and source-grounded.

For multilingual ordering requests, do not add an extra translation/planning step when the intent is clear. Proceed through the normal typed Blinkit workflow: search exact products, ask about ambiguous variants in the detected language, render exact terms, and keep the final COD confirmation boundary unchanged.

## Choose the operation

- Before the first Blinkit operation in a conversation, or after an availability failure, call `blinkit_readiness`. Continue only when it returns `ready`; follow the typed recovery table below for other states.
- For “which screen is Blinkit on,” or after one semantic search/add failure that may be screen-related, call `blinkit_current_screen`. It returns only a sanitized screen kind and safe product/cart context; it never returns a screenshot or Android internals.
- For “find,” “search,” or “show options,” call `blinkit_search_products`. Do not change the cart. When a generic search returns `no_results`, retry once with a broader or brand-specific synonym before concluding unavailable (for example, `Diet Coke` → `Coca Cola`/`Coke Zero`; `chips` → `potato chips`/known chip brands). If the broader search finds only substitutes, show them and ask before substituting.
- For “check,” “show,” or “what is in my current cart,” call `blinkit_cart_status`. This is read-only and must not replace the cart.
- For “share my cart,” “send the cart link,” or equivalent, inspect the cart first and call `blinkit_share_cart` only when it is non-empty. Return the exact provider URL and say that sharing did not prepare or place an order. Treat the URL as owner-sensitive and never invent, shorten, rewrite, or send it outside the owner conversation.
- For an official Blinkit cart link, call `blinkit_import_shared_cart` with the URL exactly as received. Render the complete verified resulting cart and state whether it was created, merged, updated, or unchanged. A cart link is not approval: importing never prepares or places an order.
- For “which address,” “where can you deliver,” or preparation without a confirmed saved-address choice, call `blinkit_list_saved_addresses`. Show only the returned labels and ask the owner to choose when needed. When the owner asks to switch the active Blinkit location, make a fresh `blinkit_list_saved_addresses` call in the same turn with that exact safe label as `requestedLabel`, then call `blinkit_select_saved_address` with its exact returned opaque reference. Never use `blinkit_current_screen` or conversation memory as the saved-address list. Invalidate any earlier proposal, then call `blinkit_cart_status` to verify and render the complete store-dependent cart state.
- For “recent orders,” “did this order exist,” or before reconciling an ambiguous final action, call `blinkit_recent_orders`. Treat it as read-only evidence; never place or retry an order from this result.
- For “add this product” or incremental cart building, search first, resolve exactly one current `offerId`, and call `blinkit_add_cart_item` with the original query and desired final quantity. This preserves every other cart line and does not prepare or place an order.
- For “change quantity,” inspect the cart, resolve exactly one returned `productId`, and call `blinkit_set_cart_item_quantity`.
- For “remove this item,” inspect the cart, resolve exactly one returned `productId`, and call `blinkit_remove_cart_item`.
- For “clear” or “empty my cart,” call `blinkit_clear_cart` only when the owner explicitly requests the entire cart be cleared.
- For “show current total,” call `blinkit_cart_status`. For “prepare this current cart,” inspect it first and call `blinkit_prepare_existing_cart_cod_order` only when the verified cart is non-empty.
- For “prepare a new exact cart from this complete item list,” search each ambiguous item when needed and call `blinkit_start_prepare_cod_order` with a stable interface-event idempotency key. Poll `blinkit_operation_status` until it completes, is blocked, fails, or expires. This rebuilds the requested cart, selects COD, returns a proposal or structured provider constraint, and never places the order.
- For “prepare/place/order this current cart,” call `blinkit_prepare_existing_cart_cod_order`, render every exact proposal term, and state that nothing has been ordered yet. Call `blinkit_place_cod_order` only after the owner confirms that rendered proposal.
- For “order,” “buy,” or “place using COD” with an item list, authenticate, search when needed, prepare the exact proposal, render every term, and wait for confirmation before calling `blinkit_place_cod_order` with a stable idempotency key.
- For order progress, call `blinkit_order_status`.
- If an agent restart lost the active asynchronous operation ID, call `blinkit_recent_operations`, choose only an exact owner/account operation, and resume `blinkit_operation_status`; never start a duplicate operation merely because chat memory was lost.
- Before placing a proposal after owner confirmation, call `blinkit_compare_proposal`. Continue only on `unchanged`; render changed terms through a fresh proposal on `changed`, and prepare again on `expired`.
- For an ambiguous final action, call `blinkit_reconcile_order`. Never call the place tool again.

## Read saved addresses and order history

`blinkit_list_saved_addresses` returns only saved labels and opaque references. Never ask for or infer a full street address from its result. If it returns `empty`, explain that no usable saved label was found and stop before preparation.

`blinkit_recent_orders` returns only order reference, items, total, timestamp, and provider status. Match an ambiguous attempt only when the returned facts correspond to the proposal. If no matching order appears, absence is not proof that the final action failed: continue with `blinkit_reconcile_order` and never retry `blinkit_place_cod_order`. Never expose or request screenshots, order-screen XML, or address details.

## Check readiness and recover safely

Treat `blinkit_readiness` as the authoritative dependency check. It returns only sanitized component states.

- `ready`: continue with the requested semantic tool.
- `action_required` with `login_required`: use the private login flow below.
- `action_required` with `challenge_required`: tell the owner the provider requires supervised attention; do not improvise device controls.
- `unavailable` with `worker_unreachable`: report that the Android worker is unavailable and stop. Retry once only if the owner explicitly asks after connectivity is restored.
- `unavailable` or `unknown` for Appium, emulator, or Blinkit app: report the named dependency state and stop. Do not use SSH, cloud tools, Appium, ADB, or screenshots.

If another tool fails with `worker_unreachable`, `worker_execution_failed`, or `worker_response_invalid`, report that exact safe category and do not translate it into a login problem. Treat a structured `blocked` result as a reachable, successfully completed ErrandOS call—not as MCP downtime:

- `cod_minimum_not_met`: render the exact returned `itemSubtotal` and `requiredSubtotal`. Explain that nothing was ordered. Ask whether the owner wants to add or increase an item; do not retry unchanged terms.
- `product_unavailable`: identify the requested item without inventing a substitute. Search alternatives only when requested.
- `quantity_unavailable`: explain that the requested quantity cannot be prepared. Ask for a lower quantity or another product.
- `address_unserviceable`: list saved address labels again and ask the owner to choose another one.
- `cod_unavailable`: state that Blinkit is not currently offering COD, that no proposal or order was created, and that the cart remains the current source of truth. Never switch payment method. Retry only after a later owner request.
- `price_changed`: search or inspect again, prepare a fresh proposal, and render the new exact terms. Never place the older proposal.
- `checkout_terms_unreadable`: state that exact checkout terms could not be verified and stop. Do not infer prices, fees, total, address, or payment mode.

For `screen_blocked`, explain that the provider screen could not be handled semantically; do not request a screenshot or expose device controls. For `operation_failed`, state that the semantic operation failed without inventing a cause.

Every canonical Blinkit tool can return a typed failure envelope with `status: failed`, `reason`, `retryable`, and `suggestedAction`. A returned `status: failed` is a successful MCP response: the server is reachable, so never call it “MCP unreachable.” Follow the suggested action only within this skill’s bounded rules. Retry at most once when `retryable` is true; do not retry a final order action under any condition. Report only the safe reason and optional safe stage.

If a search or incremental add fails before producing a verified result, call `blinkit_current_screen` once:

- `home`, `search`, or `search_results` with `searchAction: available`: retry the original semantic operation once.
- a product-detail, cart, checkout, payment, address-selection, order-confirmation, order-history, location, or review screen with `searchAction: recoverable`: retry the original semantic operation once. ErrandOS performs the bounded navigation internally.
- `login` or `otp`: use the typed private authentication flow.
- `unknown` or `searchAction: blocked`: stop and report `screen_blocked`.

Do not repeatedly diagnose or retry. Never ask for, receive, or send a screenshot through MCP. The sanitized screen result is the agent-facing diagnostic boundary.

## Select exact products

Show search results with their exact title, pack size, price, availability, and `offerId`. A result may include an optional `imageUrl`; when the interface supports images, render that exact URL with the matching result. Never guess, scrape, or substitute an image, and do not treat a missing image as a search failure. Ask the owner when flavour, size, or variant is ambiguous. Select one result object, then copy its `offerId` verbatim and reuse the exact query that produced that result; never calculate, shorten, reconstruct, or reuse an ID from an older search. Pass that `offerId`, exact search query, and quantity to preparation. Never silently substitute another result.

For incremental additions, pass an `offerId` from the latest relevant search to `blinkit_add_cart_item`. Its `quantity` is the final target quantity for that exact offer, not an increment. If the owner says “add two more” and that offer is already present, inspect the cart first and calculate the new final quantity. After the tool returns, render the complete refreshed cart and state that nothing was ordered.

If `blinkit_add_cart_item` returns `operation_failed`, call `blinkit_cart_status` before deciding what happened. If the exact selected title and price are present at the desired final quantity and all earlier lines are preserved, render that verified cart and do not retry. If the selected line is absent and the cart is unchanged, repeat the same search once, resolve one current exact result again, and retry the idempotent add once with the newly returned `offerId`. After a second failure or any unexpected/partially changed cart, stop and report the actual operation failure and verified cart state. Never proceed to preparation or ordering from a failed or unverified edit.

## Edit an existing cart

Use `offerId` only for exact searched-product additions. Use a `productId` returned by the latest `blinkit_cart_status` or cart-mutation result for changing or removing an existing line. Match the owner's item description to exactly one returned line; ask for clarification when multiple lines could match. Never use a product name as a substitute for either opaque ID.

Render the complete refreshed cart after every edit. An edit invalidates the practical intent of any earlier proposal: prepare and render a new proposal before ordering, and never place an older proposal after changing the cart.

## Select a saved address

Make a fresh `blinkit_list_saved_addresses` call in the same turn as every address-switch request and pass the owner's exact safe label as `requestedLabel`. Match exactly one returned label, then pass only its matching `addressReference` to `blinkit_select_saved_address`. Never treat `blinkit_current_screen`, an earlier turn, or conversation memory as the current saved-address list. A completed selection returns the selected safe label with `cartStatus: unverified`; immediately call `blinkit_cart_status` before making any cart claim or continuing toward preparation. Address selection can switch the serving store and change availability or cart contents, so render that verified follow-up cart and discard every earlier proposal. Never calculate an address reference, pass a label where the reference is required, or ask for raw address text.

## Share an existing cart

Call `blinkit_cart_status` first. If it is empty, explain that there is no cart to share. Otherwise call `blinkit_share_cart`; ErrandOS uses Blinkit’s native Android Share action, extracts only a Blinkit-domain URL, and verifies the cart fingerprint did not change.

Render the returned `shareUrl` exactly and warn that anyone who receives it may be able to view or recreate the cart. Do not treat the link as a proposal, approval, receipt, or order. Do not call a preparation or placement tool merely because the cart was shared.

When preparation succeeds, render the proposal status, every item and quantity, unit and line prices, unavailable items, every fee or discount, total, saved address label, COD payment mode, ETA when present, and expiry. Retain the exact `proposalId` and `proposalHash` returned by the tool; never calculate or alter either value. State plainly that preparation selected COD but did not place an order. Do not call the place tool in the same turn unless the owner has already reviewed and explicitly confirmed these exact returned terms.

Treat a proposal whose `expiresAt` has passed as unusable even if it remains visible in the conversation. Prepare and render a fresh proposal before placement. Any cart edit, address change, price change, quantity change, unavailable item, fee change, total change, payment change, ETA change, or provider-fingerprint change makes the earlier practical terms stale; never reuse its approval or hash.

## Import a shared cart

Accept only a URL that `blinkit_import_shared_cart` validates as an official HTTPS Blinkit link. Pass it through exactly; never open an arbitrary URL, shorten it, extract private parameters, or use a browser or raw device tool.

The import mutates only the owner’s current Blinkit cart and returns its complete verified state. Render every resulting line, quantity, price, subtotal, unavailable item, address label, payment selection state, ETA, fingerprint, and `importBehavior`. Do not assume that the link replaced the previous cart: `merged` and `updated` mean the complete returned cart—not the link alone—is the source of truth. If unexpected pre-existing items remain, ask whether to edit them before preparation.

For “order this cart link,” run the normal boundary in separate stages:

1. Check readiness and authentication.
2. Call `blinkit_import_shared_cart` and render the complete verified resulting cart.
3. Call `blinkit_prepare_existing_cart_cod_order` only after the owner chooses to continue with that exact cart.
4. Render every immutable proposal term and state that nothing has been ordered.
5. Wait for explicit confirmation of those exact proposal terms.
6. Call `blinkit_compare_proposal`; place only when it is `unchanged`.
7. Use `blinkit_place_cod_order` at most once with the stable idempotency key.

A cart link is not approval. Never import and place in one unreviewed step, and never infer authorization from the link text itself.

## Run long preparation asynchronously

Use `blinkit_start_prepare_cod_order` for a new exact item list. Derive its required idempotency key from the originating interface event, for example `telegram-update-123456:prepare`. Reuse that same key if the start response is lost; never mint another key for the same request.

The start tool must return `running` with an `operationId` promptly. Retain that ID and call `blinkit_operation_status` with the same account key. Poll at a moderate interval; do not issue concurrent Blinkit mutations while it is running. Do not let a short-lived command exit immediately after the start response; either keep the agent session alive through terminal polling or rely on the persistent Hermes gateway. Interpret terminal states exactly:

- `completed`: render the returned immutable proposal and state that nothing was ordered.
- `blocked`: render the returned typed constraint using the recovery table above and state that nothing was ordered.
- `failed`: report only the returned typed reason. Check readiness again only for dependency reasons; do not blindly restart preparation.
- `expired`: state that the unfinished operation expired and that nothing was ordered. Start a replacement only after a new owner request.

The operation record survives a Hermes restart. Resume status polling with the retained `operationId`; do not rebuild the cart merely because the conversation or gateway restarted. If an in-flight worker was interrupted, the durable status may eventually become `expired`; never create a replacement operation without a new owner request.

If the `operationId` itself was lost, call `blinkit_recent_operations` with the same account key. It returns recent durable IDs, statuses, timestamps, optional proposal IDs, and safe failure reasons without request items, addresses, or idempotency keys. Resume the exact matching operation. If no unique operation matches the current owner intent, ask rather than guessing or starting a duplicate.

## Authenticate Blinkit privately

1. Call `blinkit_auth_status` with the stable account key, normally `main`.
2. If active, continue.
3. If login is required, ask for the 10-digit phone number in the private owner conversation and immediately call `blinkit_begin_login`.
4. If an OTP is requested, ask for it privately and immediately call `blinkit_submit_otp`.
5. Never repeat, store, log, or place phone or OTP values in ordinary responses.
6. Continue only after authentication becomes active.

## Place COD orders

Render every exact proposal term before placing an order. The first request to place an uninspected current cart authorizes preparation, not the unseen final terms. Call `blinkit_place_cod_order` only for a prepared Blinkit COD proposal with `requiresExternalApproval: false` after the owner explicitly confirms the rendered terms.

After confirmation and before the place tool, call `blinkit_compare_proposal` with the same proposal ID and account key. It re-reads live checkout terms without performing the final action:

- `unchanged`: the immutable proposal still matches; proceed with the existing proposal ID and stable placement idempotency key.
- `changed`: do not place. Treat the listed changed fields as stale evidence, prepare a fresh proposal, render all exact new terms, and obtain confirmation again.
- `expired`: do not place. Prepare and render a fresh proposal.
- typed `failed`: do not place; apply only the bounded failure recovery above.

Do not place when comparison returns `changed` or `expired`, and never interpret comparison as approval.

Derive the idempotency key from the originating interface event ID plus proposal ID, for example `telegram-update-123456:proposal_abcd`. Reuse the same key after timeouts. Never create a second key for the same proposal.

Treat outcomes exactly:

- `prepared`: nothing has been ordered.
- `stale`: terms changed; no final action occurred. Prepare a replacement proposal.
- `committed`: show success only with the verified provider reference.
- `ambiguous`: the click may have occurred. Reconcile read-only and never place again.
- `failed`: state that the order was not completed.

Known location prompts, review prompts, and provider overlays are handled inside ErrandOS. Never try to dismiss them through a generic click, terminal, browser, Appium, ADB, coordinate, selector, screenshot, or XML tool. A typed `screen_blocked` result means bounded recovery stopped safely.

Never expose Appium, ADB, coordinates, selectors, UI XML, screenshots, device sessions, or internal recovery actions. Never claim success without a committed result and verified provider reference.
