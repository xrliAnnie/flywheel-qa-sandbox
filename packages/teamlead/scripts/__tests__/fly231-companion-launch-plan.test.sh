#!/bin/bash
# FLY-231: companion-Lead launch-plan + role-detection test (hermetic).
#
# Runs the REAL claude-lead.sh in dry-run (FLYWHEEL_LEAD_DRY_RUN=1) under an
# ISOLATED HOME with a fixture FLYWHEEL_PROJECTS, and asserts the structured
# launch plan. This is the reverse-compat sentinel + companion capability proof
# (Codex design review R3 BLOCKER-4 / R4 HIGH-4 / R5 / R6):
#   - companion gets ONLY persona-friendly rules (companion-safety-contract +
#     cross-dept) + --effort xhigh (FLY-583, was medium); NONE of the eng-governance rules; pane creds
#     EMPTY (token unusable); no terminal/inbox/gbrain/user MCP; FLYWHEEL_LEAD_COMPANION set.
#   - standard dept Lead is UNCHANGED (all eng rules + terminal/inbox MCP + creds
#     SET; no companion items) — byte-compat by construction.
#   - cos Lead unchanged (cos-lead-rules; no dept base rules).
#   - role detection: companion / exact-noncompanion / notfound→fail-STOP /
#     error→fail-STOP; NO FLYWHEEL_LEAD_ROLE bypass; clean rollback; fail-STOP has
#     no side effects (no manifest written); secret-canary (no token value echoed).
#
# Requires: built dist/ProjectConfig.js, node, jq. Touches NOTHING outside the
# per-test isolated HOME and never starts a real Lead (dry-run exits before tmux).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"

if [ ! -f "${DIST}/ProjectConfig.js" ]; then
  echo "SKIP: dist/ProjectConfig.js not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

# Per-test isolated HOME + fixture projects. CANARY tokens must never appear in
# the emitted plan (we only print env KEY+status, never values).
CANARY_BOT="CANARYBOTtok_$$"
CANARY_TL="CANARYTLtok_$$"

make_home() {
  local h; h=$(mktemp -d "/tmp/fly231-test.XXXXXX")
  mkdir -p "$h/proj-growth/.lead/mufasa-lead" \
           "$h/proj-gf/.lead/product-lead" \
           "$h/proj-gf/.lead/cos-lead"
  printf -- '---\nname: mufasa-lead\n---\nMufasa\n' > "$h/proj-growth/.lead/mufasa-lead/identity.md"
  printf -- '---\nname: product-lead\n---\nPeter\n'  > "$h/proj-gf/.lead/product-lead/identity.md"
  printf -- '---\nname: cos-lead\n---\nSimba\n'       > "$h/proj-gf/.lead/cos-lead/identity.md"
  echo "$h"
}

# $1=projects-json-override ("" = default fixture using $HOME paths) printed to stdout
fixture_projects() {
  local h="$1" companion="${2:-true}"
  cat <<JSON
[
 {"projectName":"growth","projectRoot":"${h}/proj-growth","leads":[
   {"agentId":"mufasa-lead","chatChannel":"111","alertChannel":"111","match":{"labels":["growth"]},"botTokenEnv":"MUFASA_BOT_TOKEN","canSpawnRunners":false,"companion":${companion},"department":"growth"}]},
 {"projectName":"geoforge3d","projectRoot":"${h}/proj-gf","leads":[
   {"agentId":"product-lead","chatChannel":"222","match":{"labels":["Product"]},"botTokenEnv":"PETER_BOT_TOKEN","canSpawnRunners":true},
   {"agentId":"cos-lead","chatChannel":"333","match":{"labels":["PM"]},"botTokenEnv":"TEST_COS_BOT_TOKEN","canSpawnRunners":false}]}
]
JSON
}

# run_dry HOME PROJECTS LEAD_ID PROJECT_DIR PROJECT_NAME [EXTRA_ENV...]
run_dry() {
  local h="$1" proj="$2" lead="$3" pdir="$4" pname="$5"; shift 5
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 FLYWHEEL_PROJECTS="$proj" \
    DISCORD_BOT_TOKEN="$CANARY_BOT" TEAMLEAD_API_TOKEN="$CANARY_TL" \
    "$@" \
    bash "$LEAD_SH" "$lead" "$pdir" "$pname" 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }
has()  { grep -qF "$1"; }

# ───────────────────────────────────────────────────────────── T1: companion
H=$(make_home); P=$(fixture_projects "$H" true)
OUT=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth); PLAN=$(printf '%s' "$OUT" | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tcompanion'                         && ok "T1 companion role" || bad "T1 companion role"
printf '%s\n' "$PLAN" | grep -qF 'companion-safety-contract.md'        && ok "T1 has safety-contract" || bad "T1 has safety-contract"
printf '%s\n' "$PLAN" | grep -qF 'cross-dept-channel-rules.md'         && ok "T1 has cross-dept" || bad "T1 has cross-dept"
printf '%s\n' "$PLAN" | grep -qF $'ARG\t--effort'                      && ok "T1 has --effort flag" || bad "T1 has --effort flag"
# FLY-583: companion effort is pinned to xhigh (was medium). Evidence showed medium
# did NOT prevent the FLY-306/387 reply-leak (Belle leaked at xhigh too) and only
# degraded capability against Annie's xhigh requirement — the real leak defense is
# the discord-reply-enforcer Stop hook. Assert the value is xhigh and never medium.
printf '%s\n' "$PLAN" | grep -qF $'ARG\txhigh'                         && ok "T1 effort value is xhigh (FLY-583)" || bad "T1 effort value is xhigh (FLY-583)"
printf '%s\n' "$PLAN" | grep -qF $'ARG\tmedium'                        && bad "T1 effort must NOT be medium (FLY-583 regression)" || ok "T1 effort not medium (FLY-583 regression guard)"
printf '%s\n' "$PLAN" | grep -qF 'founder-only-authority.md'           && bad "T1 must NOT have founder-only-authority" || ok "T1 no founder-only-authority"
printf '%s\n' "$PLAN" | grep -qF 'department-lead-rules.md'            && bad "T1 must NOT have department-lead-rules" || ok "T1 no department-lead-rules"
printf '%s\n' "$PLAN" | grep -qF 'screencapture-l3-skill.md'          && bad "T1 must NOT have screencapture" || ok "T1 no screencapture"
printf '%s\n' "$PLAN" | grep -qF 'inbox-ack-rule.md'                  && bad "T1 must NOT have inbox-ack" || ok "T1 no inbox-ack"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tTEAMLEAD_API_TOKEN\tempty'     && ok "T1 token empty (unusable)" || bad "T1 token empty"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tBRIDGE_URL\tempty'             && ok "T1 BRIDGE_URL empty" || bad "T1 BRIDGE_URL empty"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tFLYWHEEL_LEAD_COMPANION\tset'  && ok "T1 companion marker set" || bad "T1 companion marker set"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tflywheel-terminal'      && bad "T1 must NOT register terminal MCP" || ok "T1 no terminal MCP"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tflywheel-inbox'         && bad "T1 must NOT register inbox MCP" || ok "T1 no inbox MCP"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tgbrain'                 && bad "T1 must NOT register gbrain MCP" || ok "T1 no gbrain MCP"
# secret-canary: full output (not just plan) must not contain the token VALUES
printf '%s' "$OUT" | grep -qF "$CANARY_BOT" && bad "T1 SECRET LEAK (bot token)" || ok "T1 no bot-token leak"
printf '%s' "$OUT" | grep -qF "$CANARY_TL"  && bad "T1 SECRET LEAK (teamlead token)" || ok "T1 no teamlead-token leak"
rm -rf "$H"

# ───────────────────────────────────────────────────── T2: standard dept Lead
H=$(make_home); P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tstandard'                         && ok "T2 standard role" || bad "T2 standard role"
printf '%s\n' "$PLAN" | grep -qF 'department-lead-rules.md'           && ok "T2 has department-lead-rules" || bad "T2 has department-lead-rules"
printf '%s\n' "$PLAN" | grep -qF 'founder-only-authority.md'          && ok "T2 has founder-only-authority" || bad "T2 has founder-only-authority"
printf '%s\n' "$PLAN" | grep -qF $'MCP_SERVER\tflywheel-terminal'     && ok "T2 has terminal MCP" || bad "T2 has terminal MCP"
printf '%s\n' "$PLAN" | has $'PANE_ENV\tTEAMLEAD_API_TOKEN\tset'      && ok "T2 token SET (unchanged)" || bad "T2 token set"
printf '%s\n' "$PLAN" | grep -qF $'ARG\t--effort'                     && bad "T2 must NOT have --effort" || ok "T2 no --effort"
printf '%s\n' "$PLAN" | grep -qF 'companion-safety-contract.md'       && bad "T2 must NOT have safety-contract" || ok "T2 no safety-contract"
printf '%s\n' "$PLAN" | grep -qF 'FLYWHEEL_LEAD_COMPANION'            && bad "T2 must NOT have companion marker" || ok "T2 no companion marker"
rm -rf "$H"

# ─────────────────────────────────────────────────────────────── T3: cos Lead
H=$(make_home); P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" cos-lead "$H/proj-gf" geoforge3d | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tstandard'                        && ok "T3 cos role (standard, not companion)" || bad "T3 cos role"
printf '%s\n' "$PLAN" | grep -qF 'cos-lead-rules.md'                 && ok "T3 has cos-lead-rules" || bad "T3 has cos-lead-rules"
printf '%s\n' "$PLAN" | grep -qF 'department-lead-rules.md'          && bad "T3 cos must NOT have dept base rules" || ok "T3 no dept base rules"
printf '%s\n' "$PLAN" | grep -qF 'founder-only-authority.md'         && ok "T3 has founder-only-authority" || bad "T3 has founder-only-authority"
rm -rf "$H"

# ──────────────────────────────────── T4: notfound → fail-STOP, no side effect
H=$(make_home); P=$(fixture_projects "$H" true)
run_dry "$H" "$P" ghost-lead "$H/proj-gf" geoforge3d >/dev/null 2>&1
[ $? -ne 0 ] && ok "T4 notfound fail-STOP (nonzero exit)" || bad "T4 notfound fail-STOP"
ls "$H/.flywheel/manifests/geoforge3d-ghost-lead.json" >/dev/null 2>&1 \
  && bad "T4 fail-STOP wrote a manifest (side effect)" || ok "T4 fail-STOP wrote no manifest"
rm -rf "$H"

# ──────────────────────────────────────────────── T5: error config → fail-STOP
H=$(make_home)
run_dry "$H" "{ not valid json" mufasa-lead "$H/proj-growth" growth >/dev/null 2>&1
[ $? -ne 0 ] && ok "T5 invalid-config fail-STOP (nonzero exit)" || bad "T5 invalid-config fail-STOP"
rm -rf "$H"

# ─────────────────────────── T6: NO FLYWHEEL_LEAD_ROLE bypass (query is authority)
# companion + accidental role env → STILL companion
H=$(make_home); P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_LEAD_ROLE=lead | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tcompanion' && ok "T6 companion+role-env still companion (no bypass)" || bad "T6 companion+role-env still companion"
# role env + missing config → still fail-STOP (cannot bypass to noncompanion)
H2=$(make_home)
run_dry "$H2" "[]" product-lead "$H2/proj-gf" geoforge3d FLYWHEEL_LEAD_ROLE=lead >/dev/null 2>&1
[ $? -ne 0 ] && ok "T6 role-env + empty config still fail-STOP" || bad "T6 role-env + empty config fail-STOP"
rm -rf "$H" "$H2"

# ───────────────────────────────── T7: rollback (remove companion:true → standard)
H=$(make_home); P=$(fixture_projects "$H" false)
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth | plan_of)
printf '%s\n' "$PLAN" | has $'ROLE\tstandard' && ok "T7 rollback: companion:false → standard" || bad "T7 rollback to standard"
rm -rf "$H"

# ───────── T8: ALL 5 existing Leads — FULL normalized launch-plan golden sentinel
# Codex code-review R2 MEDIUM-2: a real byte-compat sentinel, not spot-checks.
# Normalize each plan to role + sorted rule basenames + sorted pane-env key=status
# + sorted MCP names, and compare to a hardcoded golden. ANY drift (rule/env/MCP
# added or removed) fails → forces a conscious update. dept (product/ops/joycon/
# sub) share one golden; cos has its own.
#
# Transport determinism (Codex code-review R3 MEDIUM-1): run_dry keeps the host
# PATH, so whether agent-team-transport exists on the host would otherwise flip
# the standard Lead in/out of the transport branch and make the golden flaky. We
# install a deterministic stub at $HOME/.flywheel/bin/agent-team-transport —
# claude-lead.sh prepends that dir to PATH, so it shadows any host binary — and
# bake its effect (env=CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=set) into the golden.
normalize_plan() {
  awk -F'\t' '
    $1=="ROLE"{print "role="$2}
    $1=="ARG" && $2=="--effort"{print "flag=--effort"}
    $1=="ARG" && prev=="--append-system-prompt-file"{n=split($2,a,"/"); print "rule="a[n]}
    $1=="ARG"{prev=$2}
    $1=="PANE_ENV"{print "env="$2"="$3}
    $1=="MCP_SERVER"{print "mcp="$2}
  ' | LC_ALL=C sort
}
# FLY-583/FLY-879: refreshed these goldens for PRE-EXISTING staleness, unrelated to
# the role changes. The FLY-231 goldens predate later base rules that
# claude-lead.sh now emits for standard/cos leads — discord-reply-contract.md
# (FLY-387), runner-reengage-rules.md (FLY-229), xiaohongshu-memory-rules.md
# (FLY-222), and (added in this FLY-879 refresh) auto-qa-pipeline.md (FLY-579),
# default-enable-policy.md (FLY-707), model-routing.md (FLY-728), and
# runner-patrol-rules.md (FLY-369). Proven pre-existing: HEAD's claude-lead.sh
# appends all four but the committed golden lacked them, and the FLY-879 external
# role diff never touches these dept-branch appends. This sentinel is not wired
# into vitest/CI, so the drift went unnoticed.
#
# FLY-900 (2026-07-06): the founder-UX signoff gate is RETIRED fleet-wide by
# default. claude-lead.sh now appends founder-ux-rules.md only when
# FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1. run_dry uses `env -i` (no such env), so the
# DEFAULT plan no longer carries founder-ux-rules.md — it was removed from both
# goldens. The reverse (env=1 → still appended) is covered by T11 below.
read -r -d '' DEPT_GOLDEN <<'G'
env=BRIDGE_URL=set
env=CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=set
env=CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=set
env=DISCORD_BOT_TOKEN=set
env=DISCORD_CORE_CHANNEL=empty
env=DISCORD_STATE_DIR=set
env=FLYWHEEL_COMM_CLI=set
env=FLYWHEEL_COMM_DB=set
env=FLYWHEEL_LEAD_ID=set
env=FLYWHEEL_PROJECT_DIR=set
env=FLYWHEEL_PROJECT_NAME=set
env=FLYWHEEL_TEAMLEAD_SCRIPT_DIR=set
env=HOME=set
env=LEAD_ID=set
env=OPENAI_API_KEY=empty
env=PATH=set
env=PROJECT_NAME=set
env=TEAMLEAD_API_TOKEN=set
env=TEAMLEAD_ISSUE_PREFIXES=set
mcp=flywheel-inbox
mcp=flywheel-terminal
role=standard
rule=auto-qa-pipeline.md
rule=cross-dept-channel-rules.md
rule=default-enable-policy.md
rule=department-lead-rules.md
rule=discord-reply-contract.md
rule=doc-flow-rules.md
rule=executor-routing.md
rule=founder-html-delivery.md
rule=founder-only-authority.md
rule=inbox-ack-rule.md
rule=model-routing.md
rule=runner-messaging-rules.md
rule=runner-patrol-rules.md
rule=runner-reengage-rules.md
rule=screencapture-l3-skill.md
rule=stuck-runner-remanage.md
rule=xiaohongshu-memory-rules.md
G
read -r -d '' COS_GOLDEN <<'G'
env=BRIDGE_URL=set
env=CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=set
env=CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=set
env=DISCORD_BOT_TOKEN=set
env=DISCORD_CORE_CHANNEL=empty
env=DISCORD_STATE_DIR=set
env=FLYWHEEL_COMM_CLI=set
env=FLYWHEEL_COMM_DB=set
env=FLYWHEEL_LEAD_ID=set
env=FLYWHEEL_PROJECT_DIR=set
env=FLYWHEEL_PROJECT_NAME=set
env=FLYWHEEL_TEAMLEAD_SCRIPT_DIR=set
env=HOME=set
env=LEAD_ID=set
env=OPENAI_API_KEY=empty
env=PATH=set
env=PROJECT_NAME=set
env=TEAMLEAD_API_TOKEN=set
env=TEAMLEAD_ISSUE_PREFIXES=set
mcp=flywheel-inbox
mcp=flywheel-terminal
role=standard
rule=cos-lead-rules.md
rule=cross-dept-channel-rules.md
rule=discord-reply-contract.md
rule=founder-html-delivery.md
rule=founder-only-authority.md
rule=inbox-ack-rule.md
rule=screencapture-l3-skill.md
G
H=$(mktemp -d "/tmp/fly231-test.XXXXXX")
for L in product-lead ops-lead cos-lead joycon-lead sub-lead; do
  mkdir -p "$H/proj/.lead/$L"
  printf -- '---\nname: %s\n---\n%s\n' "$L" "$L" > "$H/proj/.lead/$L/identity.md"
done
# Deterministic transport stub (shadows any host agent-team-transport).
mkdir -p "$H/.flywheel/bin"
cat > "$H/.flywheel/bin/agent-team-transport" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) exit 0 ;;
  vendor)    echo "claude-code" ;;
  lead-env)  echo "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" ;;
  lead-args) echo "FLYWHEEL_AGENT_TEAM_ARGS=()" ;;
esac
STUB
chmod +x "$H/.flywheel/bin/agent-team-transport"
P5='[{"projectName":"gf","projectRoot":"'"$H"'/proj","leads":[
  {"agentId":"product-lead","chatChannel":"1","match":{"labels":["Product"]}},
  {"agentId":"ops-lead","chatChannel":"2","match":{"labels":["Operations"]}},
  {"agentId":"cos-lead","chatChannel":"3","match":{"labels":["PM"]},"canSpawnRunners":false},
  {"agentId":"joycon-lead","chatChannel":"4","match":{"labels":["joycon"]}},
  {"agentId":"sub-lead","chatChannel":"5","match":{"labels":["Sub"]}}]}]'
for L in product-lead ops-lead cos-lead joycon-lead sub-lead; do
  GOT=$(run_dry "$H" "$P5" "$L" "$H/proj" gf | plan_of | normalize_plan)
  if [ "$L" = "cos-lead" ]; then WANT="$COS_GOLDEN"; else WANT="$DEPT_GOLDEN"; fi
  if [ "$GOT" = "$WANT" ]; then
    ok "T8 $L full launch-plan matches golden (byte-compat)"
  else
    bad "T8 $L launch-plan DRIFTED from golden"
    diff <(printf '%s\n' "$WANT") <(printf '%s\n' "$GOT") | sed 's/^/      /'
  fi
done
rm -rf "$H"

# ───────── T9: transport elif still routes standard→transport (companion skips it)
# A stub agent-team-transport on PATH (claude-lead.sh prepends ~/.flywheel/bin)
# makes the real transport wiring run in dry-run (CLI present → not the skip path).
# Proves the FLY-231 `if companion … elif command -v` head didn't break standard
# transport entry, and that companion genuinely skips it even when the CLI exists.
H=$(make_home); P=$(fixture_projects "$H" true)
mkdir -p "$H/.flywheel/bin"
cat > "$H/.flywheel/bin/agent-team-transport" <<'STUB'
#!/bin/bash
case "$1" in
  preflight) exit 0 ;;
  vendor)    echo "claude-code" ;;
  lead-env)  echo "export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1" ;;
  lead-args) echo "FLYWHEEL_AGENT_TEAM_ARGS=(--agent-team-stub-flag)" ;;
esac
STUB
chmod +x "$H/.flywheel/bin/agent-team-transport"
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d | plan_of)
printf '%s\n' "$PLAN" | grep -qF -- '--agent-team-stub-flag' && ok "T9 standard enters transport (stub flag merged)" || bad "T9 standard enters transport"
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth | plan_of)
printf '%s\n' "$PLAN" | grep -qF -- '--agent-team-stub-flag' && bad "T9 companion must skip transport" || ok "T9 companion skips transport (no stub flag)"
rm -rf "$H"

# ───────── T10: companion fail-STOP when safety-contract is absent (Codex CR HIGH-2)
# The safety contract is the companion's ONLY hard boundary (founder-only-authority
# is skipped). If it's missing/unreadable, the companion must REFUSE to start.
# (FLYWHEEL_BASE_RULES_DIR override is honored ONLY under dry-run — see HIGH-1 fix.)
H=$(make_home); P=$(fixture_projects "$H" true)
EMPTY_RULES=$(mktemp -d "/tmp/fly231-emptyrules.XXXXXX")  # no companion-safety-contract.md
run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_BASE_RULES_DIR="$EMPTY_RULES" >/dev/null 2>&1
[ $? -ne 0 ] && ok "T10 companion fail-STOP when safety-contract missing" || bad "T10 companion fail-STOP on missing contract"
rm -rf "$H" "$EMPTY_RULES"

# ───────── T11: FLY-900 reverse-compat — env=1 re-enables the founder-ux rules
# The default (T8, env -i) drops founder-ux-rules.md. With the kill-switch
# explicitly re-enabled a standard dept Lead gets it appended again (proves the
# gate is reversible, not deleted). A companion still never gets it (env-agnostic
# — the companion guard short-circuits before the founder-ux append).
H=$(make_home); P=$(fixture_projects "$H" true)
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1 | plan_of)
printf '%s\n' "$PLAN" | grep -qF 'founder-ux-rules.md' && ok "T11 env=1 re-appends founder-ux-rules (reversible)" || bad "T11 env=1 must re-append founder-ux-rules"
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1 | plan_of)
printf '%s\n' "$PLAN" | grep -qF 'founder-ux-rules.md' && bad "T11 companion must NOT get founder-ux-rules even with env=1" || ok "T11 companion still excluded (env=1)"
rm -rf "$H"

echo ""
echo "FLY-231 launch-plan test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
