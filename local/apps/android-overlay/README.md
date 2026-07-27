# JaldiAI Android overlay

Minimal native status overlay for the buildathon phone agent.

- Shows working, clarification, success, cart-ready, and error states above Blinkit.
- Press and hold the circular button to record. Releasing sends the command.
- Sarvam handles STT and TTS; the pill plays the spoken reply while Blinkit remains visible.
- The overlay is visual reinforcement only. Sarvam remains responsible for STT and TTS.
- It never confirms a cart mutation unless the Appium bridge verifies it.

Build with `./build.sh`. The APK is written to `dist/errandos-overlay-debug.apk`.
