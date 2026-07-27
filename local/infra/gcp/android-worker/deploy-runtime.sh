#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/errandos/gcp-android-worker.env"
test -f "$STATE_FILE" || { echo "missing GCP Android worker state" >&2; exit 2; }
# shellcheck disable=SC1090
source "$STATE_FILE"
: "${PROJECT_ID:?missing PROJECT_ID}"
: "${ZONE:?missing ZONE}"
: "${VM_NAME:?missing VM_NAME}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid git revision" >&2; exit 3; }
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

cd "$ROOT"
pnpm --filter @errandos/worker build
pnpm --filter @errandos/worker --prod deploy --legacy "$TEMP/release"

# pnpm deploy contains only the worker's production dependency closure. Refuse
# credential-equivalent or generated provider artifacts before packaging it.
if find "$TEMP/release" -type f \( \
  -name '.env' -o -name '.env.*' -o -name '*.png' -o -name '*.xml' \
  -o -name '*.trace' -o -name '*.log' -o -name 'storage-state.json' \
\) -print -quit | grep -q .; then
  echo "unsafe file in Android worker deployment" >&2
  exit 4
fi

tar -C "$TEMP/release" -czf "$TEMP/errandos-android-worker-$SHA.tgz" .
gcloud compute scp "$TEMP/errandos-android-worker-$SHA.tgz" \
  "$VM_NAME:/tmp/errandos-android-worker-$SHA.tgz" \
  --project="$PROJECT_ID" --zone="$ZONE" --tunnel-through-iap

remote="$(cat <<EOF
set -euo pipefail
sudo install -d -m 0755 /opt/errandos/releases/$SHA /opt/errandos/bin
sudo tar -xzf /tmp/errandos-android-worker-$SHA.tgz -C /opt/errandos/releases/$SHA
sudo ln -sfn /opt/errandos/releases/$SHA /opt/errandos/current
printf '%s\n' '#!/usr/bin/env bash' 'exec /opt/node/bin/node /opt/errandos/current/dist/android-job-entry.js' | sudo tee /opt/errandos/bin/android-worker-job >/dev/null
sudo chmod 0755 /opt/errandos/bin/android-worker-job
rm -f /tmp/errandos-android-worker-$SHA.tgz
EOF
)"
gcloud compute ssh "$VM_NAME" --project="$PROJECT_ID" --zone="$ZONE" \
  --tunnel-through-iap --command="$remote"

printf 'android_worker_release=%s\n' "$SHA"
