# Agent-driven provider login

Hermes may collect the owner's phone number and OTP in the private conversation and pass each value once through typed Blinkit or Rapido MCP login tools. JaldiAI sends them in the Android worker request on stdin. They are never placed in SSH arguments, durable state, logs, errors, screenshots, traces, or tool output.

The flow is:

1. `blinkit_auth_status` or `rapido_auth_status` reads the official app session state.
2. `blinkit_begin_login` or `rapido_begin_login` enters the phone number and clicks the exact semantic continuation control once.
3. Hermes asks for the received OTP.
4. `blinkit_submit_otp` or `rapido_submit_otp` enters only the active OTP controls and verifies that the authenticated app state is active.
5. The Android emulator retains the official app session across later jobs.

There is no browser link, Playwright context, browser profile, cookie export, terminal prompt, or raw device control in this flow. If the app presents CAPTCHA, security approval, an unknown screen, or an invalid/expired OTP, the tool reports a challenge/error state without exposing provider details.
