#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/scripts/lib/qa-slot-pool.sh"
TMP="$(mktemp -d /tmp/fly2874-slot-pool-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_invalid() {
  local fixture="$1" label="$2"
  if qa_slot_pool_size "$fixture" >/dev/null 2>&1; then
    fail "$label was accepted"
  fi
}

[[ -f "$HELPER" ]] || fail "missing slot-pool helper: $HELPER"
# shellcheck source=../lib/qa-slot-pool.sh
source "$HELPER"

jq -n '
  {slots: [range(1; 7) as $id | {
    id: $id,
    bridgePort: (19870 + $id),
    channelId: ("channel-" + ($id | tostring)),
    botAppId: ("bot-" + ($id | tostring)),
    tokenEnvVar: ("TEST_BOT_TOKEN_" + ($id | tostring)),
    voiceChannelId: ("15000000000000000" + ($id | tostring)),
    voiceChannelName: ("voice-test-" + ($id | tostring))
  }]}
' > "$TMP/valid.json"

[[ "$(qa_slot_pool_size "$TMP/valid.json")" == "6" ]] \
  || fail "valid six-slot pool did not report size 6"
qa_slot_pool_require_member "$TMP/valid.json" 6 \
  || fail "slot 6 was rejected"
if qa_slot_pool_require_member "$TMP/valid.json" 7 >/dev/null 2>&1; then
  fail "slot 7 was accepted"
fi

jq 'del(.slots[].voiceChannelId, .slots[].voiceChannelName)' \
  "$TMP/valid.json" > "$TMP/text-only.json"
[[ "$(qa_slot_pool_size "$TMP/text-only.json")" == "6" ]] \
  || fail "text-only synthetic pool should remain compatible"

jq '.slots[5].id = 8' "$TMP/valid.json" > "$TMP/non-contiguous.json"
expect_invalid "$TMP/non-contiguous.json" "non-contiguous ids"

jq '.slots[5].bridgePort = .slots[4].bridgePort' \
  "$TMP/valid.json" > "$TMP/duplicate-port.json"
expect_invalid "$TMP/duplicate-port.json" "duplicate bridgePort"

jq '.slots[5].channelId = .slots[4].channelId' \
  "$TMP/valid.json" > "$TMP/duplicate-channel.json"
expect_invalid "$TMP/duplicate-channel.json" "duplicate channelId"

jq '.slots[5].botAppId = .slots[4].botAppId' \
  "$TMP/valid.json" > "$TMP/duplicate-bot.json"
expect_invalid "$TMP/duplicate-bot.json" "duplicate botAppId"

jq '.slots[5].tokenEnvVar = .slots[4].tokenEnvVar' \
  "$TMP/valid.json" > "$TMP/duplicate-token-env.json"
expect_invalid "$TMP/duplicate-token-env.json" "duplicate tokenEnvVar"

jq 'del(.slots[5].voiceChannelId)' \
  "$TMP/valid.json" > "$TMP/partial-voice.json"
expect_invalid "$TMP/partial-voice.json" "partial voice mapping"

jq '.slots[5].voiceChannelId = .slots[4].voiceChannelId' \
  "$TMP/valid.json" > "$TMP/duplicate-voice.json"
expect_invalid "$TMP/duplicate-voice.json" "duplicate voiceChannelId"
[[ "$(qa_slot_pool_count "$TMP/duplicate-voice.json")" == "6" ]] \
  || fail "count-only teardown view should ignore unrelated voice-map drift"

jq '.slots[5].voiceChannelId = "not-a-snowflake"' \
  "$TMP/valid.json" > "$TMP/invalid-voice-id.json"
expect_invalid "$TMP/invalid-voice-id.json" "invalid voiceChannelId"

jq '.slots[5].voiceChannelName = "voice-test-5"' \
  "$TMP/valid.json" > "$TMP/mismatched-voice-name.json"
expect_invalid "$TMP/mismatched-voice-name.json" "mismatched voiceChannelName"

printf '%s\n' '{"slots":[]}' > "$TMP/empty.json"
expect_invalid "$TMP/empty.json" "empty pool"

FAKE_HOME="$TMP/home"
mkdir -p "$FAKE_HOME/.flywheel"
cp "$TMP/valid.json" "$FAKE_HOME/.flywheel/test-slots.json"

if HOME="$FAKE_HOME" bash "$ROOT/scripts/qa-fly-60-driver.sh" \
    --slot 6 --g3-trials 0 >"$TMP/driver-slot6.out" 2>&1; then
  fail "driver accepted invalid g3 trial count"
fi
grep -Fq -- '--g3-trials must be positive' "$TMP/driver-slot6.out" \
  || fail "driver rejected slot 6 before reaching the next argument check"
if grep -Fq -- '--slot must be 1-4' "$TMP/driver-slot6.out"; then
  fail "driver still hard-codes the four-slot range"
fi

if HOME="$FAKE_HOME" bash "$ROOT/scripts/qa-fly-60-driver.sh" \
    --slot 7 >"$TMP/driver-slot7.out" 2>&1; then
  fail "driver accepted slot 7 outside the configured pool"
fi
grep -Fq 'configured range 1-6' "$TMP/driver-slot7.out" \
  || fail "driver did not report the configured six-slot range"

DISCORD_E2E="$ROOT/scripts/discord-e2e.sh"
grep -Fq 'source "${SCRIPT_DIR}/lib/qa-slot-pool.sh"' "$DISCORD_E2E" \
  || fail "discord-e2e does not load the configured slot-pool authority"
grep -Fq 'TOTAL_SLOTS="$(qa_slot_pool_count "$SLOTS_FILE")"' "$DISCORD_E2E" \
  || fail "discord-e2e does not derive its autodetect bound from the slot pool"
grep -Fq 'for i in $(seq 1 "$TOTAL_SLOTS")' "$DISCORD_E2E" \
  || fail "discord-e2e autodetect does not scan every configured slot"
if grep -Eq 'for i in 1 2 3 4([;[:space:]]|$)' "$DISCORD_E2E"; then
  fail "discord-e2e still hard-codes the four-slot autodetect range"
fi

INVALID_HOME="$TMP/invalid-home"
mkdir -p "$INVALID_HOME/.flywheel"
printf '%s\n' '{"slots":' > "$INVALID_HOME/.flywheel/test-slots.json"
TEARDOWN_CALLS="$TMP/teardown-calls"
if (
  export HOME="$INVALID_HOME"
  export FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE="fly2874-test"
  export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMP/cmux-lock"
  export FLYWHEEL_CMUX_MAINTENANCE_MARKER="$TMP/cmux-maintenance"
  # shellcheck source=/dev/null
  source "$ROOT/scripts/test-teardown.sh"
  acquire_cmux_qa_teardown_claim() { return 0; }
  acquire_cmux_teardown_lease_with_retry() { return 0; }
  release_cmux_teardown_resources() { :; }
  teardown_slot() { printf '%s\n' "$1" >> "$TEARDOWN_CALLS"; }
  test_teardown_main all
) >"$TMP/teardown-all.out" 2>&1; then
  fail "teardown all accepted an unreadable slot config"
fi
[[ ! -s "$TEARDOWN_CALLS" ]] \
  || fail "teardown all touched slots after an unreadable config"

echo "PASS FLY-2874 slot-pool contract"
