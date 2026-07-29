#!/usr/bin/env bash
set -euo pipefail

credential="${ERRANDOS_CREDENTIAL_FILE:-/root/.hermes/profiles/errandos/secrets/errandos-runtime.cred}"
tmp="$(mktemp /dev/shm/errandos-brother-runtime.XXXXXX)"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT
chmod 600 "$tmp"
systemd-creds decrypt --name=errandos-runtime "$credential" "$tmp" >/dev/null
set -a
# This host-local file is encrypted and managed by the existing ErrandOS deployment.
# shellcheck disable=SC1090
. "$tmp"
set +a
cleanup
trap - EXIT

# The family web profile is limited to building and sharing a cart from the
# common account. It is not the single trusted autonomous owner.
export ERRANDOS_PERSISTENCE_MODE=filesystem
export ERRANDOS_DEPLOYMENT_PROFILE=personal
export ERRANDOS_PRINCIPAL_ID=brother
export ERRANDOS_LIVE_COMMIT=false
export ERRANDOS_RAPIDO_LIVE_COMMIT=false
export ERRANDOS_TRUSTED_AUTONOMOUS_COD=false
export ERRANDOS_OWNER_ORDER_EVIDENCE=false
export ERRANDOS_MCP_SURFACE=public-cart

release_entry="/opt/errandos/control-plane/current/dist/src/mcp-entry.js"
if [[ ! -f "$release_entry" ]]; then
  echo "ErrandOS control-plane release is unavailable." >&2
  exit 1
fi

exec node "$release_entry"
