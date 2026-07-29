#!/usr/bin/env bash
#
# Pure H092 preflight evaluator.
#
# The live canary supplies facts gathered from the real device, host services,
# allowlisted configuration, and source-boundary checks. Tests call the same
# evaluator with inert fixtures. This file performs no I/O other than reading
# the snapshot text passed by its caller and printing the decision.

h092_snapshot_value() {
  snapshot_text="$1"
  snapshot_key="$2"
  printf '%s\n' "$snapshot_text" \
    | awk -F= -v key="$snapshot_key" '$1 == key { print $2; exit }'
}

h092_evaluate_snapshot_text() {
  snapshot_text="$1"
  h092_preflight_blocked=0

  while IFS='|' read -r gate expected refusal; do
    [ -n "$gate" ] || continue
    actual="$(h092_snapshot_value "$snapshot_text" "$gate")"
    if [ "$actual" = "$expected" ]; then
      printf 'PASS h092_gate=%s actual=%s\n' "$gate" "$actual"
    else
      printf 'BLOCKED h092_gate=%s expected=%s actual=%s refusal=%s\n' \
        "$gate" "$expected" "${actual:-missing}" "$refusal"
      h092_preflight_blocked=$((h092_preflight_blocked + 1))
    fi
  done <<'EOF'
device_connected|true|device_not_connected
device_identity|true|device_identity_unavailable
device_awake|true|device_locked_or_dozing
keyguard_unlocked|true|device_locked_or_dozing
device_interactive|true|device_locked_or_dozing
reverse_ready|true|pixel_backend_bridge_unhealthy
server_healthy|true|local_server_unhealthy
appium_healthy|true|appium_unhealthy
overlay_installed|true|overlay_unhealthy
overlay_audio_granted|true|overlay_unhealthy
overlay_window_allowed|true|overlay_unhealthy
overlay_service_foreground|true|overlay_unhealthy
live_commit_disabled|true|live_commit_enabled_or_unproven
final_dispatch_guard|true|final_dispatch_not_structurally_suppressed
checkout_stop_boundary|true|checkout_stop_boundary_absent
policy_evaluator_healthy|true|preflight_policy_test_failed
checkout_boundary_tests_healthy|true|checkout_boundary_test_failed
requested_test_matrix_healthy|true|requested_test_matrix_failed
EOF

  if [ "$h092_preflight_blocked" -gt 0 ]; then
    printf 'RESULT h092_preflight=REFUSED blocked=%s\n' \
      "$h092_preflight_blocked"
    return 1
  fi

  printf '%s\n' 'RESULT h092_preflight=ALLOWED blocked=0'
  return 0
}
