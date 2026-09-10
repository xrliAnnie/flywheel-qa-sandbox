#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK_TMP="$(mktemp -d)"
trap 'rm -rf "$TASK_TMP"' EXIT
export UPDATE_FLYWHEEL_SOURCED=1 ENV_FILE=/dev/null
export FLYWHEEL_HOME="$TASK_TMP/state" FLYWHEEL_DIR="$TASK_TMP/repo"
mkdir -p "$FLYWHEEL_HOME/comm/flywheel" "$FLYWHEEL_DIR"
source "$ROOT/scripts/update-flywheel.sh"
if ! declare -F updater_auto_narrow_rollback_precheck >/dev/null; then
  echo 'FAIL: updater lacks auto narrow rollback precheck' >&2
  exit 1
fi
git -C "$FLYWHEEL_DIR" init -q
git -C "$FLYWHEEL_DIR" config user.name fixture
git -C "$FLYWHEEL_DIR" config user.email fixture@example.test
mkdir -p "$FLYWHEEL_DIR/packages/teamlead/src"
printf '// old projector\n' > "$FLYWHEEL_DIR/packages/teamlead/src/StateStore.ts"
git -C "$FLYWHEEL_DIR" add .
git -C "$FLYWHEEL_DIR" commit -qm old
OLD_SHA="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$OLD_SHA"
python3 - "$FLYWHEEL_HOME" <<'FIXTURE'
import sqlite3, sys
from pathlib import Path
root = Path(sys.argv[1])
with sqlite3.connect(root / 'comm/flywheel/comm.db') as c:
 c.executescript("CREATE TABLE workflow_source_event (project TEXT, source_event_id TEXT, kind TEXT, payload TEXT); INSERT INTO workflow_source_event VALUES ('flywheel','auto-narrow:q','founder_approval','{\"decision_source\":\"auto_narrow_gate\"}');")
with sqlite3.connect(root / 'teamlead.db') as c:
 c.execute('CREATE TABLE workflow_source_receipt (project TEXT, source_event_id TEXT)')
FIXTURE
# Exercise the production deploy call site, with only external side effects stubbed.
updater_fetch_origin() { return 0; }
discord_pointer_cutover_required() { return 1; }
updater_host_tmux_gate() { return 0; }
updater_merge_remote() { echo merge >> "$TASK_TMP/effects"; }
updater_restart_services() { echo restart >> "$TASK_TMP/effects"; }
if default_deploy > "$TASK_TMP/denied.log" 2>&1; then
  echo 'FAIL: old projector accepted unprojected auto source' >&2; exit 1
fi
[[ ! -e "$TASK_TMP/effects" ]]
grep -q 'unprojected_auto_narrow_source' "$TASK_TMP/denied.log"
python3 - "$FLYWHEEL_HOME/teamlead.db" <<'PROJECT'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as c:
 c.execute("INSERT INTO workflow_source_receipt VALUES ('other','auto-narrow:q')")
PROJECT
if updater_auto_narrow_rollback_precheck > /dev/null 2>&1; then
 echo 'FAIL: another project receipt bypassed rollback guard' >&2; exit 1
fi
python3 - "$FLYWHEEL_HOME/teamlead.db" <<'PROJECT'
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as c:
 c.execute("INSERT INTO workflow_source_receipt VALUES ('flywheel','auto-narrow:q')")
PROJECT
default_deploy > "$TASK_TMP/allowed.log" 2>&1
[[ "$(cat "$TASK_TMP/effects")" == $'merge\nrestart' ]]
echo 'PASS: unprojected blocks before merge/restart; exact project receipt permits rollback'
