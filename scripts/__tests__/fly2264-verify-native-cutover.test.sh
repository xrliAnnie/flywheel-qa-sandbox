#!/usr/bin/env bash
# FLY-2274: native cutover verifier helpers and artifact contract.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh"
TMP="$(mktemp -d -t fly2264-verify.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '  ✓ %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$1"; }
test_file_mode() {
  local value=""
  if value="$(stat -c %a "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-7]{3,4}$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  value="$(stat -f %Lp "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-7]{3,4}$ ]] || return 1
  printf '%s\n' "$value"
}

cat >"$TMP/bin/ps" <<'STUB'
#!/usr/bin/env bash
set -u
pid="${*: -1}"
file="${FLY2264_VERIFY_TEST_STATE:?}/$pid"
[[ -f "$file" ]] || exit 1
# shellcheck disable=SC1090
source "$file"
case "$*" in
  *'lstart='*) printf '%s\n' "$START" ;;
  *'pid=,flags='*) printf '%s %s\n' "$pid" "$FLAGS" ;;
  *) exit 64 ;;
esac
STUB
cat >"$TMP/bin/lsof" <<'STUB'
#!/usr/bin/env bash
set -u
pid=""
while [[ $# -gt 0 ]]; do
  [[ "$1" == -p ]] && { pid="${2:-}"; shift 2; continue; }
  shift
done
file="${FLY2264_VERIFY_TEST_STATE:?}/$pid"
[[ -f "$file" ]] || exit 1
# shellcheck disable=SC1090
source "$file"
printf 'p%s\n' "$pid"
printf 'n%s\n' "$MAIN"
[[ "${EXTRA_MAIN:-0}" != 1 ]] || printf 'n%s\n' "${SECOND_MAIN:?}"
printf 'n%s.aot\n' "$MAIN"
printf 'n/usr/libexec/rosetta/runtime\n'
printf 'n/Library/Apple/usr/libexec/oah/libRosettaRuntime\n'
printf 'n/usr/lib/libSystem.B.dylib\n'
printf 'n/usr/lib/dyld\n'
printf 'n/private/var/db/dyld/dyld_shared_cache_arm64e\n'
STUB
cat >"$TMP/bin/file" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  *x86-only*) printf 'Mach-O 64-bit executable x86_64\n' ;;
  *'/usr/lib/dyld'*) printf 'Mach-O 64-bit dynamically linked shared library arm64e\n' ;;
  *dyld_shared_cache*) printf 'data\n' ;;
  *) printf 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64e:Mach-O 64-bit executable arm64e]\n' ;;
esac
STUB
chmod +x "$TMP/bin/ps" "$TMP/bin/lsof" "$TMP/bin/file"
export PATH="$TMP/bin:$PATH"
export FLY2264_VERIFY_TEST_STATE="$TMP/state"

echo "Test: verifier is source-only safe and declares seven exact artifacts"
# shellcheck disable=SC1090
if [ -f "$SCRIPT" ] && source "$SCRIPT" \
    && [ "$(fly2264_artifact_names | tr '\n' ' ')" = '01-updater.json 02-lead-census.json 03-native-tmux.json 04-tmux-servers.json 05-lead-health.json 06-cmux.json 07-path.json ' ]; then
  pass "verifier exposes the seven reviewed artifact names"
else
  fail "verifier missing, unsafe to source, or artifact set drifted"
fi

echo "Test: heartbeat age prefers numeric GNU stat before BSD fallback"
mkdir -p "$TMP/gnu-stat-bin"
cat >"$TMP/gnu-stat-bin/stat" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  '-c %Y')
    [ ! -e "${FLY2264_VERIFY_TEST_STATE:?}/bsd-stat-called" ] || exit 1
    printf '1\n'
    ;;
  '-c %a') printf '600\n' ;;
  '-f %m')
    : >"${FLY2264_VERIFY_TEST_STATE:?}/bsd-stat-called"
    printf 'File: fixture\nType: tmpfs\n'
    ;;
  '-f %Lp')
    : >"${FLY2264_VERIFY_TEST_STATE:?}/bsd-stat-called"
    printf 'File: fixture\nType: tmpfs\n'
    ;;
  *) exit 64 ;;
esac
STUB
chmod +x "$TMP/gnu-stat-bin/stat"
touch "$TMP/heartbeat"
if heartbeat_age="$(PATH="$TMP/gnu-stat-bin:$PATH" fly2264_file_age_seconds "$TMP/heartbeat")" \
    && [[ "$heartbeat_age" =~ ^[0-9]+$ ]] \
    && [ "$(PATH="$TMP/gnu-stat-bin:$PATH" test_file_mode "$TMP/heartbeat")" = 600 ] \
    && [ ! -e "$TMP/state/bsd-stat-called" ]; then
  pass "numeric GNU stat is accepted before BSD mtime and mode probes"
else
  fail "mtime or mode did not prefer the numeric GNU stat probe"
fi

write_state() {
  local pid="$1" flags="$2" main="$3" extra="${4:-0}" second="${5:-}"
  printf 'START=%q\nFLAGS=%q\nMAIN=%q\nEXTRA_MAIN=%q\nSECOND_MAIN=%q\n' \
    'Mon Sep  2 15:00:00 2026   ' "$flags" "$main" "$extra" "$second" >"$TMP/state/$pid"
}

echo "Test: P_TRANSLATED is execution authority and universal arm64 capability passes"
write_state 101 4004 "$TMP/native-universal"
touch "$TMP/native-universal"
if declare -F fly2264_verify_process_native >/dev/null \
    && native_json="$(fly2264_verify_process_native 101)" \
    && printf '%s' "$native_json" | jq -e \
      '.pid == 101 and .translated == false and .arm64Capable == true
       and .startIdentity == "Mon Sep  2 15:00:00 2026"' >/dev/null; then
  pass "native P_TRANSLATED=0 plus universal arm64 slice passes"
else
  fail "native universal process did not pass"
fi

echo "Test: translated, x86-only, and ambiguous main images each turn red"
write_state 102 34004 "$TMP/native-universal"
write_state 103 4004 "$TMP/x86-only"
touch "$TMP/x86-only"
write_state 104 4004 "$TMP/native-universal" 1 "$TMP/second-main"
touch "$TMP/second-main"
if fly2264_verify_process_native 102 >/dev/null 2>&1; then
  fail "translated process passed"
elif fly2264_verify_process_native 103 >/dev/null 2>&1; then
  fail "x86-only process passed"
elif fly2264_verify_process_native 104 >/dev/null 2>&1; then
  fail "ambiguous main image passed"
else
  pass "three architecture negative controls fail closed"
fi

echo "Test: Darwin ps exposes the real hexadecimal P_TRANSLATED authority"
if [ "$(uname -s)" = Darwin ]; then
  real_identity="$(/bin/ps -o pid=,flags= -p $$ 2>/dev/null | awk '{$1=$1; print}' || true)"
  real_flags="${real_identity##* }"
  if [ -z "$real_identity" ]; then
    printf '  - SKIP: sandbox denies live /bin/ps process inspection\n'
  elif [[ "$real_flags" =~ ^[0-9A-Fa-f]+$ ]] \
      && [ $((16#$real_flags & 0x00020000)) -eq 0 ]; then
    pass "live test shell has a readable native p_flag"
  else
    fail "live test shell p_flag is unreadable or translated: $real_identity"
  fi
  translated_pid="$(/bin/ps -axo pid=,flags= 2>/dev/null | awk '
    function hex(s, i,n,c,v) {
      n=0; for(i=1;i<=length(s);i++){c=substr(s,i,1); v=index("0123456789abcdef",tolower(c))-1; if(v<0)return -1; n=n*16+v} return n
    }
    {v=hex($2); if(v>=0 && int(v/131072)%2==1){print $1; exit}}
  ' || true)"
  if [ -n "$translated_pid" ]; then
    if PATH=/usr/bin:/bin:/usr/sbin:/sbin fly2264_verify_process_native "$translated_pid" >/dev/null 2>&1; then
      fail "live translated process passed: $translated_pid"
    else
      pass "live translated process is rejected: $translated_pid"
    fi
  else
    printf '  - SKIP: no live P_TRANSLATED process exists\n'
  fi
else
  printf '  - SKIP: Darwin-only real p_flag control\n'
fi

# Full hermetic production fixture. The script has no environment bypass; the
# test sources its pure functions and supplies fixture-owned path globals.
FIX="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TMP/full")"
HOME_DIR="$FIX/home"
WINDOW="$FIX/window"
LIVE="$FIX/live"
STATE="$FIX/state"
PROC="$STATE/proc"
mkdir -p "$HOME_DIR/Library/LaunchAgents" "$HOME_DIR/.flywheel/state/host-tmux" \
  "$WINDOW/lib" "$WINDOW/artifacts" "$LIVE/scripts" "$PROC" "$FIX/bin" \
  "$HOME_DIR/.flywheel/backup/tmux-native-3.7c/bin" \
  "$HOME_DIR/.flywheel/backup/tmux-old-3.5a/bin"
chmod 700 "$WINDOW/artifacts"
cp "$ROOT/scripts/cutover/FLY-2264/generate-supervisor-labels.sh" "$WINDOW/"
cp "$ROOT/scripts/cutover/FLY-2264/supervisor-labels.txt" "$WINDOW/"
cp "$ROOT/scripts/cutover/FLY-2264/lib/tmux-process-inventory.sh" "$WINDOW/lib/"
chmod +x "$WINDOW/generate-supervisor-labels.sh"

CUTOVER_SHA=0123456789abcdef0123456789abcdef01234567
NATIVE="$HOME_DIR/.flywheel/backup/tmux-native-3.7c/bin/tmux"
OLD="$HOME_DIR/.flywheel/backup/tmux-old-3.5a/bin/tmux"
LINKED="$FIX/opt/homebrew/bin/tmux"
mkdir -p "$(dirname "$LINKED")"
ln -s "$NATIVE" "$LINKED"

cat >"$NATIVE" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = -V ]; then cat "${FLY2264_VERIFY_TEST_STATE:?}/native-version"; exit 0; fi
if [ "${1:-}" = -S ] && [ "${3:-}" = display-message ]; then
  [ "${4:-}" = -p ] || exit 64
  case "${5:-}" in
    '#{pid}') awk -F'|' -v socket="$2" '$1 == socket {print $2; found=1} END {exit(found ? 0 : 1)}' \
      "${FLY2264_VERIFY_TEST_STATE:?}/socket-map" ;;
    '#{socket_path}') awk -F'|' -v socket="$2" '$1 == socket {print $1; found=1} END {exit(found ? 0 : 1)}' \
      "${FLY2264_VERIFY_TEST_STATE:?}/socket-map" ;;
    *) exit 64 ;;
  esac
  exit $?
fi
exit 64
STUB
cat >"$OLD" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = -V ]; then printf 'tmux 3.5a\n'; exit 0; fi
if [ "${1:-}" = -S ] && [ "${3:-}" = display-message ]; then
  [ "${4:-}" = -p ] || exit 64
  case "${5:-}" in
    '#{pid}') awk -F'|' -v socket="$2" '$1 == socket {print $2; found=1} END {exit(found ? 0 : 1)}' \
      "${FLY2264_VERIFY_TEST_STATE:?}/socket-map" ;;
    '#{socket_path}') awk -F'|' -v socket="$2" '$1 == socket {print $1; found=1} END {exit(found ? 0 : 1)}' \
      "${FLY2264_VERIFY_TEST_STATE:?}/socket-map" ;;
    *) exit 64 ;;
  esac
  exit $?
fi
exit 64
STUB
chmod +x "$NATIVE" "$OLD"
printf 'tmux 3.7c\n' >"$STATE/native-version"
printf 'tmux\n' >"$STATE/pinned"
printf 'census pass plists=16 generic=14 codex-mufasa=1 codex-infra-bot=1 codex-raya=0\n' >"$STATE/census-output"
printf '0\n' >"$STATE/census-rc"
printf '0\n' >"$STATE/sidebar-rc"
printf '{"status":"pass","exit_code":0,"report":["PASS fixture"],"reasons":[],"caveats":[]}\n' >"$STATE/sidebar-json"
printf '0\n' >"$STATE/hygiene-rc"
printf '901 902 903 904\n' >"$STATE/tmux-pids"
printf '/tmp/fly2264-native.sock|901\n/tmp/fly2264-atlas.sock|902\n' >"$STATE/socket-map"
printf '901|com.flywheel.runtime\n902|com.xiaorongli.atlas-growth\n' >"$STATE/coalitions"
: >"$STATE/x86-paths"

cat >"$FIX/bin/ps" <<'STUB'
#!/usr/bin/env bash
set -u
if [ "$*" = '-axo pid=,ppid=' ]; then
  awk -F'|' '{print $2, $1}' "${FLY2264_VERIFY_TEST_STATE:?}/children"
  exit 0
fi
pid=""
prev=""
for arg in "$@"; do
  [ "$prev" != -p ] || pid="$arg"
  prev="$arg"
done
[[ "$pid" =~ ^[0-9]+$ ]] || exit 64
state="${FLY2264_VERIFY_TEST_STATE:?}/proc/$pid"
[ -f "$state" ] || exit 1
# shellcheck disable=SC1090
source "$state"
case "$*" in
  *'lstart='*)
    if [ "${DRIFT:-0}" = 1 ]; then
      counter="${FLY2264_VERIFY_TEST_STATE:?}/drift-$pid"
      if [ -e "$counter" ]; then printf '%s\n' "Tue Sep  3 15:00:00 2026"; else : >"$counter"; printf '%s\n' "$START"; fi
    else
      printf '%s\n' "$START"
    fi
    ;;
  *'pid=,flags='*) printf '%s %s\n' "$pid" "$FLAGS" ;;
  *'ppid='*) printf '%s\n' "$PPID_VALUE" ;;
  eww*)
    [ "${PATH_UNREADABLE:-0}" != 1 ] || exit 1
    printf '%s PATH=%s SAFE_FIXTURE=1\n' "$COMMAND" "$PATH_VALUE"
    ;;
  *'command='*) printf '%s\n' "$COMMAND" ;;
  *) exit 64 ;;
esac
STUB
cat >"$FIX/bin/lsof" <<'STUB'
#!/usr/bin/env bash
set -u
pid=""; prev=""
for arg in "$@"; do [ "$prev" != -p ] || pid="$arg"; prev="$arg"; done
state="${FLY2264_VERIFY_TEST_STATE:?}/proc/$pid"
[ -f "$state" ] || exit 1
# shellcheck disable=SC1090
source "$state"
case "$*" in
  *' -U '*)
    printf 'p%s\n' "$pid"
    case "$pid" in 901|902|906) printf 'n%s\n' "$SOCKET" ;; esac
    printf 'n->0x%s\n' "$pid"
    ;;
  *'-d txt'*)
    printf 'p%s\nn%s\nn%s.aot\nn/usr/libexec/rosetta/runtime\nn/Library/Apple/usr/libexec/oah/runtime\nn/usr/lib/libSystem.B.dylib\nn/usr/lib/dyld\nn/private/var/db/dyld/dyld_shared_cache_arm64e\n' "$pid" "$MAIN" "$MAIN"
    ;;
  *) exit 64 ;;
esac
STUB
cat >"$FIX/bin/file" <<'STUB'
#!/usr/bin/env bash
if grep -Fxq "${*: -1}" "${FLY2264_VERIFY_TEST_STATE:?}/x86-paths"; then
  printf 'Mach-O 64-bit executable x86_64\n'
elif [ "${*: -1}" = /usr/lib/dyld ]; then
  printf 'Mach-O 64-bit dynamically linked shared library arm64e\n'
elif [[ "${*: -1}" == *dyld_shared_cache* ]]; then
  printf 'data\n'
else
  printf 'Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64e:Mach-O 64-bit executable arm64e]\n'
fi
STUB
cat >"$FIX/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
if [ "$*" = '-a -x tmux' ]; then
  cat "${FLY2264_VERIFY_TEST_STATE:?}/tmux-pids"
  [ ! -f "${FLY2264_VERIFY_TEST_STATE:?}/tmux-ancestor-pids" ] \
    || cat "${FLY2264_VERIFY_TEST_STATE:?}/tmux-ancestor-pids"
elif [ "$*" = '-x tmux' ]; then
  cat "${FLY2264_VERIFY_TEST_STATE:?}/tmux-pids"
elif [ "${1:-}" = -P ]; then
  if [ -e "${FLY2264_VERIFY_TEST_STATE:?}/lead-seat" ] && [ "${2:-}" = 300 ]; then
    exit 1
  fi
  awk -F'|' -v pid="$2" '$1 == pid {print $2; found=1} END {exit(found ? 0 : 1)}' \
    "${FLY2264_VERIFY_TEST_STATE:?}/children"
else
  exit 64
fi
STUB
cat >"$FIX/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
set -u
[ "${1:-}" = print ] || exit 64
target="${2:-}"
case "$target" in
  gui/*/*)
    label="${target##*/}"
    pid="$(awk -F'|' -v label="$label" '$1 == label {print $2; found=1} END {exit(found ? 0 : 1)}' "${FLY2264_VERIFY_TEST_STATE:?}/launchd")" || exit 113
    printf 'state = running\npid = %s\n' "$pid"
    if [ "$label" = com.flywheel.bridge ] \
        && [ ! -e "${FLY2264_VERIFY_TEST_STATE:?}/bridge-launchd-path-unavailable" ]; then
      printf 'default environment = {\n\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n}\n'
    fi
    ;;
  pid/*)
    pid="${target#pid/}"
    [ ! -e "${FLY2264_VERIFY_TEST_STATE:?}/unknown-coalition-$pid" ] || exit 1
    coalition="$(awk -F'|' -v pid="$pid" '$1 == pid {print $2; found=1} END {exit(found ? 0 : 1)}' "${FLY2264_VERIFY_TEST_STATE:?}/coalitions")" || exit 1
    printf 'resource coalition = {\n\tname = %s\n}\n' "$coalition"
    ;;
  *) exit 64 ;;
esac
STUB
cat >"$FIX/bin/curl" <<'STUB'
#!/usr/bin/env bash
cat "${FLY2264_VERIFY_TEST_STATE:?}/health.json"
STUB
cat >"$FIX/bin/brew" <<'STUB'
#!/usr/bin/env bash
[ "$*" = 'list --pinned' ] || exit 64
cat "${FLY2264_VERIFY_TEST_STATE:?}/pinned"
STUB
cat >"$FIX/bin/sysctl" <<'STUB'
#!/usr/bin/env bash
[ "$*" = '-n sysctl.proc_translated' ] || exit 64
printf '0\n'
STUB
chmod +x "$FIX/bin/ps" "$FIX/bin/lsof" "$FIX/bin/file" "$FIX/bin/pgrep" \
  "$FIX/bin/launchctl" "$FIX/bin/curl" "$FIX/bin/brew" "$FIX/bin/sysctl"

cat >"$LIVE/scripts/host-tmux-selection-gate.sh" <<'STUB'
#!/usr/bin/env bash
cat "${FLY2264_VERIFY_TEST_STATE:?}/census-output"
exit "$(cat "${FLY2264_VERIFY_TEST_STATE:?}/census-rc")"
STUB
cat >"$LIVE/scripts/flywheel-cmux-sync.sh" <<'STUB'
#!/usr/bin/env bash
[ "$*" = '--verify-sidebar --json' ] || exit 64
cat "${FLY2264_VERIFY_TEST_STATE:?}/sidebar-json"
if [ -e "${FLY2264_VERIFY_TEST_STATE:?}/mutate-owner-on-sidebar" ]; then
  printf '201|Mon Sep  2 15:00:00 2026|watch|changed-nonce\n' \
    >"${FLY2264_VERIFY_CMUX_OWNER_FILE:?}"
fi
if [ -e "${FLY2264_VERIFY_TEST_STATE:?}/remove-owner-on-sidebar" ]; then
  rm -f "${FLY2264_VERIFY_CMUX_OWNER_FILE:?}"
fi
if [ -e "${FLY2264_VERIFY_TEST_STATE:?}/remove-watcher-on-sidebar" ]; then
  rm -f "${FLY2264_VERIFY_TEST_STATE:?}/proc/201"
fi
exit "$(cat "${FLY2264_VERIFY_TEST_STATE:?}/sidebar-rc")"
STUB
cat >"$LIVE/scripts/check-global-path-hygiene.sh" <<'STUB'
#!/usr/bin/env bash
[ "$1" = --source-tree ] && [ "$2" = "${FLY2264_VERIFY_LIVE_REPO:?}" ] || exit 64
[ "$(cat "${FLY2264_VERIFY_TEST_STATE:?}/hygiene-rc")" = 0 ] || exit 1
printf 'path hygiene pass\n'
STUB
chmod +x "$LIVE/scripts/"*.sh

MAIN_IMAGE="$FIX/native-main"
X86_IMAGE="$FIX/x86-main"
touch "$MAIN_IMAGE" "$X86_IMAGE"
write_proc() {
  local pid="$1" ppid="$2" main="$3" command="$4" path_value="$5" socket="${6:-}"
  local start="${7:-Mon Sep  2 15:00:00 2026}"
  printf 'START=%q\nFLAGS=%q\nMAIN=%q\nPPID_VALUE=%q\nCOMMAND=%q\nPATH_VALUE=%q\nSOCKET=%q\nPATH_UNREADABLE=0\nDRIFT=0\n' \
    "$start" 4004 "$main" "$ppid" "$command" "$path_value" "$socket" >"$PROC/$pid"
}
GOOD_PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
write_proc 1 0 "$MAIN_IMAGE" launchd "$GOOD_PATH"
write_proc 200 1 "$MAIN_IMAGE" bridge "$GOOD_PATH"
sed -i.bak 's/PATH_UNREADABLE=0/PATH_UNREADABLE=1/' "$PROC/200"
rm -f "$PROC/200.bak"
write_proc 201 1 "$MAIN_IMAGE" watcher "$GOOD_PATH" '' 'Mon Sep  2 15:00:00 2026   '
write_proc 202 1 "$MAIN_IMAGE" liveness "$GOOD_PATH"
: >"$STATE/launchd"
printf 'com.flywheel.bridge|200\ncom.flywheel.bridge-liveness-probe|202\ncom.flywheel.cmux-watcher|201\n' >>"$STATE/launchd"
: >"$STATE/children"

lead_index=0
while IFS= read -r label; do
  case "$label" in com.flywheel.lead.*) ;; *) continue ;; esac
  pid=$((300 + lead_index))
  child=$((400 + lead_index))
  wrapper=flywheel-lead-wrapper-v2.sh
  [ "$lead_index" -ne 13 ] || wrapper=flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh
  [ "$lead_index" -ne 14 ] || wrapper=flywheel-codex-lead-wrapper-codex-infra-bot.sh
  [ "$lead_index" -ne 15 ] || wrapper=flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh
  printf 'com.flywheel.lead.%s|%s\n' "${label#com.flywheel.lead.}" "$pid" >>"$STATE/launchd"
  printf '%s|%s\n' "$pid" "$child" >>"$STATE/children"
  write_proc "$pid" 1 "$MAIN_IMAGE" "lead-$pid" "$GOOD_PATH"
  write_proc "$child" "$pid" "$MAIN_IMAGE" "child-$child" "$GOOD_PATH"
  python3 - "$HOME_DIR/Library/LaunchAgents/$label.plist" "$label" "$LIVE/scripts/$wrapper" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as handle:
    plistlib.dump({'Label':sys.argv[2], 'ProgramArguments':[sys.argv[3]]}, handle)
PY
  lead_index=$((lead_index + 1))
done <"$WINDOW/supervisor-labels.txt"
cat >"$LIVE/scripts/flywheel-bridge-wrapper.sh" <<'STUB'
#!/bin/bash
export PATH="${HOME}/.local/bin:${HOME}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
STUB
chmod +x "$LIVE/scripts/flywheel-bridge-wrapper.sh"
for label in com.flywheel.bridge com.flywheel.bridge-liveness-probe com.flywheel.cmux-watcher; do
  wrapper=/bin/true
  [ "$label" != com.flywheel.bridge ] || wrapper="$LIVE/scripts/flywheel-bridge-wrapper.sh"
  python3 - "$HOME_DIR/Library/LaunchAgents/$label.plist" "$label" "$wrapper" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as handle:
    plistlib.dump({'Label':sys.argv[2], 'ProgramArguments':['/bin/bash',sys.argv[3]]}, handle)
PY
done

# Process inventory: native Flywheel server + native attached client, alongside
# the one reviewed atlas server/client exemption.
write_proc 901 1 "$NATIVE" "$NATIVE -S /tmp/fly2264-native.sock new-session" "$GOOD_PATH" /tmp/fly2264-native.sock
write_proc 902 1 "$OLD" "$OLD -S /tmp/fly2264-atlas.sock new-session" "$GOOD_PATH" /tmp/fly2264-atlas.sock
write_proc 903 200 "$NATIVE" "$NATIVE attach-session -t =cmux-native" "$GOOD_PATH" /tmp/fly2264-native.sock
write_proc 904 201 "$OLD" "$OLD attach-session -t =cmux-atlas" "$GOOD_PATH" /tmp/fly2264-atlas.sock

for carrier in lead codex-mufasa codex-infra-bot; do
  jq -n --arg carrier "$carrier" --arg sha "$CUTOVER_SHA" \
    '{schemaVersion:1,carrier:$carrier,targetSha:$sha,tmuxVersion:"tmux 3.7c",architecture:"arm64",verdict:"pass"}' \
    >"$HOME_DIR/.flywheel/state/host-tmux/$carrier.json"
done
jq -n --arg sha "$CUTOVER_SHA" \
  '{schemaVersion:1,reason:"updater",leadsRestartStatus:"healthy",failed:0,skipped:0,total:16,codeDeployedSha:$sha}' \
  >"$HOME_DIR/.flywheel/leads-restart-status.json"
printf '%s\n' "$CUTOVER_SHA" >"$HOME_DIR/.flywheel/deployed-sha"
jq -n --arg sha "$CUTOVER_SHA" '{ok:true,buildSha:$sha,artifactBuildSha:$sha}' >"$STATE/health.json"
mkdir -p "$FIX/watcher.lock" "$HOME_DIR/.flywheel/state"
printf '201|Mon Sep  2 15:00:00 2026|watch|fixture-nonce\n' >"$FIX/watcher.lock/owner"
printf '201|1|scan\n' >"$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"

export HOME="$HOME_DIR"
export PATH="$FIX/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export FLY2264_VERIFY_TEST_STATE="$STATE"
FLY2264_VERIFY_CUTOVER_SHA="$CUTOVER_SHA"
FLY2264_VERIFY_SELF_DIR="$WINDOW"
FLY2264_VERIFY_LIVE_REPO="$LIVE"
FLY2264_VERIFY_LINKED_TMUX="$LINKED"
FLY2264_VERIFY_NATIVE_TMUX="$NATIVE"
FLY2264_VERIFY_BREW="$FIX/bin/brew"
FLY2264_VERIFY_NATIVE_CONTROL_SHELL=/bin/bash
FLY2264_VERIFY_SYSCTL="$FIX/bin/sysctl"
FLY2264_VERIFY_CMUX_OWNER_FILE="$FIX/watcher.lock/owner"
FLY2264_VERIFY_CMUX_HEARTBEAT_FILE="$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"
FLY2264_VERIFY_ARTIFACT_DIR="$WINDOW/artifacts"
JQ_BIN=jq
export FLY2264_VERIFY_CUTOVER_SHA FLY2264_VERIFY_SELF_DIR FLY2264_VERIFY_LIVE_REPO
export FLY2264_VERIFY_LINKED_TMUX FLY2264_VERIFY_NATIVE_TMUX FLY2264_VERIFY_BREW
export FLY2264_VERIFY_NATIVE_CONTROL_SHELL FLY2264_VERIFY_SYSCTL
export FLY2264_VERIFY_CMUX_OWNER_FILE FLY2264_VERIFY_CMUX_HEARTBEAT_FILE
export FLY2264_VERIFY_ARTIFACT_DIR JQ_BIN
die() { printf 'fixture inventory: %s\n' "$*" >&2; exit 1; }
# shellcheck disable=SC1091
source "$WINDOW/lib/tmux-process-inventory.sh"

echo "Test: golden cutover fixture emits seven private green artifacts and a hashed summary"
golden_rc=0
fly2264_verify_run >"$FIX/golden.out" 2>"$FIX/golden.err" || golden_rc=$?
golden_ok=1
for artifact in $(fly2264_artifact_names); do
  [ -f "$WINDOW/artifacts/$artifact" ] || golden_ok=0
  [ "$(test_file_mode "$WINDOW/artifacts/$artifact")" = 600 ] || golden_ok=0
  jq -e '.status == "pass"' "$WINDOW/artifacts/$artifact" >/dev/null || golden_ok=0
done
if [ "$golden_rc" -eq 0 ] && [ "$golden_ok" -eq 1 ] \
    && jq -e '.status == "pass" and (.artifacts | length == 7) and all(.artifacts[]; (.sha256 | length) == 64)' \
      "$WINDOW/artifacts/verification-summary.json" >/dev/null \
    && jq -e '.evidence.processes[] | select(.label == "com.flywheel.bridge") | .authority == "launchd-wrapper-contract" and .launchdDefaultPathStatus == "available"' \
      "$WINDOW/artifacts/07-path.json" >/dev/null \
    && jq -e '.evidence.startIdentity == "Mon Sep  2 15:00:00 2026"' \
      "$WINDOW/artifacts/06-cmux.json" >/dev/null; then
  pass "golden fixture produces seven 0600 pass artifacts plus hashes"
else
  golden_diagnostics="$(for artifact in $(fly2264_artifact_names); do
    jq -c '{artifact,status,exitCode,error}' "$WINDOW/artifacts/$artifact" 2>/dev/null || true
  done | tr '\n' ' ')"
  fail "golden verifier fixture failed rc=$golden_rc err=$(cat "$FIX/golden.err") artifacts=$golden_diagnostics"
fi

producer_fails() {
  local artifact="$1" producer="$2" rc=0
  fly2264_run_producer "$artifact" "$producer" >/dev/null 2>&1 || rc=$?
  [ "$rc" -ne 0 ] && jq -e '.status == "fail" and .exitCode != 0' \
    "$WINDOW/artifacts/$artifact" >/dev/null
}

echo "Test: updater ledger fields and all SHA authorities fail closed"
cp "$HOME_DIR/.flywheel/leads-restart-status.json" "$FIX/status.good"
cp "$STATE/health.json" "$FIX/health.good"
updater_negative=1
jq 'del(.total)' "$FIX/status.good" >"$HOME_DIR/.flywheel/leads-restart-status.json"
producer_fails 01-updater.json fly2264_verify_updater || updater_negative=0
jq '.total="16"' "$FIX/status.good" >"$HOME_DIR/.flywheel/leads-restart-status.json"
producer_fails 01-updater.json fly2264_verify_updater || updater_negative=0
jq '.failed=1' "$FIX/status.good" >"$HOME_DIR/.flywheel/leads-restart-status.json"
producer_fails 01-updater.json fly2264_verify_updater || updater_negative=0
cp "$FIX/status.good" "$HOME_DIR/.flywheel/leads-restart-status.json"
jq '.buildSha="bad"' "$FIX/health.good" >"$STATE/health.json"
producer_fails 01-updater.json fly2264_verify_updater || updater_negative=0
cp "$FIX/health.good" "$STATE/health.json"
if [ "$updater_negative" -eq 1 ]; then pass "updater total/failed/SHA negative controls turn 01 red"; else fail "updater negative matrix"; fi

echo "Test: census count, transport/parse, and carrier receipt drift fail closed"
census_negative=1
victim="$HOME_DIR/Library/LaunchAgents/com.flywheel.lead.flywheel-claude-infra-bot-lead.plist"
mv "$victim" "$FIX/victim.plist"
producer_fails 02-lead-census.json fly2264_verify_lead_census || census_negative=0
mv "$FIX/victim.plist" "$victim"
python3 - "$HOME_DIR/Library/LaunchAgents/com.flywheel.lead.extra-lead.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as h: plistlib.dump({'Label':'com.flywheel.lead.extra-lead','ProgramArguments':['/bin/true']}, h)
PY
producer_fails 02-lead-census.json fly2264_verify_lead_census || census_negative=0
rm -f "$HOME_DIR/Library/LaunchAgents/com.flywheel.lead.extra-lead.plist"
printf 'not a census\n' >"$STATE/census-output"
producer_fails 02-lead-census.json fly2264_verify_lead_census || census_negative=0
printf 'census pass plists=16 generic=14 codex-mufasa=1 codex-infra-bot=1 codex-raya=0\n' >"$STATE/census-output"
printf '9\n' >"$STATE/census-rc"
producer_fails 02-lead-census.json fly2264_verify_lead_census || census_negative=0
printf '0\n' >"$STATE/census-rc"
cp "$HOME_DIR/.flywheel/state/host-tmux/lead.json" "$FIX/receipt.good"
jq '.targetSha="bad"' "$FIX/receipt.good" >"$HOME_DIR/.flywheel/state/host-tmux/lead.json"
producer_fails 02-lead-census.json fly2264_verify_lead_census || census_negative=0
cp "$FIX/receipt.good" "$HOME_DIR/.flywheel/state/host-tmux/lead.json"
if [ "$census_negative" -eq 1 ]; then pass "15/17 census, parser, transport, and receipt controls turn 02 red"; else fail "census negative matrix"; fi

echo "Test: native link, version, architecture, and pin each fail closed"
native_negative=1
old_linked="$FLY2264_VERIFY_LINKED_TMUX"
FLY2264_VERIFY_LINKED_TMUX="$FIX/missing-tmux"
producer_fails 03-native-tmux.json fly2264_verify_native_tmux || native_negative=0
FLY2264_VERIFY_LINKED_TMUX="$old_linked"
printf 'tmux 9.9\n' >"$STATE/native-version"
producer_fails 03-native-tmux.json fly2264_verify_native_tmux || native_negative=0
printf 'tmux 3.7c\n' >"$STATE/native-version"
printf '%s\n' "$NATIVE" >"$STATE/x86-paths"
producer_fails 03-native-tmux.json fly2264_verify_native_tmux || native_negative=0
: >"$STATE/x86-paths"
: >"$STATE/pinned"
producer_fails 03-native-tmux.json fly2264_verify_native_tmux || native_negative=0
printf 'tmux\n' >"$STATE/pinned"
if [ "$native_negative" -eq 1 ]; then pass "link/version/arch/pin controls turn 03 red"; else fail "native tmux negative matrix"; fi

echo "Test: Lead health uses a complete process table when pgrep hides an ancestor"
touch "$STATE/lead-seat"
lead_seat_rc=0
fly2264_run_producer 05-lead-health.json fly2264_verify_lead_health >/dev/null 2>&1 || lead_seat_rc=$?
rm -f "$STATE/lead-seat"
if [ "$lead_seat_rc" -eq 0 ] \
    && jq -e '.status == "pass" and .evidence.leadCount == 16' \
      "$WINDOW/artifacts/05-lead-health.json" >/dev/null; then
  pass "Lead-seat ancestor suppression cannot hide a representative child"
else
  fail "Lead-seat child census rc=$lead_seat_rc artifact=$(jq -c '{status,exitCode,error}' "$WINDOW/artifacts/05-lead-health.json" 2>/dev/null)"
fi

echo "Test: tmux server census includes a server in the caller ancestry"
write_proc 906 1 "$NATIVE" "$NATIVE -S /tmp/fly2264-ancestor.sock new-session" "$GOOD_PATH" /tmp/fly2264-ancestor.sock
printf '/tmp/fly2264-ancestor.sock|906\n' >>"$STATE/socket-map"
printf '906|com.flywheel.ancestor\n' >>"$STATE/coalitions"
printf '906\n' >"$STATE/tmux-ancestor-pids"
tmux_seat_rc=0
fly2264_run_producer 04-tmux-servers.json fly2264_verify_tmux_servers >/dev/null 2>&1 || tmux_seat_rc=$?
if [ "$tmux_seat_rc" -eq 0 ] \
    && jq -e '.status == "pass" and (.evidence.inScope[] | select(.pid == 906 and .role == "server"))' \
      "$WINDOW/artifacts/04-tmux-servers.json" >/dev/null; then
  pass "ancestor-inclusive pgrep keeps the caller's tmux server in 04 evidence"
else
  fail "ancestor tmux missing from verifier rc=$tmux_seat_rc artifact=$(jq -c '{status,exitCode,error,evidence}' "$WINDOW/artifacts/04-tmux-servers.json" 2>/dev/null)"
fi
rm -f "$PROC/906" "$STATE/tmux-ancestor-pids"
grep -v '^/tmp/fly2264-ancestor.sock|' "$STATE/socket-map" >"$FIX/socket.no-ancestor" \
  && mv "$FIX/socket.no-ancestor" "$STATE/socket-map"
grep -v '^906|' "$STATE/coalitions" >"$FIX/coalitions.no-ancestor" \
  && mv "$FIX/coalitions.no-ancestor" "$STATE/coalitions"

echo "Test: a socket-owning server remains a server when argv contains attach"
cp "$PROC/901" "$FIX/proc901.good"
write_proc 901 1 "$NATIVE" "$NATIVE -S /tmp/fly2264-native.sock new-session -d -s fixture 'sleep 60 attach foo'" "$GOOD_PATH" /tmp/fly2264-native.sock
attach_server_rc=0
fly2264_run_producer 04-tmux-servers.json fly2264_verify_tmux_servers >/dev/null 2>&1 || attach_server_rc=$?
if [ "$attach_server_rc" -eq 0 ] \
    && jq -e '.status == "pass" and (.evidence.inScope[] | select(.pid == 901 and .role == "server"))' \
      "$WINDOW/artifacts/04-tmux-servers.json" >/dev/null; then
  pass "filesystem socket authority prevents attach-token server exemption"
else
  fail "socket-owning attach-token server was misclassified"
fi
cp "$FIX/proc901.good" "$PROC/901"

echo "Test: legacy servers and unknown owners fail while socket-less attach clients are informational"
tmux_negative=1
cp "$PROC/901" "$FIX/proc901.shape-good"
write_proc 901 1 "$NATIVE" "$NATIVE display-message attach" "$GOOD_PATH" /tmp/fly2264-native.sock
producer_fails 04-tmux-servers.json fly2264_verify_tmux_servers || tmux_negative=0
cp "$FIX/proc901.shape-good" "$PROC/901"
cp "$PROC/903" "$FIX/proc903.alias-good"
write_proc 903 200 "$NATIVE" "$NATIVE attach -t =cmux-native" "$GOOD_PATH" /tmp/fly2264-native.sock
producer_fails 04-tmux-servers.json fly2264_verify_tmux_servers || tmux_negative=0
cp "$FIX/proc903.alias-good" "$PROC/903"
cp "$STATE/coalitions" "$FIX/coalitions.good"
printf '901|com.flywheel.runtime\n902|com.flywheel.other\n' >"$STATE/coalitions"
producer_fails 04-tmux-servers.json fly2264_verify_tmux_servers || tmux_negative=0
cp "$FIX/coalitions.good" "$STATE/coalitions"
cp "$PROC/903" "$FIX/proc903.good"
write_proc 903 200 "$OLD" "$OLD attach-session -t =cmux-native" "$GOOD_PATH" /tmp/fly2264-native.sock
client_rc=0
fly2264_run_producer 04-tmux-servers.json fly2264_verify_tmux_servers >/dev/null 2>&1 || client_rc=$?
if [ "$client_rc" -ne 0 ] \
    || ! jq -e '.status == "pass" and (.evidence.clients[] | select(.pid == 903 and .role == "client" and .socket == "n/a"))' \
      "$WINDOW/artifacts/04-tmux-servers.json" >/dev/null; then
  tmux_negative=0
fi
cp "$FIX/proc903.good" "$PROC/903"
write_proc 905 1 "$OLD" "$OLD -S /tmp/fly2264-new.sock new-session" "$GOOD_PATH" /tmp/fly2264-new.sock
printf '/tmp/fly2264-new.sock|905\n' >>"$STATE/socket-map"
printf '905|com.flywheel.new\n' >>"$STATE/coalitions"
printf '901 902 903 904 905\n' >"$STATE/tmux-pids"
producer_fails 04-tmux-servers.json fly2264_verify_tmux_servers || tmux_negative=0
printf '901 902 903 904\n' >"$STATE/tmux-pids"
grep -v '^/tmp/fly2264-new.sock|' "$STATE/socket-map" >"$FIX/socket.clean" && mv "$FIX/socket.clean" "$STATE/socket-map"
cp "$FIX/coalitions.good" "$STATE/coalitions"
: >"$STATE/unknown-coalition-901"
producer_fails 04-tmux-servers.json fly2264_verify_tmux_servers || tmux_negative=0
rm -f "$STATE/unknown-coalition-901"
if [ "$tmux_negative" -eq 1 ]; then pass "server closure controls turn 04 red and attach clients remain informational"; else fail "tmux closure negative matrix"; fi

echo "Test: Lead lstart drift, missing child, P_TRANSLATED, and x86-only image fail closed"
lead_negative=1
cp "$PROC/300" "$FIX/proc300.good"
cp "$STATE/children" "$FIX/children.good"
sed 's/^DRIFT=.*/DRIFT=1/' "$FIX/proc300.good" >"$PROC/300"
rm -f "$STATE/drift-300"
producer_fails 05-lead-health.json fly2264_verify_lead_health || lead_negative=0
cp "$FIX/proc300.good" "$PROC/300"
grep -v '^300|' "$FIX/children.good" >"$STATE/children"
producer_fails 05-lead-health.json fly2264_verify_lead_health || lead_negative=0
cp "$FIX/children.good" "$STATE/children"
sed 's/^FLAGS=.*/FLAGS=34004/' "$FIX/proc300.good" >"$PROC/300"
producer_fails 05-lead-health.json fly2264_verify_lead_health || lead_negative=0
cp "$FIX/proc300.good" "$PROC/300"
sed "s|^MAIN=.*|MAIN=$X86_IMAGE|" "$FIX/proc300.good" >"$PROC/300"
printf '%s\n' "$X86_IMAGE" >"$STATE/x86-paths"
producer_fails 05-lead-health.json fly2264_verify_lead_health || lead_negative=0
cp "$FIX/proc300.good" "$PROC/300"
: >"$STATE/x86-paths"
if [ "$lead_negative" -eq 1 ]; then pass "Lead identity/translation/image controls turn 05 red"; else fail "Lead health negative matrix"; fi

echo "Test: watcher owner, heartbeat freshness, and sidebar verdict fail closed"
cmux_negative=1
cp "$FIX/watcher.lock/owner" "$FIX/owner.good"
mv "$FIX/watcher.lock/owner" "$FIX/owner.missing"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux owner file is missing or unsafe")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
mv "$FIX/owner.missing" "$FIX/watcher.lock/owner"
printf '999|Mon Sep  2 15:00:00 2026|watch|fixture-nonce\n' >"$FIX/watcher.lock/owner"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux owner identity mismatch")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
printf '201|Tue Sep  3 15:00:00 2026|watch|fixture-nonce\n' >"$FIX/watcher.lock/owner"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux owner start identity mismatch")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
cp "$FIX/owner.good" "$FIX/watcher.lock/owner"
mv "$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat" "$FIX/heartbeat.missing"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux heartbeat file is missing or unsafe")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
mv "$FIX/heartbeat.missing" "$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"
printf '999|1|scan\n' >"$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux heartbeat pid mismatch")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
printf '201|1|scan\n' >"$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"
python3 - "$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat" <<'PY'
import os,sys,time
old=time.time()-300
os.utime(sys.argv[1],(old,old))
PY
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux heartbeat is stale")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
touch "$HOME_DIR/.flywheel/state/cmux-watcher-heartbeat"
printf 'not-json\n' >"$STATE/sidebar-json"
printf '0\n' >"$STATE/sidebar-rc"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux sidebar returned invalid JSON") and contains("not-json")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
printf '{"status":"fail","exit_code":1,"report":[],"reasons":["fixture"],"caveats":[]}\n' >"$STATE/sidebar-json"
printf '1\n' >"$STATE/sidebar-rc"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux sidebar verification failed") and contains("fixture")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
printf '0\n' >"$STATE/sidebar-rc"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux sidebar verdict is not pass") and contains("fixture")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
printf '{"status":"pass","exit_code":0,"report":["PASS fixture"],"reasons":[],"caveats":[]}\n' >"$STATE/sidebar-json"
touch "$STATE/mutate-owner-on-sidebar"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux owner changed during sidebar verification")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
rm -f "$STATE/mutate-owner-on-sidebar"
cp "$FIX/owner.good" "$FIX/watcher.lock/owner"
touch "$STATE/remove-owner-on-sidebar"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux owner re-read failed")' "$WINDOW/artifacts/06-cmux.json" >/dev/null \
  || cmux_negative=0
rm -f "$STATE/remove-owner-on-sidebar"
cp "$FIX/owner.good" "$FIX/watcher.lock/owner"
cp "$PROC/201" "$FIX/proc201.good"
touch "$STATE/remove-watcher-on-sidebar"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux watcher final start identity unavailable")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
rm -f "$STATE/remove-watcher-on-sidebar"
cp "$FIX/proc201.good" "$PROC/201"
sed 's/^DRIFT=.*/DRIFT=1/' "$FIX/proc201.good" >"$PROC/201"
rm -f "$STATE/drift-201"
producer_fails 06-cmux.json fly2264_verify_cmux || cmux_negative=0
jq -e '.error | contains("cmux watcher identity changed during verification")' \
  "$WINDOW/artifacts/06-cmux.json" >/dev/null || cmux_negative=0
cp "$FIX/proc201.good" "$PROC/201"
if [ "$cmux_negative" -eq 1 ]; then pass "watcher owner/heartbeat/sidebar controls turn 06 red"; else fail "cmux negative matrix"; fi

echo "Test: reversed runtime PATH and hygiene transport each fail closed without persisting PATH"
path_negative=1
touch "$STATE/bridge-launchd-path-unavailable"
if fly2264_run_producer 07-path.json fly2264_verify_paths \
    && jq -e '.evidence.processes[] | select(.label == "com.flywheel.bridge") | .launchdDefaultPathStatus == "unavailable"' \
      "$WINDOW/artifacts/07-path.json" >/dev/null; then
  :
else
  path_negative=0
fi
rm -f "$STATE/bridge-launchd-path-unavailable"
cp "$PROC/300" "$FIX/proc300-path.good"
sed 's|^PATH_VALUE=.*|PATH_VALUE=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin|' "$FIX/proc300-path.good" >"$PROC/300"
producer_fails 07-path.json fly2264_verify_paths || path_negative=0
cp "$FIX/proc300-path.good" "$PROC/300"
cp "$LIVE/scripts/flywheel-bridge-wrapper.sh" "$FIX/bridge-wrapper.good"
sed 's|/opt/homebrew/bin:/usr/local/bin|/usr/local/bin:/opt/homebrew/bin|' \
  "$FIX/bridge-wrapper.good" >"$LIVE/scripts/flywheel-bridge-wrapper.sh"
producer_fails 07-path.json fly2264_verify_paths || path_negative=0
cp "$FIX/bridge-wrapper.good" "$LIVE/scripts/flywheel-bridge-wrapper.sh"
printf '1\n' >"$STATE/hygiene-rc"
producer_fails 07-path.json fly2264_verify_paths || path_negative=0
printf '0\n' >"$STATE/hygiene-rc"
if [ "$path_negative" -eq 1 ] \
    && ! grep -Fq "$GOOD_PATH" "$WINDOW/artifacts/07-path.json"; then
  pass "PATH order/hygiene controls turn 07 red and raw PATH stays out of evidence"
else
  fail "PATH negative matrix or secret minimization"
fi

echo "Test: invalid producer JSON and shared-deadline cleanup become explicit fail artifacts"
fixture_invalid_json() { printf 'not-json\n'; }
fixture_slow_producer() { trap 'exit 143' TERM INT; while :; do :; done; }
transport_negative=1
producer_fails 01-updater.json fixture_invalid_json || transport_negative=0
[ "$(jq -r '.exitCode' "$WINDOW/artifacts/01-updater.json")" = 65 ] || transport_negative=0
rm -f "$WINDOW/artifacts/02-lead-census.json"
fly2264_run_producer 02-lead-census.json fixture_slow_producer &
slow_wrapper=$!
fly2264_wait_workers "$slow_wrapper:02-lead-census.json" "$(($(date +%s) + 1))"
fly2264_write_timeout_artifact 02-lead-census.json || transport_negative=0
if kill -0 "$slow_wrapper" 2>/dev/null; then transport_negative=0; fi
jq -e '.status == "fail" and .exitCode == 124' "$WINDOW/artifacts/02-lead-census.json" >/dev/null \
  || transport_negative=0
if [ "$transport_negative" -eq 1 ]; then
  pass "invalid JSON and timed-out producer fail closed with bounded cleanup"
else
  fail "producer transport/deadline controls"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
