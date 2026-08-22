#!/usr/bin/env bash
# FLY-1944: attach helper trees are reaped only from durable, bounded,
# incarnation-checked authority created after a workspace close succeeds.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$ROOT/scripts/flywheel-view-attach.sh"
export FLYWHEEL_CMUX_LEAD_ATTACH_BIN="$ROOT/scripts/flywheel-lead-attach.sh"
export ATTACH_REAP_STATE="$TMP/reap.state"
export ATTACH_ORPHAN_STATE="$TMP/orphan.state"
export CMUX_SESSION_STATE="$TMP/session.json"

# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
set +e

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
payload() {
  python3 - "$@" <<'PY'
import base64,json,sys
rows=[]
for spec in sys.argv[1:]:
    pid,ppid,start,depth=spec.split(",")
    rows.append({"pid":int(pid),"ppid":int(ppid),"start":start,"depth":int(depth)})
print(base64.b64encode(json.dumps(rows,separators=(",",":"),sort_keys=True).encode()).decode())
PY
}

FLYWHEEL_CMUX_ATTACH_MAX_TREE_PROCESSES=0
FLYWHEEL_CMUX_ATTACH_MAX_TREE_DELIVERIES=1
fallback=$(attach_reap_limits)
FLYWHEEL_CMUX_ATTACH_MAX_TREE_PROCESSES=3
FLYWHEEL_CMUX_ATTACH_MAX_TREE_DELIVERIES=6
configured=$(attach_reap_limits)
if [[ "$fallback" == '4|8' && "$configured" == '3|6' ]]; then
  ok "tree and delivery limits enforce the 2x safety relationship"
else
  bad "reap limit validation fallback=[$fallback] configured=[$configured]"
fi
unset FLYWHEEL_CMUX_ATTACH_MAX_TREE_PROCESSES FLYWHEEL_CMUX_ATTACH_MAX_TREE_DELIVERIES

start_root=$(b64 'Fri Aug 21 18:00:00 2026')
start_child=$(b64 'Fri Aug 21 18:00:01 2026')
command_root=$(b64 "$FLYWHEEL_CMUX_VIEW_HELPER_BIN cmux-FLY-1944-implement fwtok1-0123456789abcdef0123456789abcdef")
command_child=$(b64 'tmux attach -t =cmux-FLY-1944-implement')
snapshot="101|1|$start_root|$command_root
102|101|$start_child|$command_child"
tree_payload=$(_attach_reap_tree_payload "$snapshot" 101 2)
tree_lines=$(_attach_reap_tuples "$tree_payload")
_attach_reap_tree_payload "$snapshot" 101 1 >/dev/null 2>&1
oversize_rc=$?
if [[ "$tree_lines" == $'102|'"$start_child"$'|1\n101|'"$start_root"'|0' && "$oversize_rc" == 3 ]]; then
  ok "one snapshot builds a leaf-first bounded ancestry tree"
else
  bad "tree payload mismatch rc=$oversize_rc rows=[$tree_lines]"
fi

ps() {
  printf '%s\n' \
    '101 1 Fri Aug 21 18:00:00 2026 /bin/sleep 1' \
    'continuation from an embedded newline' \
    '102 1 Fri Aug 21 18:00:01 2026 /bin/sleep 2'
}
snapshot_with_continuation=$(cmux_process_snapshot_records)
snapshot_continuation_rc=$?
unset -f ps
snapshot_valid_rows=$(printf '%s\n' "$snapshot_with_continuation" | grep -c . || true)
if [[ "$snapshot_continuation_rc" == 0 && "$snapshot_valid_rows" == 2 ]]; then
  ok "one multiline argv continuation cannot disable the whole process census"
else
  bad "process census continuation handling rc=$snapshot_continuation_rc rows=[$snapshot_with_continuation]"
fi

# A host-sized process snapshot must be parsed in one interpreter.  The
# wrapper keeps this regression fast while still counting every python3
# command the production function attempts to launch.
python_calls="$TMP/python.calls"
: > "$python_calls"
python3() {
  printf '1\n' >> "$python_calls"
  case "$*" in
    *'sys.stdout.write(base64.b64decode(sys.stdin.read(),validate=True).decode())'*)
      /usr/bin/base64 -D
      ;;
    *'words=shlex.split(sys.stdin.read())'*)
      /bin/cat >/dev/null
      return 1
      ;;
    *) /usr/bin/python3 "$@" ;;
  esac
}
large_snapshot=""
for pid in $(seq 1001 1128); do
  large_snapshot+="${large_snapshot:+$'\n'}$pid|1|$start_root|$command_child"
done
cmux_attach_helper_records_from_snapshot "$large_snapshot" >/dev/null 2>&1
large_rc=$?
python_count=$(wc -l < "$python_calls" | tr -d ' ')
unset -f python3
if [[ "$large_rc" == 0 && "$python_count" == 1 ]]; then
  ok "host-sized helper census uses one bounded parser process"
else
  bad "helper census parser fan-out rc=$large_rc python_calls=$python_count"
fi

calls="$TMP/close.calls"
: > "$calls"
saved_prepare=$(declare -f attach_reap_prepare_workspace)
saved_commit=$(declare -f attach_reap_commit_prepared)
attach_reap_prepare_workspace() {
  printf 'prepare:%s:%s\n' "$1" "$2" >> "$calls"
  _ATTACH_REAP_PREPARED_TREE=tree
  _ATTACH_REAP_PREPARED_ROW=row
  return 0
}
attach_reap_commit_prepared() { printf 'commit:%s\n' "$1" >> "$calls"; }
close_guard() { return "${BLOCK_GUARD:-0}"; }
cmux_call_guarded() {
  local guard="$1"; shift
  GUARD_WAS_BLOCKED=0
  "$guard" || { GUARD_WAS_BLOCKED=1; return 1; }
  printf 'close:%s\n' "$*" >> "$calls"
  return "${CLOSE_RC:-0}"
}
BLOCK_GUARD=0 CLOSE_RC=0
cmux_call_guarded_close_with_attach_reap workspace:44 uuid-44 close_guard
success_calls=$(cat "$calls")
: > "$calls"
CLOSE_RC=1
cmux_call_guarded_close_with_attach_reap workspace:45 uuid-45 close_guard >/dev/null 2>&1
failed_calls=$(cat "$calls")
if [[ "$success_calls" == $'prepare:workspace:44:uuid-44\nclose:close-workspace --workspace workspace:44\ncommit:workspace:44' \
    && "$failed_calls" != *commit:* ]]; then
  ok "post-close seam commits signal authority only after confirmed close"
else
  bad "post-close seam ordering success=[$success_calls] failed=[$failed_calls]"
fi
eval "$saved_prepare"
eval "$saved_commit"

direct_sites=$(grep -c 'close-workspace --workspace' "$ROOT/scripts/flywheel-cmux-sync.sh" || true)
if [[ "$direct_sites" == 2 ]]; then
  ok "all production workspace closes route through the two shared seam adapters"
else
  bad "found $direct_sites direct close spellings outside the shared seam"
fi

# Restore only the functions the durable state machine needs after the seam
# test's mocks.
assert_or_reuse_owned_lease() { return 0; }
signal_log="$TMP/signals"
: > "$signal_log"
cmux_process_tuple_current() { return "${TUPLE_RC:-0}"; }
_attach_reap_signal() {
  local persisted
  persisted=$(awk -F'|' 'NR==1 {print $9}' "$ATTACH_REAP_STATE")
  printf '%s:%s:%s\n' "$1" "$2" "$persisted" >> "$signal_log"
  return 0
}

tree=$(printf 'a%.0s' {1..64})
tuples=$(payload "102,101,$start_child,1" "101,1,$start_root,0")
now=$(date +%s)
row=$(_attach_reap_row "$tree" view "$(b64 cmux-FLY-1944-implement)" \
  fwtok1-0123456789abcdef0123456789abcdef term-issued "$now" "$now" 0 0 \
  workspace:44 00000000-0000-4000-8000-000000000044 101 "$tuples")
printf '%s\n' "$row" > "$ATTACH_REAP_STATE"
TUPLE_RC=0
advance_attach_reap_state
term_signals=$(cat "$signal_log")
term_state=$(cat "$ATTACH_REAP_STATE")
IFS='|' read -r _ _ _ _ _ _ _ deadline _ _ _ _ _ _ < "$ATTACH_REAP_STATE"
python3 - "$ATTACH_REAP_STATE" <<'PY'
import sys
p=open(sys.argv[1]).read().rstrip("\n").split("|")
p[7]="0"
open(sys.argv[1],"w").write("|".join(p)+"\n")
PY
advance_attach_reap_state
all_signals=$(cat "$signal_log")
hold_state=$(cat "$ATTACH_REAP_STATE")
if [[ "$term_signals" == $'TERM:102:1\nTERM:101:2' \
    && "$term_state" == *'|kill-pending|'*'|2|1|'* \
    && "$all_signals" == $'TERM:102:1\nTERM:101:2\nKILL:102:3\nKILL:101:4' \
    && "$hold_state" == *'|terminal-hold|'*'|4|2|'* ]]; then
  ok "write-ahead delivery slots precede leaf-first TERM then KILL"
else
  bad "reap phase mismatch term=[$term_signals][$term_state] all=[$all_signals][$hold_state]"
fi

before_hold=$(cat "$ATTACH_REAP_STATE")
advance_attach_reap_state
after_hold=$(cat "$ATTACH_REAP_STATE")
TUPLE_RC=1
advance_attach_reap_state
if [[ "$before_hold" == "$after_hold" && ! -e "$ATTACH_REAP_STATE" \
    && "$(wc -l < "$signal_log" | tr -d ' ')" == 4 ]]; then
  ok "terminal tombstones emit zero further signals and GC only after absence"
else
  bad "terminal hold replayed or failed GC before=[$before_hold] after=[$after_hold]"
fi

printf '%s\n' "$row" > "$ATTACH_REAP_STATE"
: > "$signal_log"
FLYWHEEL_CMUX_DRY_RUN=1 TUPLE_RC=0 advance_attach_reap_state
dry_after=$(cat "$ATTACH_REAP_STATE")
if [[ "$dry_after" == "$row" && ! -s "$signal_log" ]]; then
  ok "dry-run preserves durable intent and emits zero physical signals"
else
  bad "dry-run changed reap authority state=[$dry_after] signals=[$(cat "$signal_log")]"
fi
rm -f "$ATTACH_REAP_STATE"

printf '%s\n' "$row" > "$TMP/real-reap"
ln -s "$TMP/real-reap" "$ATTACH_REAP_STATE"
: > "$signal_log"
TUPLE_RC=0
advance_attach_reap_state >/dev/null 2>&1
symlink_rc=$?
if [[ "$symlink_rc" == 2 && ! -s "$signal_log" ]]; then
  ok "symlink or malformed reap state freezes every signal"
else
  bad "invalid state was not fail-closed rc=$symlink_rc signals=[$(cat "$signal_log")]"
fi
rm -f "$ATTACH_REAP_STATE"

# Token identity selects one root even when the target has two helper
# incarnations; legacy v1 refuses the same ambiguity.
token_a=fwtok1-0123456789abcdef0123456789abcdef
token_b=fwtok1-fedcba9876543210fedcba9876543210
target=cmux-FLY-1944-implement
TEST_TARGET_B64=$(b64 "$target")
cmd_a=$(b64 "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $target $token_a")
cmd_b=$(b64 "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $target $token_b")
TEST_SNAPSHOT="201|1|$start_root|$cmd_a
202|1|$start_child|$cmd_b"
cmux_process_snapshot_records() { printf '%s\n' "$TEST_SNAPSHOT"; }
cmux_workspace_birth_record() {
  local emitted_token
  if [[ "${BIRTH_TOKEN+x}" == x ]]; then emitted_token="$BIRTH_TOKEN"; else emitted_token="$token_a"; fi
  printf 'workspace:44|00000000-0000-4000-8000-000000000044|%s|00000000-0000-4000-8000-000000000144|view|%s|%s\n' \
    "$(b64 FLY-1944-implement)" "$TEST_TARGET_B64" "$emitted_token"
}
cmux_attach_birth_records() { cmux_workspace_birth_record; }
BIRTH_TOKEN="$token_a"
attach_reap_prepare_workspace workspace:44 00000000-0000-4000-8000-000000000044
token_rc=$?
token_row="$_ATTACH_REAP_PREPARED_ROW"
BIRTH_TOKEN=""
attach_reap_prepare_workspace workspace:44 00000000-0000-4000-8000-000000000044 >/dev/null 2>&1
legacy_rc=$?
if [[ "$token_rc" == 0 && "$token_row" == *"|$token_a|"*'|201|'* && "$legacy_rc" == 1 ]]; then
  ok "v2 token disambiguates same-target helpers while legacy stays cardinality-fenced"
else
  bad "token root selection mismatch token_rc=$token_rc legacy_rc=$legacy_rc row=[$token_row]"
fi

# tmux rc=1 is ambiguous: only an exact absence diagnostic may feed the
# report-only orphan observer. Protocol/version failures remain inconclusive.
probe_bin="$TMP/probe-bin"
mkdir -p "$probe_bin"
printf '%s\n' \
  '#!/bin/bash' \
  'printf "%s\n" "${TEST_TMUX_DIAG:-}" >&2' \
  'exit "${TEST_TMUX_RC:-0}"' > "$probe_bin/tmux"
chmod +x "$probe_bin/tmux"
saved_path="$PATH"
PATH="$probe_bin:$PATH"
TEST_TMUX_RC=0 TEST_TMUX_DIAG='' _attach_target_presence view cmux-FLY-1944-implement
present_rc=$?
TEST_TMUX_RC=1 TEST_TMUX_DIAG="can't find session: cmux-FLY-1944-implement" \
  _attach_target_presence view cmux-FLY-1944-implement
absent_rc=$?
TEST_TMUX_RC=1 TEST_TMUX_DIAG='protocol version mismatch (client 3.7c, server 3.5a)' \
  _attach_target_presence view cmux-FLY-1944-implement
ambiguous_rc=$?
PATH="$saved_path"
if [[ "$present_rc" == 0 && "$absent_rc" == 1 && "$ambiguous_rc" == 2 ]]; then
  ok "tmux target absence requires a message-anchored verdict"
else
  bad "tmux target verdict mismatch present=$present_rc absent=$absent_rc ambiguous=$ambiguous_rc"
fi

# Orphan discovery is always report-only: current workspace inventory must
# suppress birthless false positives, and two distinct absent rounds may alert
# but can never mint TERM/KILL authority.
rm -f "$ATTACH_REAP_STATE" "$ATTACH_ORPHAN_STATE"
TEST_SNAPSHOT="201|1|$start_root|$cmd_a"
cmux_attach_birth_records() { return 0; }
_attach_target_presence() { return 1; }
get_cmux_workspaces_json() {
  printf '%s\n' '{"workspaces":[{"ref":"workspace:44","title":"FLY-1944-implement"}]}'
}
CMUX_ADDITIVE_ROUND_ID=1-1
discover_orphan_attach_helpers
claimed_orphan=$(cat "$ATTACH_ORPHAN_STATE" 2>/dev/null || true)
claimed_reap=$(cat "$ATTACH_REAP_STATE" 2>/dev/null || true)

alerts="$TMP/orphan.alerts"
: > "$alerts"
_alert_cmux_cleanup() { printf '%s|%s\n' "$1" "$3" >> "$alerts"; }
get_cmux_workspaces_json() { printf '%s\n' '{"workspaces":[]}'; }
CMUX_ADDITIVE_ROUND_ID=2-1
discover_orphan_attach_helpers
first_orphan=$(cat "$ATTACH_ORPHAN_STATE" 2>/dev/null || true)
first_reap=$(cat "$ATTACH_REAP_STATE" 2>/dev/null || true)
CMUX_ADDITIVE_ROUND_ID=2-2
discover_orphan_attach_helpers
second_orphan=$(cat "$ATTACH_ORPHAN_STATE" 2>/dev/null || true)
second_reap=$(cat "$ATTACH_REAP_STATE" 2>/dev/null || true)
CMUX_ADDITIVE_ROUND_ID=2-3
discover_orphan_attach_helpers
third_reap=$(cat "$ATTACH_REAP_STATE" 2>/dev/null || true)
alert_count=$(wc -l < "$alerts" | tr -d ' ')
if [[ -z "$claimed_orphan" && -z "$claimed_reap" \
    && "$first_orphan" == orphanv1'|'* && -z "$first_reap" \
    && "$second_orphan" == orphanv1'|'* && -z "$second_reap" \
    && -z "$third_reap" && "$alert_count" -ge 1 ]]; then
  ok "birthless claimants suppress orphan episodes and proven absence stays report-only"
else
  bad "orphan report-only mismatch claimed=[$claimed_orphan][$claimed_reap] first=[$first_orphan][$first_reap] second=[$second_orphan][$second_reap] third=[$third_reap] alerts=[$(cat "$alerts")]"
fi

printf '\nFLY-1944 helper reap: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
