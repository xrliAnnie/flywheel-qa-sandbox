#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly1884-attach-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

export ATTACH_HEAL_STATE="$SB/attach.state"
export HEAL_STATE="$SB/heal.state"
export FLYWHEEL_CMUX_ATTACH_RETRIES=3
export FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$ROOT/scripts/flywheel-view-attach.sh"
export FLYWHEEL_CMUX_LEAD_ATTACH_BIN="$SB/lead-attach"
printf '#!/bin/sh\nexit 0\n' > "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN"
chmod +x "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"

pass=0 fail=0 CMUX_OPS="" ALERTS=""
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

_attach_mutation_guard() { GUARD_BLOCK_RC=0; return 0; }
cmux_call_guarded() {
  local guard="$1"; shift
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  CMUX_OPS+="${CMUX_OPS:+$'\n'}$*"
}
_alert_cmux_cleanup() { ALERTS+="${ALERTS:+$'\n'}$3"; }

ordinary_cmd="$(build_attach_command cmux-FLY-1884-qa)"
i=1
while [[ "$i" -le 5 ]]; do
  recover_attach_surface view generation-a workspace:1 FLY-1884-qa surface:1 \
    "$ordinary_cmd" cmux-FLY-1884-qa bare
  i=$((i + 1))
done
if [[ "$(grep -c '^send ' <<< "$CMUX_OPS" || true)" == 3 \
    && "$(grep -c '^respawn-pane ' <<< "$CMUX_OPS" || true)" == 1 \
    && "$(awk -F'|' '{print $6}' "$ATTACH_HEAL_STATE")" == rebuilt ]]; then
  ok "bare-shell recovery sends N times, then rebuilds exactly once"
else
  bad "ordinary retry budget drifted ops=[$CMUX_OPS] state=[$(cat "$ATTACH_HEAL_STATE" 2>/dev/null)]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
recover_attach_surface view generation-a workspace:10 duplicate-title surface:10 \
  "$ordinary_cmd" cmux-duplicate-title bare
recover_attach_surface view generation-a workspace:11 duplicate-title surface:11 \
  "$ordinary_cmd" cmux-duplicate-title bare
if [[ "$(wc -l < "$ATTACH_HEAL_STATE" | tr -d ' ')" == 2 \
    && "$(awk -F'|' '$2 == "workspace:10" {print $5}' "$ATTACH_HEAL_STATE")" == 1 \
    && "$(awk -F'|' '$2 == "workspace:11" {print $5}' "$ATTACH_HEAL_STATE")" == 1 ]]; then
  ok "retry budgets remain exact-ref scoped for duplicate titles"
else
  bad "duplicate-title retries overwrote another ref state=[$(cat "$ATTACH_HEAL_STATE" 2>/dev/null)]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
recover_attach_surface view generation-a workspace:2 FLY-1884-implement surface:2 \
  "$ordinary_cmd" cmux-FLY-1884-implement no-pty
recover_attach_surface view generation-a workspace:2 FLY-1884-implement surface:2 \
  "$ordinary_cmd" cmux-FLY-1884-implement no-pty
if [[ "$(grep -c '^respawn-pane ' <<< "$CMUX_OPS" || true)" == 1 \
    && "$(grep -c '^send ' <<< "$CMUX_OPS" || true)" == 0 ]]; then
  ok "no-PTY diagnostic rebuilds immediately and idempotently"
else
  bad "no-PTY recovery mutated more than once ops=[$CMUX_OPS]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
printf '%s\n' 'generation-a|workspace:2|FLY-1884-implement|view|3|rebuild-issued|1|1|0-0' \
  > "$ATTACH_HEAL_STATE"
recover_attach_surface view generation-a workspace:2 FLY-1884-implement surface:2 \
  "$ordinary_cmd" cmux-FLY-1884-implement bare
recover_attach_surface view generation-a workspace:2 FLY-1884-implement surface:2 \
  "$ordinary_cmd" cmux-FLY-1884-implement bare
if [[ "$CMUX_OPS" != *'respawn-pane '* && "$CMUX_OPS" != *'send '* \
    && "$(awk -F'|' '{print $6}' "$ATTACH_HEAL_STATE")" == dead \
    && "$CMUX_OPS" == *'连接失效 · 点击重连'* ]]; then
  ok "crash after rebuild reservation dead-letters without replay"
else
  bad "rebuild-issued replayed after crash ops=[$CMUX_OPS] state=[$(cat "$ATTACH_HEAL_STATE")]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""; ALERTS=""
CMUX_ADDITIVE_ROUND_ID=100-1
recover_attach_surface view generation-a workspace:3 FLY-1884-design surface:3 \
  "$ordinary_cmd" cmux-FLY-1884-design unclassified
sleep 1
CMUX_ADDITIVE_ROUND_ID=100-2
recover_attach_surface view generation-a workspace:3 FLY-1884-design surface:3 \
  "$ordinary_cmd" cmux-FLY-1884-design unclassified
if [[ "$CMUX_OPS" == *'连接未就绪 · 继续观察'* \
    && "$CMUX_OPS" == *'连接失效 · 点击重连'* \
    && "$CMUX_OPS" != *'send '* && "$CMUX_OPS" != *'respawn-pane '* \
    && "$ALERTS" == *'attach-unclassified'* ]]; then
  ok "unclassified surfaces stay mutation-free and become visibly stale"
else
  bad "unclassified recovery drifted ops=[$CMUX_OPS] alerts=[$ALERTS]"
fi

recover_attach_surface view generation-a workspace:3 FLY-1884-design surface:3 \
  "$ordinary_cmd" cmux-FLY-1884-design healthy
if [[ ! -s "$ATTACH_HEAL_STATE" && "$CMUX_OPS" == *'clear-status'* ]]; then
  ok "a real client clears durable recovery and visible status"
else
  bad "healthy recovery did not clear state=[$(cat "$ATTACH_HEAL_STATE" 2>/dev/null)] ops=[$CMUX_OPS]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
recover_attach_surface view generation-a workspace:4 FLY-1884-qa surface:4 \
  "$ordinary_cmd" cmux-FLY-1884-qa missing
if [[ "$CMUX_OPS" == *'底层 session 不存在 · 等待重建'* \
    && "$CMUX_OPS" == *'--color #ff3b30'* \
    && "$(awk -F'|' '{print $5 "|" $6}' "$ATTACH_HEAL_STATE")" == '0|dead' \
    && "$CMUX_OPS" != *'send '* && "$CMUX_OPS" != *'respawn-pane '* ]]; then
  ok "missing tmux authority is explicit and never receives pane mutation"
else
  bad "missing-session handling drifted ops=[$CMUX_OPS] state=[$(cat "$ATTACH_HEAL_STATE" 2>/dev/null)]"
fi
recover_attach_surface view generation-a workspace:4 FLY-1884-qa surface:4 \
  "$ordinary_cmd" cmux-FLY-1884-qa unclassified
if [[ "$CMUX_OPS" == *'连接未就绪 · 继续观察'* ]]; then
  ok "a returned session leaves missing state and resumes classification"
else
  bad "returned session remained stuck in missing state ops=[$CMUX_OPS]"
fi

printf 'corrupt\n' > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
recover_attach_surface view generation-a workspace:4 FLY-1884-qa surface:4 \
  "$ordinary_cmd" cmux-FLY-1884-qa bare || true
if [[ "$CMUX_OPS" == *'连接失效 · 恢复状态损坏'* \
    && "$CMUX_OPS" == *'--color #ff3b30'* \
    && "$CMUX_OPS" != *'send '* && "$CMUX_OPS" != *'respawn-pane '* ]]; then
  ok "corrupt durable state fails closed with a visible error"
else
  bad "corrupt state was silent or mutated the pane ops=[$CMUX_OPS]"
fi

: > "$ATTACH_HEAL_STATE"; CMUX_OPS=""
socket="$SB/private.sock"
lead_cmd="$(build_lead_attach_command "$socket")"
recover_attach_surface v2 generation-a workspace:5 growth-rafiki-lead surface:5 \
  "$lead_cmd" "$socket" no-pty
if [[ "$CMUX_OPS" == *"respawn-pane --workspace workspace:5 --surface surface:5 --command $lead_cmd"* ]]; then
  ok "private-v2 rebuild uses the private-socket command producer"
else
  bad "private-v2 rebuild command drifted ops=[$CMUX_OPS]"
fi

printf '\nFLY-1884 attach recovery: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
