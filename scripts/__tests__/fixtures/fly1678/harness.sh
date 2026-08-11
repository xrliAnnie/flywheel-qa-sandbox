#!/usr/bin/env bash
# FLY-1678 shared renderer harness — sourced by the suites in scripts/__tests__/.
#
# The statusline is a pure stdin -> stdout filter, so it is fully testable without
# tmux, a server, or a network. What it is NOT is portable: it calls BSD-only
# `stat -f` / `date -juf|-v|-jf`, and its bar glyphs come out of `tr`, whose
# multibyte behaviour differs by locale AND implementation. Everything the script
# reads from the outside world is therefore intercepted:
#
#   HOME              -> a throwaway directory (cache, .claude.json, settings.json)
#   date / stat / tr  -> deterministic shims (see shim/)
#   curl / security   -> forbidden-call markers; running either fails the suite
#   clock             -> pinned via FLY1678_FAKE_NOW
#   LC_ALL            -> C. Safe ONLY because the tr shim intercepts both bar
#                        calls; with the real locale-sensitive BSD tr in the path
#                        this pin would have baked 1-byte broken bars into the
#                        goldens (plan section 5.1.1).

FLY1678_FIXTURES="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLY1678_SHIM="$FLY1678_FIXTURES/shim"
# Read by the suites that source this file, not here.
# shellcheck disable=SC2034
FLY1678_BASELINE="$FLY1678_FIXTURES/baseline-statusline-command.sh"

# Pinned clock: 2026-08-11T12:00:00Z. Chosen so the snapshot's reset instants land
# on distinguishable branches (today / tmrw / weekday) without drifting.
export FLY1678_FAKE_NOW=1786449600

# The production script hard-codes this outside $HOME (pre-existing; FLY-1678 does
# not change it). The suites assert the harness never creates or touches it.
FLY1678_REAL_LOCK="/tmp/claude-usage-refresh.lock"

FLY1678_FAILURES=0
FLY1678_CHECKS=0

fly1678_pass() { FLY1678_CHECKS=$((FLY1678_CHECKS + 1)); echo "  ok   — $1"; }
fly1678_fail() {
  FLY1678_CHECKS=$((FLY1678_CHECKS + 1))
  FLY1678_FAILURES=$((FLY1678_FAILURES + 1))
  echo "  FAIL — $1"
  [ $# -gt 1 ] && printf '         %s\n' "${@:2}"
  return 0
}
fly1678_check() { # <condition-result 0/1> <description> [detail...]
  if [ "$1" -eq 0 ]; then fly1678_pass "$2"; else shift; fly1678_fail "$@"; fi
}

fly1678_summary() {
  echo
  if [ "$FLY1678_FAILURES" -eq 0 ]; then
    echo "PASS — $FLY1678_CHECKS checks, 0 failures"
    return 0
  fi
  echo "FAIL — $FLY1678_FAILURES of $FLY1678_CHECKS checks failed"
  return 1
}

# --- sandbox -----------------------------------------------------------------

fly1678_setup() {
  FLY1678_SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/fly1678.XXXXXX")"
  export FLY1678_MARKER="$FLY1678_SANDBOX/forbidden-calls.log"
  : > "$FLY1678_MARKER"
  mkdir -p "$FLY1678_SANDBOX/home/.claude"
  printf '%s' '{"oauthAccount":{"emailAddress":"harness@example.test"}}' \
    > "$FLY1678_SANDBOX/home/.claude.json"
  printf '%s' '{"effortLevel":"high"}' > "$FLY1678_SANDBOX/home/.claude/settings.json"

  # Record the real lock's state so we can prove we never touched it.
  if [ -e "$FLY1678_REAL_LOCK" ]; then
    FLY1678_LOCK_BEFORE="present:$(cksum < "$FLY1678_REAL_LOCK" 2>/dev/null || echo unreadable)"
  else
    FLY1678_LOCK_BEFORE="absent"
  fi
}

fly1678_teardown() { [ -n "${FLY1678_SANDBOX:-}" ] && rm -rf "$FLY1678_SANDBOX"; }

# --- rendering ---------------------------------------------------------------

# fly1678_render <script> <cache-content-or-@file> -> stdout in $FLY1678_OUT,
# stderr in $FLY1678_ERR, exit status in $FLY1678_RC.
fly1678_render() {
  local script="$1" cache="$2"
  local home="$FLY1678_SANDBOX/home"
  if [ "${cache:0:1}" = "@" ]; then
    cp "${cache:1}" "$home/.claude/usage-api-cache.json"
  else
    printf '%s' "$cache" > "$home/.claude/usage-api-cache.json"
  fi

  FLY1678_OUT="$FLY1678_SANDBOX/out.bin"
  FLY1678_ERR="$FLY1678_SANDBOX/err.txt"
  # `if` rather than `cmd; rc=$?` so a non-zero render cannot abort a caller
  # running under `set -e` before we get to assert on it.
  if env \
      HOME="$home" \
      PATH="$FLY1678_SHIM:$PATH" \
      TZ=UTC LC_ALL=C \
      FLY1678_FAKE_NOW="$FLY1678_FAKE_NOW" \
      FLY1678_MARKER="$FLY1678_MARKER" \
      /bin/bash "$script" < "$FLY1678_FIXTURES/session.json" \
        > "$FLY1678_OUT" 2> "$FLY1678_ERR"; then
    FLY1678_RC=0
  else
    FLY1678_RC=$?
  fi
}

# Wall-clock of the last render, milliseconds. Used to assert the LAZY traversal
# contract: output alone cannot distinguish a lazy `first(...)` from a map cascade
# that materialises 100k entries and then throws all but one away, because the
# shell only ever consumes the first record either way. Cost is the observable.
fly1678_render_ms() {
  local t0
  t0=$(python3 -c 'import time;print(time.perf_counter())')
  fly1678_render "$1" "$2"
  python3 -c "import time;print(int((time.perf_counter()-$t0)*1000))"
}

fly1678_line() { sed -n "$1p" "$FLY1678_OUT"; }
fly1678_line_count() { wc -l < "$FLY1678_OUT" | tr -d ' '; }

# --- assertions --------------------------------------------------------------

fly1678_assert_clean_run() { # <label>
  fly1678_check "$([ "$FLY1678_RC" -eq 0 ] && echo 0 || echo 1)" \
    "$1: exit 0" "got exit $FLY1678_RC"
  fly1678_check "$([ ! -s "$FLY1678_ERR" ] && echo 0 || echo 1)" \
    "$1: no stderr" "stderr: $(head -c 300 "$FLY1678_ERR")"
}

fly1678_assert_no_forbidden_calls() { # <label>
  # A background refresh would be spawned asynchronously; give it a moment
  # before declaring the absence of a marker, so this can never pass by racing.
  local i=0
  while [ $i -lt 10 ]; do [ -s "$FLY1678_MARKER" ] && break; sleep 0.05; i=$((i + 1)); done
  fly1678_check "$([ ! -s "$FLY1678_MARKER" ] && echo 0 || echo 1)" \
    "$1: no curl/security call" "marker: $(cat "$FLY1678_MARKER")"

  local after
  if [ -e "$FLY1678_REAL_LOCK" ]; then
    after="present:$(cksum < "$FLY1678_REAL_LOCK" 2>/dev/null || echo unreadable)"
  else
    after="absent"
  fi
  fly1678_check "$([ "$after" = "$FLY1678_LOCK_BEFORE" ] && echo 0 || echo 1)" \
    "$1: real /tmp refresh lock untouched" "before=$FLY1678_LOCK_BEFORE after=$after"
}

# Allowlisted control-byte check. The output is DELIBERATELY full of ESC colour
# sequences, so "contains no control bytes" is not a checkable property; and UTF-8
# continuation bytes sit in the numeric C1 range, so a raw byte scan false-positives
# on the bar glyphs. Strip the exact sequences the script emits, decode what is
# left as UTF-8, then reject stray C0/C1 CODE POINTS.
fly1678_assert_no_stray_control() { # <label>
  local detail rc
  detail=$(python3 - "$FLY1678_OUT" <<'PY'
import re, sys
data = open(sys.argv[1], "rb").read()
try:
    text = data.decode("utf-8")
except UnicodeDecodeError as exc:
    print(f"output is not valid UTF-8: {exc}"); sys.exit(1)
ALLOWED = r"\x1b\[(?:0|2|32|33|35|36|90|91)m"
stripped = re.sub(ALLOWED, "", text)
bad = [(i, hex(ord(c))) for i, c in enumerate(stripped)
       if c != "\n" and (ord(c) < 0x20 or 0x7f <= ord(c) <= 0x9f)]
if bad:
    print(f"stray control code points after stripping known ANSI: {bad[:8]}"); sys.exit(1)
sys.exit(0)
PY
  ) && rc=0 || rc=1
  if [ "$rc" -eq 0 ]; then
    fly1678_pass "$1: only allowlisted ANSI, no stray control code points"
  else
    fly1678_fail "$1: stray control code points" "$detail"
  fi
}

# The MODEL bar must show the exact fill for its percentage, not merely "a bar".
# Counting glyph runs is not enough: forcing the model call to `make_bar 0` left
# the whole suite passing, because ten empty cells is still ten cells.
fly1678_assert_model_bar() { # <label> <expected-filled-cells>
  local detail rc
  detail=$(python3 - "$FLY1678_OUT" "$2" <<'PY'
import re, sys
text = open(sys.argv[1], "rb").read().decode("utf-8")
want_filled = int(sys.argv[2])
lines = text.rstrip("\n").split("\n")
if len(lines) < 2:
    print(f"expected two rendered lines, got {len(lines)}"); sys.exit(1)
bars = re.findall(r"[▓░]+", lines[1])          # line 2 only: 5h, 7d, model
if len(bars) != 3:
    print(f"expected 3 bars on line 2, found {len(bars)}"); sys.exit(1)
want = "▓" * want_filled + "░" * (10 - want_filled)
if bars[2] != want:
    print(f"model bar is {bars[2]!r}, expected {want!r}"); sys.exit(1)
sys.exit(0)
PY
  ) && rc=0 || rc=1
  if [ "$rc" -eq 0 ]; then
    fly1678_pass "$1: model bar is exactly $2/10 filled"
  else
    fly1678_fail "$1: model bar fill wrong" "$detail"
  fi
}

# Every rendered 10-cell bar must be valid UTF-8 made of exactly U+2593 / U+2591.
fly1678_assert_bar_bytes() { # <label> <expected-bar-count>
  local detail rc
  detail=$(python3 - "$FLY1678_OUT" "$2" <<'PY'
import re, sys
data = open(sys.argv[1], "rb").read()
expected = int(sys.argv[2])
try:
    text = data.decode("utf-8")
except UnicodeDecodeError as exc:
    print(f"output is not valid UTF-8 (lone 0xe2 bar bytes?): {exc}"); sys.exit(1)
bars = re.findall(r"[▓░]+", text)
if len(bars) != expected:
    print(f"expected {expected} bars, found {len(bars)}: {[len(b) for b in bars]}"); sys.exit(1)
wrong = [b for b in bars if len(b) != 10]
if wrong:
    print(f"bars not 10 cells wide: {[len(b) for b in wrong]}"); sys.exit(1)
sys.exit(0)
PY
  ) && rc=0 || rc=1
  if [ "$rc" -eq 0 ]; then
    fly1678_pass "$1: $2 bars, each 10 cells of exact U+2593/U+2591, valid UTF-8"
  else
    fly1678_fail "$1: bar bytes wrong" "$detail"
  fi
}
