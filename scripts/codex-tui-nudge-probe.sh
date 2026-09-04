#!/bin/bash
# FLY-2296: prove the Codex rate-limit model-switch nudge against a real TUI
# and a unix-socket-only fake app-server. The source CODEX_HOME is read-only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER="$SCRIPT_DIR/codex-tui-fake-app-server.cjs"
SELF="$SCRIPT_DIR/codex-tui-nudge-probe.sh"
WORK_DIR=""
SELF_DIR=""
SESSION=""
TMUX_LABEL=""
SERVER_PID=""

cleanup() {
  if [ -n "$SESSION" ] && [ -n "$TMUX_LABEL" ]; then
    env -u TMUX tmux -L "$TMUX_LABEL" kill-session -t "$SESSION" >/dev/null 2>&1 || true
  fi
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  case "$WORK_DIR" in
    /private/tmp/fly2296-nudge.*|/tmp/fly2296-nudge.*) rm -rf -- "$WORK_DIR" ;;
  esac
  case "$SELF_DIR" in
    /private/tmp/fly2296-self.*|/tmp/fly2296-self.*) rm -rf -- "$SELF_DIR" ;;
  esac
}
trap cleanup EXIT HUP INT TERM

usage() {
  echo "usage: $0 --home <CODEX_HOME> --expect menu|nomenu [--codex-bin <path>]" >&2
  echo "       $0 --self-check [--codex-bin <path>]" >&2
  exit 2
}

unverified() {
  echo "UNVERIFIED: $*" >&2
  exit 2
}

HOME_ARG=""
EXPECT=""
CODEX_BIN=""
SELF_CHECK=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) [ "$#" -ge 2 ] || usage; HOME_ARG="$2"; shift 2 ;;
    --expect) [ "$#" -ge 2 ] || usage; EXPECT="$2"; shift 2 ;;
    --codex-bin) [ "$#" -ge 2 ] || usage; CODEX_BIN="$2"; shift 2 ;;
    --self-check) SELF_CHECK=1; shift ;;
    *) usage ;;
  esac
done

resolve_runtime() {
  command -v node >/dev/null 2>&1 || unverified "node is absent"
  command -v python3 >/dev/null 2>&1 || unverified "python3 is absent"
  command -v tmux >/dev/null 2>&1 || unverified "tmux is absent"
  if [ -z "$CODEX_BIN" ]; then
    CODEX_BIN="$(command -v codex 2>/dev/null || true)"
  fi
  [ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ] \
    || unverified "codex binary is absent or not executable"
  "$CODEX_BIN" --version >/dev/null 2>&1 \
    || unverified "codex binary cannot report its version: $CODEX_BIN"
  [ -f "$SERVER" ] || unverified "fake app-server is absent: $SERVER"
}

make_short_temp_dir() {
  local prefix="$1" base="/private/tmp"
  [ -d "$base" ] && [ -w "$base" ] || base="/tmp"
  mktemp -d "$base/$prefix.XXXXXX"
}

write_self_config() {
  local destination="$1" state="$2"
  case "$state" in
    menu)
      printf 'model = "gpt-5.6-sol"\n' > "$destination"
      ;;
    nomenu)
      printf 'model = "gpt-5.6-sol"\n\n[notice]\nhide_rate_limit_model_nudge = true\n' > "$destination"
      ;;
    ctrlfalse)
      printf 'model = "gpt-5.6-sol"\n\n[notice]\nhide_rate_limit_model_nudge = false\n' > "$destination"
      ;;
    *) unverified "internal self-check state is invalid: $state" ;;
  esac
  chmod 0600 "$destination"
}

run_self_check() {
  [ -z "$HOME_ARG" ] && [ -z "$EXPECT" ] || usage
  resolve_runtime
  SELF_DIR="$(make_short_temp_dir fly2296-self)"
  local state home expected mutation_probe mutation_out mutation_rc
  for state in menu nomenu ctrlfalse; do
    home="$SELF_DIR/$state"
    mkdir -p "$home"
    write_self_config "$home/config.toml" "$state"
    expected="menu"
    [ "$state" = "nomenu" ] && expected="nomenu"
    "$SELF" --home "$home" --expect "$expected" --codex-bin "$CODEX_BIN"
  done

  # Mutate a disposable copy of the probe itself, so the negative control
  # exercises the copy verifier without adding a production env/argv seam.
  mutation_probe="$SELF_DIR/codex-tui-nudge-probe.sh"
  cp "$SELF" "$mutation_probe"
  cp "$SERVER" "$SELF_DIR/codex-tui-fake-app-server.cjs"
  python3 - "$mutation_probe" <<'PYMUTATE' \
    || unverified "could not prepare the self-check mutation probe"
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = path.read_text()
needle = '  append_temporary_trust "$config" "$cwd"\n'
replacement = needle + '  printf \'probe_unexpected_mutation = true\\n\' >> "$config"\n'
if data.count(needle) != 1:
    sys.exit(2)
path.write_text(data.replace(needle, replacement))
PYMUTATE
  chmod 0700 "$mutation_probe"
  mutation_out="$SELF_DIR/mutation-guard.out"
  set +e
  "$mutation_probe" --home "$SELF_DIR/menu" --expect menu --codex-bin "$CODEX_BIN" \
    > "$mutation_out" 2>&1
  mutation_rc=$?
  set -e
  if [ "$mutation_rc" -ne 2 ] \
     || ! grep -q "unexpected config copy difference" "$mutation_out"; then
    echo "SELF-CHECK FAIL: config-copy mutation guard was not discriminating (rc=$mutation_rc)" >&2
    sed -n '1,160p' "$mutation_out" >&2
    exit 1
  fi
  echo "SELF-CHECK PASS: missing=true-menu, true=nomenu, false=menu, copy-mutation=exit-2"
}

strip_managed_credential_block() {
  local source="$1" destination="$2"
  python3 - "$source" "$destination" <<'PY'
import sys

source, destination = sys.argv[1:]
lines = open(source, "rb").read().splitlines(keepends=True)
out = []
inside = False
found_end = True
for line in lines:
    if line.startswith(b"# >>> flywheel-managed credential (FLY-123)"):
        if inside:
            sys.exit(2)
        inside = True
        found_end = False
        continue
    if inside and line.startswith(b"# <<< flywheel-managed credential (FLY-123)"):
        inside = False
        found_end = True
        continue
    if not inside:
        out.append(line)
if inside or not found_end:
    sys.exit(2)
open(destination, "wb").write(b"".join(out))
PY
}

normalize_allowed_differences() {
  local source="$1" destination="$2"
  python3 - "$source" "$destination" <<'PY'
import re
import sys

source, destination = sys.argv[1:]
data = open(source, "rb").read()
trust_start = b"# >>> flywheel-nudge-probe temporary trust separator="
start = data.find(trust_start)
if start >= 0:
    line_end = data.find(b"\n", start)
    end_marker = b"# <<< flywheel-nudge-probe temporary trust <<<"
    end = data.find(end_marker, line_end)
    if line_end < 0 or end < 0 or data.find(trust_start, start + 1) >= 0:
        sys.exit(2)
    end_line = data.find(b"\n", end)
    suffix_start = len(data) if end_line < 0 else end_line + 1
    separator_added = b"separator=1" in data[start:line_end]
    prefix = data[:start]
    if separator_added:
        if not prefix.endswith(b"\n"):
            sys.exit(2)
        prefix = prefix[:-1]
    data = prefix + data[suffix_start:]
lines = data.splitlines(keepends=True)
out = []
inside_notice = False
notice_header = re.compile(br"^[ \t]*\[notice\][ \t]*(?:#.*)?(?:\r?\n)?$")
any_header = re.compile(br"^[ \t]*\[")
for line in lines:
    if notice_header.match(line):
        inside_notice = True
        continue
    if inside_notice and any_header.match(line):
        inside_notice = False
    if not inside_notice:
        out.append(line)
open(destination, "wb").write(b"".join(out))
PY
}

append_temporary_trust() {
  local config="$1" cwd="$2"
  if ! python3 - "$config" "$cwd" <<'PY'
import json
import sys
import tomllib

path, cwd = sys.argv[1:]
data = open(path, "rb").read()
config = tomllib.loads(data.decode("utf-8"))
projects = config.get("projects", {})
if not isinstance(projects, dict) or sys.argv[2] in projects:
    sys.exit(2)
separator_added = bool(data and not data.endswith((b"\n", b"\r")))
separator = b"\n" if separator_added else b""
block = (
    f"# >>> flywheel-nudge-probe temporary trust separator={int(separator_added)} >>>\n"
    f"[projects.{json.dumps(cwd)}]\n"
    'trust_level = "trusted"\n'
    "# <<< flywheel-nudge-probe temporary trust <<<\n"
).encode("utf-8")
with open(path, "ab") as f:
    f.write(separator + block)
PY
  then
    unverified "source config cannot safely accept the temporary project trust table"
  fi
}

run_probe() {
  [ "$SELF_CHECK" -eq 0 ] || usage
  case "$HOME_ARG" in /*) ;; *) unverified "--home must be an absolute path" ;; esac
  case "$EXPECT" in menu|nomenu) ;; *) usage ;; esac
  resolve_runtime
  [ -d "$HOME_ARG" ] || unverified "CODEX_HOME directory is absent: $HOME_ARG"
  [ -f "$HOME_ARG/config.toml" ] && [ ! -L "$HOME_ARG/config.toml" ] \
    || unverified "config.toml must be a regular, non-symlink file: $HOME_ARG/config.toml"

  WORK_DIR="$(make_short_temp_dir fly2296-nudge)"
  local probe_home="$WORK_DIR/home" cwd="$WORK_DIR/cwd"
  local config="$probe_home/config.toml" source_sanitized="$WORK_DIR/source-sanitized.toml"
  local source_normalized="$WORK_DIR/source-normalized.toml"
  local copy_normalized="$WORK_DIR/copy-normalized.toml"
  local socket="$WORK_DIR/app.sock" server_log="$WORK_DIR/server.log"
  local pane="$WORK_DIR/pane.txt" tui_err="$WORK_DIR/tui.err"
  mkdir -p "$probe_home" "$cwd"
  strip_managed_credential_block "$HOME_ARG/config.toml" "$source_sanitized" \
    || unverified "managed credential block is malformed; no TUI was started"
  cp "$source_sanitized" "$config"
  chmod 0600 "$config"
  [ ! -e "$probe_home/auth.json" ] || unverified "internal invariant: auth.json was copied"
  if grep -q "GH_TOKEN" "$config"; then
    unverified "sanitized config still contains GH_TOKEN; no TUI was started"
  fi

  append_temporary_trust "$config" "$cwd"
  normalize_allowed_differences "$source_sanitized" "$source_normalized" \
    || unverified "could not normalize the source config for copy verification"
  normalize_allowed_differences "$config" "$copy_normalized" \
    || unverified "could not normalize the probe copy for copy verification"
  if ! diff -u "$source_normalized" "$copy_normalized"; then
    unverified "unexpected config copy difference (only credential removal, [notice], and temporary trust are allowed)"
  fi

  local thread_id tui_command observed menu_title_rc menu_confirm_rc ready=0
  thread_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  node "$SERVER" "$socket" "$server_log" "$cwd" "$thread_id" &
  SERVER_PID=$!
  for _ in $(seq 1 100); do
    # The socket path can become visible just before Node's listen callback
    # fires. Wait for the callback evidence too or Codex can lose that race
    # and exit with "server exited unexpectedly".
    if [ -S "$socket" ] && grep -Fq "LISTEN $socket" "$server_log" 2>/dev/null; then
      ready=1
      break
    fi
    kill -0 "$SERVER_PID" >/dev/null 2>&1 \
      || unverified "fake app-server exited before creating its unix socket"
    sleep 0.05
  done
  [ "$ready" -eq 1 ] || unverified "fake app-server unix socket did not become ready"

  TMUX_LABEL="fly2296-nudge-${WORK_DIR##*.}"
  SESSION="$TMUX_LABEL"
  printf -v tui_command 'exec env CODEX_HOME=%q %q resume --remote %q -C %q %q 2>%q' \
    "$probe_home" "$CODEX_BIN" "unix://$socket" "$cwd" "$thread_id" "$tui_err"
  if ! env -u TMUX tmux -L "$TMUX_LABEL" new-session -d -s "$SESSION" -x 140 -y 40 "$tui_command"; then
    [ ! -f "$tui_err" ] || sed -n '1,160p' "$tui_err" >&2
    [ ! -f "$server_log" ] || sed -n '1,160p' "$server_log" >&2
    unverified "tmux could not start the Codex TUI"
  fi

  ready=0
  for _ in $(seq 1 150); do
    if grep -q 'SENT.*"method":"turn/completed"' "$server_log" 2>/dev/null; then
      ready=1
      break
    fi
    env -u TMUX tmux -L "$TMUX_LABEL" has-session -t "$SESSION" >/dev/null 2>&1 \
      || unverified "Codex TUI exited before the synthetic turn completed"
    sleep 0.1
  done
  [ "$ready" -eq 1 ] || unverified "synthetic turn/completed was not observed"
  sleep 1
  env -u TMUX tmux -L "$TMUX_LABEL" capture-pane -p -S - -t "$SESSION" > "$pane" \
    || unverified "tmux pane capture failed"

  menu_title_rc=1
  menu_confirm_rc=1
  grep -Fq "Approaching rate limits" "$pane" && menu_title_rc=0
  grep -Fq "Press enter to confirm" "$pane" && menu_confirm_rc=0
  if [ "$menu_title_rc" -eq 0 ] && [ "$menu_confirm_rc" -eq 0 ]; then
    observed="menu"
  elif [ "$menu_title_rc" -ne 0 ] && [ "$menu_confirm_rc" -ne 0 ]; then
    observed="nomenu"
  else
    observed="indeterminate"
  fi

  echo "PROBE observed=$observed expected=$EXPECT home=$HOME_ARG"
  sed -n '1,80p' "$pane"
  if [ "$observed" != "$EXPECT" ]; then
    echo "PROBE FAIL: real TUI state did not match expectation" >&2
    sed -n '1,160p' "$tui_err" >&2
    exit 1
  fi
  echo "PROBE PASS: $EXPECT"
}

if [ "$SELF_CHECK" -eq 1 ]; then
  run_self_check
else
  run_probe
fi
