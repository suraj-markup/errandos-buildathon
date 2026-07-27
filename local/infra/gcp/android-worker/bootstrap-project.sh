#!/usr/bin/env bash
set -euo pipefail

REGION="asia-south1"
CONFIGURATION="errandos-android"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/errandos"
STATE_FILE="$STATE_DIR/gcp-android-worker.env"
DRY_RUN="${ERRANDOS_GCP_DRY_RUN:-false}"

active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
test -n "$active_account" || { echo "no active gcloud account" >&2; exit 2; }

project_id="$(gcloud config get-value project 2>/dev/null)"
test -n "$project_id" && [[ "$project_id" != "(unset)" ]] || { echo "no configured GCP project" >&2; exit 3; }
billing_enabled="$(gcloud billing projects describe "$project_id" --format='value(billingEnabled)')"
[[ "$billing_enabled" == "True" ]] || { echo "configured project is not billing-enabled" >&2; exit 4; }

if [[ "$DRY_RUN" == "true" ]]; then
  printf 'would_use_existing_project=true\nregion=%s\nconfiguration=%s\n' "$REGION" "$CONFIGURATION"
  exit 0
fi

gcloud services enable \
  serviceusage.googleapis.com compute.googleapis.com iam.googleapis.com \
  iap.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  --project="$project_id"

if gcloud config configurations describe "$CONFIGURATION" >/dev/null 2>&1; then
  gcloud config configurations activate "$CONFIGURATION"
else
  gcloud config configurations create "$CONFIGURATION" --activate
fi
gcloud config set account "$active_account"
gcloud config set project "$project_id"
gcloud config set compute/region "$REGION"

mkdir -p "$STATE_DIR"
umask 077
cat >"$STATE_FILE" <<EOF
PROJECT_ID=$project_id
REGION=$REGION
GCLOUD_CONFIGURATION=$CONFIGURATION
EOF
printf 'state_file=%s\nexisting_project_selected=true\n' "$STATE_FILE"
