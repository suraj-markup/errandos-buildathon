#!/usr/bin/env bash
#
# Read-only H092-H095 readiness probe.
#
# This script deliberately has no mode that opens an app, creates an Appium
# session, sends a JaldiAI task request, changes a cart, enters checkout,
# grants confirmation, dispatches an order, changes a feature flag, or creates
# an ADB reverse mapping. It only reads host/device health and, when explicitly
# requested, runs fixture/unit tests.

set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
# shellcheck source=lib/h092-preflight.sh
source "$script_dir/lib/h092-preflight.sh"
device_serial="${ANDROID_DEVICE_UDID:-55221VDAQ000J1}"
voice_url="${JALDI_READINESS_VOICE_URL:-http://127.0.0.1:3100}"
appium_url="${JALDI_READINESS_APPIUM_URL:-http://127.0.0.1:4723}"
include_tests=false
h092_preflight=false
blocked=0
device_connected=false
device_identity=false
device_awake=false
keyguard_unlocked=false
device_interactive=false
reverse_ready=false
server_healthy=false
appium_healthy=false
overlay_installed=false
overlay_audio_granted=false
overlay_window_allowed=false
overlay_service_foreground=false
live_commit_disabled=false
final_dispatch_guard=false
checkout_stop_boundary=false
policy_evaluator_healthy=false
checkout_boundary_tests_healthy=false
requested_test_matrix_healthy=true

usage() {
  printf '%s\n' \
    "Usage: $0 [--h092-preflight] [--tests]" \
    "" \
    "  --h092-preflight  Evaluate the machine-enforced H092 stop gate." \
    "  --tests  Also run the safe fixture/unit rollout matrix." \
    "" \
    "Environment overrides:" \
    "  ANDROID_DEVICE_UDID         Exact device serial (default: $device_serial)" \
    "  JALDI_READINESS_VOICE_URL   GET-only voice base URL (default: $voice_url)" \
    "  JALDI_READINESS_APPIUM_URL GET-only Appium base URL (default: $appium_url)"
}

for argument in "$@"; do
  case "$argument" in
    --h092-preflight)
      h092_preflight=true
      ;;
    --tests)
      include_tests=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'BLOCKED unknown_argument=%s\n' "$argument"
      usage
      exit 2
      ;;
  esac
done

pass() {
  printf 'PASS %s\n' "$1"
}

warn() {
  printf 'WARN %s\n' "$1"
}

block() {
  printf 'BLOCKED %s\n' "$1"
  blocked=$((blocked + 1))
}

need_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "command=$1"
  else
    block "missing_command=$1"
  fi
}

printf '%s\n' \
  'JaldiAI H092-H095 read-only readiness probe' \
  "repo=$repo_root" \
  "device=$device_serial" \
  'safety=no_app_open,no_appium_session,no_task_post,no_cart,no_checkout,no_order,no_flag_change,no_reverse_change'

for required in adb curl jq rg; do
  need_command "$required"
done

if [ "$blocked" -gt 0 ]; then
  if [ "$h092_preflight" = true ]; then
    printf 'RESULT h092_preflight=REFUSED blocked=%s reason=missing_required_command\n' \
      "$blocked"
  fi
  exit 1
fi

device_line="$(adb devices -l | awk -v serial="$device_serial" '$1 == serial { print; exit }')"
if printf '%s\n' "$device_line" | rg -q ' device( |$)'; then
  pass "device_connected=$device_line"
  device_connected=true
else
  block "device_not_ready=$device_serial"
fi

manufacturer="$(adb -s "$device_serial" shell getprop ro.product.manufacturer 2>/dev/null | tr -d '\r')"
model="$(adb -s "$device_serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
android_release="$(adb -s "$device_serial" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
if [ -n "$manufacturer" ] && [ -n "$model" ] && [ -n "$android_release" ]; then
  pass "device_identity=$manufacturer/$model android=$android_release"
  device_identity=true
else
  block 'device_identity_unavailable'
fi

power_state="$(adb -s "$device_serial" shell dumpsys power 2>/dev/null)"
if printf '%s\n' "$power_state" | rg -q 'mWakefulness=Awake'; then
  pass 'device_awake=true'
  device_awake=true
else
  block 'device_awake=false_or_unknown'
fi

policy_state="$(
  adb -s "$device_serial" shell dumpsys window policy 2>/dev/null \
    || true
)"
keyguard_values="$(
  printf '%s\n' "$policy_state" \
    | sed -nE 's/^[[:space:]]+showing=(true|false).*$/\1/p'
)"
keyguard_value_count="$(
  printf '%s\n' "$keyguard_values" \
    | awk 'NF > 0 { count++ } END { print count + 0 }'
)"
if [ "$keyguard_value_count" -eq 1 ] \
  && [ "$keyguard_values" = 'false' ]; then
  pass 'keyguard_unlocked=true'
  keyguard_unlocked=true
else
  if [ "$h092_preflight" = true ]; then
    block 'keyguard_unlocked=false_or_unknown'
  else
    warn 'keyguard_unlocked=false_or_unknown'
  fi
fi
interactive_values="$(
  printf '%s\n' "$policy_state" \
    | sed -nE 's/.*interactiveState=(INTERACTIVE_STATE_[A-Z]+).*$/\1/p'
)"
interactive_value_count="$(
  printf '%s\n' "$interactive_values" \
    | awk 'NF > 0 { count++ } END { print count + 0 }'
)"
if [ "$interactive_value_count" -eq 1 ] \
  && [ "$interactive_values" = 'INTERACTIVE_STATE_AWAKE' ]; then
  pass 'device_interactive=true'
  device_interactive=true
else
  if [ "$h092_preflight" = true ]; then
    block 'device_interactive=false_or_unknown'
  else
    warn 'device_interactive=false_or_unknown'
  fi
fi

focus_line="$(
  adb -s "$device_serial" shell dumpsys window 2>/dev/null \
    | rg 'mCurrentFocus=Window' \
    | tail -n 1
)"
focused_package="$(
  printf '%s\n' "$focus_line" \
    | sed -nE 's#.* u[0-9]+ ([A-Za-z0-9._]+)/.*#\1#p'
)"
if [ -n "$focused_package" ]; then
  pass "foreground_package=$focused_package"
elif printf '%s\n' "$focus_line" | rg -q 'NotificationShade'; then
  warn 'foreground_window=NotificationShade'
else
  warn 'foreground_package=unknown'
fi

package_state="$(adb -s "$device_serial" shell dumpsys package ai.errandos.overlay 2>/dev/null)"
if printf '%s\n' "$package_state" | rg -q 'lastUpdateTime='; then
  pass 'overlay_installed=true'
  overlay_installed=true
else
  block 'overlay_installed=false_or_unknown'
fi
if printf '%s\n' "$package_state" | rg -q 'android.permission.RECORD_AUDIO: granted=true'; then
  pass 'overlay_record_audio_granted=true'
  overlay_audio_granted=true
else
  block 'overlay_record_audio_granted=false_or_unknown'
fi

window_state="$(
  adb -s "$device_serial" shell appops get \
    ai.errandos.overlay SYSTEM_ALERT_WINDOW 2>/dev/null \
    || true
)"
if printf '%s\n' "$window_state" | rg -q 'SYSTEM_ALERT_WINDOW: allow'; then
  pass 'overlay_system_alert_window=allow'
  overlay_window_allowed=true
else
  block 'overlay_system_alert_window=not_allowed_or_unknown'
fi

service_state="$(adb -s "$device_serial" shell dumpsys activity services ai.errandos.overlay 2>/dev/null)"
if printf '%s\n' "$service_state" | rg -q 'isForeground=true'; then
  pass 'overlay_foreground_service=true'
  overlay_service_foreground=true
else
  block 'overlay_foreground_service=false_or_unknown'
fi

reverse_state="$(adb -s "$device_serial" reverse --list 2>/dev/null)"
if printf '%s\n' "$reverse_state" | rg -q 'tcp:3100[[:space:]]+tcp:3100'; then
  pass 'overlay_backend_bridge=tcp:3100->tcp:3100'
  reverse_ready=true
else
  block 'overlay_backend_bridge=missing (probe will not create it)'
fi

voice_status="$(
  curl --max-time 3 -sS -o /dev/null -w '%{http_code}' "$voice_url/" 2>/dev/null \
    || true
)"
if [ "$voice_status" = '200' ]; then
  pass "voice_health=http_200 url=$voice_url/"
  server_healthy=true
else
  block "voice_health=http_${voice_status:-unreachable} url=$voice_url/"
fi

appium_status="$(curl --max-time 3 -sS "$appium_url/status" 2>/dev/null || true)"
if printf '%s\n' "$appium_status" | jq -e '.value.ready == true' >/dev/null 2>&1; then
  pass "appium_ready=true url=$appium_url/status"
  appium_healthy=true
else
  block "appium_ready=false_or_unreachable url=$appium_url/status"
fi

env_file="$repo_root/local/apps/voice/.env.local"
if [ -f "$env_file" ]; then
  printf '%s\n' 'INFO allowlisted_boolean_config_snapshot:'
  sed -nE \
    '/^(JALDI_(AUTHORITATIVE_TASK_STATE_V1|PHONE_TASK_V2|TASK_RECOVERY_V1|ATOMIC_PRODUCT_SELECTION_V1|STRUCTURED_PROGRESS_V1|REALTIME_SHADOW_V1|REALTIME_CONTROL_V1|REALTIME_VOICE_V1|REALTIME_PHONE_TOOLS_V1)|ERRANDOS_LIVE_COMMIT)=(true|false|0|1)$/p' \
    "$env_file"
  commit_values="$(
    sed -nE 's/^ERRANDOS_LIVE_COMMIT=(true|false|0|1)$/\1/p' "$env_file"
  )"
  commit_value_count="$(
    printf '%s\n' "$commit_values" | awk 'NF > 0 { count++ } END { print count + 0 }'
  )"
  if [ "$commit_value_count" -eq 1 ] \
    && printf '%s\n' "$commit_values" | rg -q '^(false|0)$'; then
    pass 'live_commit_disabled=true'
    live_commit_disabled=true
  else
    if [ "$h092_preflight" = true ]; then
      block 'live_commit_disabled=false_or_unproven'
    else
      warn 'live_commit_disabled=false_or_unproven'
    fi
  fi
  if printf '%s\n' "$commit_values" | rg -q '^(true|1)$'; then
    warn 'live_commit_configured=true; this is not H093 authorization and must not be used by H092'
  fi
else
  if [ "$h092_preflight" = true ]; then
    block 'allowlisted_boolean_config_snapshot=env_file_missing'
  else
    warn 'allowlisted_boolean_config_snapshot=env_file_missing'
  fi
fi

blinkit_source="$repo_root/local/apps/voice/lib/blinkit-execution.ts"
blinkit_test="$repo_root/local/apps/voice/lib/blinkit-execution.test.ts"
if [ -f "$blinkit_source" ] \
  && [ -f "$blinkit_test" ] \
  && rg -Fq "?? process.env.ERRANDOS_LIVE_COMMIT === 'true';" "$blinkit_source" \
  && rg -Fq 'if (!this.liveCommitEnabled) {' "$blinkit_source" \
  && rg -Fq "status: 'final_dispatch_disabled'" "$blinkit_source" \
  && rg -Fq "status: 'final_dispatch_disabled'" "$blinkit_test" \
  && rg -Fq 'expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();' \
    "$blinkit_test"; then
  pass 'final_dispatch_guard=present'
  final_dispatch_guard=true
else
  if [ "$h092_preflight" = true ]; then
    block 'final_dispatch_guard=absent_or_unproven'
  else
    warn 'final_dispatch_guard=absent_or_unproven'
  fi
fi

if [ -f "$blinkit_source" ] \
  && [ -f "$blinkit_test" ] \
  && rg -Fq 'Checkout ready for review · NOT ORDERED' "$blinkit_source" \
  && rg -Fq "confirmationPhrase: 'Confirm COD order'" "$blinkit_source" \
  && rg -Fq "message: 'Review these exact terms. Nothing has been ordered.'" \
    "$blinkit_source" \
  && rg -Fq "status: 'confirmation_required'" "$blinkit_source" \
  && rg -Fq 'prepares complete checkout terms while keeping the order NOT ORDERED' \
    "$blinkit_test" \
  && rg -Fq 'expect(driver.clickFinalOrderOnce).not.toHaveBeenCalled();' \
    "$blinkit_test"; then
  pass 'checkout_stop_boundary=present'
  checkout_stop_boundary=true
else
  if [ "$h092_preflight" = true ]; then
    block 'checkout_stop_boundary=absent_or_unproven'
  else
    warn 'checkout_stop_boundary=absent_or_unproven'
  fi
fi

if [ "$h092_preflight" = true ]; then
  if bash "$script_dir/test/h092-preflight.test.sh"; then
    pass 'h092_policy_evaluator_tests=passed'
    policy_evaluator_healthy=true
  else
    block 'h092_policy_evaluator_tests=failed'
  fi
  if (
    cd "$repo_root/local" || exit 1
    pnpm --filter @errandos/voice exec vitest run --silent=true \
      lib/blinkit-execution.test.ts \
      lib/phone-tool.test.ts \
      lib/checkout/v2/checkout-graph.test.ts
  ); then
    pass 'h092_checkout_boundary_tests=passed'
    checkout_boundary_tests_healthy=true
  else
    block 'h092_checkout_boundary_tests=failed'
  fi
fi

if [ "$include_tests" = true ]; then
  printf '%s\n' 'INFO running_safe_fixture_and_unit_matrix=true'
  (
    cd "$repo_root/local" || exit 1
    pnpm --filter @errandos/voice exec vitest run --silent=true \
      lib/general-mobile/v2/android-settings-read-only-adapter.test.ts \
      lib/general-mobile/v2/contracts-registry.test.ts \
      lib/general-mobile/v2/fake-adapter.test.ts \
      lib/general-mobile/v2/read-only-companion.test.ts \
      lib/general-mobile/v2/runner.test.ts \
      lib/blinkit-execution.test.ts \
      lib/phone-tool.test.ts \
      lib/checkout/v2/confirmation-grants.test.ts \
      lib/checkout/v2/cod-checkout-state.test.ts \
      lib/checkout/v2/checkout-graph.test.ts \
      lib/execution/v2/cart-mutation-execution-truth.test.ts \
      lib/execution/v2/idempotency-records.test.ts \
      lib/execution/v2/mutation-outcomes.test.ts \
      lib/realtime/safe-phone-tools.test.ts
  ) || {
    requested_test_matrix_healthy=false
    block 'voice_rollout_unit_matrix=failed'
  }
  (
    cd "$repo_root/local" || exit 1
    pnpm --filter @errandos/provider-connectors exec vitest run --silent=true \
      test/android-commit.test.ts \
      test/blinkit-orders.test.ts
  ) || {
    requested_test_matrix_healthy=false
    block 'provider_rollout_unit_matrix=failed'
  }
fi

if [ "$h092_preflight" = true ]; then
  h092_snapshot="$(
    printf '%s\n' \
      "device_connected=$device_connected" \
      "device_identity=$device_identity" \
      "device_awake=$device_awake" \
      "keyguard_unlocked=$keyguard_unlocked" \
      "device_interactive=$device_interactive" \
      "reverse_ready=$reverse_ready" \
      "server_healthy=$server_healthy" \
      "appium_healthy=$appium_healthy" \
      "overlay_installed=$overlay_installed" \
      "overlay_audio_granted=$overlay_audio_granted" \
      "overlay_window_allowed=$overlay_window_allowed" \
      "overlay_service_foreground=$overlay_service_foreground" \
      "live_commit_disabled=$live_commit_disabled" \
      "final_dispatch_guard=$final_dispatch_guard" \
      "checkout_stop_boundary=$checkout_stop_boundary" \
      "policy_evaluator_healthy=$policy_evaluator_healthy" \
      "checkout_boundary_tests_healthy=$checkout_boundary_tests_healthy" \
      "requested_test_matrix_healthy=$requested_test_matrix_healthy"
  )"
  h092_evaluate_snapshot_text "$h092_snapshot"
  exit $?
fi

if [ "$blocked" -gt 0 ]; then
  printf 'RESULT blocked=%s\n' "$blocked"
  exit 1
fi

printf '%s\n' 'RESULT readiness_checks_passed=true'
