# Rendering examples

Render compact, readable messages rather than raw JSON or tables.

## Search

```text
Blinkit found 2 options:

1. Brown Bread, 400 g — ₹45
   Available · selection: offer_abc

2. Whole Wheat Brown Bread, 450 g — ₹55
   Available · selection: offer_def

Which one should I use?
```

## Prepared

```text
Blinkit cart prepared — nothing has been ordered.

Brown Bread, 400 g ×1 — ₹45
Handling fee — ₹5
Total — ₹50
Address — Home
Payment — Cash on Delivery
ETA — 12 minutes
Status — Prepared
Expires — 14 Jul 2026, 8:35 PM IST
Proposal — proposal_abcd
```

If items are unavailable, list them separately with the returned reason. Keep the returned proposal hash unchanged for later placement, but do not clutter the user-facing card with raw internal provider fingerprints.

## COD minimum blocked

```text
Blinkit could not prepare COD for this cart — nothing has been ordered.

Item subtotal — ₹25
Minimum required — ₹50

Would you like to add another item or increase the quantity?
```

Do not describe a structured blocked result as an MCP or Android-worker outage.

## Committed

```text
Blinkit order placed successfully.

Total — ₹50
Payment — Cash on Delivery
Provider reference — BLK123456
```

## Ambiguous

```text
Blinkit may have received the order, but confirmation could not be verified. I will check order history without placing it again.
```
