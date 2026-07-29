# Sarvam Telegram voice notes for ErrandOS turns

Session learning: Telegram voice messages may arrive as text prefixed with a Sarvam wrapper, for example:

```text
[Voice input transcribed by Sarvam. Detected language: Hindi (hi-IN), probability: 1.0. Reply in this same language unless I ask otherwise. Use Sarvam TTS for voice replies when voice mode is enabled.]
I want to order chips and Diet Coke.
```

Operational handling:

- Treat the wrapper as the owner's message context, not as tool output or provider facts.
- Reply in the detected language unless the owner explicitly switches language.
- If the owner has requested text + voice replies, include both: final text in the detected language and a Sarvam TTS media attachment when the TTS tool is available.
- Keep exact Blinkit/provider facts untranslated or carefully preserved: product names, pack sizes, prices, quantities, fees, totals, ETA, address labels, proposal IDs, order references, and statuses.
- The English transcript may be Sarvam's translation of non-English speech. Use it for intent, but ask clarifying questions in the detected language when variants are ambiguous.
- Do not weaken transaction safety for voice: prepare/render exact terms first, place COD only after explicit confirmation of the rendered proposal, and never retry ambiguous final actions.
- A verified Blinkit `committed` result is a mandatory final voice-notification event when Telegram voice mode and Sarvam TTS are enabled. Call `blinkit_order_status` first and narrate one concise completion from its durable summary: order confirmed, exact COD amount to keep ready, and ETA when present. Apply the same rule after read-only reconciliation becomes `committed`.
- Never narrate order success for `ambiguous`, `stale`, or `failed`. Never infer the amount or ETA from chat history. If ETA is absent, say it is not currently available rather than estimating it.
- In `voice_only` mode send the completion voice note once. In text-and-voice mode send matching text and voice; do not generate separate voice notes for the status lookup or internal tool progress.

Search recovery pattern observed:

- Generic or exact user wording can return `no_results` even when nearby inventory exists.
- Retry once with safe broader/brand synonyms before reporting unavailable, e.g. `Diet Coke` → `Coca Cola`/`Coke Zero`; `chips` → `potato chips`/known chip brands.
- If broader search returns substitutes only, present them as substitutes and ask before adding.
