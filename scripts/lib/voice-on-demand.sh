#!/bin/bash

voice_on_demand_loaded_identity() {
  local target="$1" wrapper="$2"
  python3 -c '
import re,sys
s=sys.stdin.read(); target,wrapper=sys.argv[1:]
def field(name):
 m=re.findall(r"^\s*"+re.escape(name)+r" = (.+?)\s*$",s,re.M)
 return m[0] if len(m)==1 else None
args=re.search(r"^\s*arguments = \{\s*\n(.*?)^\s*\}",s,re.M|re.S)
valid=(field("path")==target and field("program")=="/bin/bash" and args and
 [x.strip() for x in args[1].splitlines() if x.strip()]==["/bin/bash",wrapper])
sys.exit(0 if valid else 1)
' "$target" "$wrapper"
}

# Prove the complete installed on-demand contract. A registered job may be
# dormant; PID/state are deliberately not part of this identity check.
voice_on_demand_contract_check() {
  local repo="${1:-${FLYWHEEL_DIR:-${HOME}/Dev/flywheel}}"
  local home_dir="${2:-${HOME}}"
  local domain="${3:-gui/$(id -u)}"
  local source_plist="${repo}/scripts/launchd/com.flywheel.voice.plist"
  local installed_plist="${home_dir}/Library/LaunchAgents/com.flywheel.voice.plist"
  local wrapper="${repo}/scripts/flywheel-voice-wrapper.sh"
  local loaded

  [[ -f "$source_plist" && ! -L "$source_plist" ]] || return 1
  [[ -f "$installed_plist" && ! -L "$installed_plist" ]] || return 1
  [[ -f "$wrapper" && ! -L "$wrapper" && -x "$wrapper" ]] || return 1
  cmp -s "$source_plist" "$installed_plist" || return 1
  python3 - "$source_plist" "$installed_plist" "$wrapper" 2>/dev/null <<'PY' || return 1
import os,plistlib,stat,sys
plist_path,installed_path,wrapper=sys.argv[1:]
for path in (plist_path,installed_path,wrapper):
    info=os.lstat(path)
    assert stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid()
p=plistlib.load(open(plist_path,'rb'))
assert p.get('Label')=='com.flywheel.voice'
assert p.get('ProgramArguments')==['/bin/bash',wrapper]
assert 'Program' not in p and 'BundleProgram' not in p
assert p.get('RunAtLoad') is False and p.get('KeepAlive') is False
assert type(p.get('ThrottleInterval')) is int and p['ThrottleInterval']==1
assert not p.get('EnvironmentVariables')
PY
  loaded="$(launchctl print "${domain}/com.flywheel.voice" 2>/dev/null)" || return 1
  printf '%s\n' "$loaded" | voice_on_demand_loaded_identity "$installed_plist" "$wrapper"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  voice_on_demand_contract_check "$@"
fi
