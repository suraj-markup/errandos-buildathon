# HeyClicky-style phone agent

## Voice provider decision

- Use Sarvam as the preferred speech layer so JaldiAI can understand and respond in Indian languages, regional accents, and mixed-language speech such as Hinglish.
- Keep speech-to-text and text-to-speech behind a provider interface. The reasoning and Appium execution layers should not depend directly on Sarvam-specific APIs.
- Preserve the detected language throughout the session and reply in the language—or language mix—the user naturally uses.
- Keep the intelligence and tool-calling layer separate from speech. Sarvam handles voice and language processing; the agent plans the task and the Appium bridge executes it on the phone.

## Buildathon follow-up

- Replace the current direct OpenAI Realtime audio path with a Sarvam-first streaming voice pipeline.
- Add environment variables for Sarvam credentials only on the Mac server; never expose secret keys to the phone browser.
- Test at minimum Hindi, Hinglish, and English voice commands before the demo.
