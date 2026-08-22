#!/usr/bin/env bash
# FLY-1944: managed cmux carrier commands use one strict, versioned argv
# grammar.  The token identifies one helper incarnation; it is not a secret.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export FLYWHEEL_CMUX_VIEW_HELPER_BIN="$ROOT/scripts/flywheel-view-attach.sh"
export FLYWHEEL_CMUX_LEAD_ATTACH_BIN="$ROOT/scripts/flywheel-lead-attach.sh"

# shellcheck source=../lib/cmux-mutator-process-census.sh
source "$ROOT/scripts/lib/cmux-mutator-process-census.sh"
# shellcheck source=../flywheel-cmux-sync.sh
source "$ROOT/scripts/flywheel-cmux-sync.sh"
# The production script enables errexit for its command entrypoint.  This
# assertion harness needs to collect all RED/GREEN outcomes instead.
set +e

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'PASS: %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL: %s\n' "$1" >&2; }

token="fwtok1-0123456789abcdef0123456789abcdef"
view="cmux-FLY-1944-implement"
socket="/tmp/flywheel-fly1944.sock"

view_v1=$(build_attach_command "$view" 2>/dev/null || true)
view_v2=$(build_attach_command "$view" "$token" 2>/dev/null || true)
lead_v1=$(build_lead_attach_command "$socket" 2>/dev/null || true)
lead_v2=$(build_lead_attach_command "$socket" "$token" 2>/dev/null || true)

if [[ "$view_v1" == "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' '$view'" \
    && "$view_v2" == "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' '$view' '$token'" \
    && "$lead_v1" == "env -u TMUX '$FLYWHEEL_CMUX_LEAD_ATTACH_BIN' '$socket'" \
    && "$lead_v2" == "env -u TMUX '$FLYWHEEL_CMUX_LEAD_ATTACH_BIN' '$socket' '$token'" ]]; then
  ok "builders preserve v1 and emit caller-supplied v2 tokens verbatim"
else
  bad "builder grammar drift view_v1=[$view_v1] view_v2=[$view_v2] lead_v1=[$lead_v1] lead_v2=[$lead_v2]"
fi

if [[ "$(managed_view_command_parse "$view_v1" record 2>/dev/null || true)" == "view|$view|" \
    && "$(managed_view_command_parse "$view_v2" record 2>/dev/null || true)" == "view|$view|$token" \
    && "$(managed_view_command_parse "$lead_v1" record 2>/dev/null || true)" == "lead|$socket|" \
    && "$(managed_view_command_parse "$lead_v2" record 2>/dev/null || true)" == "lead|$socket|$token" \
    && "$(managed_view_command_parse "$view_v2" 2>/dev/null || true)" == "$view" \
    && "$(managed_view_command_parse "$view_v2" token 2>/dev/null || true)" == "$token" ]]; then
  ok "one strict parser normalizes view and Lead v1/v2 carrier commands"
else
  bad "managed carrier parser did not normalize every protocol shape"
fi

parser_rejected=1
for malformed in \
  "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' '$view' fwtok1-short" \
  "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' '$view' '$token' extra" \
  "env -u TMUX '$FLYWHEEL_CMUX_LEAD_ATTACH_BIN' relative.sock '$token'" \
  "env -u TMUX '$FLYWHEEL_CMUX_VIEW_HELPER_BIN' not-a-view '$token'" \
  "env -u TMUX /bin/bash -c '$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token'"; do
  if managed_view_command_parse "$malformed" record >/dev/null 2>&1; then
    parser_rejected=0
  fi
done
if [[ "$parser_rejected" == 1 ]]; then
  ok "parser rejects malformed tokens, targets, trailing argv, and shell prose"
else
  bad "parser accepted a malformed carrier command"
fi

candidate_json=$(python3 - "$view_v2" "$view" <<'PY'
import json,sys
command,target=sys.argv[1:3]
neighbor=command.replace(target, target + "-neighbor")
print(json.dumps({"workspaces":[
    {"ref":"workspace:1944","title":command},
    {"ref":"workspace:1945","title":neighbor},
]}))
PY
)
candidate_rows=$(workspace_title_candidates "$candidate_json" "FLY-1944-implement" "$view_v1" 2>/dev/null)
candidate_rc=$?
if [[ "$candidate_rc" == 0 && "$candidate_rows" == "raw|workspace:1944|0|0|1944" ]]; then
  ok "workspace candidate parsing accepts v2 tokens and isolates neighboring targets"
else
  bad "workspace candidates lost token or target isolation rc=$candidate_rc rows=[$candidate_rows]"
fi

saved_cmux_call_guarded=$(declare -f cmux_call_guarded)
rollback_seen=""
cmux_call_guarded() {
  local guard="$1"
  rollback_seen="$_GUARD_ROLLBACK_PROVISIONAL_TITLE"
  GUARD_WAS_BLOCKED=0
  return 0
}
rollback_unreceipted_workspace generation-1944 workspace:1944 "$view_v2" >/dev/null 2>&1
eval "$saved_cmux_call_guarded"
if printf '%s\n' "$rollback_seen" | grep -qxF "$view_v2"; then
  ok "rename-lag rollback retains the exact caller-issued v2 command"
else
  bad "rename-lag rollback discarded the v2 incarnation token variants=[$rollback_seen]"
fi

get_cmux_workspaces_json() {
  python3 - "$view_v2" <<'PY'
import json,sys
print(json.dumps({"workspaces":[{"ref":"workspace:1944","title":sys.argv[1]}]}))
PY
}
stock_rows=$(stock_workspace_records 2>/dev/null)
stock_rc=$?
if [[ "$stock_rc" == 0 && "$stock_rows" == C$'\tworkspace:1944\t'*$'\tFLY-1944-implement\t'* ]]; then
  ok "raw-title stock parsing normalizes a valid v2 carrier through the strict grammar"
else
  bad "stock parser rejected a valid v2 carrier rc=$stock_rc rows=[$stock_rows]"
fi

generated_a=$(new_managed_attach_token 2>/dev/null || true)
generated_b=$(new_managed_attach_token 2>/dev/null || true)
if managed_attach_token_valid "$generated_a" \
    && managed_attach_token_valid "$generated_b" \
    && [[ "$generated_a" != "$generated_b" ]]; then
  ok "caller token generator emits distinct validated fwtok1 values"
else
  bad "token generator did not emit distinct validated values a=[$generated_a] b=[$generated_b]"
fi

if cmux_attach_helper_command_matches "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token" \
    && cmux_attach_helper_command_matches "/bin/bash $FLYWHEEL_CMUX_VIEW_HELPER_BIN $view" \
    && cmux_attach_helper_command_matches "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN $socket $token" \
    && [[ "$(cmux_attach_helper_command_parse "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token" 2>/dev/null || true)" == "view|$view|$token" ]]; then
  ok "process census recognizes exact v1/v2 helper argv shapes"
else
  bad "process census rejected a valid helper argv shape"
fi

census_rejected=1
for malformed in \
  "/bin/bash -c '$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token'" \
  "echo $FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token" \
  "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view fwtok1-short" \
  "$FLYWHEEL_CMUX_VIEW_HELPER_BIN $view $token extra" \
  "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN relative.sock $token"; do
  if cmux_attach_helper_command_matches "$malformed"; then
    census_rejected=0
  fi
done
if [[ "$census_rejected" == 1 ]]; then
  ok "process census rejects bash -c, substrings, malformed tokens, and extra argv"
else
  bad "process census accepted a malformed helper argv shape"
fi

helper_rejected=1
helper_returns_usage() {
  local pid rc=0
  "$@" >/dev/null 2>&1 &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.05
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  wait "$pid" || rc=$?
  [[ "$rc" == 64 ]]
}
for invocation in \
  "$FLYWHEEL_CMUX_VIEW_HELPER_BIN|$view|fwtok1-short" \
  "$FLYWHEEL_CMUX_VIEW_HELPER_BIN|$view|$token|extra" \
  "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN|$socket|fwtok1-short" \
  "$FLYWHEEL_CMUX_LEAD_ATTACH_BIN|$socket|$token|extra"; do
  IFS='|' read -r -a argv <<< "$invocation"
  helper_returns_usage "${argv[@]}" || helper_rejected=0
done
if [[ "$helper_rejected" == 1 ]]; then
  ok "both helpers reject malformed v2 and trailing argv with EX_USAGE"
else
  bad "a helper accepted malformed protocol argv"
fi

printf '\nFLY-1944 attach protocol: %s passed, %s failed\n' "$pass" "$fail"
[[ "$fail" == 0 ]]
