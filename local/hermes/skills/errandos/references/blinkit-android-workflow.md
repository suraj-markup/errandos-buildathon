# Blinkit Android workflow

## Readiness

Call `blinkit_readiness` before the first provider operation in a conversation and after any availability failure. It checks the control plane, Android worker, local Appium service, persistent emulator, official Blinkit app, and authentication state without returning device internals.

- Continue only when the overall status is `ready`.
- Run the typed private login flow when authentication is `login_required`.
- Stop and explain the typed reason when status is `challenge_required`, `worker_unreachable`, or another component is `unavailable` or `unknown`.
- Never diagnose by falling back to SSH, GCP, Appium, ADB, screenshots, coordinates, selectors, or UI XML.

## Search

Call `blinkit_search_products` with:

- `accountKey`: normally `main`
- `query`: the requested product and variant
- `limit`: one to ten results

Use the returned opaque `offerId` to preserve the owner's exact selection. Copy it verbatim from the same result object and retain the exact query used for that search. Do not calculate an ID, reuse one from an older search, or infer a different pack size, flavour, or brand.

An offer can contain an optional provider-supplied `imageUrl`. Render it only with that exact offer when the interface supports images. Missing images are normal; never manufacture or scrape one.

If search or incremental add fails before returning a verified result, call `blinkit_current_screen` once. It returns only a sanitized screen `kind`, whether search is `available`, `recoverable`, or `blocked`, and optional safe product/cart facts. It never returns a screenshot, UI tree, selector, coordinate, or device state.

- On `home`, `search`, or `search_results`, retry the original semantic operation once.
- On a product-detail screen or another screen marked `recoverable`, retry the original semantic operation once; ErrandOS normalizes the app back to search internally.
- On `login` or `otp`, use the typed authentication flow.
- On `unknown` or `blocked`, stop with `screen_blocked`.

Do not loop between diagnosis and retries.

## Saved addresses

Call `blinkit_list_saved_addresses` when the owner asks where Blinkit can deliver or when preparation needs a saved-address choice that has not been confirmed. For every address-switch request, make a fresh `blinkit_list_saved_addresses` call in the same turn with the owner's exact safe label as `requestedLabel`; never use `blinkit_current_screen`, an earlier turn, or conversation memory as the current saved-address list. Render only each returned label. Retain its opaque `addressReference` internally and pass that exact reference with its matching label to preparation; never calculate a reference or ask the worker for full address text.

If exactly one saved label matches the owner's request, use it. If multiple labels could match, ask which label to use. If the result is `empty`, stop before preparation and explain that no usable saved address label was found.

To change the active provider location, call `blinkit_select_saved_address` with the chosen result's exact opaque `addressReference`. A completed selection confirms only the safe label and returns `cartStatus: unverified`; immediately call `blinkit_cart_status` and render that complete verified cart. Because a location change can switch stores and change the cart, invalidate every prior proposal and never infer that the cart stayed unchanged.

## Recent orders

Call `blinkit_recent_orders` for order-history questions and before `blinkit_reconcile_order` after an ambiguous final action. Render only order reference, item names and quantities, total, timestamp, and provider status.

A matching recent order is evidence that the provider has an order; do not call the place tool. No match is not evidence that placement failed. Continue with proposal-bound read-only reconciliation and never repeat the final action. Do not expose or request delivery-address details, screenshots, selectors, UI XML, or emulator state.

## Add one exact product without replacing the cart

For incremental cart building, call `blinkit_add_cart_item` with:

- `accountKey`: normally `main`
- `query`: the original current search query
- `offerId`: exactly one available offer from the latest relevant search result
- `quantity`: the desired final quantity, from 1 to 20

The operation searches the official app again, selects only that exact offer, sets its final quantity, and verifies the refreshed cart. Every other pre-existing cart line must remain at the same quantity or the operation fails. It does not select COD, create a proposal, or place an order.

If the owner asks to add more units to an offer already in the cart, inspect the cart first and convert the increment to a final target quantity. After each addition, render the complete returned cart. Prepare a fresh proposal only when the owner is ready to review exact checkout terms.

If an add returns `operation_failed`, inspect the cart before retrying. A cart that already contains the exact selected title and price at the requested final quantity is the verified result and must not be mutated again. If the line is absent and every earlier line is unchanged, repeat the same search and retry the idempotent add once using the newly returned exact `offerId`. Stop after that one retry or on any unexpected cart change; report the operation failure and current verified cart instead of claiming the MCP tools were unavailable.

## Prepare

Call `blinkit_start_prepare_cod_order` with:

- `accountKey`: normally `main`
- `items`: each selected `offerId`, original `query`, and quantity
- `deliveryAddressRef`: the stable local address reference
- `deliveryAddressLabel`: the exact saved Blinkit label, normally `Home`
- `idempotencyKey`: one stable key derived from the originating interface event

The call returns promptly with `running` and an opaque `operationId`. Call `blinkit_operation_status` with that ID until it returns `completed`, `blocked`, `failed`, or `expired`. Keep the agent process alive while polling when using a short-lived command; the persistent Hermes gateway naturally owns a long-lived MCP connection. A completed operation contains the immutable proposal. Preparation may navigate the official Android app, rebuild the cart after an address/store change, select COD, and recover from bounded overlays. It must stop before `Place Order`.

Reuse the same idempotency key after a lost start response. Do not begin a second Blinkit mutation while the operation is running. Operation status is durable across a Hermes restart; resume polling rather than starting preparation again. An interrupted in-flight worker may later become `expired`; never replace it without a new owner request. On `blocked`, render the exact typed constraint below. On `failed`, report the typed reason and follow only its documented recovery. On `expired`, state that nothing was ordered and wait for a new owner request before starting again.

If chat memory lost the operation ID, call `blinkit_recent_operations` for the same account. Resume one uniquely matching operation with `blinkit_operation_status`; do not guess among multiple records or start duplicate work.

## Checkout constraints

Preparation can finish safely with `status: blocked`:

- `cod_minimum_not_met`: render both `itemSubtotal` and `requiredSubtotal`; ask whether to add or increase an item.
- `product_unavailable`: do not substitute without permission.
- `quantity_unavailable`: ask for a lower quantity or another product.
- `address_unserviceable`: list saved labels and ask for another choice.
- `cod_unavailable`: do not change payment method or retry in the same turn.
- `price_changed`: search or inspect again and prepare fresh exact terms.
- `checkout_terms_unreadable`: stop because exact terms cannot be verified.

A blocked result proves the tool and provider path responded; never report it as MCP unreachability. No blocked result creates a proposal or places an order.

A canonical tool result with `status: failed`, `reason`, `retryable`, and `suggestedAction` also proves MCP responded. Follow the safe suggested action at most once within the skill rules. A transport-level tool-call error is distinct from this typed provider result.

If a requested product cannot be matched uniquely, search again or ask the owner. If it is unavailable, report it without substituting.

## Inspect or prepare an existing app cart

Call `blinkit_cart_status` when the owner asks what is already in the Blinkit app cart. Render the exact in-stock lines, unavailable items, subtotal, address label, payment selection state, and ETA returned by the tool. Do not claim that inspection creates a proposal or places an order.

For existing-cart edits, first use the latest cart result to resolve one exact opaque `productId`:

- Call `blinkit_set_cart_item_quantity` with that ID and a quantity from 1 to 20.
- Call `blinkit_remove_cart_item` with that ID to remove only that line.
- Call `blinkit_clear_cart` only for an explicit request to empty the entire cart.

Each mutation returns the verified refreshed cart or `empty`. Render that result, and prepare a new proposal before any later order attempt. Never reuse a proposal prepared before a cart edit.

For “share this cart” or “send me the cart link,” inspect the cart first and stop if it is empty. Call `blinkit_share_cart` for a non-empty cart. It uses Blinkit’s native Android Share action, permits only a Blinkit-domain URL, and verifies the cart fingerprint is unchanged. Return the URL exactly, treat it as owner-sensitive, and state that nothing was prepared or ordered. Never invent, shorten, or reinterpret the link.

For an incoming official Blinkit cart link, call `blinkit_import_shared_cart` with the URL exactly as received. The tool opens the validated HTTPS Blinkit link only in the persistent owner app, then returns the complete verified resulting cart and whether it was `created`, `merged`, `updated`, or `unchanged`. It does not expose the link in its result, create a proposal, select COD, or place an order.

Always render the complete verified resulting cart. Do not assume the shared contents replaced the existing cart, and do not omit pre-existing lines that remain after a merge. A cart link is not approval. For “order this link,” import and render first, then use `blinkit_prepare_existing_cart_cod_order`, render the immutable proposal, wait for explicit confirmation of those exact terms, call `blinkit_compare_proposal`, and only then use the normal at-most-once placement flow.

Call `blinkit_prepare_existing_cart_cod_order` when the owner asks to order the current app cart. This selects COD, extracts exact items, fees, total, address, and ETA, and persists an immutable proposal. It does not click the final order action.

If preparation returns `blocked` with `cod_unavailable`, Blinkit is not currently offering COD. State that no proposal or order was created, preserve and render the verified current cart, and stop. Never switch to another payment method or retry in the same turn. A later retry requires a new owner request after provider availability may have changed.

Inspect the cart first and stop if it is empty. Render the complete proposal, including unavailable items, status, expiry, and all monetary terms, then wait for the owner to confirm those exact terms. Keep the returned `proposalId` and `proposalHash` verbatim. After confirmation, call `blinkit_place_cod_order` using that proposal ID and one stable idempotency key. Never rebuild the manually created cart from guessed item names.

## Place

Call `blinkit_place_cod_order` with the prepared `proposalId` and deterministic `idempotencyKey`. Do not call it for search-only or prepare-only language.

Before the final action, ErrandOS revalidates products, quantities, prices, fees, total, address, payment mode, ETA, and provider fingerprint against the proposal. Changed terms produce `stale` and no click.

After the owner confirms the rendered proposal, call `blinkit_compare_proposal` before placement. `unchanged` permits the existing proposal to proceed. `changed` or `expired` forbids placement and requires a fresh rendered proposal plus new confirmation. A comparison never authorizes or places an order.

Never place a proposal after its `expiresAt`. Prepare and render a fresh proposal instead.

## Recover outcomes

- On `stale`, prepare a new proposal from the same explicit intent and selected products. The replacement proposal gets its own key because its proposal ID changed.
- On `ambiguous`, call `blinkit_reconcile_order` with the same proposal ID. Never call the place tool again, never mint a replacement key, and do not busy-poll.
- On `committed`, show the verified provider reference.
- On a recoverable pre-dispatch failure, retry only the documented semantic operation. Never improvise raw device actions.

Known location prompts, review prompts, and overlays are recovered inside ErrandOS. If bounded recovery returns `screen_blocked`, stop and report that safe category. Never reach for raw clicks, screenshots, coordinates, selectors, XML, Appium, or ADB.
