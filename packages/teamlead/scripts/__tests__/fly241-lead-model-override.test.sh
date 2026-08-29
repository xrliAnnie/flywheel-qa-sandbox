#!/bin/bash
# FLY-241: per-Lead model override (`FLYWHEEL_LEAD_MODEL`) — hermetic launch-plan
# test.
#
# Runs the REAL claude-lead.sh in dry-run (FLYWHEEL_LEAD_DRY_RUN=1) under an
# ISOLATED HOME with a fixture FLYWHEEL_PROJECTS, and asserts the emitted
# launch-plan argv for the four model-override paths:
#   - SET    (FLYWHEEL_LEAD_MODEL=claude-fable-5) → `--model claude-fable-5` present
#   - UNSET  (default) → NO `--model` arg (byte-compat — the account default)
#   - EMPTY  (FLYWHEEL_LEAD_MODEL="") → NO `--model` arg
#   - SPACES (FLYWHEEL_LEAD_MODEL="  ") → NO `--model` arg (trim → treated as unset;
#            guards against injecting `--model "  "` which the claude CLI rejects)
# Plus a companion-path check: the override is independent of the FLY-231
# companion `--effort` block (xhigh as of FLY-583; both can coexist).
#
# Mirrors fly231-companion-launch-plan.test.sh: per-test isolated HOME, fixture
# projects, dry-run exits before tmux. Requires built dist/ProjectConfig.js.
# Touches NOTHING outside the per-test isolated HOME.
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

CANARY_BOT="CANARYBOTtok_$$"
CANARY_TL="CANARYTLtok_$$"

make_home() {
  local h; h=$(mktemp -d "/tmp/fly241-test.XXXXXX")
  mkdir -p "$h/proj-gf/.lead/product-lead" \
           "$h/proj-growth/.lead/mufasa-lead"
  printf -- '---\nname: product-lead\n---\nPeter\n'  > "$h/proj-gf/.lead/product-lead/identity.md"
  printf -- '---\nname: mufasa-lead\n---\nMufasa\n'   > "$h/proj-growth/.lead/mufasa-lead/identity.md"
  echo "$h"
}

fixture_projects() {
  local h="$1"
  cat <<JSON
[
 {"projectName":"geoforge3d","projectRoot":"${h}/proj-gf","leads":[
   {"agentId":"product-lead","chatChannel":"222","match":{"labels":["Product"]},"botTokenEnv":"PETER_BOT_TOKEN","canSpawnRunners":true}]},
 {"projectName":"growth","projectRoot":"${h}/proj-growth","leads":[
   {"agentId":"mufasa-lead","chatChannel":"111","alertChannel":"111","match":{"labels":["growth"]},"botTokenEnv":"MUFASA_BOT_TOKEN","canSpawnRunners":false,"companion":true,"department":"growth"}]}
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

# The plan emits each argv token on its own `ARG\t<token>` line, so a
# `--model claude-fable-5` pair shows up as two consecutive ARG lines.
#
# Codex LOW: detect token PRESENCE separately from VALUE — otherwise an empty
# value (`--model ""`, which WOULD violate byte-compat) is indistinguishable
# from "no --model at all" since both yield an empty value string.

# Prints "yes" iff a `--model` ARG token is present in the plan (regardless of
# its value, including an empty value).
model_arg_present() {
  printf '%s\n' "$1" | awk -F'\t' '
    $1=="ARG" && $2=="--model" { print "yes"; exit }
  '
}

# Prints the VALUE token immediately following `--model`, or nothing.
model_arg_value() {
  printf '%s\n' "$1" | awk -F'\t' '
    prev=="--model" && $1=="ARG" { print $2; exit }
    $1=="ARG" { prev=$2 }
  '
}

# ───────────────────────────────────────────────── T1: SET → --model present
H=$(make_home); P=$(fixture_projects "$H")
OUT=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d FLYWHEEL_LEAD_MODEL=claude-fable-5)
PLAN=$(printf '%s' "$OUT" | plan_of)
[ "$(model_arg_present "$PLAN")" = "yes" ] && ok "T1 SET → --model token present" || bad "T1 SET → --model token missing"
[ "$(model_arg_value "$PLAN")" = "claude-fable-5" ] && ok "T1 SET → value claude-fable-5" || bad "T1 SET → expected claude-fable-5, got '$(model_arg_value "$PLAN")'"
# Secret-canary: tokens must never appear in the emitted plan.
printf '%s' "$OUT" | grep -qF "$CANARY_BOT" && bad "T1 SECRET LEAK (bot token)" || ok "T1 no bot-token leak"
rm -rf "$H"

# ───────────────────── T1b: FLY-360 bracketed 1M selector → exact passthrough
# The `[1m]` suffix must reach `--model` byte-for-byte: bash array quoting must
# not word-split it or let `[1m]` undergo glob/pathname expansion.
H=$(make_home); P=$(fixture_projects "$H")
OUT=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d "FLYWHEEL_LEAD_MODEL=claude-opus-4-8[1m]")
PLAN=$(printf '%s' "$OUT" | plan_of)
[ "$(model_arg_present "$PLAN")" = "yes" ] && ok "T1b 1M SET → --model token present" || bad "T1b 1M SET → --model token missing"
[ "$(model_arg_value "$PLAN")" = "claude-opus-4-8[1m]" ] && ok "T1b 1M SET → value claude-opus-4-8[1m] verbatim" || bad "T1b 1M SET → expected claude-opus-4-8[1m], got '$(model_arg_value "$PLAN")'"
rm -rf "$H"

# ──────────────────────────────────────── T2: UNSET → no --model (byte-compat)
# Assert TOKEN absence (Codex LOW): `--model ""` would also yield an empty value,
# so checking the value alone would miss a byte-compat-violating empty arg.
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d | plan_of)
[ -z "$(model_arg_present "$PLAN")" ] && ok "T2 UNSET → no --model token (account default)" || bad "T2 UNSET → --model token present (byte-compat broken)"
rm -rf "$H"

# ──────────────────────────────────────────────── T3: EMPTY → no --model token
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d FLYWHEEL_LEAD_MODEL= | plan_of)
[ -z "$(model_arg_present "$PLAN")" ] && ok "T3 EMPTY value → no --model token" || bad "T3 EMPTY → --model token present (would pass --model \"\")"
rm -rf "$H"

# ───────────────────────────── T4: WHITESPACE-only → no --model (trim guard)
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d "FLYWHEEL_LEAD_MODEL=   " | plan_of)
[ -z "$(model_arg_present "$PLAN")" ] && ok "T4 WHITESPACE-only → trimmed → no --model token" || bad "T4 WHITESPACE → --model token present (trim failed)"
rm -rf "$H"

# ────────── T4b (Codex NIT): non-empty value padded with surrounding whitespace
# (spaces + a tab) is trimmed to the bare model id — proves trim strips padding
# on a REAL value without dropping it. Uses a literal tab via $'...'.
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d "FLYWHEEL_LEAD_MODEL=$(printf ' \tclaude-fable-5 \t')" | plan_of)
[ "$(model_arg_present "$PLAN")" = "yes" ] && ok "T4b padded value → --model token present" || bad "T4b padded value → --model token missing"
[ "$(model_arg_value "$PLAN")" = "claude-fable-5" ] && ok "T4b padded value trimmed to claude-fable-5" || bad "T4b padded value → expected claude-fable-5, got '$(model_arg_value "$PLAN")'"
rm -rf "$H"

# ─────────────────── T5: SET on a companion → --model coexists with --effort
# The override is role-agnostic (operator opt-in per Lead via plist env). A
# companion still gets its companion `--effort` (xhigh as of FLY-583); the model flag is additive.
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_LEAD_MODEL=claude-fable-5 | plan_of)
[ "$(model_arg_value "$PLAN")" = "claude-fable-5" ] && ok "T5 companion SET → --model present" || bad "T5 companion SET → expected claude-fable-5, got '$(model_arg_value "$PLAN")'"
printf '%s\n' "$PLAN" | grep -qF $'ARG\t--effort' && ok "T5 companion still has --effort (additive)" || bad "T5 companion lost --effort"
# FLY-583: companion effort value is xhigh, never medium. This is the CI-gated
# regression guard (fly247-bash-suites.test.ts wires THIS suite into vitest; the
# fuller fly231 launch-plan sentinel asserts the same but is not in CI). medium
# was a stale FLY-231 mitigation that did NOT prevent the FLY-306/387 reply leak.
printf '%s\n' "$PLAN" | grep -qF $'ARG\txhigh' && ok "T5 companion effort is xhigh (FLY-583)" || bad "T5 companion effort is xhigh (FLY-583)"
printf '%s\n' "$PLAN" | grep -qF $'ARG\tmedium' && bad "T5 companion effort must NOT be medium (FLY-583)" || ok "T5 companion effort not medium (FLY-583)"
rm -rf "$H"

# ─────────────────────────── T6: production claude-lead.sh has the FLY-241 gate
test_production_has_gate() {
  if ! grep -qE 'FLYWHEEL_LEAD_MODEL' "$LEAD_SH"; then
    bad "claude-lead.sh missing FLYWHEEL_LEAD_MODEL gate (FLY-241 regression)"
    return
  fi
  if ! grep -qE '\-\-model.*_fly241_lead_model' "$LEAD_SH"; then
    bad "claude-lead.sh missing --model append (FLY-241 regression)"
    return
  fi
  ok "production claude-lead.sh has FLY-241 --model gate"
}
test_production_has_gate

# ═══════════════════════════════════════════════════════════════════════════
# FLY-671: per-Lead effort override (`FLYWHEEL_LEAD_EFFORT`). The carrier flows
# projects.json → manifest → plist env; here we drive the env directly (same as
# the model tests) and assert the emitted `--effort` argv. Precedence:
#   valid explicit env  → --effort <value> (any Lead, incl companion)
#   no/empty/bad env + companion → --effort xhigh (FLY-583 fallback preserved)
#   no/empty/bad env + non-companion → NO --effort (byte-compat)
# ═══════════════════════════════════════════════════════════════════════════

# Prints the VALUE token immediately following `--effort`, or nothing.
effort_arg_value() {
  printf '%s\n' "$1" | awk -F'\t' '
    prev=="--effort" && $1=="ARG" { print $2; exit }
    $1=="ARG" { prev=$2 }
  '
}
# Prints "yes" iff an `--effort` ARG token is present.
effort_arg_present() {
  printf '%s\n' "$1" | awk -F'\t' '
    $1=="ARG" && $2=="--effort" { print "yes"; exit }
  '
}

# E1: non-companion + valid effort → --effort high
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d FLYWHEEL_LEAD_EFFORT=high | plan_of)
[ "$(effort_arg_value "$PLAN")" = "high" ] && ok "E1 non-companion valid → --effort high" || bad "E1 non-companion valid → expected high, got '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E2: non-companion + UNSET → NO --effort (byte-compat — the sentinel)
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d | plan_of)
[ -z "$(effort_arg_present "$PLAN")" ] && ok "E2 non-companion UNSET → no --effort (byte-compat)" || bad "E2 non-companion UNSET → --effort leaked '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E3: non-companion + whitespace-only → trimmed → NO --effort
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d "FLYWHEEL_LEAD_EFFORT=   " | plan_of)
[ -z "$(effort_arg_present "$PLAN")" ] && ok "E3 non-companion whitespace → trimmed → no --effort" || bad "E3 non-companion whitespace → --effort present"
rm -rf "$H"

# E4: non-companion + INVALID value → treated as unset → NO --effort
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" product-lead "$H/proj-gf" geoforge3d FLYWHEEL_LEAD_EFFORT=ultra | plan_of)
[ -z "$(effort_arg_present "$PLAN")" ] && ok "E4 non-companion invalid → no --effort (unset)" || bad "E4 non-companion invalid → --effort leaked '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E5: companion + UNSET → --effort xhigh (FLY-583 fallback intact)
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth | plan_of)
[ "$(effort_arg_value "$PLAN")" = "xhigh" ] && ok "E5 companion UNSET → --effort xhigh (FLY-583)" || bad "E5 companion UNSET → expected xhigh, got '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E5b: companion + INVALID value → falls through to xhigh (bad env must NOT strip xhigh)
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_LEAD_EFFORT=bogus | plan_of)
[ "$(effort_arg_value "$PLAN")" = "xhigh" ] && ok "E5b companion invalid env → still xhigh (fallback preserved)" || bad "E5b companion invalid env → expected xhigh, got '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E6: companion + valid explicit effort → overrides xhigh (--effort medium)
H=$(make_home); P=$(fixture_projects "$H")
PLAN=$(run_dry "$H" "$P" mufasa-lead "$H/proj-growth" growth FLYWHEEL_LEAD_EFFORT=medium | plan_of)
[ "$(effort_arg_value "$PLAN")" = "medium" ] && ok "E6 companion explicit → --effort medium (overrides xhigh)" || bad "E6 companion explicit → expected medium, got '$(effort_arg_value "$PLAN")'"
rm -rf "$H"

# E7: production claude-lead.sh has the FLY-671 effort gate
if grep -qE 'FLYWHEEL_LEAD_EFFORT' "$LEAD_SH" && grep -qE '\-\-effort.*_fly671_lead_effort' "$LEAD_SH"; then
  ok "production claude-lead.sh has FLY-671 --effort gate"
else
  bad "claude-lead.sh missing FLY-671 --effort gate (regression)"
fi

echo ""
echo "FLY-241/671 lead model+effort override test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
