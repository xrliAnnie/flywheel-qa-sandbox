#!/bin/bash
# FLY-1496: hermetic Lead launch-model derivation contract.
#
# The real claude-lead.sh runs in dry-run under an isolated HOME. It proves:
# projects.json is authoritative on every physical launch; manifest/env are
# ignored as model inputs; aliases canonicalize through hot models.json; an
# unresolvable model falls back to Fable. The v2 wrapper owns the manifest, so
# the body launcher must not rewrite or synthesize it.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEAD_SH="$(cd "${SCRIPT_DIR}/.." && pwd)/claude-lead.sh"
DIST="$(cd "${SCRIPT_DIR}/../../dist" && pwd 2>/dev/null || true)"

if [ ! -f "${DIST}/ProjectConfig.js" ] || [ ! -f "${DIST}/lead-model-launch.js" ]; then
  echo "SKIP: teamlead dist not built — run 'pnpm -C packages/teamlead build' first" >&2
  exit 0
fi

PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

make_home() {
  local h
  h=$(mktemp -d "/tmp/fly1496-lead.XXXXXX")
  mkdir -p "$h/project/.lead/eng-lead" "$h/.flywheel/manifests"
  printf -- '---\nname: eng-lead\n---\nLead\n' > "$h/project/.lead/eng-lead/identity.md"
  echo "$h"
}

fixture_projects() {
  local h="$1" model="${2:-}" effort="${3:-}" companion="${4:-false}"
  jq -cn \
    --arg root "$h/project" \
    --arg model "$model" \
    --arg effort "$effort" \
    --argjson companion "$companion" \
    '[{
      projectName:"flywheel",
      projectRoot:$root,
      leads:[{
        agentId:"eng-lead",
        summaryRole:"producer",
        chatChannel:"1",
        match:{labels:["eng"]},
        canSpawnRunners:(if $companion then false else true end),
        companion:$companion
      }
      | if $model != "" then .model=$model else . end
      | if $effort != "" then .effort=$effort else . end]
    }]'
}

run_dry() {
  local h="$1" projects="$2"
  shift 2
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 \
    FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1 \
    FLYWHEEL_PROJECTS="$projects" \
    DISCORD_BOT_TOKEN="CANARYBOT" \
    TEAMLEAD_API_TOKEN="CANARYTEAM" \
    "$@" \
    bash "$LEAD_SH" eng-lead "$h/project" flywheel 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }
arg_value() {
  local plan="$1" flag="$2"
  printf '%s\n' "$plan" | awk -F'\t' -v wanted="$flag" '
    previous==wanted && $1=="ARG" { print $2; exit }
    $1=="ARG" { previous=$2 }
  '
}

# 1. projects.json beats both stale carriers and preserves raw evidence.
H=$(make_home)
P=$(fixture_projects "$H" "opus" "high")
jq -n '{model:"claude-opus-4-8[1m]",effort:"max"}' > "$H/.flywheel/manifests/flywheel-eng-lead.json"
MANIFEST_BEFORE=$(cat "$H/.flywheel/manifests/flywheel-eng-lead.json")
OUT=$(run_dry "$H" "$P" FLYWHEEL_LEAD_MODEL="claude-opus-4-8" FLYWHEEL_LEAD_EFFORT="low")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-opus-5" ] \
  && ok "projects alias canonicalizes; stale manifest/env cannot win" \
  || bad "expected canonical Opus 5 from projects.json"
[ "$(arg_value "$PLAN" --effort)" = "high" ] \
  && ok "projects effort beats stale manifest/env" \
  || bad "expected projects effort high"
[ "$(cat "$H/.flywheel/manifests/flywheel-eng-lead.json")" = "$MANIFEST_BEFORE" ] \
  && ok "body launcher leaves the v2-owned manifest byte-identical" \
  || bad "body launcher rewrote the v2-owned manifest"
printf '%s\n' "$OUT" | grep -q "using manifest" \
  && bad "launcher still reports manifest input authority" \
  || ok "launcher has no using-manifest path"
rm -rf "$H"

# 2. Authoritative absence clears stale model+effort and pins Fable explicitly.
H=$(make_home)
P=$(fixture_projects "$H")
jq -n '{model:"claude-opus-4-8[1m]",effort:"max"}' > "$H/.flywheel/manifests/flywheel-eng-lead.json"
MANIFEST_BEFORE=$(cat "$H/.flywheel/manifests/flywheel-eng-lead.json")
OUT=$(run_dry "$H" "$P" FLYWHEEL_LEAD_MODEL="sonnet" FLYWHEEL_LEAD_EFFORT="high")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-fable-5" ] \
  && [ -z "$(arg_value "$PLAN" --effort)" ] \
  && ok "authoritative absence resets to Fable with no stale effort" \
  || bad "absence did not clear stale carriers"
[ "$(cat "$H/.flywheel/manifests/flywheel-eng-lead.json")" = "$MANIFEST_BEFORE" ] \
  && ok "authoritative model absence does not mutate the v2 manifest" \
  || bad "authoritative model absence rewrote the v2 manifest"
rm -rf "$H"

# 3. An explicit legacy pin is honored verbatim; only unresolvable spellings
#    fall back, so a fallback in the log always means a real config mistake.
H=$(make_home)
P=$(fixture_projects "$H" "claude-opus-4-8[1m]")
OUT=$(run_dry "$H" "$P")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-opus-4-8[1m]" ] \
  && ok "an explicitly pinned legacy id launches exactly as pinned" \
  || bad "explicit legacy pin was not honored"
printf '%s\n' "$OUT" | grep -q "model_config WARNING" \
  && bad "honoring an explicit pin should not warn" \
  || ok "honoring an explicit pin is silent"
[ ! -e "$H/.flywheel/manifests/flywheel-eng-lead.json" ] \
  && ok "direct body launch does not synthesize a legacy manifest" \
  || bad "direct body launch synthesized a legacy manifest"
rm -rf "$H"

# 3b. An unresolvable spelling still falls back loudly rather than bricking boot.
H=$(make_home)
P=$(fixture_projects "$H" "claude-not-a-model")
OUT=$(run_dry "$H" "$P")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-fable-5" ] \
  && printf '%s\n' "$OUT" | grep -q "model_config WARNING" \
  && ok "an unresolvable spelling falls back to Fable, loudly" \
  || bad "unresolvable spelling handling"
rm -rf "$H"

# 4. A models.json binding edit changes the next launch with no code change.
H=$(make_home)
P=$(fixture_projects "$H" "opus")
MODELS="$H/models.json"
printf '%s\n' '{"version":1,"bindings":{"opus":"claude-fable-5"}}' > "$MODELS"
PLAN=$(run_dry "$H" "$P" FLYWHEEL_MODELS_CONFIG="$MODELS" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-fable-5" ] \
  && ok "hot binding config controls actual launch argv" \
  || bad "models.json binding did not reach launch argv"
rm -rf "$H"

# 5. Companion policy remains explicit and independent of stale env.
H=$(make_home)
P=$(fixture_projects "$H" "" "" true)
PLAN=$(run_dry "$H" "$P" FLYWHEEL_LEAD_MODEL="claude-opus-4-8" FLYWHEEL_LEAD_EFFORT="medium" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-fable-5" ] \
  && [ "$(arg_value "$PLAN" --effort)" = "xhigh" ] \
  && ok "companion gets explicit Fable + xhigh, not stale env" \
  || bad "companion launch policy mismatch"
rm -rf "$H"

echo ""
echo "FLY-1496 Lead model derivation test: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
