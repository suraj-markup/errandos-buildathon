#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/errandos/gcp-android-worker.env"
test -f "$STATE_FILE" || { echo "missing GCP Android worker state" >&2; exit 2; }
# shellcheck disable=SC1090
source "$STATE_FILE"

VM_NAME="errandos-android-worker-1"
NETWORK="errandos-android"
SUBNET="errandos-android-worker"
FIREWALL="errandos-android-allow-iap-ssh"
SERVICE_ACCOUNT="android-worker@$PROJECT_ID.iam.gserviceaccount.com"

zone=""
for candidate in asia-south1-a asia-south1-b asia-south1-c; do
  if gcloud compute machine-types describe n2-standard-8 \
    --zone="$candidate" --project="$PROJECT_ID" >/dev/null 2>&1; then
    zone="$candidate"
    break
  fi
done
test -n "$zone" || { echo "n2-standard-8 unavailable in asia-south1" >&2; exit 5; }

gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud iam service-accounts create android-worker \
    --display-name="JaldiAI Android Worker" --project="$PROJECT_ID"

for role in roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT" --role="$role" \
    --condition=None >/dev/null
done

gcloud compute networks describe "$NETWORK" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute networks create "$NETWORK" --subnet-mode=custom --project="$PROJECT_ID"

gcloud compute networks subnets describe "$SUBNET" \
  --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute networks subnets create "$SUBNET" \
    --network="$NETWORK" --region="$REGION" --range=10.80.0.0/24 \
    --project="$PROJECT_ID"

gcloud compute firewall-rules describe "$FIREWALL" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create "$FIREWALL" \
    --network="$NETWORK" --allow=tcp:22 --source-ranges=35.235.240.0/20 \
    --target-service-accounts="$SERVICE_ACCOUNT" --project="$PROJECT_ID"

if ! gcloud compute instances describe "$VM_NAME" \
  --zone="$zone" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" --zone="$zone" --machine-type=n2-standard-8 \
    --enable-nested-virtualization \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=200GB --boot-disk-type=pd-ssd \
    --boot-disk-device-name=errandos-android-data \
    --network-interface="subnet=$SUBNET,network-tier=PREMIUM" \
    --service-account="$SERVICE_ACCOUNT" --scopes=logging-write,monitoring-write \
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
    --labels=app=errandos,component=android-worker,environment=canary
fi

tmp_state="$(mktemp)"
grep -Ev '^(ZONE|VM_NAME|SERVICE_ACCOUNT)=' "$STATE_FILE" >"$tmp_state"
printf 'ZONE=%s\nVM_NAME=%s\nSERVICE_ACCOUNT=%s\n' \
  "$zone" "$VM_NAME" "$SERVICE_ACCOUNT" >>"$tmp_state"
chmod 600 "$tmp_state"
mv "$tmp_state" "$STATE_FILE"
printf 'vm_ready=true\nzone=%s\n' "$zone"
