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

LAUNCHCTL_MODE=valid
launchctl() {
  printf '%s\n' "$*" >> "$ROOT/launchctl-calls"
  [[ "$1" == print && "$2" == gui/501/com.flywheel.voice ]] || return 90
  [[ "$LAUNCHCTL_MODE" == valid ]] || return 113
  printf '%s\n' \
    'gui/501/com.flywheel.voice = {' \
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

voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" gui/501
[[ "$(cat "$ROOT/launchctl-calls")" == 'print gui/501/com.flywheel.voice' ]]

printf '\n<!-- drift -->\n' >> "$INSTALLED"
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" gui/501; then
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
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" gui/501; then
  echo "FAIL: resident launchd bytes were accepted as on-demand" >&2
  exit 1
fi

sed "s#/Users/xiaorongli/Dev/flywheel#${FIXTURE_REPO}#g" \
  "$REPO_ROOT/scripts/launchd/com.flywheel.voice.plist" > "$SOURCE"
cp "$SOURCE" "$INSTALLED"
LAUNCHCTL_MODE=missing
if voice_on_demand_contract_check "$FIXTURE_REPO" "$FIXTURE_HOME" gui/501; then
  echo "FAIL: an unregistered unit was accepted" >&2
  exit 1
fi

echo "restart-voice-on-demand: PASS"
