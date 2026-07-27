# GCP Android Emulator Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision an isolated JaldiAI resource namespace inside the owner-authorized existing GCP project and one KVM-accelerated persistent Android emulator, then prove that the official Blinkit app supports login, restart persistence, search, reversible cart preparation, checkout extraction, and truthful COD detection without using Playwright or placing an order.

**Architecture:** Hermes and the durable JaldiAI control plane remain on the existing VPC. A dedicated VPC, subnet, service account, Intel N2 VM, persistent Android emulator, and local-only Appium/ADB are created inside the owner-authorized billing-enabled GCP project; unrelated resources are not modified. This plan stops at the infrastructure/provider feasibility gate; the typed `AndroidBlinkitAdapter` integration receives a separate implementation plan only after the canary passes.

**Tech Stack:** Google Cloud CLI 567+, Compute Engine N2, Ubuntu 24.04 x86-64, nested KVM, Android SDK command-line tools 14742923, Android Emulator, Google Play x86-64 system image, Node.js 22, Appium 3, UiAutomator2, Bash, pnpm workspaces.

## Global Constraints

- Use the owner-authorized existing billing-enabled GCP project; isolate every new resource with the `errandos-android` name or JaldiAI labels and never modify unrelated resources.
- Use `asia-south1`, `n2-standard-8`, Ubuntu 24.04 x86-64, a 200 GB persistent SSD-backed disk, and nested virtualization verified through `/dev/kvm`.
- Run exactly one persistent Android emulator and one mutating provider job at a time.
- Use the official Blinkit Android application; do not create a custom JaldiAI Android application.
- Do not instantiate or use Playwright for any Blinkit login, search, cart, checkout, status, commit, or reconciliation operation.
- Bind Appium and ADB to local interfaces only; never expose Appium, ADB, VNC, emulator consoles, screenshots, UI XML, or arbitrary device controls publicly or through MCP.
- Never echo, log, persist, trace, or screenshot phone numbers, OTPs, cookies, passwords, addresses, payment details, or browser/device state containing personal data.
- Keep `ERRANDOS_LIVE_COMMIT=false` for this plan. No order may be placed.
- Keep the canary VM running while implementation is actively progressing. Stop it when work is blocked on external input or when the owner requests it.
- If Blinkit blocks the emulator through device-integrity or provider controls, stop; do not bypass, spoof integrity, reverse-engineer private APIs, or intercept traffic.

---

### Task 1: Align repository policy with mobile-only Blinkit execution

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/provider-adapter-scope.md`
- Test: repository text assertions

**Interfaces:**
- Consumes: approved design in `docs/superpowers/specs/2026-07-18-gcp-android-worker-design.md`
- Produces: repository policy that permits only `AndroidBlinkitAdapter` for live Blinkit work while leaving other providers unimplemented in this slice

- [ ] **Step 1: Write the failing policy assertions**

Run:

```bash
rg -q "official Blinkit Android app" AGENTS.md
rg -q "AndroidBlinkitAdapter" README.md
rg -q "No live Playwright.*Blinkit" docs/provider-adapter-scope.md
```

Expected: at least one command exits `1` because the current policy still mandates Playwright.

- [ ] **Step 2: Replace the Blinkit provider policy in `AGENTS.md`**

Replace the Playwright-only Blinkit language with this exact policy while preserving the transaction rules that follow it:

```markdown
Every Blinkit interaction must go through the provider-specific `AndroidBlinkitAdapter`, including product discovery, authentication, cart preparation, checkout review, COD selection, commit, status, and reconciliation. The adapter controls the official Blinkit Android app through local-only Appium and a principal-isolated persistent emulator. Playwright is not an active Blinkit runtime. Do not expose raw Appium, ADB, selectors, coordinates, screenshots, UI XML, arbitrary device commands, OTPs, cookies, or emulator state through MCP.

Other providers are outside the Android canary and remain unimplemented in this slice.
```

- [ ] **Step 3: Update README and provider scope**

Add this architecture statement to both documents and remove contradictory claims that live Blinkit uses Playwright:

```markdown
The active Blinkit provider path is mobile-only: a typed `AndroidBlinkitAdapter` controls the official Blinkit app inside a persistent KVM-accelerated Android emulator. Existing Playwright code may remain as inactive migration scaffolding, but it is not instantiated or deployed for Blinkit.
```

- [ ] **Step 4: Run the policy assertions**

Run:

```bash
rg -q "official Blinkit Android app" AGENTS.md
rg -q "AndroidBlinkitAdapter" README.md
rg -q "No live Playwright.*Blinkit|Playwright is not an active Blinkit runtime" docs/provider-adapter-scope.md AGENTS.md
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md README.md docs/provider-adapter-scope.md
git commit -m "docs: switch Blinkit policy to Android runtime"
```

---

### Task 2: Add an isolated, idempotent existing-project bootstrap

**Files:**
- Create: `infra/gcp/android-worker/bootstrap-project.sh`
- Create: `infra/gcp/android-worker/README.md`
- Test: `infra/gcp/android-worker/bootstrap-project.sh` syntax and dry-run guards

**Interfaces:**
- Consumes: an active `gcloud auth login` session and the owner-authorized billing-enabled configured project
- Produces: `$HOME/.local/state/errandos/gcp-android-worker.env` containing `PROJECT_ID`, `REGION`, and `GCLOUD_CONFIGURATION`

- [ ] **Step 1: Write the bootstrap script with a no-write dry-run**

Create `infra/gcp/android-worker/bootstrap-project.sh`:

```bash
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
```

- [ ] **Step 2: Document the isolation contract**

Create `infra/gcp/android-worker/README.md` with these exact operational rules:

```markdown
# JaldiAI GCP Android worker

These scripts operate only on the owner-authorized existing project recorded in
`$HOME/.local/state/errandos/gcp-android-worker.env`. Every mutating `gcloud`
command must pass `--project="$PROJECT_ID"`. Appium and ADB remain local to the
worker. The canary never enables live commit. The VM may remain running while
implementation is actively progressing and must be stopped when work is blocked.

Run `ERRANDOS_GCP_DRY_RUN=true ./bootstrap-project.sh` before creating anything.
The bootstrap refuses a project without billing and never creates or links a
billing account.
```

- [ ] **Step 3: Verify syntax and guards before any cloud write**

Run:

```bash
bash -n infra/gcp/android-worker/bootstrap-project.sh
ERRANDOS_GCP_DRY_RUN=true bash infra/gcp/android-worker/bootstrap-project.sh
```

Expected: syntax passes and output contains `would_use_existing_project=true`; `gcloud projects list` shows no newly created project.

- [ ] **Step 4: Commit the bootstrap**

```bash
git add infra/gcp/android-worker/bootstrap-project.sh infra/gcp/android-worker/README.md
git commit -m "infra: add isolated GCP project bootstrap"
```

- [ ] **Step 5: Select the authorized existing project and record local state**

Run:

```bash
bash infra/gcp/android-worker/bootstrap-project.sh
source "$HOME/.local/state/errandos/gcp-android-worker.env"
test "$(gcloud config get-value project)" = "$PROJECT_ID"
gcloud projects describe "$PROJECT_ID" --format='value(projectId,lifecycleState)'
```

Expected: the authorized project lifecycle state is `ACTIVE`; no new project is created and every later resource uses dedicated JaldiAI names.

---

### Task 3: Provision the locked-down nested-virtualization VM

**Files:**
- Create: `infra/gcp/android-worker/provision-vm.sh`
- Test: shell syntax plus live KVM/resource assertions

**Interfaces:**
- Consumes: the state file produced by Task 2
- Produces: VM `errandos-android-worker-1`, custom VPC `errandos-android`, subnet `worker`, and service account `android-worker@$PROJECT_ID.iam.gserviceaccount.com`

- [ ] **Step 1: Create the provisioning script**

Create `infra/gcp/android-worker/provision-vm.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/errandos/gcp-android-worker.env"
source "$STATE_FILE"
VM_NAME="errandos-android-worker-1"
NETWORK="errandos-android"
SUBNET="errandos-android-worker"
FIREWALL="errandos-android-allow-iap-ssh"
SERVICE_ACCOUNT="android-worker@$PROJECT_ID.iam.gserviceaccount.com"

zone=""
for candidate in asia-south1-a asia-south1-b asia-south1-c; do
  if gcloud compute machine-types describe n2-standard-8 --zone="$candidate" --project="$PROJECT_ID" >/dev/null 2>&1; then
    zone="$candidate"
    break
  fi
done
test -n "$zone" || { echo "n2-standard-8 unavailable in asia-south1" >&2; exit 5; }

gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud iam service-accounts create android-worker --display-name="JaldiAI Android Worker" --project="$PROJECT_ID"
for role in roles/logging.logWriter roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SERVICE_ACCOUNT" --role="$role" --condition=None >/dev/null
done

gcloud compute networks describe "$NETWORK" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute networks create "$NETWORK" --subnet-mode=custom --project="$PROJECT_ID"
gcloud compute networks subnets describe "$SUBNET" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" --range=10.80.0.0/24 --project="$PROJECT_ID"
gcloud compute firewall-rules describe "$FIREWALL" --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create "$FIREWALL" --network="$NETWORK" --allow=tcp:22 \
    --source-ranges=35.235.240.0/20 --target-service-accounts="$SERVICE_ACCOUNT" --project="$PROJECT_ID"

if ! gcloud compute instances describe "$VM_NAME" --zone="$zone" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT_ID" --zone="$zone" --machine-type=n2-standard-8 \
    --enable-nested-virtualization \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=200GB --boot-disk-type=pd-ssd --boot-disk-device-name=errandos-android-data \
    --network-interface="subnet=$SUBNET,network-tier=PREMIUM" \
    --service-account="$SERVICE_ACCOUNT" --scopes=logging-write,monitoring-write \
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
    --labels=app=errandos,component=android-worker,environment=canary
fi

printf '\nZONE=%s\nVM_NAME=%s\nSERVICE_ACCOUNT=%s\n' "$zone" "$VM_NAME" "$SERVICE_ACCOUNT" >>"$STATE_FILE"
sort -u "$STATE_FILE" -o "$STATE_FILE"
printf 'vm_created=true\nzone=%s\n' "$zone"
```

- [ ] **Step 2: Verify syntax**

Run:

```bash
bash -n infra/gcp/android-worker/provision-vm.sh
```

Expected: exit `0`.

- [ ] **Step 3: Commit before provisioning**

```bash
git add infra/gcp/android-worker/provision-vm.sh
git commit -m "infra: provision nested Android worker VM"
```

- [ ] **Step 4: Provision and verify isolation**

Run:

```bash
bash infra/gcp/android-worker/provision-vm.sh
source "$HOME/.local/state/errandos/gcp-android-worker.env"
gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
  --format='value(machineType.basename(),advancedMachineFeatures.enableNestedVirtualization,status)'
```

Expected: `n2-standard-8`, `True`, and `RUNNING`.

- [ ] **Step 5: Verify KVM from the guest**

Run:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='test -e /dev/kvm && grep -Eq "(vmx|svm)" /proc/cpuinfo && echo kvm_ready=true'
```

Expected: `kvm_ready=true`. If absent, stop the VM and end the canary.

---

### Task 4: Install the pinned Android and Appium runtime

**Files:**
- Create: `infra/gcp/android-worker/bootstrap-host.sh`
- Create: `infra/gcp/android-worker/systemd/errandos-emulator.service`
- Create: `infra/gcp/android-worker/systemd/errandos-appium.service`
- Test: remote version and acceleration checks

**Interfaces:**
- Consumes: KVM-ready Ubuntu VM from Task 3
- Produces: user `errandos`, Android SDK at `/opt/android-sdk`, AVD `errandos_pixel_api35`, Node.js 22, Appium 3, and local services

- [ ] **Step 1: Create the host bootstrap**

Create `infra/gcp/android-worker/bootstrap-host.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ANDROID_HOME=/opt/android-sdk
NODE_VERSION=v22.17.1
CMDLINE_TOOLS=14742923

sudo apt-get update
sudo apt-get install -y curl unzip openjdk-17-jre-headless qemu-kvm cpu-checker libgl1 libpulse0
id errandos >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash --groups kvm errandos
sudo usermod -aG kvm errandos

curl -fsSLO "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
sudo rm -rf /opt/node
sudo mkdir -p /opt/node
sudo tar -xJf "node-$NODE_VERSION-linux-x64.tar.xz" -C /opt/node --strip-components=1
rm "node-$NODE_VERSION-linux-x64.tar.xz"

curl -fsSLO "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
sudo rm -rf "$ANDROID_HOME"
sudo mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
tmp="$(mktemp -d)"
unzip -q "commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" -d "$tmp"
sudo cp -a "$tmp/cmdline-tools/." "$ANDROID_HOME/cmdline-tools/latest/"
rm -rf "$tmp" "commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip"
sudo chown -R errandos:errandos "$ANDROID_HOME"

sudo -u errandos env ANDROID_HOME="$ANDROID_HOME" PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  bash -lc 'yes | sdkmanager --licenses >/dev/null'
sudo -u errandos env ANDROID_HOME="$ANDROID_HOME" PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  sdkmanager 'platform-tools' 'emulator' 'system-images;android-35;google_apis_playstore;x86_64'
sudo -u errandos env ANDROID_HOME="$ANDROID_HOME" PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH" \
  bash -lc 'printf "no\n" | avdmanager create avd --force --name errandos_pixel_api35 --package "system-images;android-35;google_apis_playstore;x86_64" --device pixel_8'

sudo /opt/node/bin/npm install --global --prefix /opt/appium appium@3.5.2
sudo mkdir -p /opt/appium-home
sudo env APPIUM_HOME=/opt/appium-home /opt/appium/bin/appium driver install uiautomator2@8.1.0
sudo chown -R errandos:errandos /opt/appium /opt/appium-home

sudo install -o root -g root -m 0644 systemd/errandos-emulator.service /etc/systemd/system/errandos-emulator.service
sudo install -o root -g root -m 0644 systemd/errandos-appium.service /etc/systemd/system/errandos-appium.service
sudo systemctl daemon-reload
sudo systemctl enable --now errandos-emulator.service
sudo systemctl enable --now errandos-appium.service
```

Execution must pause before `sdkmanager --licenses` until the owner confirms acceptance of the Android SDK license shown at [developer.android.com/studio](https://developer.android.com/studio).

- [ ] **Step 2: Create the emulator unit**

Create `infra/gcp/android-worker/systemd/errandos-emulator.service`:

```ini
[Unit]
Description=JaldiAI persistent Android emulator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=errandos
Group=errandos
Environment=ANDROID_HOME=/opt/android-sdk
Environment=ANDROID_AVD_HOME=/home/errandos/.android/avd
ExecStart=/opt/android-sdk/emulator/emulator @errandos_pixel_api35 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on -memory 8192 -cores 4 -camera-back none -camera-front none
Restart=on-failure
RestartSec=10
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Create the Appium unit**

Create `infra/gcp/android-worker/systemd/errandos-appium.service`:

```ini
[Unit]
Description=JaldiAI local-only Appium
After=errandos-emulator.service
Requires=errandos-emulator.service

[Service]
Type=simple
User=errandos
Group=errandos
Environment=ANDROID_HOME=/opt/android-sdk
Environment=APPIUM_HOME=/opt/appium-home
Environment=PATH=/opt/node/bin:/opt/android-sdk/platform-tools:/usr/bin:/bin
ExecStart=/opt/appium/bin/appium --address 127.0.0.1 --port 4723 --log-level error --log-no-colors
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 4: Verify local files before upload**

Run:

```bash
bash -n infra/gcp/android-worker/bootstrap-host.sh
rg -q -- '--address 127.0.0.1' infra/gcp/android-worker/systemd/errandos-appium.service
rg -q -- '-accel on' infra/gcp/android-worker/systemd/errandos-emulator.service
```

Expected: every command exits `0`.

- [ ] **Step 5: Commit**

```bash
git add infra/gcp/android-worker/bootstrap-host.sh infra/gcp/android-worker/systemd
git commit -m "infra: install persistent Android emulator runtime"
```

- [ ] **Step 6: Upload, install, and verify**

Run:

```bash
source "$HOME/.local/state/errandos/gcp-android-worker.env"
gcloud compute scp --recurse infra/gcp/android-worker "$VM_NAME":~/android-worker \
  --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='cd ~/android-worker && bash bootstrap-host.sh'
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='sudo -u errandos /opt/android-sdk/emulator/emulator -accel-check; systemctl is-active errandos-emulator errandos-appium'
```

Expected: acceleration reports usable KVM and both services report `active`.

---

### Task 5: Add a redacted runtime verification harness

**Files:**
- Create: `infra/gcp/android-worker/verify-runtime.sh`
- Test: live VM verification

**Interfaces:**
- Consumes: running emulator and Appium services
- Produces: only boolean/version readiness facts; no serial, UI XML, screenshot, account, or provider data

- [ ] **Step 1: Create the verifier**

Create `infra/gcp/android-worker/verify-runtime.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME=/opt/android-sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"

timeout 240 bash -c 'until adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do sleep 3; done'
test -e /dev/kvm
adb shell settings get global device_provisioned | grep -q 1
curl -fsS http://127.0.0.1:4723/status | \
  /opt/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.value?.ready)process.exit(1);console.log("appium_ready=true")})'
printf 'kvm_ready=true\nemulator_booted=true\nappium_ready=true\n'
```

- [ ] **Step 2: Run syntax verification and commit**

```bash
bash -n infra/gcp/android-worker/verify-runtime.sh
git add infra/gcp/android-worker/verify-runtime.sh
git commit -m "test: add Android runtime readiness probe"
```

- [ ] **Step 3: Run twice across a VM restart**

```bash
source "$HOME/.local/state/errandos/gcp-android-worker.env"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='cd ~/android-worker && bash verify-runtime.sh'
gcloud compute instances stop "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
gcloud compute instances start "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='cd ~/android-worker && bash verify-runtime.sh'
```

Expected: both runs print the same three `true` facts.

---

### Task 6: Run the official Blinkit mobile canary with commit disabled

**Files:**
- Create: `docs/canaries/2026-07-18-gcp-blinkit-mobile-canary.md`
- Never create: committed screenshots, UI XML, APKs, phone/OTP files, emulator profiles, or Appium traces

**Interfaces:**
- Consumes: persistent GCP Android emulator and owner-supervised Google Play/Blinkit login
- Produces: sanitized pass/fail evidence for install, auth, restart persistence, search, reversible cart, checkout facts, and COD availability

- [ ] **Step 1: Open a private screen tunnel**

Run from the Mac and keep the process open only during supervised setup:

```bash
source "$HOME/.local/state/errandos/gcp-android-worker.env"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  -- -N -L 5555:127.0.0.1:5555 -L 4723:127.0.0.1:4723
```

Expected: local ports forward through IAP; no public firewall rule is created.

- [ ] **Step 2: Install Blinkit from the official store and complete login**

Use the tunneled emulator display for the owner-supervised Google Play and Blinkit steps. Enter phone and OTP only in the live session. Before and after login, verify remotely without printing identity:

```bash
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --tunnel-through-iap \
  --command='export PATH=/opt/android-sdk/platform-tools:$PATH; adb shell pm list packages | grep -q "^package:com.grofers.customerapp$" && echo blinkit_installed=true'
```

Expected: `blinkit_installed=true`. If Play Store refuses the emulator or Blinkit cannot be installed, stop the canary.

- [ ] **Step 3: Verify authenticated session persistence**

Stop and start the VM, wait for runtime readiness, open Blinkit, and record only `auth_active=true` or `auth_active=false`. Do not retain screenshots or UI XML.

Expected: `auth_active=true` without another OTP.

- [ ] **Step 4: Run safe provider operations**

Through a bounded diagnostic Appium client, perform exactly:

1. open the official Blinkit app;
2. search for one owner-approved low-value item;
3. identify one exact variant and price;
4. add quantity one;
5. open checkout and extract sanitized item, quantity, item total, fee labels and amounts, grand total, ETA, address-label match, and payment-mode availability;
6. detect COD and select it only if Blinkit enables the option;
7. verify the final order control exists but do not click it;
8. remove the item and verify the cart is empty.

Set and verify the kill switch before the diagnostic:

```bash
export ERRANDOS_LIVE_BROWSER_ACTIONS=true
export ERRANDOS_LIVE_COMMIT=false
test "$ERRANDOS_LIVE_BROWSER_ACTIONS" = true
test "$ERRANDOS_LIVE_COMMIT" = false
```

`ERRANDOS_LIVE_BROWSER_ACTIONS` is the repository's legacy name for the reversible provider-action gate; enabling it does not start Playwright. Expected: search/cart/checkout facts are readable, the cart returns to empty, and no provider reference or order appears.

- [ ] **Step 5: Write the sanitized canary report**

Create `docs/canaries/2026-07-18-gcp-blinkit-mobile-canary.md` using only this schema:

```markdown
# GCP Blinkit mobile canary

- Project isolated: pass/fail
- Nested KVM: pass/fail
- Emulator cold boot: pass/fail
- Emulator restart persistence: pass/fail
- Appium local-only: pass/fail
- Official Blinkit install: pass/fail
- Blinkit authentication: pass/fail
- Authentication survives VM restart: pass/fail
- Search: pass/fail
- Reversible cart preparation: pass/fail
- Checkout extraction: pass/fail
- COD availability represented truthfully: pass/fail
- Final order action attempted: no
- Order placed: no
- Device-integrity/provider block: none or sanitized stage name
- Decision: proceed to typed Android adapter / stop and use dedicated physical Android worker
```

- [ ] **Step 6: Verify no sensitive artifacts and commit the report**

```bash
git status --short
rg -n "otp|phone|address|mastercard|visa|cookie|storage state|ui xml|screenshot" docs/canaries/2026-07-18-gcp-blinkit-mobile-canary.md
git diff --check
```

Expected: the scan returns no personal value or artifact path; only generic checklist labels may appear.

```bash
git add docs/canaries/2026-07-18-gcp-blinkit-mobile-canary.md
git commit -m "test: record GCP Blinkit mobile canary"
```

---

### Task 7: Review spend and make the integration decision

**Files:**
- Modify: `docs/canaries/2026-07-18-gcp-blinkit-mobile-canary.md`
- Create after a passing canary: `docs/superpowers/plans/2026-07-18-android-blinkit-adapter.md`

**Interfaces:**
- Consumes: complete canary report
- Produces: a binary proceed/stop decision and an explicit keep-running or stop action

- [ ] **Step 1: Keep the VM running only while active work continues**

```bash
source "$HOME/.local/state/errandos/gcp-android-worker.env"
gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID" --format='value(status)'
```

Expected during active implementation: `RUNNING`. If work becomes blocked on external input, run `gcloud compute instances stop "$VM_NAME" --zone="$ZONE" --project="$PROJECT_ID"` and verify `TERMINATED`.

- [ ] **Step 2: Inventory remaining billable resources**

```bash
gcloud compute disks list --project="$PROJECT_ID" --format='table(name,zone.basename(),sizeGb,type.basename(),status)'
gcloud compute addresses list --project="$PROJECT_ID"
gcloud compute instances list --project="$PROJECT_ID"
```

Expected: one explicitly accounted-for VM and one 200 GB disk; no reserved static address. Record whether the VM and disk remain active.

- [ ] **Step 3: Apply the feasibility gate**

Proceed only if every mandatory canary item passes. A provider/device-integrity block, missing session persistence, non-deterministic cart mutation, or personal-data leakage is a stop result. Do not write the product integration plan around a failed canary.

- [ ] **Step 4: Write the separate product integration plan after success**

The next plan must cover `AndroidBlinkitAdapter`, a typed Appium client, semantic UI models, a one-emulator lease, worker/control-plane authenticated jobs, login commands, proposal extraction, COD selection, at-most-once commit, receipts, reconciliation, redaction, Hermes skill updates, and the full repository gates. It must not reactivate Playwright for Blinkit.
