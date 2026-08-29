#!/usr/bin/env bash
# FLY-886 / FLY-876 handoff — re-point the 6 launchd plists from ~/Dev/sub to
# ~/Dev/tidal-echo/sub (the merged tree).
#
# OWNERSHIP: FLY-876 owns the cron/plist re-point + ~/Dev/sub disposal (plan §5,
# §9). This script is prepped in the FLY-886 activation bundle for a turnkey
# founder-morning run; FLY-876 confirms + verifies the nightly actually produces.
#
# PREP-ONLY: dry-run by default. Pass --activate to edit + reload, ONLY inside the
# founder window AFTER the tidal-echo PR is merged + `git pull` (so the tick
# scripts exist at ~/Dev/tidal-echo/sub/content/scripts/). Reloads each job.
#
# Precondition: ~/Dev/sub must NOT be disposed/archived until all 6 are re-pointed
# AND the next nightly has produced (plan §5#5).
set -euo pipefail

OLD_BASE="/Users/xiaorongli/Dev/sub/content/scripts"
NEW_BASE="/Users/xiaorongli/Dev/tidal-echo/sub/content/scripts"
LA="$HOME/Library/LaunchAgents"
ACTIVATE="${1:-}"
TS=$(date +%Y%m%d-%H%M%S)
UID_NUM=$(id -u)

PLISTS=(
  com.flywheel.sub-create-nightly
  com.flywheel.sub-daily-loop
  com.flywheel.growth-improve
  com.flywheel.growth-learn
  com.flywheel.growth-report
  com.flywheel.growth-retro
)

echo "== FLY-886/876 plist re-point (${ACTIVATE:-dry-run}) =="
[ -d "$NEW_BASE" ] || echo "WARN: $NEW_BASE not present yet — merge tidal-echo PR + git pull before --activate"

for name in "${PLISTS[@]}"; do
  pl="$LA/$name.plist"
  [ -f "$pl" ] || { echo "SKIP  $name (plist not found)"; continue; }
  if ! grep -q "$OLD_BASE" "$pl"; then
    echo "NOOP  $name (no $OLD_BASE reference — already re-pointed?)"
    continue
  fi
  echo "EDIT  $name : $OLD_BASE -> $NEW_BASE"
  if [ "$ACTIVATE" = "--activate" ]; then
    cp "$pl" "$pl.bak-fly886-$TS"
    # anchored to the scripts base path so only ProgramArguments paths change
    sed -i '' "s#$OLD_BASE#$NEW_BASE#g" "$pl"
    launchctl bootout "gui/$UID_NUM/$name" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$pl"
    echo "      reloaded $name (backup: $pl.bak-fly886-$TS)"
  else
    echo "      (dry-run) sed + launchctl bootout/bootstrap $name"
  fi
done

echo "== verify (post-activate): grep -l '$OLD_BASE' $LA/com.flywheel.{sub,growth}-*.plist should be EMPTY =="
[ "$ACTIVATE" = "--activate" ] || echo "== pass --activate inside the founder window (after merge+pull) to execute =="
