#!/bin/bash
# FLY-2444: exact restart authority for the generalized full-access Codex
# carrier, without weakening any existing carrier identity.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; shift; [ "$#" -eq 0 ] || echo "        $*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly2444-restart-authority-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
export HOME="$SANDBOX/home"
mkdir -p "$HOME/.flywheel/manifests" "$HOME/.flywheel/bin"

# shellcheck source=../lib/lead-restart-lifecycle.sh
source "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh"

PROJECTS="$HOME/.flywheel/projects.json"
cat > "$PROJECTS" <<JSON
[
  {"projectName":"demo","projectRoot":"$HOME/Dev/demo","leads":[
    {"agentId":"claude-lead","backend":"claude-code","carrier":"v2"},
    {"agentId":"codex-lead","backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":false,"companion":false}
  ]},
  {"projectName":"growth","projectRoot":"$HOME/Dev/growth","leads":[
    {"agentId":"mufasa-lead","backend":"codex-app-server"}
  ]},
  {"projectName":"flywheel","projectRoot":"$HOME/Dev/flywheel","leads":[
    {"agentId":"codex-infra-bot-lead","backend":"codex-app-server"}
  ]},
  {"projectName":"raya","projectRoot":"$HOME/Dev/raya","leads":[
    {"agentId":"raya","backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":false,"companion":false}
  ]}
]
JSON

write_manifest() {
  local path="$1" project="$2" lead="$3" backend="$4"
  jq -n --arg project "$project" --arg lead "$lead" --arg backend "$backend" \
    '{projectName:$project,leadId:$lead,leadBackend:{backendId:$backend}}' > "$path"
}

write_plist() {
  local path="$1" label="$2"
  shift 2
  python3 - "$path" "$label" "$@" <<'PY'
import plistlib
import sys

path, label, *argv = sys.argv[1:]
with open(path, "wb") as handle:
    plistlib.dump({"Label": label, "ProgramArguments": argv}, handle)
PY
}

assert_authorized() {
  local manifest="$1" plist="$2" label="$3" name="$4"
  if lead_restart_validate_authority "$manifest" "$plist" "$PROJECTS" "$label"; then
    pass "$name"
  else
    fail "$name"
  fi
}

CLAUDE_MANIFEST="$HOME/.flywheel/manifests/demo-claude-lead.json"
GENERIC_MANIFEST="$HOME/.flywheel/manifests/demo-codex-lead.json"
MUFASA_MANIFEST="$HOME/.flywheel/manifests/growth-mufasa-lead.json"
INFRA_MANIFEST="$HOME/.flywheel/manifests/flywheel-codex-infra-bot-lead.json"
RAYA_MANIFEST="$HOME/.flywheel/manifests/raya-raya.json"
write_manifest "$CLAUDE_MANIFEST" demo claude-lead claude-code
write_manifest "$GENERIC_MANIFEST" demo codex-lead codex-app-server
write_manifest "$MUFASA_MANIFEST" growth mufasa-lead codex-app-server
write_manifest "$INFRA_MANIFEST" flywheel codex-infra-bot-lead codex-app-server
write_manifest "$RAYA_MANIFEST" raya raya codex-app-server

CLAUDE_PLIST="$SANDBOX/claude.plist"
GENERIC_PLIST="$SANDBOX/generic.plist"
MUFASA_PLIST="$SANDBOX/mufasa.plist"
INFRA_PLIST="$SANDBOX/infra.plist"
RAYA_PLIST="$SANDBOX/raya.plist"
write_plist "$CLAUDE_PLIST" com.flywheel.lead.demo-claude-lead \
  /bin/bash "$HOME/.flywheel/bin/flywheel-lead-wrapper-v2.sh" "$CLAUDE_MANIFEST"
write_plist "$GENERIC_PLIST" com.flywheel.lead.demo-codex-lead \
  /bin/bash "$HOME/.flywheel/bin/flywheel-lead.sh" "$GENERIC_MANIFEST"
write_plist "$MUFASA_PLIST" com.flywheel.lead.growth-mufasa-lead \
  /bin/bash "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"
write_plist "$INFRA_PLIST" com.flywheel.lead.flywheel-codex-infra-bot-lead \
  /bin/bash "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh"
write_plist "$RAYA_PLIST" com.flywheel.lead.raya-raya \
  /bin/bash "$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"

ARGV_AND_MANIFEST_OK=1
while IFS='|' read -r plist expected_argv expected_inventory; do
  parsed="$(_lead_restart_plist_json "$plist")" || ARGV_AND_MANIFEST_OK=0
  actual_argv="$(jq -c '.argv' <<<"$parsed" 2>/dev/null)" || ARGV_AND_MANIFEST_OK=0
  actual_inventory="$(_lead_restart_plist_key_and_manifest "$plist")" \
    || ARGV_AND_MANIFEST_OK=0
  [ "$actual_argv" = "$expected_argv" ] || ARGV_AND_MANIFEST_OK=0
  [ "$actual_inventory" = "$(printf '%b' "$expected_inventory")" ] \
    || ARGV_AND_MANIFEST_OK=0
done <<EOF
$CLAUDE_PLIST|["/bin/bash","$HOME/.flywheel/bin/flywheel-lead-wrapper-v2.sh","$CLAUDE_MANIFEST"]|demo-claude-lead	$CLAUDE_MANIFEST
$GENERIC_PLIST|["/bin/bash","$HOME/.flywheel/bin/flywheel-lead.sh","$GENERIC_MANIFEST"]|demo-codex-lead	$GENERIC_MANIFEST
$MUFASA_PLIST|["/bin/bash","$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"]|growth-mufasa-lead	-
$INFRA_PLIST|["/bin/bash","$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-codex-infra-bot.sh"]|flywheel-codex-infra-bot-lead	-
$RAYA_PLIST|["/bin/bash","$HOME/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"]|raya-raya	-
EOF
if [ "$ARGV_AND_MANIFEST_OK" -eq 1 ]; then
  pass "all five carrier plists retain exact argv arrays and manifest extraction"
else
  fail "carrier argv or manifest inventory drifted"
fi

assert_authorized "$CLAUDE_MANIFEST" "$CLAUDE_PLIST" \
  com.flywheel.lead.demo-claude-lead "existing Claude v2 authority remains accepted"
assert_authorized "$MUFASA_MANIFEST" "$MUFASA_PLIST" \
  com.flywheel.lead.growth-mufasa-lead "existing Mufasa authority remains accepted"
assert_authorized "$INFRA_MANIFEST" "$INFRA_PLIST" \
  com.flywheel.lead.flywheel-codex-infra-bot-lead "existing infra authority remains accepted"
assert_authorized "$RAYA_MANIFEST" "$RAYA_PLIST" \
  com.flywheel.lead.raya-raya "existing Raya authority remains accepted"

if lead_restart_validate_authority "$GENERIC_MANIFEST" "$GENERIC_PLIST" "$PROJECTS" \
  com.flywheel.lead.demo-codex-lead \
  && [ "$LEAD_RESTART_PROJECT" = demo ] \
  && [ "$LEAD_RESTART_LEAD_ID" = codex-lead ] \
  && [ "$LEAD_RESTART_BACKEND" = codex-app-server ]; then
  pass "generic Codex authority binds exact manifest and full-access registry row"
else
  fail "generic Codex authority rejected the reviewed exact shape"
fi

GENERIC_NEGATIVE_OK=1
for mutation in profile spawn companion project-backend manifest-backend argv; do
  cp "$PROJECTS" "$SANDBOX/projects.before"
  cp "$GENERIC_MANIFEST" "$SANDBOX/manifest.before"
  cp "$GENERIC_PLIST" "$SANDBOX/plist.before"
  case "$mutation" in
    profile) jq '.[0].leads[1].codexProfile = "write-capable"' "$PROJECTS" > "$PROJECTS.tmp"; mv "$PROJECTS.tmp" "$PROJECTS" ;;
    spawn) jq '.[0].leads[1].canSpawnRunners = true' "$PROJECTS" > "$PROJECTS.tmp"; mv "$PROJECTS.tmp" "$PROJECTS" ;;
    companion) jq '.[0].leads[1].companion = true' "$PROJECTS" > "$PROJECTS.tmp"; mv "$PROJECTS.tmp" "$PROJECTS" ;;
    project-backend) jq '.[0].leads[1].backend = "claude-code"' "$PROJECTS" > "$PROJECTS.tmp"; mv "$PROJECTS.tmp" "$PROJECTS" ;;
    manifest-backend) jq '.leadBackend.backendId = "claude-code"' "$GENERIC_MANIFEST" > "$GENERIC_MANIFEST.tmp"; mv "$GENERIC_MANIFEST.tmp" "$GENERIC_MANIFEST" ;;
    argv) write_plist "$GENERIC_PLIST" com.flywheel.lead.demo-codex-lead /bin/bash "$HOME/.flywheel/bin/flywheel-lead.sh" run "$GENERIC_MANIFEST" ;;
  esac
  if lead_restart_validate_authority "$GENERIC_MANIFEST" "$GENERIC_PLIST" "$PROJECTS" \
    com.flywheel.lead.demo-codex-lead; then
    GENERIC_NEGATIVE_OK=0
  fi
  mv "$SANDBOX/projects.before" "$PROJECTS"
  mv "$SANDBOX/manifest.before" "$GENERIC_MANIFEST"
  mv "$SANDBOX/plist.before" "$GENERIC_PLIST"
done
if [ "$GENERIC_NEGATIVE_OK" -eq 1 ]; then
  pass "generic authority rejects argv, backend, profile, spawn, and companion drift"
else
  fail "generic authority accepted a weakened identity shape"
fi

UNKNOWN_PLIST="$SANDBOX/unknown.plist"
write_plist "$UNKNOWN_PLIST" com.flywheel.lead.demo-codex-lead \
  /bin/bash "$HOME/.flywheel/bin/flywheel-lead-next.sh" "$GENERIC_MANIFEST"
if ! lead_restart_validate_authority "$GENERIC_MANIFEST" "$UNKNOWN_PLIST" "$PROJECTS" \
  com.flywheel.lead.demo-codex-lead; then
  pass "unregistered carrier basename remains outside restart authority"
else
  fail "unregistered carrier basename gained restart authority"
fi

if [ "$(grep -Ec '^[[:space:]]*flywheel-lead\.sh\)' \
  "$REPO_ROOT/scripts/lib/lead-restart-lifecycle.sh")" -eq 1 ]; then
  pass "restart authority contains exactly one literal generic carrier case"
else
  fail "restart authority must add exactly one literal generic carrier case"
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
cp "$CLAUDE_PLIST" "$PLIST_DIR/com.flywheel.lead.demo-claude-lead.plist"
cp "$GENERIC_PLIST" "$PLIST_DIR/com.flywheel.lead.demo-codex-lead.plist"
cp "$MUFASA_PLIST" "$PLIST_DIR/com.flywheel.lead.growth-mufasa-lead.plist"
cp "$INFRA_PLIST" "$PLIST_DIR/com.flywheel.lead.flywheel-codex-infra-bot-lead.plist"
cp "$RAYA_PLIST" "$PLIST_DIR/com.flywheel.lead.raya-raya.plist"
for carrier in \
  flywheel-lead-wrapper-v2.sh \
  flywheel-lead.sh \
  flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh \
  flywheel-codex-lead-wrapper-codex-infra-bot.sh \
  flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh; do
  cp "$REPO_ROOT/scripts/$carrier" "$HOME/.flywheel/bin/$carrier"
done
lead_restart_launchd_probe() { printf 'loaded\n'; }
CANDIDATES="$SANDBOX/loaded-candidates.tsv"
COLLECT_RC=0
lead_restart_collect_candidates "$HOME/.flywheel/manifests" "$PLIST_DIR" \
  "$PROJECTS" "$CANDIDATES" || COLLECT_RC=$?
CENSUS_RC=0
FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1 \
FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR="$PLIST_DIR" \
FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR="$REPO_ROOT/scripts" \
  bash "$REPO_ROOT/scripts/host-tmux-selection-gate.sh" census "$CANDIDATES" \
    > "$SANDBOX/census.out" 2> "$SANDBOX/census.err" || CENSUS_RC=$?
if [ "$COLLECT_RC" -eq 0 ] \
  && [ "$(wc -l < "$CANDIDATES" | tr -d ' ')" -eq 5 ] \
  && [ "$(awk -F '\t' '$5 == "restart" && $6 == "manifest,plist" && $4 != "-" { count++ } END { print count+0 }' "$CANDIDATES")" -eq 5 ] \
  && [ "$CENSUS_RC" -eq 0 ] \
  && grep -Fq 'census pass plists=5 generic=1 codex-generic=1 codex-mufasa=1 codex-infra-bot=1 codex-raya=1' \
    "$SANDBOX/census.out"; then
  pass "dry-run fleet inventory and census converge for all five carrier shapes"
else
  fail "five-carrier dry-run inventory/census did not converge" \
    "collect=$COLLECT_RC census=$CENSUS_RC $(cat "$SANDBOX/census.err" 2>/dev/null)"
fi

echo ""
echo "lead-restart-lifecycle-generic-carrier: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
