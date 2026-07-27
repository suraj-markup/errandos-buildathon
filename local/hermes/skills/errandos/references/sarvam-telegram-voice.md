# Sarvam Telegram voice notes for JaldiAI turns

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

Search recovery pattern observed:

- Generic or exact user wording can return `no_results` even when nearby inventory exists.
- Retry once with safe broader/brand synonyms before reporting unavailable, e.g. `Diet Coke` → `Coca Cola`/`Coke Zero`; `chips` → `potato chips`/known chip brands.
- If broader search returns substitutes only, present them as substitutes and ask before adding.
