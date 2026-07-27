#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/errandos
export ANDROID_HOME=/opt/android-sdk
export ADB_VENDOR_KEYS=/home/errandos/.android
export PATH="$ANDROID_HOME/platform-tools:/usr/bin:/bin"

tmp="$(mktemp /dev/shm/errandos-safe-screen.XXXXXX.xml)"
cleanup() {
  rm -f "$tmp"
  adb shell rm -f /sdcard/errandos-safe-screen.xml >/dev/null 2>&1 || true
}
trap cleanup EXIT

adb shell uiautomator dump /sdcard/errandos-safe-screen.xml >/dev/null 2>&1
adb exec-out cat /sdcard/errandos-safe-screen.xml >"$tmp"

# Preview only the catalog surfaces that cannot contain login, address,
# checkout, payment, or order-history details. Refuse everything else.
if grep -Eiq \
  'log in or sign up|one time password|verification code|pay using|cash on delivery|delivering to|select delivery location|your saved addresses|place order|payment options|order history|track order' \
  "$tmp"; then
  printf 'screen_preview_blocked\n' >&2
  exit 3
fi

if ! grep -Eiq \
  'Search for atta, dal, coke and more|Recent searches|Voice search|Select Unit|Add to cart|is available for ₹' \
  "$tmp"; then
  printf 'screen_preview_blocked\n' >&2
  exit 3
fi

adb exec-out screencap -p
