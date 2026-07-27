# ErrandOS GCP Android worker

These scripts operate only on the owner-authorized existing project recorded in
`$HOME/.local/state/errandos/gcp-android-worker.env`. Every mutating `gcloud`
command must pass `--project="$PROJECT_ID"`. Appium and ADB remain local to the
worker. The canary never enables live commit. The VM may remain running while
implementation is actively progressing and must be stopped when work is blocked.

Run `ERRANDOS_GCP_DRY_RUN=true ./bootstrap-project.sh` before creating anything.
The bootstrap refuses a project without billing and never creates or links a
billing account.

The Blinkit canary uses `-gpu lavapipe`. SwiftShader variants crashed the
emulator while rendering checkout; do not change the renderer without rerunning
the cart and checkout canary.

The emulator is pinned to `Asia/Kolkata`. Provider availability windows such as
Blinkit COD depend on device-local time, so UTC host defaults are not acceptable.

## Owner-only safe screen preview

`capture-safe-screen.sh` is an optional channel-level diagnostic, not an MCP
operation. Install it behind a separate restricted SSH account whose forced
command runs the script as the `errandos` user. The script emits a PNG only for
catalog/search/product-detail surfaces and refuses login, OTP, address,
checkout, payment, order-history, confirmation, and unknown screens.

The VPC wrapper at `scripts/capture-blinkit-screen.sh` decrypts the existing
host-local worker connection settings, writes the PNG to a private Hermes cache
directory, validates the PNG signature, and prints only the absolute path so
the Telegram gateway can deliver it as media. Restrict the corresponding
`/screen` quick command to the single owner through Hermes slash-command access
control. Never register this path as an ErrandOS MCP tool.

`infra/hermes/install-screen-command.py` adds the `/screen` quick command and
enables slash-command gating. It refuses to proceed unless
`TELEGRAM_ALLOWED_USERS` contains exactly one numeric owner ID, makes that owner
the only DM slash-command administrator, makes that same owner the Telegram
home channel for safe media delivery, and denies the command in groups.
