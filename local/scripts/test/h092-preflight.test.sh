#!/usr/bin/env bash

set -u

test_dir="$(cd "$(dirname "$0")" && pwd)"
script_dir="$(cd "$test_dir/.." && pwd)"

# shellcheck source=../lib/h092-preflight.sh
source "$script_dir/lib/h092-preflight.sh"

allow_fixture="$test_dir/fixtures/h092-allow.snapshot"
refusal_fixture="$test_dir/fixtures/h092-refusal-cases.txt"
allow_snapshot="$(awk 'NF > 0 && $1 !~ /^#/' "$allow_fixture")"
tests_run=0

fail() {
  printf 'FAIL h092_preflight_fixture_test=%s\n' "$1"
  exit 1
}

if ! allow_output="$(h092_evaluate_snapshot_text "$allow_snapshot")"; then
  fail 'safe_snapshot_was_refused'
fi
printf '%s\n' "$allow_output" | rg -q \
  '^RESULT h092_preflight=ALLOWED blocked=0$' \
  || fail 'safe_snapshot_missing_allowed_result'
tests_run=$((tests_run + 1))

while IFS='|' read -r gate unsafe_value expected_refusal; do
  [ -n "$gate" ] || continue
  case "$gate" in
    \#*)
      continue
      ;;
  esac
  unsafe_snapshot="$(
    printf '%s\n' "$allow_snapshot" \
      | awk -F= -v key="$gate" -v value="$unsafe_value" '
          BEGIN { OFS = "=" }
          $1 == key { $2 = value }
          { print }
        '
  )"
  if refusal_output="$(h092_evaluate_snapshot_text "$unsafe_snapshot")"; then
    fail "${gate}_unsafe_snapshot_was_allowed"
  fi
  printf '%s\n' "$refusal_output" | rg -q \
    "^BLOCKED h092_gate=${gate} .*refusal=${expected_refusal}$" \
    || fail "${gate}_missing_expected_refusal"
  printf '%s\n' "$refusal_output" | rg -q \
    '^RESULT h092_preflight=REFUSED blocked=1$' \
    || fail "${gate}_wrong_block_count"
  tests_run=$((tests_run + 1))
done < "$refusal_fixture"

missing_snapshot="$(
  printf '%s\n' "$allow_snapshot" \
    | awk -F= '$1 != "checkout_stop_boundary"'
)"
if missing_output="$(h092_evaluate_snapshot_text "$missing_snapshot")"; then
  fail 'missing_gate_was_allowed'
fi
printf '%s\n' "$missing_output" | rg -q \
  'h092_gate=checkout_stop_boundary .*actual=missing' \
  || fail 'missing_gate_did_not_fail_closed'
tests_run=$((tests_run + 1))

printf 'PASS h092_preflight_fixture_tests=%s\n' "$tests_run"
