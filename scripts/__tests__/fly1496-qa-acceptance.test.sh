#!/bin/bash
# FLY-1496 QA acceptance suite — independent of the implementation suites.
#
# Covers the founder acceptance items that the implementation tests leave
# uncovered, and the seams where a launch is most likely to stop being FAITHFUL
# to the authoritative source: the resolver-unavailable branch (plan §2.2-6,
# which the implementation suite never exercises), the alert kind actually
# reaching the queue rather than being dropped as unknown, a `models.json`
# binding edit that must be obeyed at the Lead seam yet cannot turn a
# non-dispatch model into a difficulty tier, and a second physical launch
# reusing a HOME a previous launch already wrote a manifest into (the FLY-1285
# regression shape).
#
# There is no model blocklist (founder decision, 2026-07-27): a model reaches a
# launch by being named in config, so what is worth machining is that config is
# reproduced exactly — not that some second list gets consulted. The v2 body
# never writes the manifest; materializer/fleet own its static fields and the
# wrapper owns only runtime identity.
#
# Everything runs against the real claude-lead.sh + real dist under an isolated
# HOME. Nothing touches the production ~/.flywheel.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LEAD_SH="${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh"
DIST="${REPO_ROOT}/packages/teamlead/dist"
CONFIG_DIST="${REPO_ROOT}/packages/config/dist/index.js"

if [ ! -f "${DIST}/lead-model-launch.js" ] || [ ! -f "$CONFIG_DIST" ]; then
  echo "SKIP: dist not built — run 'pnpm -r build' first" >&2
  exit 0
fi

PASS=0
FAIL=0
ok() { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }
TMPDIRS=()
cleanup() { for d in ${TMPDIRS[@]+"${TMPDIRS[@]}"}; do rm -rf "$d"; done; }
trap cleanup EXIT

make_home() {
  local h
  h=$(mktemp -d "/tmp/fly1496-qa.XXXXXX")
  TMPDIRS+=("$h")
  mkdir -p "$h/project/.lead/eng-lead" "$h/.flywheel/manifests"
  printf '%s\n' '{"granularity":"per-lead","setBy":"test","setAt":"2026-08-28T00:00:00.000Z"}' \
    > "$h/.flywheel/summary-config.json"
  printf -- '---\nname: eng-lead\n---\nLead\n' > "$h/project/.lead/eng-lead/identity.md"
  echo "$h"
}

# projects.json fixture written to the real per-HOME path so lead-alert.sh (which
# reads the FILE, not the inline env) resolves the same identity the launcher does.
write_projects() {
  local h="$1" model="${2:-}" effort="${3:-}"
  jq -n \
    --arg root "$h/project" --arg model "$model" --arg effort "$effort" \
    '[{projectName:"flywheel",projectRoot:$root,leads:[
        {agentId:"eng-lead",summaryRole:"producer",chatChannel:"1",match:{labels:["eng"]},
         canSpawnRunners:true,companion:false}
        | if $model != "" then .model=$model else . end
        | if $effort != "" then .effort=$effort else . end]}]' \
    > "$h/.flywheel/projects.json"
}

run_dry() {
  local h="$1" lead_sh="$2"
  shift 2
  env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_LEAD_DRY_RUN=1 \
    FLYWHEEL_PROJECTS="$(cat "$h/.flywheel/projects.json")" \
    DISCORD_BOT_TOKEN="CANARYBOT" \
    TEAMLEAD_API_TOKEN="CANARYTEAM" \
    "$@" \
    bash "$lead_sh" eng-lead "$h/project" flywheel 2>&1
}

plan_of() { sed -n '/LAUNCH_PLAN_BEGIN/,/LAUNCH_PLAN_END/p'; }
arg_value() {
  printf '%s\n' "$1" | awk -F'\t' -v wanted="$2" '
    previous==wanted && $1=="ARG" { print $2; exit }
    $1=="ARG" { previous=$2 }
  '
}

# ---------------------------------------------------------------------------
# 1. Resolver-unavailable branch: a broken dist must NOT fall back to the frozen
#    launchd env (which in the incident carried exactly the banned 4.8 identity).
#    Built via a mirrored root so FLYWHEEL_ROOT resolves to a tree whose only
#    difference from the real one is an unimportable lead-model-launch.js.
# ---------------------------------------------------------------------------
MIRROR=$(mktemp -d "/tmp/fly1496-mirror.XXXXXX")
TMPDIRS+=("$MIRROR")
mkdir -p "$MIRROR/packages/teamlead/dist"
for entry in "$REPO_ROOT"/*; do
  base=$(basename "$entry")
  [ "$base" = packages ] || ln -s "$entry" "$MIRROR/$base"
done
for entry in "$REPO_ROOT"/packages/*; do
  base=$(basename "$entry")
  [ "$base" = teamlead ] || ln -s "$entry" "$MIRROR/packages/$base"
done
for entry in "$REPO_ROOT"/packages/teamlead/*; do
  base=$(basename "$entry")
  [ "$base" = dist ] || ln -s "$entry" "$MIRROR/packages/teamlead/$base"
done
for entry in "$DIST"/*; do
  base=$(basename "$entry")
  [ "$base" = lead-model-launch.js ] || ln -s "$entry" "$MIRROR/packages/teamlead/dist/$base"
done
echo 'throw new Error("QA: simulated unimportable resolver dist");' \
  > "$MIRROR/packages/teamlead/dist/lead-model-launch.js"

H=$(make_home)
write_projects "$H" "fable"
# A healthy generation writes the dependency-free authority receipt. The
# simulated mid-deploy generation below must use that exact last-good value
# after both model-resolution dist seams become unavailable.
NORMAL=$(run_dry "$H" "$LEAD_SH")
OUT=$(run_dry "$H" "$MIRROR/packages/teamlead/scripts/claude-lead.sh" \
  FLYWHEEL_LEAD_MODEL="claude-opus-4-8[1m]" FLYWHEEL_LEAD_EFFORT="max")
PLAN=$(printf '%s\n' "$OUT" | plan_of)
[ "$(arg_value "$PLAN" --model)" = "claude-fable-5-1" ] \
  && ok "broken resolver launches the last-good canonical Fable, never the frozen env" \
  || bad "broken resolver produced model '$(arg_value "$PLAN" --model)'"
[ -z "$(arg_value "$PLAN" --effort)" ] \
  && ok "broken resolver drops the stale frozen effort" \
  || bad "stale env effort survived resolver failure"
printf '%s\n' "$OUT" | grep -q "last-good model authority receipt" \
  && ok "resolver failure and receipt fallback are loud in the launcher log" \
  || bad "resolver failure was silent"

# 2. The fallback alert must be a kind lead-alert.sh accepts. A rejected kind
#    exits before queueing, so an absent record here means silent policy loss.
ALERT_FILE=$(find "$H/.flywheel/alert-queue" "$H/.flywheel/alert-deadletter" \
  -type f -name '*model_config*' 2>/dev/null | head -1)
if [ -n "$ALERT_FILE" ] \
  && [ "$(jq -r '.eventType' "$ALERT_FILE")" = "model_config" ] \
  && [ "$(jq -r '.severity' "$ALERT_FILE")" = "severe" ] \
  && jq -e '.body | test("last_good_receipt")' "$ALERT_FILE" >/dev/null; then
  ok "model_config alert is accepted and recorded with the fallback reason"
else
  bad "model_config alert was dropped or malformed"
fi

# ---------------------------------------------------------------------------
# 3. Resolution is FAITHFUL to the authoritative source: the case/whitespace
#    variants a hand-edited projects.json can carry all land on the one
#    canonical id, and never on some other model.
# ---------------------------------------------------------------------------
SPELLINGS=("claude-opus-4-8|claude-opus-4-8" "claude-opus-4-8[1m]|claude-opus-4-8[1m]" "CLAUDE-OPUS-4-8|claude-opus-4-8" "  claude-opus-4-8[1m]  |claude-opus-4-8[1m]" "opus|claude-opus-5" "fable|claude-fable-5-1")
SPELL_FAIL=0
for pair in "${SPELLINGS[@]}"; do
  spelling="${pair%%|*}"
  want="${pair##*|}"
  H=$(make_home)
  write_projects "$H" "$spelling"
  PLAN=$(run_dry "$H" "$LEAD_SH" | plan_of)
  got=$(arg_value "$PLAN" --model)
  if [ "$got" != "$want" ]; then
    SPELL_FAIL=1
    echo "       spelling '$spelling' produced '$got' (wanted '$want')"
  fi
done
[ "$SPELL_FAIL" -eq 0 ] \
  && ok "every spelling canonicalizes to exactly what config names" \
  || bad "a spelling did not resolve faithfully"

# ---------------------------------------------------------------------------
# 4. A binding edit is obeyed at the Lead seam, but a model with no dispatch
#    surface still cannot become a difficulty tier — the tier falls back to the
#    built-in rather than silently routing work somewhere it cannot run.
# ---------------------------------------------------------------------------
H=$(make_home)
write_projects "$H" "opus"
MODELS="$H/models.json"
printf '%s\n' '{"version":1,"bindings":{"opus":"claude-opus-4-8"},"tiers":{"medium":"opus"}}' > "$MODELS"
PLAN=$(run_dry "$H" "$LEAD_SH" FLYWHEEL_MODELS_CONFIG="$MODELS" | plan_of)
got=$(arg_value "$PLAN" --model)
[ "$got" = "claude-opus-4-8" ] \
  && ok "a re-pointed binding is obeyed verbatim at the Lead seam" \
  || bad "re-pointed binding produced '$got'"

PROBE=$(FLY_MODELS="$MODELS" FLY_ENTRY="$CONFIG_DIST" node --input-type=module -e '
  process.env.FLYWHEEL_MODELS_CONFIG = process.env.FLY_MODELS;
  const mod = await import(process.env.FLY_ENTRY);
  const snap = mod.getModelConfigSnapshot();
  process.stdout.write(JSON.stringify({
    dispatchOpus: snap.getDispatchCanonical("opus"),
    mediumTier: snap.tiers.medium.id,
    leadSelectable: snap.isModelSelectable({ surface: "lead", model: "claude-opus-4-8" }),
  }));
' 2>/dev/null)
if [ "$(jq -r '.dispatchOpus // "null"' <<<"$PROBE")" = "null" ] \
  && [ "$(jq -r '.mediumTier' <<<"$PROBE")" = "claude-opus-5" ] \
  && [ "$(jq -r '.leadSelectable' <<<"$PROBE")" = "false" ]; then
  ok "a non-dispatch model yields no alias, a built-in tier, and no picker entry"
else
  bad "non-dispatch model leaked into dispatch/tiers: $PROBE"
fi

# ---------------------------------------------------------------------------
# 5. A second physical launch in a HOME with an existing wrapper-shaped manifest
#    follows CURRENT projects.json without rewriting that control-plane artifact.
# ---------------------------------------------------------------------------
H=$(make_home)
write_projects "$H" "claude-opus-5" "high"
MANIFEST="$H/.flywheel/manifests/flywheel-eng-lead.json"
jq -n --arg root "$H/project" '{
  leadId:"eng-lead", projectName:"flywheel", projectDir:$root,
  workspace:$root, model:"applied-before-launch", effort:"medium",
  leadBackend:{backendId:"claude-code"}, pid:4242,
  socketPath:"/tmp/existing-v2.sock", unrelated:{keep:"byte-identical"}
}' > "$MANIFEST"
MANIFEST_BEFORE="$(shasum -a 256 "$MANIFEST" | awk '{print $1}')"
FIRST=$(run_dry "$H" "$LEAD_SH" | plan_of)
MANIFEST_AFTER_FIRST="$(shasum -a 256 "$MANIFEST" | awk '{print $1}')"
write_projects "$H" "fable"
SECOND=$(run_dry "$H" "$LEAD_SH" | plan_of)
MANIFEST_AFTER_SECOND="$(shasum -a 256 "$MANIFEST" | awk '{print $1}')"
[ "$(arg_value "$FIRST" --model)" = "claude-opus-5" ] \
  && [ "$(arg_value "$SECOND" --model)" = "claude-fable-5-1" ] \
  && ok "a relaunch follows the edited projects.json, not its own manifest" \
  || bad "relaunch carried the previous launch model forward"
[ -z "$(arg_value "$SECOND" --effort)" ] \
  && ok "a removed effort field does not survive in the manifest carrier" \
  || bad "stale effort survived the relaunch"
[ "$MANIFEST_AFTER_FIRST" = "$MANIFEST_BEFORE" ] \
  && [ "$MANIFEST_AFTER_SECOND" = "$MANIFEST_BEFORE" ] \
  && ok "both body launches leave the v2-owned manifest byte-identical" \
  || bad "body launch rewrote the v2-owned manifest"

# ---------------------------------------------------------------------------
# 6. Dispatch resolves aliases and keeps accepting the legacy identities an old
#    carrier may still pin (pre-existing back-compat), while an unknown spelling
#    stays unresolvable.
# ---------------------------------------------------------------------------
PROBE=$(FLY_ENTRY="$CONFIG_DIST" node --input-type=module -e '
  delete process.env.FLYWHEEL_MODELS_CONFIG;
  const mod = await import(process.env.FLY_ENTRY);
  const snap = mod.getModelConfigSnapshot();
  process.stdout.write(JSON.stringify({
    legacy48: snap.getDispatchCanonical("claude-opus-4-8[1m]"),
    unknown: snap.getDispatchCanonical("claude-not-a-model"),
    acceptedHasLegacy: snap.acceptedDispatchModels.some((m) => m.includes("4-8")),
    aliasOpus: snap.getDispatchCanonical("opus"),
  }));
' 2>/dev/null)
if [ "$(jq -r '.legacy48 // "null"' <<<"$PROBE")" = "claude-opus-4-8[1m]" ] \
  && [ "$(jq -r '.unknown // "null"' <<<"$PROBE")" = "null" ] \
  && [ "$(jq -r '.acceptedHasLegacy' <<<"$PROBE")" = "true" ] \
  && [ "$(jq -r '.aliasOpus' <<<"$PROBE")" = "claude-opus-5" ]; then
  ok "dispatch resolves aliases and keeps legacy pins working, unknown stays null"
else
  bad "dispatch canonicalization contract broken: $PROBE"
fi

echo ""
echo "FLY-1496 QA acceptance: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
