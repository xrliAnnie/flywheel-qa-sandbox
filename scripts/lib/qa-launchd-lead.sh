#!/bin/bash
# FLY-1663: isolated launchd-v2 carrier helpers for 529 QA room slots.
# All persistent artifacts belong to the slot directory; no production plist,
# projects file, state root, socket, or delivery secret is shared.

qa_launchd_err() { printf '[qa-launchd] ERROR: %s\n' "$*" >&2; }
qa_launchd_diag() { printf '[qa-launchd] %s\n' "$*" >&2; }

# Cold real-Lead starts measured about 20-30 seconds in the 529 room. Preserve
# a 60-second observation envelope without hammering the machine that is also
# trying to start the Lead. PID discovery keeps its faster cadence below;
# topology verification deliberately probes only once per second.
QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT=60
QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT=1

qa_launchd_domain() {
  printf '%s\n' "${FLYWHEEL_QA_LAUNCHD_DOMAIN:-gui/$(id -u)}"
}

qa_launchd_label() {
  local slot="$1" agent="$2"
  [[ "$slot" =~ ^[1-9][0-9]*$ ]] || { qa_launchd_err "invalid slot: $slot"; return 1; }
  [[ "$agent" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid agent id: $agent"; return 1; }
  printf 'com.flywheel.qa.lead.slot-%s.%s\n' "$slot" "$agent"
}

qa_launchd_xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

qa_launchd_require_absolute() {
  case "$1" in
    /*) return 0 ;;
    *) qa_launchd_err "path must be absolute: $1"; return 1 ;;
  esac
}

qa_launchd_plist_open() {
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '<key>Label</key><string>%s</string>\n' "$1"
}

qa_launchd_plist_argv_claude() {
  printf '<key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>\n' "$1" "$2"
}

qa_launchd_plist_argv_codex() {
  printf '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>\n' "$1"
}

qa_launchd_plist_env_claude() {
  local x_home="$1" x_path="$2" x_state="$3" x_projects="$4"
  local x_env="$5" x_summary_config_home="$6"
  printf '%s\n' '<key>EnvironmentVariables</key><dict>'
  printf '<key>HOME</key><string>%s</string>\n' "$x_home"
  printf '<key>PATH</key><string>%s</string>\n' "$x_path"
  printf '<key>FLYWHEEL_DIR</key><string>%s</string>\n' "$(printf '%s' "${FLYWHEEL_DIR:?}" | qa_launchd_xml_escape)"
  printf '<key>FLYWHEEL_STATE_DIR</key><string>%s</string>\n' "$x_state"
  printf '<key>FLYWHEEL_PROJECTS_FILE</key><string>%s</string>\n' "$x_projects"
  printf '<key>FLYWHEEL_WRAPPER_ENV_FILE</key><string>%s</string>\n' "$x_env"
  if [ -n "$x_summary_config_home" ]; then
    printf '<key>FLYWHEEL_SUMMARY_CONFIG_HOME</key><string>%s</string>\n' "$x_summary_config_home"
  fi
  printf '%s\n' '</dict>'
}

qa_launchd_plist_env_codex() {
  local x_home="$1" x_path="$2" x_state="$3" x_slot_dir="$4"
  printf '%s\n' '<key>EnvironmentVariables</key><dict>'
  printf '<key>HOME</key><string>%s</string>\n' "$x_home"
  printf '<key>PATH</key><string>%s</string>\n' "$x_path"
  printf '<key>FLYWHEEL_DIR</key><string>%s</string>\n' "$(printf '%s' "${FLYWHEEL_DIR:?}" | qa_launchd_xml_escape)"
  printf '<key>FLYWHEEL_STATE_DIR</key><string>%s</string>\n' "$x_state"
  printf '<key>TMUX_TMPDIR</key><string>%s</string>\n' "$x_slot_dir"
  printf '%s\n' '</dict>'
}

qa_launchd_plist_close() {
  local x_log="$1"
  printf '%s\n' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
  printf '%s\n' '<key>ThrottleInterval</key><integer>3</integer>'
  printf '<key>StandardOutPath</key><string>%s</string>\n' "$x_log"
  printf '<key>StandardErrorPath</key><string>%s</string>\n' "$x_log"
  printf '%s\n' '</dict></plist>'
}

# Args: plist label wrapper manifest home state projects env log [summaryConfigHome]
qa_launchd_render_plist() {
  local plist="$1" label="$2" wrapper="$3" manifest="$4" home="$5"
  local state="$6" projects="$7" env_file="$8" log_file="$9"
  local summary_config_home="${10:-}"
  local value tmp
  [[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid label: $label"; return 1; }
  for value in "$plist" "$wrapper" "$manifest" "$home" "$state" \
    "$projects" "$env_file" "$log_file"; do
    qa_launchd_require_absolute "$value" || return 1
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || { qa_launchd_err "control character in path"; return 1; }
  done
  if [ -n "$summary_config_home" ]; then
    qa_launchd_require_absolute "$summary_config_home" || return 1
    [[ "$summary_config_home" != *$'\n'* && "$summary_config_home" != *$'\r'* ]] \
      || { qa_launchd_err "control character in path"; return 1; }
  fi
  [ -x "$wrapper" ] || { qa_launchd_err "wrapper is not executable: $wrapper"; return 1; }
  [ -f "$manifest" ] || { qa_launchd_err "manifest missing: $manifest"; return 1; }

  local x_label x_wrapper x_manifest x_home x_state x_projects x_env x_log x_path x_summary_config_home
  x_label=$(printf '%s' "$label" | qa_launchd_xml_escape)
  x_wrapper=$(printf '%s' "$wrapper" | qa_launchd_xml_escape)
  x_manifest=$(printf '%s' "$manifest" | qa_launchd_xml_escape)
  x_home=$(printf '%s' "$home" | qa_launchd_xml_escape)
  x_state=$(printf '%s' "$state" | qa_launchd_xml_escape)
  x_projects=$(printf '%s' "$projects" | qa_launchd_xml_escape)
  x_env=$(printf '%s' "$env_file" | qa_launchd_xml_escape)
  x_log=$(printf '%s' "$log_file" | qa_launchd_xml_escape)
  x_summary_config_home=$(printf '%s' "$summary_config_home" | qa_launchd_xml_escape)
  x_path=$(printf '%s' "${FLYWHEEL_QA_LAUNCHD_PATH:-${home}/.local/bin:${home}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}" \
    | qa_launchd_xml_escape)
  tmp="${plist}.tmp.$$"
  mkdir -p "$(dirname "$plist")" || return 1
  umask 077
  if ! {
    qa_launchd_plist_open "$x_label"
    qa_launchd_plist_argv_claude "$x_wrapper" "$x_manifest"
    qa_launchd_plist_env_claude "$x_home" "$x_path" "$x_state" \
      "$x_projects" "$x_env" "$x_summary_config_home"
    qa_launchd_plist_close "$x_log"
  } > "$tmp"; then
    rm -f "$tmp"
    qa_launchd_err "failed to render plist: $plist"
    return 1
  fi
  if chmod 600 "$tmp" && mv "$tmp" "$plist"; then
    return 0
  fi
  rm -f "$tmp"
  qa_launchd_err "failed to render plist: $plist"
  return 1
}

# Args: plist label wrapper home state log slotDir
qa_launchd_render_codex_plist() {
  local plist="$1" label="$2" wrapper="$3" home="$4" state="$5"
  local log_file="$6" slot_dir="$7" value tmp
  [[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid label: $label"; return 1; }
  for value in "$plist" "$wrapper" "$home" "$state" "$log_file" "$slot_dir"; do
    qa_launchd_require_absolute "$value" || return 1
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
      || { qa_launchd_err "control character in path"; return 1; }
  done
  [ -x "$wrapper" ] || { qa_launchd_err "wrapper is not executable: $wrapper"; return 1; }

  local x_label x_wrapper x_home x_state x_log x_slot_dir x_path
  x_label=$(printf '%s' "$label" | qa_launchd_xml_escape)
  x_wrapper=$(printf '%s' "$wrapper" | qa_launchd_xml_escape)
  x_home=$(printf '%s' "$home" | qa_launchd_xml_escape)
  x_state=$(printf '%s' "$state" | qa_launchd_xml_escape)
  x_log=$(printf '%s' "$log_file" | qa_launchd_xml_escape)
  x_slot_dir=$(printf '%s' "$slot_dir" | qa_launchd_xml_escape)
  x_path=$(printf '%s' "${FLYWHEEL_QA_LAUNCHD_PATH:-${home}/.local/bin:${home}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}" \
    | qa_launchd_xml_escape)
  tmp="${plist}.tmp.$$"
  mkdir -p "$(dirname "$plist")" || return 1
  umask 077
  if ! {
    qa_launchd_plist_open "$x_label"
    qa_launchd_plist_argv_codex "$x_wrapper"
    qa_launchd_plist_env_codex "$x_home" "$x_path" "$x_state" "$x_slot_dir"
    qa_launchd_plist_close "$x_log"
  } > "$tmp"; then
    rm -f "$tmp"
    qa_launchd_err "failed to render plist: $plist"
    return 1
  fi
  if chmod 600 "$tmp" && mv "$tmp" "$plist"; then
    return 0
  fi
  rm -f "$tmp"
  qa_launchd_err "failed to render plist: $plist"
  return 1
}

qa_launchd_mint_codex_home() (
  local source="$1" dest="$2" slot_root="$3" stage="" validation
  local source_real slot_real release_real release_name parent socket_path_bytes move_rc
  cleanup() {
    if [ -n "$stage" ] && [ -d "$stage" ]; then
      rm -rf "$stage"
    fi
  }
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT
  trap 'cleanup; exit 143' TERM

  validation=$(python3 - "$source" "$dest" "$slot_root" "$HOME" <<'PY'
import os
from pathlib import Path
import re
import stat
import sys

source, dest, slot_root, home = map(Path, sys.argv[1:])
if not source.is_absolute() or not dest.is_absolute() or not slot_root.is_absolute():
    raise SystemExit(1)
if not re.fullmatch(r"/(?:private/)?tmp/flywheel-test-slot-[1-9][0-9]*", str(slot_root)):
    raise SystemExit(1)
if dest.exists() or dest.is_symlink():
    raise SystemExit(1)
try:
    source_info = source.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISDIR(source_info.st_mode) or source.is_symlink():
    raise SystemExit(1)

source_real = Path(os.path.realpath(source))
slot_real = Path(os.path.realpath(slot_root))
dest_real = Path(os.path.realpath(dest))
try:
    if os.path.commonpath((str(slot_real), str(dest_real))) != str(slot_real):
        raise SystemExit(1)
    if os.path.commonpath((str(source_real), str(dest_real))) in {str(source_real), str(dest_real)}:
        raise SystemExit(1)
except ValueError:
    raise SystemExit(1)

ancestor = dest.parent
while not ancestor.exists() and not ancestor.is_symlink():
    if ancestor == ancestor.parent:
        raise SystemExit(1)
    ancestor = ancestor.parent
try:
    ancestor_info = ancestor.lstat()
except OSError:
    raise SystemExit(1)
if not (stat.S_ISDIR(ancestor_info.st_mode) or (str(ancestor) == "/tmp" and ancestor.is_symlink())):
    raise SystemExit(1)
if os.path.commonpath((str(slot_real), os.path.realpath(ancestor))) != str(Path(os.path.realpath(slot_root.parent))):
    # Before slot_root exists, its nearest ancestor is /tmp; after it exists,
    # the ancestor must resolve within the slot itself.
    if os.path.commonpath((str(slot_real), os.path.realpath(ancestor))) != str(slot_real):
        raise SystemExit(1)

for part in (
    home / ".codex-mufasa",
    home / ".codex-infra-bot",
    home / ".codex-242",
    home / ".flywheel/raya/codex-home",
):
    if source_real == Path(os.path.realpath(part)):
        print("[qa-launchd] ERROR: refusing production Lead codex home", file=sys.stderr)
        raise SystemExit(1)

auth = source / "auth.json"
try:
    auth_info = auth.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISREG(auth_info.st_mode) or auth.is_symlink():
    raise SystemExit(1)
current = source / "packages/standalone/current"
try:
    release = current.resolve(strict=True)
except OSError:
    raise SystemExit(1)
releases = (source_real / "packages/standalone/releases").resolve(strict=True)
if release.parent != releases or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", release.name):
    raise SystemExit(1)
codex = release / "codex"
if not codex.is_file() or not os.access(codex, os.X_OK):
    raise SystemExit(1)
print("\t".join((str(source_real), str(slot_real), str(release), release.name)))
PY
  ) || return 1
  IFS=$'\t' read -r source_real slot_real release_real release_name <<<"$validation"

  umask 077
  parent=$(dirname "$dest")
  mkdir -p "$parent" || return 1
  chmod 700 "$parent" || return 1
  python3 - "$parent" "$slot_real" <<'PY' || return 1
import os
from pathlib import Path
import stat
import sys

parent, slot = map(Path, sys.argv[1:])
info = parent.lstat()
if not stat.S_ISDIR(info.st_mode) or parent.is_symlink():
    raise SystemExit(1)
if os.path.commonpath((os.path.realpath(parent), str(slot))) != str(slot):
    raise SystemExit(1)
PY

  stage=$(mktemp -d "${parent}/.cdxh-stage.XXXXXX") || return 1
  mkdir -p "$stage/packages/standalone/releases" || return 1
  if ! cp -Rc "$release_real" "$stage/packages/standalone/releases/$release_name" 2>/dev/null; then
    rm -rf "$stage/packages/standalone/releases/$release_name"
    cp -R "$release_real" "$stage/packages/standalone/releases/$release_name" || return 1
  fi
  ln -s "releases/$release_name" "$stage/packages/standalone/current" || return 1
  python3 - "$stage" <<'PY' || return 1
import os
from pathlib import Path
import sys

stage = Path(sys.argv[1]).resolve(strict=True)
codex = (stage / "packages/standalone/current/codex").resolve(strict=True)
if os.path.commonpath((str(stage), str(codex))) != str(stage) or not os.access(codex, os.X_OK):
    raise SystemExit(1)
PY
  socket_path_bytes=$(LC_ALL=C printf '%s' "$dest/app-server-control/app-server-control.sock" | wc -c | tr -d ' ')
  [ "$socket_path_bytes" -le 100 ] \
    || { qa_launchd_err "Codex daemon socket path exceeds 100 bytes"; return 1; }
  cp "$source_real/auth.json" "$stage/auth.json" || return 1
  chmod 600 "$stage/auth.json" || return 1
  mv "$stage" "$dest"
  move_rc=$?
  [ "$move_rc" -eq 0 ] || return "$move_rc"
  stage=""
)

qa_launchd_lead_pid() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" out
  out=$("$launchctl_bin" print "$(qa_launchd_domain)/${label}" 2>/dev/null) || return 1
  printf '%s\n' "$out" | awk '/pid =/{print $NF; exit}' | grep -E '^[1-9][0-9]*$'
}

qa_launchd_lead_pid_exact() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" out
  out=$("$launchctl_bin" print "$(qa_launchd_domain)/${label}" 2>/dev/null) || return 1
  printf '%s\n' "$out" | awk '
    /^[[:space:]]*pid = [1-9][0-9]*[[:space:]]*$/ { count++; pid=$3 }
    END { if (count == 1) print pid; else exit 1 }
  '
}

# Return 0 for an exact NAME=value match, 1 for a proven mismatch, and 2 when
# the probe is invalid or unavailable. Diagnostics never include environment
# values.
qa_launchd_process_env_has() {
  local pid="$1" name="$2" expected="$3" probe out rc
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
    || { qa_launchd_err "probe=unavailable match=0"; return 2; }
  if [ -r "/proc/${pid}/environ" ]; then
    probe=proc
    python3 - "/proc/${pid}/environ" "$name" "$expected" <<'PY'
import sys

path, name, expected = sys.argv[1:]
data = open(path, "rb").read(65537)
if len(data) > 65536:
    raise SystemExit(2)
wanted = (name + "=" + expected).encode()
raise SystemExit(0 if sum(item == wanted for item in data.split(b"\0")) == 1 else 1)
PY
    rc=$?
  else
    probe=ps
    out=$(ps eww -p "$pid" -o command= 2>/dev/null) \
      || { qa_launchd_err "probe=unavailable match=0"; return 2; }
    [ "$(printf '%s' "$out" | wc -c | tr -d ' ')" -le 65536 ] \
      || { qa_launchd_err "probe=${probe} match=0"; return 2; }
    python3 - "$name" "$expected" "$out" <<'PY'
import sys

name, expected, text = sys.argv[1:]
wanted = name + "=" + expected
raise SystemExit(0 if sum(item == wanted for item in text.split()) == 1 else 1)
PY
    rc=$?
  fi
  case "$rc" in
    0) qa_launchd_diag "probe=${probe} match=1"; return 0 ;;
    1) qa_launchd_err "probe=${probe} match=0"; return 1 ;;
    *) qa_launchd_err "probe=${probe} match=0"; return 2 ;;
  esac
}

qa_launchd_codex_process_matches() {
  local pid="$1" status command
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  status=$(ps -o stat= -p "$pid" 2>/dev/null) || return 1
  status="${status#${status%%[![:space:]]*}}"
  [[ -n "$status" && "${status:0:1}" != Z ]] || return 1
  command=$(ps -p "$pid" -o command= 2>/dev/null) || return 1
  [ "$(printf '%s' "$command" | wc -c | tr -d ' ')" -le 65536 ] || return 1
  python3 - "$command" <<'PY'
import os
import shlex
import sys

suffix = "/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
try:
    argv = shlex.split(sys.argv[1])
except ValueError:
    raise SystemExit(1)
matches = [
    index for index, value in enumerate(argv)
    if os.path.normpath(value).endswith(suffix)
]
if len(matches) != 1 or matches[0] == 0:
    raise SystemExit(1)
raise SystemExit(0 if os.path.basename(argv[matches[0] - 1]) == "node" else 1)
PY
}

qa_launchd_read_heartbeat() {
  local path="$1" snapshot_out="${2:-}"
  python3 - "$path" "$snapshot_out" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

path = Path(sys.argv[1])
snapshot_text = sys.argv[2]
try:
    info = path.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > 65536:
    raise SystemExit(1)
try:
    with path.open("rb") as stream:
        data = stream.read(65537)
except OSError:
    raise SystemExit(1)
if len(data) > 65536:
    raise SystemExit(1)
try:
    value = json.loads(data)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(value, dict) or type(value.get("v")) is not int or value["v"] != 1:
    raise SystemExit(1)
pid = value.get("processPid")
if type(pid) is not int or pid <= 0:
    raise SystemExit(1)
for field in ("generationId", "threadId", "carrierInstanceId"):
    item = value.get(field)
    if not isinstance(item, str) or not item or len(item) > 256:
        raise SystemExit(1)
updated = value.get("updatedAt")
if not isinstance(updated, str) or not updated or len(updated) > 64:
    raise SystemExit(1)
state_value = value.get("state")
if state_value not in {"running", "online", "generation_lost", "shutdown"}:
    raise SystemExit(1)
digest = hashlib.sha256(data).hexdigest()

if snapshot_text:
    snapshot = Path(snapshot_text)
    try:
        snapshot_info = snapshot.lstat()
    except OSError:
        raise SystemExit(1)
    if not stat.S_ISDIR(snapshot_info.st_mode) or snapshot.is_symlink():
        raise SystemExit(1)
    slot_root = None
    for parent in (path, *path.parents):
        if re.fullmatch(r"flywheel-test-slot-[1-9][0-9]*", parent.name):
            slot_root = parent
            break
    if slot_root is None:
        raise SystemExit(1)
    try:
        slot_real = Path(os.path.realpath(slot_root))
        snapshot_real = Path(os.path.realpath(snapshot))
        if os.path.commonpath((slot_real, snapshot_real)) == str(slot_real):
            raise SystemExit(1)
    except (OSError, ValueError):
        raise SystemExit(1)
    target = snapshot / f"heartbeat-{digest}.json"
    if target.exists() or target.is_symlink():
        try:
            target_info = target.lstat()
            if not stat.S_ISREG(target_info.st_mode) or target.is_symlink() or target.read_bytes() != data:
                raise SystemExit(1)
            os.chmod(target, 0o600)
        except OSError:
            raise SystemExit(1)
    else:
        fd, temp_name = tempfile.mkstemp(prefix=".heartbeat.", dir=snapshot)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.chmod(temp_name, 0o600)
            os.replace(temp_name, target)
        except Exception:
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

print(f"{pid}\t{value['generationId']}\t{value['carrierInstanceId']}\t{state_value}\t{digest}")
PY
}

qa_launchd_codex_state_dir() {
  local state_root="$1" project="$2" lead="$3" safe_project safe_lead identity_hex
  qa_launchd_require_absolute "$state_root" || return 1
  [[ "$state_root" != *$'\n'* && "$state_root" != *$'\r'* ]] || return 1
  [[ "$project" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { qa_launchd_err "invalid project name"; return 1; }
  [[ "$lead" =~ ^[a-z0-9][a-z0-9-]*$ ]] \
    || { qa_launchd_err "invalid lead id"; return 1; }
  safe_project=$(printf '%s' "$project" | tr -c 'a-zA-Z0-9_-' '_')
  safe_lead=$(printf '%s' "$lead" | tr -c 'a-zA-Z0-9_-' '_')
  identity_hex=$(printf '%s\037%s' "$project" "$lead" | od -An -v -tx1 | tr -d ' \n')
  printf '%s/state/codex-lead/%s__%s-%s\n' \
    "${state_root%/}" "$safe_project" "$safe_lead" "$identity_hex"
}

qa_launchd_codex_lead_verify() {
  local label="$1" codex_home="$2" state_dir="$3"
  local polls="${FLYWHEEL_QA_LEAD_VERIFY_POLLS:-$QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT}"
  local interval="${FLYWHEEL_QA_LEAD_VERIFY_INTERVAL:-$QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT}"
  local pid heartbeat heartbeat_pid _generation _carrier _state _hash i
  qa_launchd_require_absolute "$codex_home" || return 1
  qa_launchd_require_absolute "$state_dir" || return 1
  for i in $(seq 1 "$polls"); do
    pid=$(qa_launchd_lead_pid_exact "$label" || true)
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]] \
        && qa_launchd_codex_process_matches "$pid" \
        && qa_launchd_process_env_has "$pid" CODEX_HOME "$codex_home"; then
      heartbeat=$(qa_launchd_read_heartbeat "${state_dir}/brain/heartbeat.json" || true)
      IFS=$'\t' read -r heartbeat_pid _generation _carrier _state _hash <<<"$heartbeat"
      if [[ "$heartbeat_pid" == "$pid" ]]; then
        printf '%s\t%s\n' "$pid" "$state_dir"
        return 0
      fi
    fi
    sleep "$interval"
  done
  qa_launchd_err "Codex Lead topology did not converge: $label"
  return 1
}

qa_launchd_codex_lead_ready() {
  local state_dir="$1" pid="$2" project="$3" lead="$4" tmux_socket="$5"
  local heartbeat heartbeat_pid _generation _carrier state _hash windows expected count
  qa_launchd_require_absolute "$state_dir" || return 1
  qa_launchd_require_absolute "$tmux_socket" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$project" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  [[ "$lead" =~ ^[a-z0-9][a-z0-9-]*$ ]] || return 1
  heartbeat=$(qa_launchd_read_heartbeat "${state_dir}/brain/heartbeat.json") || return 1
  IFS=$'\t' read -r heartbeat_pid _generation _carrier state _hash <<<"$heartbeat"
  [[ "$heartbeat_pid" == "$pid" && "$state" == online ]] || return 1
  windows=$("${FLYWHEEL_QA_TMUX:-tmux}" -S "$tmux_socket" \
    list-windows -t '=flywheel' -F '#{window_name}' 2>/dev/null) || return 1
  expected="${project}-${lead}"
  count=$(printf '%s\n' "$windows" | grep -Fxc "$expected" || true)
  [[ "$count" == 1 ]]
}

qa_launchd_validate_restart_drill_args() {
  python3 - "$@" <<'PY'
import os
from pathlib import Path
import re
import stat
import sys

if len(sys.argv) != 10:
    raise SystemExit(1)
label, carrier, mode, home_raw, state_raw, socket_raw, project, lead, evidence_raw = sys.argv[1:]
match = re.fullmatch(r"com\.flywheel\.qa\.lead\.slot-([1-9][0-9]*)\.([a-z0-9][a-z0-9-]*)", label)
if not match or carrier != "codex-tui" or mode not in {"crash", "kickstart"}:
    raise SystemExit(1)
if match.group(2) != lead or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", project):
    raise SystemExit(1)
home, state, tmux_socket, evidence = map(Path, (home_raw, state_raw, socket_raw, evidence_raw))
if any(not path.is_absolute() for path in (home, state, tmux_socket, evidence)):
    raise SystemExit(1)
slot = Path(f"/tmp/flywheel-test-slot-{match.group(1)}")
slot_real = Path(os.path.realpath(slot))
if not re.fullmatch(r"/(?:private/)?tmp/flywheel-test-slot-[1-9][0-9]*", str(slot_real)):
    raise SystemExit(1)
try:
    home_info, state_info, socket_info, evidence_info = (
        home.lstat(), state.lstat(), tmux_socket.lstat(), evidence.lstat()
    )
except OSError:
    raise SystemExit(1)
if not stat.S_ISDIR(home_info.st_mode) or home.is_symlink():
    raise SystemExit(1)
if not stat.S_ISDIR(state_info.st_mode) or state.is_symlink():
    raise SystemExit(1)
if not stat.S_ISSOCK(socket_info.st_mode) or tmux_socket.is_symlink():
    raise SystemExit(1)
if not stat.S_ISDIR(evidence_info.st_mode) or evidence.is_symlink():
    raise SystemExit(1)
try:
    for path in (home, state):
        if os.path.commonpath((str(slot_real), os.path.realpath(path))) != str(slot_real):
            raise SystemExit(1)
    if os.path.commonpath((str(slot_real), os.path.realpath(evidence))) == str(slot_real):
        raise SystemExit(1)
except ValueError:
    raise SystemExit(1)
expected_socket = slot / f"tmux-{os.getuid()}" / "default"
if str(tmux_socket) != str(expected_socket) or any(evidence.iterdir()):
    raise SystemExit(1)
print(str(state / "brain/heartbeat.json"))
PY
}

qa_launchd_codex_observe_restart() {
  local label="$1" codex_home="$2" state_dir="$3" tmux_socket="$4"
  local project="$5" lead="$6" evidence_stage="$7"
  local pid incarnation heartbeat heartbeat_pid generation carrier state hash
  local windows expected count
  pid=$(qa_launchd_lead_pid_exact "$label") || return 1
  incarnation=$(qa_launchd_process_incarnation "$pid") || return 1
  qa_launchd_codex_process_matches "$pid" || return 1
  qa_launchd_process_env_has "$pid" CODEX_HOME "$codex_home" || return 1
  heartbeat=$(qa_launchd_read_heartbeat "${state_dir}/brain/heartbeat.json" "$evidence_stage") \
    || return 1
  IFS=$'\t' read -r heartbeat_pid generation carrier state hash <<<"$heartbeat"
  [[ "$heartbeat_pid" == "$pid" && "$state" == online ]] || return 1
  windows=$("${FLYWHEEL_QA_TMUX:-tmux}" -S "$tmux_socket" \
    list-windows -t '=flywheel' -F '#{window_name}' 2>/dev/null) || return 1
  expected="${project}-${lead}"
  count=$(printf '%s\n' "$windows" | grep -Fxc "$expected" || true)
  [[ "$count" == 1 ]] || return 1
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$pid" "$incarnation" "$generation" "$carrier" "$state" "$hash"
}

# Exercise launchd KeepAlive or an explicit kickstart and bind both topology
# observations to the exact heartbeat bytes archived in evidence_stage.
qa_launchd_lead_restart_drill() {
  local label="$1" carrier="$2" mode="$3" codex_home="$4" state_dir="$5"
  local tmux_socket="$6" project="$7" lead="$8" evidence_stage="$9"
  local heartbeat_path old new old_pid old_lstart old_generation old_carrier old_state old_hash
  local new_pid new_lstart new_generation new_carrier new_state new_hash domain i
  local started_at converged_at evidence_tmp hash
  heartbeat_path=$(qa_launchd_validate_restart_drill_args \
    "$label" "$carrier" "$mode" "$codex_home" "$state_dir" "$tmux_socket" \
    "$project" "$lead" "$evidence_stage") || return 1
  old=$(qa_launchd_codex_observe_restart "$label" "$codex_home" "$state_dir" \
    "$tmux_socket" "$project" "$lead" "$evidence_stage") || return 1
  IFS=$'\t' read -r old_pid old_lstart old_generation old_carrier old_state old_hash <<<"$old"
  started_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  case "$mode" in
    crash)
      kill -9 "$old_pid" || return 1
      ;;
    kickstart)
      domain=$(qa_launchd_domain) || return 1
      "${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" kickstart -k "${domain}/${label}" || return 1
      ;;
    *) return 1 ;;
  esac

  new=""
  for i in $(seq 1 "${FLYWHEEL_QA_LEAD_VERIFY_POLLS:-$QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT}"); do
    new=$(qa_launchd_codex_observe_restart "$label" "$codex_home" "$state_dir" \
      "$tmux_socket" "$project" "$lead" "$evidence_stage" || true)
    if [[ -n "$new" ]]; then
      IFS=$'\t' read -r new_pid new_lstart new_generation new_carrier new_state new_hash <<<"$new"
      if [[ ( "$new_pid" != "$old_pid" || "$new_lstart" != "$old_lstart" ) \
          && "$new_generation" != "$old_generation" \
          && "$new_carrier" != "$old_carrier" ]]; then
        break
      fi
      new=""
    fi
    sleep "${FLYWHEEL_QA_LEAD_VERIFY_INTERVAL:-$QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT}"
  done
  [[ -n "$new" ]] || { qa_launchd_err "Codex Lead restart did not converge: $label"; return 1; }
  for hash in "$old_hash" "$new_hash"; do
    python3 - "$evidence_stage/heartbeat-${hash}.json" "$hash" <<'PY' || return 1
import hashlib
from pathlib import Path
import sys

path, expected = Path(sys.argv[1]), sys.argv[2]
if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
    raise SystemExit(1)
PY
  done
  converged_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  evidence_tmp="${evidence_stage}/restart-drill.json.tmp.$$"
  if ! jq -n --arg mode "$mode" --arg label "$label" --arg domain "$(qa_launchd_domain)" \
    --arg heartbeatPath "$heartbeat_path" --arg tmuxSocket "$tmux_socket" \
    --arg startedAt "$started_at" --arg convergedAt "$converged_at" \
    --argjson oldPid "$old_pid" --arg oldLstart "$old_lstart" \
    --arg oldGeneration "$old_generation" --arg oldCarrier "$old_carrier" \
    --arg oldState "$old_state" --arg oldHash "$old_hash" \
    --argjson newPid "$new_pid" --arg newLstart "$new_lstart" \
    --arg newGeneration "$new_generation" --arg newCarrier "$new_carrier" \
    --arg newState "$new_state" --arg newHash "$new_hash" \
    '{mode:$mode,label:$label,domain:$domain,
      old:{pid:$oldPid,lstart:$oldLstart,generationId:$oldGeneration,
        carrierInstanceId:$oldCarrier,state:$oldState,heartbeatSha256:$oldHash,
        predicates:{launchdPid:true,processShape:true,codexHome:true,heartbeat:true,tuiWindow:true}},
      new:{pid:$newPid,lstart:$newLstart,generationId:$newGeneration,
        carrierInstanceId:$newCarrier,state:$newState,heartbeatSha256:$newHash,
        predicates:{launchdPid:true,processShape:true,codexHome:true,heartbeat:true,tuiWindow:true}},
      heartbeatPath:$heartbeatPath,tmuxSocket:$tmuxSocket,
      startedAt:$startedAt,convergedAt:$convergedAt}' > "$evidence_tmp"; then
    rm -f "$evidence_tmp"
    return 1
  fi
  if chmod 600 "$evidence_tmp" \
      && mv "$evidence_tmp" "$evidence_stage/restart-drill.json"; then
    return 0
  fi
  rm -f "$evidence_tmp"
  return 1
}

# Bootstrap one unique label and print the live launchd job PID.
qa_launchd_lead_start() {
  local label="$1" plist="$2" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}"
  local domain pid
  domain=$(qa_launchd_domain) || return 1
  if "$launchctl_bin" print "${domain}/${label}" >/dev/null 2>&1; then
    qa_launchd_err "label already loaded: $label"
    return 1
  fi
  "$launchctl_bin" bootstrap "$domain" "$plist" \
    || { qa_launchd_err "bootstrap failed: $label"; return 1; }
  for _ in $(seq 1 "${FLYWHEEL_QA_LAUNCHD_PID_POLLS:-50}"); do
    pid=$(qa_launchd_lead_pid "$label" || true)
    if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    sleep "${FLYWHEEL_QA_LAUNCHD_POLL_INTERVAL:-0.1}"
  done
  "$launchctl_bin" bootout "${domain}/${label}" >/dev/null 2>&1 || true
  qa_launchd_err "job never published a PID: $label"
  return 1
}

qa_launchd_lead_stop() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" domain
  domain=$(qa_launchd_domain) || return 1
  if "$launchctl_bin" print "${domain}/${label}" >/dev/null 2>&1; then
    "$launchctl_bin" bootout "${domain}/${label}"
  fi
}

# Verify positive topology evidence, not merely process existence.
# Args: label manifest
qa_launchd_lead_verify() {
  local label="$1" manifest="$2" tmux_bin="${FLYWHEEL_QA_TMUX:-tmux}"
  local launch_pid="" manifest_pid="" socket="" manifest_topology=""
  for _ in $(seq 1 "${FLYWHEEL_QA_LEAD_VERIFY_POLLS:-$QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT}"); do
    manifest_topology=$(jq -er '
      select((.pid | type) == "number" and .pid > 0)
      | select((.socketPath | type) == "string" and (.socketPath | length) > 0)
      | [(.pid | tostring), .socketPath]
      | @tsv
    ' "$manifest" 2>/dev/null || true)
    if [[ -n "$manifest_topology" ]]; then
      IFS=$'\t' read -r manifest_pid socket <<<"$manifest_topology"
      launch_pid=$(qa_launchd_lead_pid "$label" || true)
      if [[ -n "$launch_pid" && "$manifest_pid" == "$launch_pid" ]] \
          && "$tmux_bin" -S "$socket" has-session -t '=main' >/dev/null 2>&1; then
        printf '%s\t%s\n' "$launch_pid" "$socket"
        return 0
      fi
    fi
    sleep "${FLYWHEEL_QA_LEAD_VERIFY_INTERVAL:-$QA_LAUNCHD_LEAD_VERIFY_INTERVAL_DEFAULT}"
  done
  qa_launchd_err "topology verification failed: label=$label launchPid=${launch_pid:-} manifestPid=${manifest_pid:-} socket=${socket:-}"
  return 1
}

# Registry is the only teardown authority for KeepAlive jobs.
# Args: registry label plist manifest [carrier codexHome codexBin stateDir runtimePidFile]
qa_launchd_register() {
  local registry="$1" label="$2" plist="$3" manifest="$4" tmp
  tmp="${registry}.tmp.$$"
  mkdir -p "$(dirname "$registry")" || return 1
  if [ "$#" -eq 4 ]; then
    if [ -f "$registry" ]; then
      jq --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
        '. + [{label:$label, plist:$plist, manifest:$manifest}] | unique_by(.label)' \
        "$registry" > "$tmp"
    else
      jq -n --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
        '[{label:$label, plist:$plist, manifest:$manifest}]' > "$tmp"
    fi
  elif [ "$#" -eq 9 ] && [ "$5" = codex-tui ]; then
    local carrier="$5" codex_home="$6" codex_bin="$7" state_dir="$8" runtime_pid_file="$9"
    if [ -f "$registry" ]; then
      jq --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
        --arg carrier "$carrier" --arg codexHome "$codex_home" \
        --arg codexBin "$codex_bin" --arg stateDir "$state_dir" \
        --arg runtimePidFile "$runtime_pid_file" \
        '. + [{label:$label, plist:$plist, manifest:$manifest, carrier:$carrier,
          codexHome:$codexHome, codexBin:$codexBin, stateDir:$stateDir,
          runtimePidFile:$runtimePidFile}] | unique_by(.label)' \
        "$registry" > "$tmp"
    else
      jq -n --arg label "$label" --arg plist "$plist" --arg manifest "$manifest" \
        --arg carrier "$carrier" --arg codexHome "$codex_home" \
        --arg codexBin "$codex_bin" --arg stateDir "$state_dir" \
        --arg runtimePidFile "$runtime_pid_file" \
        '[{label:$label, plist:$plist, manifest:$manifest, carrier:$carrier,
          codexHome:$codexHome, codexBin:$codexBin, stateDir:$stateDir,
          runtimePidFile:$runtimePidFile}]' > "$tmp"
    fi
  else
    qa_launchd_err "invalid registry entry shape"
    return 1
  fi
  if jq -e 'type == "array"' "$tmp" >/dev/null 2>&1 \
      && chmod 600 "$tmp" && mv "$tmp" "$registry"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

qa_launchd_process_incarnation() {
  local pid="$1" status started
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  status=$(ps -o stat= -p "$pid" 2>/dev/null) || return 1
  status="${status#${status%%[![:space:]]*}}"
  [[ -n "$status" && "${status:0:1}" != Z ]] || return 1
  started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null) || return 1
  started=$(printf '%s' "$started" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [[ -n "$started" ]] || return 1
  printf '%s\n' "$started"
}

qa_launchd_wait_process_gone() {
  local pid="$1" incarnation="$2" i observed
  [[ -n "$pid" && -n "$incarnation" ]] || return 0
  for i in $(seq 1 "${FLYWHEEL_QA_STOP_POLLS:-150}"); do
    observed=$(qa_launchd_process_incarnation "$pid" || true)
    [[ "$observed" != "$incarnation" ]] && return 0
    sleep "${FLYWHEEL_QA_STOP_INTERVAL:-0.2}"
  done
  return 1
}

qa_launchd_wait_job_gone() {
  local label="$1" launchctl_bin="${FLYWHEEL_QA_LAUNCHCTL:-launchctl}" domain i
  domain=$(qa_launchd_domain) || return 1
  for i in $(seq 1 "${FLYWHEEL_QA_STOP_POLLS:-150}"); do
    "$launchctl_bin" print "${domain}/${label}" >/dev/null 2>&1 || return 0
    sleep "${FLYWHEEL_QA_STOP_INTERVAL:-0.2}"
  done
  return 1
}

qa_launchd_wait_path_gone() {
  local path="$1" i
  for i in $(seq 1 "${FLYWHEEL_QA_STOP_POLLS:-150}"); do
    [[ ! -e "$path" && ! -L "$path" ]] && return 0
    sleep "${FLYWHEEL_QA_STOP_INTERVAL:-0.2}"
  done
  return 1
}

qa_launchd_validate_codex_stop_entry() {
  local registry="$1" entry="$2"
  python3 - "$registry" "$entry" <<'PY'
import json
import os
from pathlib import Path
import re
import stat
import sys

registry = Path(sys.argv[1])
try:
    row = json.loads(sys.argv[2])
except (TypeError, ValueError):
    raise SystemExit(1)
if not registry.is_absolute() or not registry.is_file() or registry.is_symlink():
    raise SystemExit(1)
slot = registry.parent
slot_real = Path(os.path.realpath(slot))
if not re.fullmatch(r"/(?:private/)?tmp/flywheel-test-slot-[1-9][0-9]*", str(slot_real)):
    raise SystemExit(1)
required = ("label", "codexHome", "codexBin", "stateDir", "runtimePidFile")
if any(not isinstance(row.get(key), str) or not row[key] for key in required):
    raise SystemExit(1)
home = Path(row["codexHome"])
binary = Path(row["codexBin"])
state = Path(row["stateDir"])
pid_file = Path(row["runtimePidFile"])
if any(not path.is_absolute() for path in (home, binary, state, pid_file)):
    raise SystemExit(1)
try:
    home_info = home.lstat()
except OSError:
    raise SystemExit(1)
if not stat.S_ISDIR(home_info.st_mode) or home.is_symlink():
    raise SystemExit(1)
home_real = Path(os.path.realpath(home))
binary_real = Path(os.path.realpath(binary))
try:
    if os.path.commonpath((str(slot_real), str(home_real))) != str(slot_real):
        raise SystemExit(1)
    standalone = home_real / "packages/standalone"
    if os.path.commonpath((str(standalone), str(binary_real))) != str(standalone):
        raise SystemExit(1)
    for path in (state, pid_file):
        if os.path.commonpath((str(slot_real), os.path.realpath(path))) != str(slot_real):
            raise SystemExit(1)
except ValueError:
    raise SystemExit(1)
if not binary_real.is_file() or not os.access(binary_real, os.X_OK):
    raise SystemExit(1)
print("\t".join((row["label"], str(home), str(binary_real), str(state), str(pid_file))))
PY
}

qa_launchd_stop_codex_entry() {
  local registry="$1" entry="$2" validated label codex_home codex_bin state_dir runtime_pid_file
  local runtime_pid="" runtime_incarnation="" daemon_pid="" daemon_incarnation=""
  local daemon_pid_file daemon_socket failed=0
  validated=$(qa_launchd_validate_codex_stop_entry "$registry" "$entry") \
    || { qa_launchd_err "carrier=codex-tui step=validate"; return 1; }
  IFS=$'\t' read -r label codex_home codex_bin state_dir runtime_pid_file <<<"$validated"
  runtime_pid=$(qa_launchd_lead_pid_exact "$label" || true)
  if [[ -z "$runtime_pid" && -f "$runtime_pid_file" && ! -L "$runtime_pid_file" ]]; then
    runtime_pid=$(cat "$runtime_pid_file" 2>/dev/null || true)
    [[ "$runtime_pid" =~ ^[1-9][0-9]*$ ]] || runtime_pid=""
  fi
  runtime_incarnation=$(qa_launchd_process_incarnation "$runtime_pid" || true)
  if ! qa_launchd_lead_stop "$label"; then
    qa_launchd_err "carrier=codex-tui step=bootout"
    failed=1
  fi
  if ! qa_launchd_wait_job_gone "$label" \
      || ! qa_launchd_wait_process_gone "$runtime_pid" "$runtime_incarnation"; then
    qa_launchd_err "carrier=codex-tui step=runtime-converge"
    failed=1
  fi

  daemon_pid_file="${codex_home}/app-server-daemon/app-server.pid"
  daemon_socket="${codex_home}/app-server-control/app-server-control.sock"
  if [[ -f "$daemon_pid_file" && ! -L "$daemon_pid_file" ]]; then
    daemon_pid=$(cat "$daemon_pid_file" 2>/dev/null || true)
    [[ "$daemon_pid" =~ ^[1-9][0-9]*$ ]] || daemon_pid=""
  fi
  daemon_incarnation=$(qa_launchd_process_incarnation "$daemon_pid" || true)
  if ! "${FLYWHEEL_DIR:?}/scripts/lib/bounded-run.sh" 30 env \
      CODEX_HOME="$codex_home" "$codex_bin" remote-control stop --json \
      >/dev/null 2>&1; then
    qa_launchd_err "carrier=codex-tui step=daemon-stop"
    failed=1
  fi
  if ! qa_launchd_wait_process_gone "$daemon_pid" "$daemon_incarnation" \
      || ! qa_launchd_wait_path_gone "$daemon_socket"; then
    qa_launchd_err "carrier=codex-tui step=daemon-converge"
    failed=1
  fi
  [[ "$failed" == 0 ]]
}

qa_launchd_stop_registry() {
  local registry="$1" label entry carrier failed=0
  [ -f "$registry" ] || return 0
  if jq -e 'type == "array" and all(.[];
      ((keys | sort) == ["label","manifest","plist"]))' \
      "$registry" >/dev/null 2>&1; then
    # Legacy fast path: keep the original loop and fail-fast return byte-for-byte.
    while IFS= read -r label; do
      [ -z "$label" ] || qa_launchd_lead_stop "$label" || return 1
    done < <(jq -r '.[].label' "$registry")
    return 0
  fi
  jq -e 'type == "array"' "$registry" >/dev/null 2>&1 || return 1
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    carrier=$(jq -r '.carrier // ""' <<<"$entry") || { failed=1; continue; }
    case "$carrier" in
      codex-tui)
        qa_launchd_stop_codex_entry "$registry" "$entry" || failed=1
        ;;
      "")
        label=$(jq -r '.label // ""' <<<"$entry")
        [[ -n "$label" ]] && qa_launchd_lead_stop "$label" || failed=1
        ;;
      *)
        qa_launchd_err "carrier=${carrier} step=validate"
        failed=1
        ;;
    esac
  done < <(jq -c '.[]' "$registry")
  [[ "$failed" == 0 ]]
}
