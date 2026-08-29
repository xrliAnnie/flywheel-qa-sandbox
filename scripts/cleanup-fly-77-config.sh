#!/usr/bin/env bash
# FLY-77: Remove Discord control channel dead config from operator state.
#
# Idempotent — safe to re-run. Backs up files before mutating.
# Run order: BEFORE first restart-services after FLY-77 PR merges
#   (or before test-deploy in QA validation flow on the worktree).
set -euo pipefail

FLYWHEEL_HOME="${FLYWHEEL_HOME:-$HOME/.flywheel}"
CHANNELS_DIR="${CHANNELS_DIR:-$HOME/.claude/channels}"
TS=$(date +%Y%m%d-%H%M%S)

# Preflight: jq is required for access.json mutation.
if ! command -v jq >/dev/null 2>&1; then
  echo "[cleanup] ERROR: jq is required but not installed. Install via 'brew install jq' and re-run." >&2
  exit 1
fi

# 1. ~/.flywheel/.env: drop CLAUDEBOT_TOKEN line.
#    NOTE: grep -v exits 1 when zero lines are emitted (e.g. if .env contains only the matched line),
#    which would abort under `set -e`. Use `awk` (always exit 0) and a temp file via `mktemp`.
ENV_FILE="$FLYWHEEL_HOME/.env"
if [[ -f "$ENV_FILE" ]] && grep -q '^CLAUDEBOT_TOKEN=' "$ENV_FILE"; then
  cp "$ENV_FILE" "$ENV_FILE.bak-$TS"
  tmp_env=$(mktemp)
  awk '!/^CLAUDEBOT_TOKEN=/' "$ENV_FILE" > "$tmp_env"
  mv "$tmp_env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "[cleanup] removed CLAUDEBOT_TOKEN from $ENV_FILE (backup: $ENV_FILE.bak-$TS)"
fi

# 2. Drop projects.json backup files (legacy with controlChannel).
for bak in "$FLYWHEEL_HOME/projects.json.bak" "$FLYWHEEL_HOME/projects.json.bak2"; do
  if [[ -f "$bak" ]]; then
    rm "$bak"
    echo "[cleanup] removed legacy backup $bak"
  fi
done

# 3. Each Lead's access.json: drop control channel from groups + ClaudeBot from allowBots.
declare -a LEAD_CONTROL_PAIRS=(
  "discord-product-lead:1486419006540742769"
  "discord-ops-lead:1486419059267342459"
  "discord-cos-lead:1487340752995487865"
)
CLAUDEBOT_USER_ID="1484685699004497940"

for pair in "${LEAD_CONTROL_PAIRS[@]}"; do
  lead="${pair%%:*}"
  ctrl="${pair##*:}"
  acc="$CHANNELS_DIR/$lead/access.json"
  [[ -f "$acc" ]] || { echo "[cleanup] skip (missing): $acc"; continue; }
  tmp_acc=$(mktemp)
  jq --arg ctrl "$ctrl" --arg bot "$CLAUDEBOT_USER_ID" '
    .groups    = ((.groups // {}) | with_entries(select(.key != $ctrl)))
    | .allowBots = ((.allowBots // []) | map(select(. != $bot)))
  ' "$acc" > "$tmp_acc"

  # Skip backup + rewrite if jq output is byte-identical to source (already clean).
  # This makes the script truly no-op on a second run and protects the original
  # backup from being overwritten by a clean copy.
  if cmp -s "$acc" "$tmp_acc"; then
    rm -f "$tmp_acc"
    echo "[cleanup] $acc: already clean, no changes"
    continue
  fi

  # Collision-proof backup name (TS is second-grain; PID + counter avoid clobber on rapid re-run).
  bak="$acc.bak-$TS-$$"
  i=0
  while [[ -e "$bak" ]]; do
    i=$((i + 1))
    bak="$acc.bak-$TS-$$-$i"
  done
  cp "$acc" "$bak"
  mv "$tmp_acc" "$acc"
  chmod 600 "$acc"
  echo "[cleanup] $acc: removed group $ctrl + allowBots $CLAUDEBOT_USER_ID (backup: $bak)"
done

# 4. Verify acceptance — control channel key + ClaudeBot removed; remaining groups printed for manual review.
echo ""
echo "[verify] post-cleanup access.json state:"
for pair in "${LEAD_CONTROL_PAIRS[@]}"; do
  lead="${pair%%:*}"
  ctrl="${pair##*:}"
  acc="$CHANNELS_DIR/$lead/access.json"
  [[ -f "$acc" ]] || continue
  has_ctrl=$(jq --arg ctrl "$ctrl" '.groups | has($ctrl)' "$acc")
  remaining_groups=$(jq -r '.groups | keys | join(",")' "$acc")
  has_bot=$(jq --arg bot "$CLAUDEBOT_USER_ID" '(.allowBots // []) | any(. == $bot)' "$acc")
  echo "[verify] $lead: control_present=$has_ctrl claudebot_present=$has_bot remaining_groups=[$remaining_groups]"
  if [[ "$has_ctrl" != "false" || "$has_bot" != "false" ]]; then
    echo "[verify] FAIL: $acc still references control or ClaudeBot — investigate." >&2
    exit 2
  fi
done
echo "[verify] If a remaining_groups list looks wrong (chat/forum/core room channel missing), restore from the most recent .bak-* file printed above."

echo "[cleanup] done. Restart Bridge + Leads to apply: bash scripts/restart-services.sh"
