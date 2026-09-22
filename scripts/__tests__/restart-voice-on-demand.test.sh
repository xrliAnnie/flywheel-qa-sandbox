#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

FIXTURE_REPO="$ROOT/repo"
FIXTURE_HOME="$ROOT/home"
SOURCE="$FIXTURE_REPO/scripts/launchd/com.flywheel.voice.plist"
INSTALLED="$FIXTURE_HOME/Library/LaunchAgents/com.flywheel.voice.plist"
WRAPPER="$FIXTURE_REPO/scripts/flywheel-voice-wrapper.sh"
mkdir -p "$(dirname "$SOURCE")" "$(dirname "$INSTALLED")"
cp "$REPO_ROOT/scripts/flywheel-voice-wrapper.sh" "$WRAPPER"
chmod +x "$WRAPPER"
sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
  "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
cp "$SOURCE" "$INSTALLED"

# restart_voice_managed derives its own domain from the running uid, so the stub
# must too: hardcoding 501 passes locally and fails on any other runner.
UID_NOW="$(id -u)"
DOMAIN="gui/${UID_NOW}"
LAUNCHCTL_MODE=valid
launchctl() {
  printf '%s\n' "$*" >> "$ROOT/launchctl-calls"
  # bootout/bootstrap are the migration seam; they succeed like the real tool.
  [[ "$1" == bootout || "$1" == bootstrap ]] && return 0
  [[ "$1" == print && "$2" == "${DOMAIN}/com.flywheel.voice" ]] || return 90
  [[ "$LAUNCHCTL_MODE" == valid ]] || return 113
  printf '%s\n' \
    "${DOMAIN}/com.flywheel.voice = {" \
    $'\tpath = '"$INSTALLED" \
    $'\tprogram = /bin/bash' \
    $'\targuments = {' \
    $'\t\t/bin/bash' \
    $'\t\t'"$WRAPPER" \
    $'\t}' \
    $'\tstate = not running' \
    $'\tlast exit code = 0' \
    '}'
}

# shellcheck source=../lib/voice-on-demand.sh
source "$REPO_ROOT/scripts/lib/voice-on-demand.sh"

voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"
[[ "$(cat "$ROOT/launchctl-calls")" == "print ${DOMAIN}/com.flywheel.voice" ]]

printf '\n<!-- drift -->\n' >> "$INSTALLED"
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: installed byte drift was accepted" >&2
  exit 1
fi
cp "$SOURCE" "$INSTALLED"

python3 - "$SOURCE" "$INSTALLED" <<'PY'
import plistlib,sys
for path in sys.argv[1:]:
    p=plistlib.load(open(path,'rb'))
    p['RunAtLoad']=True
    p['KeepAlive']={'SuccessfulExit':False}
    p['ThrottleInterval']=30
    plistlib.dump(p,open(path,'wb'))
PY
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: resident launchd bytes were accepted as on-demand" >&2
  exit 1
fi

sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
  "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
cp "$SOURCE" "$INSTALLED"
LAUNCHCTL_MODE=missing
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" "$DOMAIN"; then
  echo "FAIL: an unregistered unit was accepted" >&2
  exit 1
fi

# ── FLY-2701 review R3 HIGH: the deploy must migrate the host's legacy resident
# plist, not fail closed on it. Today's host still runs the resident contract,
# so a managed restart that only refuses would roll back every deploy of this
# head and the on-demand lifecycle would never take effect.
LAUNCHCTL_MODE=valid
MIGRATION_STATE_DIR="$ROOT/state"
mkdir -p "$MIGRATION_STATE_DIR"
seed_sessions() {
  python3 - "$MIGRATION_STATE_DIR/teamlead.db" "$1" <<'SEED_PY'
import sqlite3,sys
con=sqlite3.connect(sys.argv[1])
con.execute("DROP TABLE IF EXISTS voice_sessions")
con.execute("CREATE TABLE voice_sessions (session_id TEXT PRIMARY KEY, state TEXT NOT NULL)")
if sys.argv[2] != "none":
    con.execute("INSERT INTO voice_sessions VALUES ('s1', ?)", (sys.argv[2],))
con.commit()
SEED_PY
}
install_resident_bytes() {
  sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
    "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
  cp "$SOURCE" "$INSTALLED"
  python3 - "$INSTALLED" <<'RESIDENT_PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
p['RunAtLoad']=True
p['KeepAlive']={'SuccessfulExit':False}
p['ThrottleInterval']=30
plistlib.dump(p,open(sys.argv[1],'wb'))
RESIDENT_PY
}

supervisor_is_loaded() { return 0; }
log() { :; }
export FLYWHEEL_DIR="$FIXTURE_REPO"
export FLYWHEEL_STATE_DIR="$MIGRATION_STATE_DIR"
HOME="$FIXTURE_HOME"
# shellcheck source=../lib/restart-voice.sh
source "$REPO_ROOT/scripts/lib/restart-voice.sh"

# A live call must never be interrupted by a migration: defer, do not fail.
install_resident_bytes
seed_sessions live
: > "$ROOT/launchctl-calls"
if ! restart_voice_managed; then
  echo "FAIL: an active call must defer the migration, not fail the deploy" >&2
  exit 1
fi
[[ "$VOICE_RESTART_STATE" == "deferred" ]] || {
  echo "FAIL: expected deferred, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: deferred migration must not bootout a unit serving a call" >&2
  exit 1
fi

# Unknown session state is not proof that nobody is talking.
install_resident_bytes
rm -f "$MIGRATION_STATE_DIR/teamlead.db"
: > "$ROOT/launchctl-calls"
restart_voice_managed
[[ "$VOICE_RESTART_STATE" == "deferred" ]] || {
  echo "FAIL: unreadable session state must defer, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: unproven quiet host must not be booted out" >&2
  exit 1
fi

# No call in progress: migrate the resident unit to the on-demand contract.
install_resident_bytes
seed_sessions none
: > "$ROOT/launchctl-calls"
if ! restart_voice_managed; then
  echo "FAIL: a quiet host must migrate, got $VOICE_RESTART_DETAIL" >&2
  exit 1
fi
[[ "$VOICE_RESTART_STATE" == "migrated" ]] || {
  echo "FAIL: expected migrated, got $VOICE_RESTART_STATE" >&2; exit 1; }
grep -q "bootout ${DOMAIN}/com.flywheel.voice" "$ROOT/launchctl-calls" || {
  echo "FAIL: the resident daemon was never stopped" >&2; exit 1; }
grep -q "bootstrap ${DOMAIN} $INSTALLED" "$ROOT/launchctl-calls" || {
  echo "FAIL: the on-demand unit was never registered" >&2; exit 1; }
cmp -s "$SOURCE" "$INSTALLED" || {
  echo "FAIL: installed bytes are not the on-demand contract" >&2; exit 1; }

# Already on-demand: no bootout, no reinstall, stays dormant.
: > "$ROOT/launchctl-calls"
restart_voice_managed
[[ "$VOICE_RESTART_STATE" == "registered" ]] || {
  echo "FAIL: expected registered, got $VOICE_RESTART_STATE" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: a current on-demand registration must not be restarted" >&2
  exit 1
fi

# Unknown drift is neither the legacy contract nor current: keep failing closed.
printf '\n<!-- unknown drift -->\n' >> "$INSTALLED"
seed_sessions none
: > "$ROOT/launchctl-calls"
if restart_voice_managed; then
  echo "FAIL: unknown installed drift must still refuse" >&2
  exit 1
fi
[[ "$VOICE_RESTART_DETAIL" == "on_demand_contract_mismatch" ]] || {
  echo "FAIL: expected contract mismatch, got $VOICE_RESTART_DETAIL" >&2; exit 1; }
if grep -q bootout "$ROOT/launchctl-calls"; then
  echo "FAIL: unknown drift must not be booted out blindly" >&2
  exit 1
fi

echo "restart-voice-on-demand: PASS"
