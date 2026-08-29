#!/usr/bin/env bash
# FLY-886 activation step 3 — transform Asha's Lead manifest for the fold.
#
# PREP-ONLY: dry-run by default (prints the new manifest, writes nothing).
# Pass --activate to actually write, and ONLY inside the founder-present window
# AFTER apply/fold-projects.sh has run (plan §4). Never run tonight.
#
# WHY a targeted jq transform (NOT materialize-lead-manifests.sh): the materialize
# helper writes `.workspace` = project dir, which the wrapper exports as
# LEAD_WORKSPACE — that would drop Asha into ~/Dev/tidal-echo instead of her
# isolated lead-workspace. We instead carry EVERY field forward from the old
# manifest and change ONLY projectName/projectDir, dropping runtime-only pid.
#
# NOTE projectDir = ~/Dev/tidal-echo (repo ROOT), not ~/Dev/tidal-echo/sub:
# claude-lead.sh reads ${PROJECT_DIR}/.lead/<id>/identity.md and Blueprint reads
# ${PROJECT_DIR}/.flywheel/config.yaml — both must resolve to the ROOT copies the
# tidal-echo PR adds (root .lead/sub-lead/ + root .flywheel/agents/content/). A
# projectDir of .../sub would read the stale sub/.flywheel snapshot config.
set -euo pipefail

OLD="$HOME/.flywheel/manifests/sub-sub-lead.json"
OUT="$HOME/.flywheel/manifests/tidal-echo-sub-lead.json"
ACTIVATE="${1:-}"

[ -f "$OLD" ] || { echo "refusing: old manifest $OLD not found" >&2; exit 1; }

tmp="${OUT}.tmp.$$"
trap 'rm -f "$tmp"' EXIT
# same-dir tmp + mv so an interrupted/failed run never leaves a half-written
# manifest that `flywheel-daemon install --all` would later trip over.
jq '.projectName="tidal-echo" | .projectDir=(env.HOME+"/Dev/tidal-echo") | del(.pid)' "$OLD" > "$tmp"
jq empty "$tmp"
jq -e '.workspace == env.HOME+"/.flywheel/lead-workspace/sub-lead"
       and .leadId=="sub-lead"
       and .projectName=="tidal-echo"
       and .projectDir==(env.HOME+"/Dev/tidal-echo")
       and .botTokenEnv=="ASHA_BOT_TOKEN"
       and .model=="claude-opus-4-8[1m]"
       and .leadBackend.backendId=="claude-code"
       and (has("pid")|not)' "$tmp" >/dev/null

if [ "$ACTIVATE" != "--activate" ]; then
  echo "== DRY-RUN (no write). New manifest would be: =="
  cat "$tmp"
  echo "== pass --activate inside the founder window to write $OUT =="
  exit 0
fi

mv "$tmp" "$OUT"
echo "wrote $OUT"
