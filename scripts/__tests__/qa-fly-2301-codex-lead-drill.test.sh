#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-drill-cli.XXXXXX)"
SLOT=$((990000 + $$))
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
trap 'rm -rf "$TMP" "$SLOT_DIR" "/tmp/flywheel-test-slot-$((SLOT + 1))"' EXIT
passed=0
failed=0
pass() { printf 'PASS: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; failed=$((failed + 1)); }

drill="$ROOT/scripts/qa-fly-2301-codex-lead-drill.sh"
if [[ -x "$drill" ]]; then
  pass "FLY-2301 drill CLI is executable"
else
  fail "FLY-2301 drill CLI is executable"
fi

agent=qa-lead
project="test-slot-${SLOT}"
label="com.flywheel.qa.lead.slot-${SLOT}.${agent}"
home="$SLOT_DIR/cdxh/${agent}"
state="$SLOT_DIR/q/${SLOT}/state/codex-lead/${project}__${agent}-$(printf '%s\037%s' "$project" "$agent" | od -An -v -tx1 | tr -d ' \n')"
tmux_socket="$SLOT_DIR/tmux-$(id -u)/default"
manifest="$SLOT_DIR/launch-manifest.json"
mkdir -p "$home" "$state" "$(dirname "$tmux_socket")"
python3 - "$tmux_socket" <<'PY'
import socket
import sys

sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.close()
PY
jq -n --arg carrier launchd-codex-tui --arg main "$label" \
  --arg label "$label" --arg project "$project" --arg agent "$agent" \
  --arg state "$state" --arg home "$home" --arg socket "$tmux_socket" '
  {leadCarrier:$carrier,mainLeadLabel:$main,codexLead:{label:$label,
    projectName:$project,agentId:$agent,stateDir:$state,codexHome:$home,
    tmuxSocket:$socket,tuiWindow:"present"}}
' > "$manifest"
chmod 600 "$manifest"

launchctl_stub="$TMP/launchctl"
tmux_stub="$TMP/tmux"
mutation_log="$TMP/mutations.log"
: > "$mutation_log"
cat > "$launchctl_stub" <<'SH'
#!/bin/bash
printf 'launchctl %s\n' "$*" >> "$FLY2301_MUTATION_LOG"
exit 99
SH
cat > "$tmux_stub" <<'SH'
#!/bin/bash
printf 'tmux %s\n' "$*" >> "$FLY2301_MUTATION_LOG"
exit 99
SH
chmod +x "$launchctl_stub" "$tmux_stub"
export FLYWHEEL_QA_LAUNCHCTL="$launchctl_stub"
export FLYWHEEL_QA_TMUX="$tmux_stub"
export FLY2301_MUTATION_LOG="$mutation_log"

invalid_ok=1
case_number=0
run_invalid() {
  case_number=$((case_number + 1))
  local jq_filter="$1" candidate="$TMP/manifest-${case_number}.json"
  local evidence="$TMP/evidence-${case_number}"
  mkdir -p "$evidence"
  jq "$jq_filter" "$manifest" > "$candidate"
  cp "$candidate" "$manifest"
  if "$drill" "$SLOT" crash "$evidence" >/dev/null 2>&1; then
    invalid_ok=0
  fi
  jq -n --arg carrier launchd-codex-tui --arg main "$label" \
    --arg label "$label" --arg project "$project" --arg agent "$agent" \
    --arg state "$state" --arg home "$home" --arg socket "$tmux_socket" '
    {leadCarrier:$carrier,mainLeadLabel:$main,codexLead:{label:$label,
      projectName:$project,agentId:$agent,stateDir:$state,codexHome:$home,
      tmuxSocket:$socket,tuiWindow:"present"}}
  ' > "$manifest"
}

for field in label projectName agentId stateDir codexHome tmuxSocket tuiWindow; do
  run_invalid "del(.codexLead.${field})"
done
run_invalid ".codexLead.label = \"com.flywheel.qa.lead.slot-$((SLOT + 1)).${agent}\""
run_invalid ".mainLeadLabel = \"com.flywheel.qa.lead.slot-$((SLOT + 1)).${agent}\""
run_invalid ".codexLead.projectName = \"test-slot-$((SLOT + 1))\""
run_invalid ".codexLead.stateDir = \"/tmp/flywheel-test-slot-$((SLOT + 1))/q/${SLOT}/state\""
run_invalid '.leadCarrier = "launchd-v2"'

if [[ "$invalid_ok" == 1 && ! -s "$mutation_log" ]]; then
  pass "drill CLI rejects every missing/mismatched lifecycle coordinate before mutation"
else
  fail "drill CLI pre-mutation manifest validation"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]]
