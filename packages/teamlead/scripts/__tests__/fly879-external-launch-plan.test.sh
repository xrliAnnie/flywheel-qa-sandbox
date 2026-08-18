#!/bin/bash
# FLY-879: external (customer-facing) Lead launch-plan + role-detection test (hermetic).
#
# Runs the REAL claude-lead.sh in dry-run (FLYWHEEL_LEAD_DRY_RUN=1) under an
# ISOLATED HOME with a fixture FLYWHEEL_PROJECTS, and asserts the structured launch
# plan for the external role class (Anna the interviewer):
#   - external gets EXACTLY ONE prompt file (external-agent-contract.md) — NONE of
#     the eng-governance rules, NO project shared rules, NO cross-dept roundtable,
#     NO discord-reply-contract, NO screencapture, NO inbox-ack, NO founder-*.
#   - pane creds EMPTY (Bridge token unusable); NO terminal/inbox/gbrain/user MCP;
#     FLYWHEEL_LEAD_EXTERNAL=1 set; NO FLYWHEEL_LEAD_COMPANION.
#   - role detection: external / exact-nonexternal→standard / notfound→fail-STOP /
#     missing-contract→fail-STOP; secret-canary (no token value echoed).
#   - DIRTY-FIXTURE isolation (Codex design review R3): even with a stale
#     LEAD_RULES_DIR, a populated project .lead/shared, and inherited user MCP
#     present, external's plan still has EXACTLY the one contract file + no MCP.
#   - byte-compat spot-check: a standard dept Lead in the SAME fixture is unchanged
#     (dept rules + terminal MCP + token SET).
#
# Requires: built dist/ProjectConfig.js (with the FLY-879 external field), node, jq.
# Touches NOTHING outside the per-test isolated HOME; never starts a real Lead.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"

if [ ! -f "${DIST}/ProjectConfig.js" ]; then
  echo "SKIP: dist/ProjectConfig.js not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi
# Guard: dist must be the FLY-879 build (external field), else the query returns
# 'nonexternal' for everything and these assertions are vacuous.
if ! grep -q "external" "${DIST}/ProjectConfig.js"; then
  echo "SKIP: dist/ProjectConfig.js predates FLY-879 (no external field) — rebuild teamlead" >&2
  exit 0
fi

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

CANARY_BOT="CANARYBOTtok_$$"
CANARY_TL="CANARYTLtok_$$"

# $1 = HOME dir. Creates identity files for an external lead + a standard dept lead.
make_home() {
  local h; h=$(mktemp -d "/tmp/fly879-test.XXXXXX")
  mkdir -p "$h/proj-fly/.lead/anna-interviewer-lead" \
           "$h/proj-fly/.lead/product-lead"
  printf -- '---\nname: anna-interviewer-lead\n---\nAnna\n' > "$h/proj-fly/.lead/anna-interviewer-lead/agent.md"
  printf -- '---\nname: product-lead\n---\nPeter\n'         > "$h/proj-fly/.lead/product-lead/identity.md"
  echo "$h"
}

# $1=home. External lead uses the lazy external-interviews label + department external.
fixture_projects() {
  local h="$1" external="${2:-true}"
  cat <<JSON
[
 {"projectName":"flywheel","projectRoot":"${h}/proj-fly","leads":[
   {"agentId":"anna-interviewer-lead","chatChannel":"111","alertChannel":"999","match":{"labels":["external-interviews"]},"department":"external","botTokenEnv":"ANNA_BOT_TOKEN","alertBotTokenEnv":"ANNA_BOT_TOKEN","canSpawnRunners":false,"external":${external}},
   {"agentId":"product-lead","chatChannel":"222","match":{"labels":["Product"]},"botTokenEnv":"PETER_BOT_TOKEN","canSpawnRunners":true}]}
]
JSON
}

# run_dry HOME PROJECTS LEAD_ID PROJECT_DIR PROJECT_NAME [EXTRA_ENV...]
run_dry() {
  local h="$1" proj="$2" lead="$3" pdir="$4" pname="$5"; shift 5
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$proj" \
    DISCORD_BOT_TOKEN="$CANARY_BOT" TEAMLEAD_API_TOKEN="$CANARY_TL" \
    ANNA_BOT_TOKEN="$CANARY_BOT" \
    "$@" \
    bash "$LEAD_SH" "$lead" "$pdir" "$pname" 2>&1
}

# FLY-1402 LEGITIMATE RETARGET: the one argv target is now a generated bundle.
# Attach its manifest header so the existing role-surface assertions continue
# proving the selected sources without reading arbitrary rule prose.
plan_of() {
  local plan target
  plan="$(sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p')"
  printf '%s\n' "$plan"
  target="$(printf '%s\n' "$plan" | awk -F'\t' '
    $1 == "ARG" && previous == "--append-system-prompt-file" { print $2 }
    $1 == "ARG" { previous = $2 }
  ')"
  if [ -n "$target" ] && [ -r "$target" ]; then
    sed '/^═══ RULE SOURCE \[/,$d' "$target"
  fi
}
has()  { grep -qF "$1"; }
# Count the appended rule basenames in a plan.
rule_names() {
  awk '
    $0 ~ /^  [0-9]+\. [^\/]+\// {
      line=$0
      sub(/^  [0-9]+\. [^\/]+\//, "", line)
      sub(/ — .*/, "", line)
      print line
    }
  '
}

# ─────────────────────────────────────────────── T1: valid external launch plan
H=$(make_home); P=$(fixture_projects "$H" true)
OUT=$(run_dry "$H" "$P" anna-interviewer-lead "$H/proj-fly" flywheel); PLAN=$(printf '%s' "$OUT" | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\texternal'                            && ok "T1 external role" || bad "T1 external role"
printf '%s\n' "$PLAN" | grep -qF 'external-agent-contract.md'            && ok "T1 has external-agent-contract" || bad "T1 has external-agent-contract"
# EXACTLY one appended rule file, and it is the contract.
_rules=$(printf '%s\n' "$PLAN" | rule_names)
_rule_count=$(printf '%s\n' "$_rules" | grep -c . )
[ "$_rule_count" = "1" ] && ok "T1 exactly ONE appended rule file" || bad "T1 expected exactly 1 rule, got ${_rule_count}: $(printf '%s' "$_rules" | tr '\n' ' ')"
[ "$(printf '%s' "$_rules")" = "external-agent-contract.md" ] && ok "T1 the one rule IS the contract" || bad "T1 the one rule is not the contract (got '$_rules')"
# Negative: none of the internal/eng/cross-dept/reply/screencap/founder rules.
for forbidden in department-lead-rules.md cos-lead-rules.md founder-only-authority.md \
  founder-html-delivery.md cross-dept-channel-rules.md \
  discord-reply-contract.md screencapture-l3-skill.md inbox-ack-rule.md \
  common-rules.md companion-safety-contract.md executor-routing.md \
  runner-messaging-rules.md doc-flow-rules.md; do
  printf '%s\n' "$PLAN" | grep -qF "$forbidden" && bad "T1 must NOT have $forbidden" || ok "T1 no $forbidden"
done
# Pane creds emptied; external marker set; no companion marker.
printf '%s\n' "$PLAN" | has $'PANE_ENV\tTEAMLEAD_API_TOKEN\tempty'        && ok "T1 token empty (unusable)" || bad "T1 token empty"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tBRIDGE_URL\tempty'                && ok "T1 BRIDGE_URL empty" || bad "T1 BRIDGE_URL empty"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tFLYWHEEL_COMM_DB\tempty'          && ok "T1 comm DB empty" || bad "T1 comm DB empty"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tFLYWHEEL_LEAD_EXTERNAL\tset'      && ok "T1 external marker set" || bad "T1 external marker set"
printf '%s\n' "$PLAN" | grep -qF 'FLYWHEEL_LEAD_COMPANION'               && bad "T1 must NOT have companion marker" || ok "T1 no companion marker"
# No internal MCP.
for mcp in flywheel-terminal flywheel-inbox gbrain; do
  printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\t'"$mcp" && bad "T1 must NOT register $mcp MCP" || ok "T1 no $mcp MCP"
done
# secret-canary: token VALUES never echoed.
printf '%s' "$OUT" | grep -qF "$CANARY_BOT" && bad "T1 SECRET LEAK (bot token)" || ok "T1 no bot-token leak"
printf '%s' "$OUT" | grep -qF "$CANARY_TL"  && bad "T1 SECRET LEAK (teamlead token)" || ok "T1 no teamlead-token leak"
rm -rf "$H"

# ─────────────────── T2: DIRTY-FIXTURE isolation (Codex R3 — no false "only" green)
# Seed a STALE lead-rules cache, a POPULATED project .lead/shared, and inherited
# user MCP. External must STILL emit exactly the one contract file + no MCP —
# proving the sync-skip, append-guard, and MCP-empty guards actually hold.
H=$(make_home); P=$(fixture_projects "$H" true)
# stale lead-rules cache for this exact leadId
mkdir -p "$H/.flywheel/lead-rules/anna-interviewer-lead"
printf 'STALE-COMMON\n' > "$H/.flywheel/lead-rules/anna-interviewer-lead/common-rules.md"
printf 'STALE-DEPT\n'   > "$H/.flywheel/lead-rules/anna-interviewer-lead/department-lead-rules.md"
# populated project shared rules (simulates a future flywheel .lead/shared)
mkdir -p "$H/proj-fly/.lead/shared"
printf 'PROJ-COMMON\n' > "$H/proj-fly/.lead/shared/common-rules.md"
printf 'PROJ-DEPT\n'   > "$H/proj-fly/.lead/shared/department-lead-rules.md"
# inherited user-scope MCP (top-level ~/.claude.json.mcpServers)
printf '{"mcpServers":{"slack":{"command":"slack-mcp"}}}\n' > "$H/.claude.json"
PLAN=$(run_dry "$H" "$P" anna-interviewer-lead "$H/proj-fly" flywheel | plan_of)
_rules=$(printf '%s\n' "$PLAN" | rule_names)
[ "$(printf '%s' "$_rules")" = "external-agent-contract.md" ] && ok "T2 dirty fixtures: still EXACTLY the contract" || bad "T2 dirty fixtures leaked rules (got '$_rules')"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tslack' && bad "T2 inherited user MCP leaked" || ok "T2 no inherited user MCP (slack absent)"
rm -rf "$H"

# ───────────────────────────────── T3: byte-compat — standard dept Lead unchanged
H=$(make_home); P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-fly" flywheel | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tstandard'                            && ok "T3 standard role" || bad "T3 standard role"
printf '%s\n' "$PLAN" | grep -qF 'department-lead-rules.md'              && ok "T3 has department-lead-rules" || bad "T3 has department-lead-rules"
printf '%s\n' "$PLAN" | grep -qF 'founder-only-authority.md'             && ok "T3 has founder-only-authority" || bad "T3 has founder-only-authority"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tflywheel-terminal'        && ok "T3 has terminal MCP" || bad "T3 has terminal MCP"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tTEAMLEAD_API_TOKEN\tset'         && ok "T3 token SET (unchanged)" || bad "T3 token set"
printf '%s\n' "$PLAN" | grep -qF 'FLYWHEEL_LEAD_EXTERNAL'               && bad "T3 must NOT have external marker" || ok "T3 no external marker"
printf '%s\n' "$PLAN" | grep -qF 'external-agent-contract.md'           && bad "T3 must NOT have external contract" || ok "T3 no external contract"
rm -rf "$H"

# ────────────────────── T4: notfound → fail-STOP, no side effect (no manifest)
H=$(make_home); P=$(fixture_projects "$H" true)
run_dry "$H" "$P" ghost-lead "$H/proj-fly" flywheel >/dev/null 2>&1
[ $? -ne 0 ] && ok "T4 notfound fail-STOP (nonzero exit)" || bad "T4 notfound fail-STOP"
rm -rf "$H"

# ─────────────── T5: external fail-STOP when the contract is absent (only boundary)
# The external-agent-contract.md is the agent's ONLY hard boundary. Missing → refuse.
H=$(make_home); P=$(fixture_projects "$H" true)
EMPTY_RULES=$(mktemp -d "/tmp/fly879-emptyrules.XXXXXX")  # no external-agent-contract.md
run_dry "$H" "$P" anna-interviewer-lead "$H/proj-fly" flywheel FLYWHEEL_BASE_RULES_DIR="$EMPTY_RULES" >/dev/null 2>&1
[ $? -ne 0 ] && ok "T5 external fail-STOP when contract missing" || bad "T5 external fail-STOP on missing contract"
rm -rf "$H" "$EMPTY_RULES"

# ─────────────────────── T6: rollback (external:false → standard, byte-compat)
H=$(make_home); P=$(fixture_projects "$H" false)
PLAN=$(run_dry "$H" "$P" anna-interviewer-lead "$H/proj-fly" flywheel | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tstandard' && ok "T6 rollback: external:false → standard" || bad "T6 rollback to standard"
rm -rf "$H"

echo ""
echo "FLY-879 external launch-plan test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
