#!/usr/bin/env bash
set -euo pipefail

export ANDROID_HOME=/opt/android-sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"

worker_adb() {
  sudo -u errandos env \
    HOME=/home/errandos \
    ADB_VENDOR_KEYS=/home/errandos/.android \
    ANDROID_HOME="$ANDROID_HOME" \
    PATH="$PATH" \
    adb "$@"
}

deadline=$((SECONDS + 240))
until worker_adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do
  (( SECONDS < deadline )) || exit 124
  sleep 3
done
test -e /dev/kvm
worker_adb shell settings get global device_provisioned | grep -q 1
curl -fsS http://127.0.0.1:4723/status | \
  /opt/node/bin/node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.value?.ready)process.exit(1)})'

unit="$(systemctl cat errandos-emulator.service)"
grep -Fq -- '-gpu lavapipe' <<<"$unit" || {
  printf 'renderer_ready=false\n' >&2
  exit 1
}
grep -Fq -- '-timezone Asia/Kolkata' <<<"$unit" || {
  printf 'timezone_ready=false\n' >&2
  exit 1
}
worker_adb shell getprop persist.sys.timezone | grep -Fxq 'Asia/Kolkata' || {
  printf 'timezone_ready=false\n' >&2
  exit 1
}

printf 'kvm_ready=true\nemulator_booted=true\ndevice_provisioned=true\nappium_ready=true\nrenderer_ready=true\ntimezone_ready=true\n'
