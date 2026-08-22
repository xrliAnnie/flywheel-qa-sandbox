#!/usr/bin/env bash
# FLY-1944 A2: positive dead-screen signatures are report-only until cmux has
# a replacement primitive that preserves immutable command-birth evidence.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SB="$(mktemp -d -t fly1944-rebuild-XXXXXX)"
trap 'rm -rf "$SB"' EXIT

export ATTACH_HEAL_STATE="$SB/attach.state"
export VIEW_LEDGER="$SB/view-ledger"
export FLYWHEEL_CMUX_PREPARED_MIN_AGE_SECONDS=1
export FLYWHEEL_CMUX_ATTACH_RETRIES=1
export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$ROOT/scripts/flywheel-view-attach.sh"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
set +e

pass=0 fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

OLD_UUID="11111111-1111-4111-8111-111111111111"
NEW_UUID="22222222-2222-4222-8222-222222222222"
OLD_REF="workspace:1"
NEW_REF="workspace:2"
TITLE="FLY-1944-implement"
TARGET="cmux-FLY-1944-implement"
OLD_SURFACE="surface:1"
NEW_SURFACE="surface:2"
MOCK_OLD_PRESENT=1
MOCK_NEW_PRESENT=0
MOCK_OLD_TITLE="$TITLE"
MOCK_NEW_TITLE="Terminal 2"
MOCK_OLD_SCREEN="[server exited]"
MOCK_NEW_SCREEN=""
MOCK_CLIENTS=0
MOCK_OPS=""
MOCK_NEW_COMMAND=""

mock_reset() {
  : > "$ATTACH_HEAL_STATE"
  printf 'committed|generation-a|%s|%s|%s\n' "$OLD_REF" "$TITLE" "$OLD_UUID" > "$VIEW_LEDGER"
  MOCK_OLD_PRESENT=1
  MOCK_NEW_PRESENT=0
  MOCK_OLD_TITLE="$TITLE"
  MOCK_NEW_TITLE="Terminal 2"
  MOCK_OLD_SCREEN="[server exited]"
  MOCK_NEW_SCREEN=""
  MOCK_CLIENTS=0
  MOCK_OPS=""
  MOCK_NEW_COMMAND=""
  CMUX_ADDITIVE_ROUND_ID=100-1
  GUARD_WAS_BLOCKED=0
  GUARD_BLOCK_RC=0
}

mock_inventory_json() {
  python3 - "$MOCK_OLD_PRESENT" "$MOCK_NEW_PRESENT" "$MOCK_OLD_TITLE" "$MOCK_NEW_TITLE" \
    "$OLD_REF" "$NEW_REF" "$OLD_UUID" "$NEW_UUID" <<'PY'
import json,sys
old_present,new_present,old_title,new_title,old_ref,new_ref,old_uuid,new_uuid=sys.argv[1:]
rows=[]
if old_present == "1": rows.append({"ref":old_ref,"id":old_uuid,"title":old_title})
if new_present == "1": rows.append({"ref":new_ref,"id":new_uuid,"title":new_title})
print(json.dumps({"workspaces":rows}))
PY
}

cmux_socket_identity() { printf 'generation-a\n'; }
assert_or_reuse_owned_lease() { return 0; }
watcher_mutation_latch_clear() { return 0; }
get_cmux_workspaces_json() { mock_inventory_json; }
workspace_identity_matches() {
  local ref="$1" title="$2" uuid="$3"
  if [[ "$ref" == "$OLD_REF" ]]; then
    [[ "$MOCK_OLD_PRESENT" == 1 && "$MOCK_OLD_TITLE" == "$title" && "$uuid" == "$OLD_UUID" ]]
  else
    [[ "$ref" == "$NEW_REF" && "$MOCK_NEW_PRESENT" == 1 && "$MOCK_NEW_TITLE" == "$title" && "$uuid" == "$NEW_UUID" ]]
  fi
}
workspace_ref_uuid_matches() {
  local ref="$1" uuid="$2"
  if [[ "$ref" == "$OLD_REF" ]]; then
    [[ "$MOCK_OLD_PRESENT" == 1 && "$uuid" == "$OLD_UUID" ]]
  else
    [[ "$ref" == "$NEW_REF" && "$MOCK_NEW_PRESENT" == 1 && "$uuid" == "$NEW_UUID" ]]
  fi
}
workspace_title_for_ref() {
  case "$1" in
    "$OLD_REF") [[ "$MOCK_OLD_PRESENT" == 1 ]] && printf '%s\n' "$MOCK_OLD_TITLE" ;;
    "$NEW_REF") [[ "$MOCK_NEW_PRESENT" == 1 ]] && printf '%s\n' "$MOCK_NEW_TITLE" ;;
    *) return 1 ;;
  esac
}
workspace_terminal_surface_ref() {
  case "$1" in
    "$OLD_REF") [[ "$MOCK_OLD_PRESENT" == 1 ]] && printf '%s\n' "$OLD_SURFACE" ;;
    "$NEW_REF") [[ "$MOCK_NEW_PRESENT" == 1 ]] && printf '%s\n' "$NEW_SURFACE" ;;
    *) return 1 ;;
  esac
}
view_session_client_count() { printf '%s\n' "$MOCK_CLIENTS"; }
cmux_call() {
  local verb="$1" ref=""; shift
  if [[ "$verb" == read-screen ]]; then
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == --workspace ]]; then ref="$2"; shift 2; else shift; fi
    done
    [[ "$ref" == "$OLD_REF" ]] && printf '%s\n' "$MOCK_OLD_SCREEN" || printf '%s\n' "$MOCK_NEW_SCREEN"
    return 0
  fi
  return 1
}
cmux_call_guarded() {
  local guard="$1" verb="$2"; shift 2
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  MOCK_OPS+="${MOCK_OPS:+$'\n'}${verb} $*"
  case "$verb" in
    new-workspace)
      MOCK_NEW_PRESENT=1
      while [[ $# -gt 0 ]]; do
        if [[ "$1" == --command ]]; then MOCK_NEW_COMMAND="$2"; shift 2; else shift; fi
      done
      ;;
    close-workspace)
      if [[ "$2" == "$OLD_REF" ]]; then MOCK_OLD_PRESENT=0; else MOCK_NEW_PRESENT=0; fi
      ;;
    rename-workspace)
      [[ "$2" == "$NEW_REF" ]] && MOCK_NEW_TITLE="$3"
      ;;
    rename-tab) ;;
  esac
  return 0
}
STATUS_CALLS=""
ALERT_CALLS=""
_attach_set_status() {
  STATUS_CALLS+="${STATUS_CALLS:+$'\n'}$1|$3|$7|$8"
}
flywheel_alert() {
  ALERT_CALLS+="${ALERT_CALLS:+$'\n'}$*"
}

class_ok=1
for fixture in \
  "can't find session: exited" \
  "[server exited]: exited" \
  "no server running: exited" \
  "[exited]: exited" \
  "server exited: exited" \
  "   : empty" \
  "open terminal failed: not a terminal: no-pty"; do
  screen=${fixture%: *}
  expected=${fixture##*: }
  [[ "$(classify_dead_view_screen "$screen" 2>/dev/null || true)" == "$expected" ]] || class_ok=0
done
for screen in 'vim README.md' 'Claude Code' 'htop' 'random disconnect text'; do
  [[ "$(classify_dead_view_screen "$screen" 2>/dev/null || true)" == unclassified ]] || class_ok=0
done
if [[ "$class_ok" == 1 ]]; then
  ok "only the enumerated exit, empty, and no-PTY signatures classify as dead"
else
  bad "dead-view signature table admitted unknown content or missed an approved literal"
fi

mock_reset
STATUS_CALLS=""
ALERT_CALLS=""
CMUX_CLEANUP_ALERT_LATCH=""
CMUX_CLEANUP_ALERT_LATCH_COUNT=0
SURFACE_LAST_SCREEN="$MOCK_OLD_SCREEN"
recover_attach_surface view generation-a "$OLD_REF" "$TITLE" "$OLD_SURFACE" \
  "$(build_attach_command "$TARGET")" "$TARGET" exited
first_state=$(cat "$ATTACH_HEAL_STATE" 2>/dev/null || true)
first_status="$STATUS_CALLS"
first_alerts="$ALERT_CALLS"
sleep 1
CMUX_ADDITIVE_ROUND_ID=100-2
recover_attach_surface view generation-a "$OLD_REF" "$TITLE" "$OLD_SURFACE" \
  "$(build_attach_command "$TARGET")" "$TARGET" exited
state=$(cat "$ATTACH_HEAL_STATE" 2>/dev/null || true)
if [[ -z "$MOCK_OPS" && "$MOCK_OLD_PRESENT" == 1 && "$MOCK_NEW_PRESENT" == 0 \
    && "$first_state" == 'generation-a|workspace:1|FLY-1944-implement|view|1|observing-exited|'* \
    && "$first_status" == *'view|workspace:1|status|连接异常 · exited · 继续观察'* \
    && -z "$first_alerts" \
    && "$state" == 'generation-a|workspace:1|FLY-1944-implement|view|2|dead-exited|'* \
    && "$STATUS_CALLS" == *'view|workspace:1|status|连接失效 · exited · 仅上报'* \
    && "$(grep -c 'cmux_cleanup|attach-dead|generation=generation-a|ref=workspace:1|title=FLY-1944-implement|class=exited' <<< "$ALERT_CALLS" || true)" == 1 ]]; then
  ok "positive dead view needs an aged second round before durable RED and one alert"
else
  bad "report-only grace drifted ops=[$MOCK_OPS] first=[$first_state] state=[$state] status=[$STATUS_CALLS] alerts=[$ALERT_CALLS]"
fi

CMUX_ADDITIVE_ROUND_ID=100-3
recover_attach_surface view generation-a "$OLD_REF" "$TITLE" "$OLD_SURFACE" \
  "$(build_attach_command "$TARGET")" "$TARGET" empty
drift_state=$(cat "$ATTACH_HEAL_STATE" 2>/dev/null || true)
if [[ "$drift_state" == 'generation-a|workspace:1|FLY-1944-implement|view|1|observing-empty|'* \
    && "$ALERT_CALLS" != *'class=empty'* ]]; then
  ok "a positive class change starts a fresh observation window instead of inheriting dead authority"
else
  bad "class drift inherited stale authority state=[$drift_state] alerts=[$ALERT_CALLS]"
fi

for dead_class in empty no-pty; do
  mock_reset
  STATUS_CALLS=""
  ALERT_CALLS=""
  CMUX_CLEANUP_ALERT_LATCH=""
  CMUX_CLEANUP_ALERT_LATCH_COUNT=0
  first=$(( $(date +%s) - 2 ))
  printf 'generation-a|%s|%s|view|1|observing-%s|%s|%s|100-1\n' \
    "$OLD_REF" "$TITLE" "$dead_class" "$first" "$first" > "$ATTACH_HEAL_STATE"
  CMUX_ADDITIVE_ROUND_ID=100-2
  recover_attach_surface view generation-a "$OLD_REF" "$TITLE" "$OLD_SURFACE" \
    "$(build_attach_command "$TARGET")" "$TARGET" "$dead_class"
  if [[ -z "$MOCK_OPS" \
      && "$(awk -F'|' '{print $6}' "$ATTACH_HEAL_STATE")" == "dead-$dead_class" \
      && "$STATUS_CALLS" == *"连接失效 · $dead_class · 仅上报"* \
      && "$ALERT_CALLS" == *"class=$dead_class"* ]]; then
    ok "$dead_class keeps the exact machine classification in status and alert"
  else
    bad "$dead_class lost report-only evidence ops=[$MOCK_OPS] status=[$STATUS_CALLS] alerts=[$ALERT_CALLS]"
  fi
done

printf '\nFLY-1944 dead-view report-only: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
