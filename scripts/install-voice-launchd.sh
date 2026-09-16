#!/usr/bin/env bash
# Explicit first-install lane only. The updater still owns normal restarts.
set -euo pipefail
VOICE_INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$VOICE_INSTALL_DIR/lib/converge-nonlead-daemons.sh"
source "$VOICE_INSTALL_DIR/lib/supervisor.sh"
source "$VOICE_INSTALL_DIR/flywheel-config-lock.sh"

launchctl() { "$VOICE_INSTALL_DIR/lib/bounded-run.sh" 5 launchctl "$@"; }

_voice_error() { echo "voice-install: $* (log: /tmp/flywheel-voice.log)" >&2; }
_voice_fingerprint() {
  python3 - "$1" <<'PY'
import hashlib,os,stat,sys
p=sys.argv[1]; s=os.lstat(p)
if not stat.S_ISREG(s.st_mode): sys.exit(1)
print(str(s.st_dev)+':'+str(s.st_ino)+':'+hashlib.sha256(open(p,'rb').read()).hexdigest())
PY
}
_voice_loaded_identity() {
  python3 -c '
import re,sys
s=sys.stdin.read(); path,wrapper,mode=sys.argv[1:]
def field(name):
 m=re.findall(r"^\s*"+re.escape(name)+r" = (.+?)\s*$",s,re.M)
 return m[0] if len(m)==1 else None
def top_field(name):
 m=re.findall(r"^\t"+re.escape(name)+r" = ([^\r\n]+)$",s,re.M)
 return m[0].strip() if len(m)==1 else None
args=re.search(r"^\s*arguments = \{\s*\n(.*?)^\s*\}",s,re.M|re.S)
valid=field("path")==path and field("program")=="/bin/bash" and args and [x.strip() for x in args[1].splitlines() if x.strip()]==["/bin/bash",wrapper]
if mode=="running": valid=valid and top_field("state")=="running" and re.fullmatch(r"[1-9][0-9]*",field("pid") or "")
sys.exit(0 if valid else 1)
' "$1" "$2" "$3"
}

voice_install() (
  mode="$1"
  [[ "$(uname -s)" == Darwin && "$(id -u)" == 501 ]] || { _voice_error 'requires Darwin user 501'; exit 1; }
  repo="$(cd "$VOICE_INSTALL_DIR/.." && pwd)"
  [[ "$repo" == "$HOME/Dev/flywheel" ]] || { _voice_error 'requires the production repository'; exit 1; }
  source_plist="$repo/scripts/launchd/com.flywheel.voice.plist"
  wrapper="$repo/scripts/flywheel-voice-wrapper.sh"
  target="$HOME/Library/LaunchAgents/com.flywheel.voice.plist"
  domain=gui/501
  label=com.flywheel.voice
  [[ -x "$wrapper" && -f "$wrapper" && ! -L "$wrapper" ]] || { _voice_error 'wrapper unavailable'; exit 1; }
  source_fingerprint="$(_voice_fingerprint "$source_plist")"
  _cnd_copy_plist_preflight "$source_plist" "$label" || { _voice_error 'source plist preflight failed'; exit 1; }
  [[ "$LAUNCHD_PROGRAM_TARGET" == "$wrapper" ]] || { _voice_error 'source wrapper mismatch'; exit 1; }
  python3 - "$source_plist" "$wrapper" <<'PY'
import plistlib,sys
p=plistlib.load(open(sys.argv[1],'rb'))
assert p.get('Label')=='com.flywheel.voice'
assert p.get('ProgramArguments')==['/bin/bash',sys.argv[2]]
assert 'Program' not in p and 'BundleProgram' not in p
assert p.get('RunAtLoad') is True and p.get('KeepAlive')=={'SuccessfulExit':False}
assert type(p.get('ThrottleInterval')) is int and p['ThrottleInterval']==30
assert not p.get('EnvironmentVariables')
PY
  source "$VOICE_INSTALL_DIR/lib/host-config.sh"
  host_config_load >/dev/null || { _voice_error 'host configuration invalid'; exit 1; }
  [[ "$FLYWHEEL_DIR" == "$repo" ]] || { _voice_error 'host repository mismatch'; exit 1; }
  state_dir="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"
  python3 - "$state_dir/.env" "$state_dir/voice-host.json" <<'PY'
import os,stat,sys
for p in sys.argv[1:]:
 s=os.lstat(p)
 assert stat.S_ISREG(s.st_mode) and s.st_mode&0o777==0o600 and s.st_uid==os.getuid()
PY
  set -a
  source "$state_dir/.env" >/dev/null 2>&1
  set +a
  [[ "${FLYWHEEL_DIR:-}" == "$repo" && "${FLYWHEEL_STATE_DIR:-}" == "$state_dir" ]] || { _voice_error 'environment path mismatch'; exit 1; }
  entry="$repo/packages/voice-codex/dist/cli.js"
  [[ -f "$entry" ]] || { _voice_error 'built voice entrypoint missing'; exit 1; }
  node "$entry" --check-config >/dev/null 2>&1 || { _voice_error 'voice local configuration rejected'; exit 1; }
  node --input-type=module - "$repo" "$state_dir" "$HOME" <<'JS'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [repo,state,home]=process.argv.slice(2);
try {
 const { loadVoiceHostConfig }=await import(pathToFileURL(`${repo}/packages/teamlead/dist/voice-host-config.js`).href);
 const projects=JSON.parse(readFileSync(`${state}/projects.json`,'utf8'));
 loadVoiceHostConfig({path:`${state}/voice-host.json`,projects,homeDir:home});
} catch { console.error('voice-install: voice-host configuration rejected'); process.exitCode=1; }
JS
  export FLYWHEEL_SUPERVISOR_BACKEND=launchd
  export FLYWHEEL_LAUNCHD_DIR="$HOME/Library/LaunchAgents"
  launchctl print "$domain" >/dev/null 2>&1 || { _voice_error 'user domain unavailable'; exit 1; }
  disabled="$(nonlead_daemon_disabled_labels "$domain")" || { _voice_error 'disabled overrides unreadable'; exit 1; }
  if printf '%s\n' "$disabled" | grep -Fxq "$label"; then _voice_error 'voice is explicitly disabled'; exit 1; fi
  [[ "$(nonlead_daemon_domain_state "$domain" com.flywheel.voice-bridge)" == missing ]] || { _voice_error 'legacy voice service present or unknown'; exit 1; }
  current="$(nonlead_daemon_domain_state "$domain" "$label")"
  [[ "$current" != error ]] || { _voice_error 'voice domain state unknown'; exit 1; }
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] && cmp -s "$source_plist" "$target" || { _voice_error 'installed plist conflict'; exit 1; }
  fi
  if [[ "$current" == loaded ]]; then
    launchctl print "$domain/$label" | _voice_loaded_identity "$target" "$wrapper" running || { _voice_error 'loaded voice identity or PID unverified'; exit 1; }
    supervisor_assert_keepalive voice on-failure || { _voice_error 'loaded keepalive mismatch'; exit 1; }
    echo 'voice-install: already running'; exit 0
  fi
  [[ "$mode" != --check ]] || { echo 'voice-install: preflight ready; not installed or started'; exit 0; }
  created=false
  bootstrapped=false
  fingerprint=""
  cleanup() {
    rc=$?
    if [[ "$rc" -ne 0 ]]; then
      live="$(nonlead_daemon_domain_state "$domain" "$label")"
      if [[ "$bootstrapped" == true && "$live" == loaded ]]; then
        if [[ "$(_voice_fingerprint "$target" 2>/dev/null || true)" == "$fingerprint" ]] && launchctl print "$domain/$label" | _voice_loaded_identity "$target" "$wrapper" identity; then
          launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
          live="$(nonlead_daemon_domain_state "$domain" "$label")"
        fi
      fi
      if [[ "$created" == true && "$live" == missing && "$(_voice_fingerprint "$target" 2>/dev/null || true)" == "$fingerprint" ]]; then rm -f "$target"; fi
      _voice_error 'installation failed; conditional rollback finished'
    fi
    exit "$rc"
  }
  trap cleanup EXIT
  [[ "$(_voice_fingerprint "$source_plist")" == "$source_fingerprint" ]] || { _voice_error 'source changed during preflight'; exit 1; }
  if [[ ! -e "$target" && ! -L "$target" ]]; then
    _cnd_install_plist "$source_plist" "$target" "$label" || { _voice_error 'atomic publication failed'; exit 1; }
    created=true
  fi
  [[ "$(_voice_fingerprint "$source_plist")" == "$source_fingerprint" ]] && cmp -s "$source_plist" "$target" || { _voice_error 'publication changed during install'; exit 1; }
  fingerprint="$(_voice_fingerprint "$target")"
  launchctl bootstrap "$domain" "$target" || { _voice_error 'bootstrap failed'; exit 1; }
  bootstrapped=true
  supervisor_assert_keepalive voice on-failure || { _voice_error 'installed keepalive mismatch'; exit 1; }
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if launchctl print "$domain/$label" | _voice_loaded_identity "$target" "$wrapper" running; then
      [[ "$(_voice_fingerprint "$target")" == "$fingerprint" ]] || exit 1
      echo 'voice-install: running'; exit 0
    fi
    sleep 1
  done
  _voice_error 'wrapper refused or running PID was not observed'; exit 1
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  [[ $# -eq 0 || ( $# -eq 1 && "$1" == --check ) ]] || { _voice_error 'usage: install-voice-launchd.sh [--check]'; exit 2; }
  if [[ "${1:-}" == --check ]]; then voice_install --check; else
    [[ "$(uname -s)" == Darwin && "$(id -u)" == 501 ]] || exit 1
    voice_install --check
    mkdir -p "$HOME/Library/LaunchAgents"
    [[ ! -L "$HOME/Library/LaunchAgents/.voice-install.lock" ]] || exit 1
    unset FLYWHEEL_CONFIG_LOCK_PY
    config_write_locked "$HOME/Library/LaunchAgents/.voice-install.lock" 10 \
      bash -c 'source "$1"; voice_install install' _ "$VOICE_INSTALL_DIR/install-voice-launchd.sh"
  fi
fi
