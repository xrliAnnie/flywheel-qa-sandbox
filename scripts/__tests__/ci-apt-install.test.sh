#!/usr/bin/env bash
# FLY-1905: hermetic contract for the bounded CI apt installer. The helper is
# exercised behind a sealed PATH so host-preinstalled packages cannot make a
# missing/broken-package scenario pass accidentally.

set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/scripts/ci-apt-install.sh"
REAL_BASH="${BASH:-/bin/bash}"
REAL_TIMEOUT="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"

if [[ -z "$REAL_TIMEOUT" ]]; then
  printf '[FAIL] GNU timeout is required (install coreutils for gtimeout on macOS)\n' >&2
  exit 1
fi

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  printf '[PASS] %s\n' "$1"
}

fail() {
  FAILED=$((FAILED + 1))
  printf '[FAIL] %s\n' "$1" >&2
}

assert_rc() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$expected" == "zero" && "$actual" -eq 0 ]] \
    || [[ "$expected" == "nonzero" && "$actual" -ne 0 ]]; then
    return 0
  fi
  fail "$label (rc=$actual, expected $expected)"
  return 1
}

make_tool() {
  local package="$1" version="$2" behavior="${3:-ok}" target="$BIN"
  case "$package" in
    tmux) target="$BIN/tmux" ;;
    lsof) target="$BIN/lsof" ;;
    sqlite3) target="$BIN/sqlite3" ;;
    ripgrep|rg) target="$BIN/rg" ;;
    *) fail "test fixture requested unknown package: $package"; return 1 ;;
  esac

  case "$behavior" in
    broken)
      printf '#!/bin/sh\nprintf "broken %s\\n" >&2\nexit 1\n' "$package" >"$target"
      ;;
    unparseable)
      printf '#!/bin/sh\nprintf "version unavailable\\n"\nexit 0\n' >"$target"
      ;;
    ok)
      case "$package" in
        tmux) printf '#!/bin/sh\nprintf "tmux %s\\n"\n' "$version" >"$target" ;;
        lsof) printf '#!/bin/sh\nprintf "lsof version information:\\n    revision: %s\\n" >&2\n' "$version" >"$target" ;;
        sqlite3) printf '#!/bin/sh\nprintf "%s 2026-01-01 00:00:00 fixture\\n"\n' "$version" >"$target" ;;
        ripgrep|rg) printf '#!/bin/sh\nprintf "ripgrep %s\\n"\n' "$version" >"$target" ;;
      esac
      ;;
  esac
  chmod +x "$target"
}

setup_case() {
  local name="$1"
  CASE_DIR="$SANDBOX/$name"
  BIN="$CASE_DIR/bin"
  APT_LOG="$CASE_DIR/apt.log"
  SUDO_LOG="$CASE_DIR/sudo.log"
  APT_STATE="$CASE_DIR/apt.state"
  MIRROR_FILE="$CASE_DIR/apt-mirrors.txt"
  OUT="$CASE_DIR/stdout"
  ERR="$CASE_DIR/stderr"
  mkdir -p "$BIN"
  : >"$APT_LOG"
  : >"$SUDO_LOG"
  printf 'http://azure.archive.ubuntu.com/ubuntu\n' >"$MIRROR_FILE"

  ln -s "$REAL_TIMEOUT" "$BIN/timeout"
  ln -s "$(command -v tee)" "$BIN/tee"
  ln -s "$(command -v chmod)" "$BIN/chmod"
  ln -s "$(command -v sleep)" "$BIN/sleep"

  cat >"$BIN/sudo" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$SUDO_LOG"
exec "$@"
SH
  chmod +x "$BIN/sudo"

  cat >"$BIN/apt-get" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >>"$APT_LOG"

write_good_tool() {
  case "$1" in
    tmux)
      printf '#!/bin/sh\nprintf "tmux 3.5a\\n"\n' >"$STUB_BIN/tmux"
      chmod +x "$STUB_BIN/tmux"
      ;;
    lsof)
      printf '#!/bin/sh\nprintf "lsof version information:\\n    revision: 4.95.0\\n" >&2\n' >"$STUB_BIN/lsof"
      chmod +x "$STUB_BIN/lsof"
      ;;
    sqlite3)
      printf '#!/bin/sh\nprintf "3.45.1 2026-01-01 fixture\\n"\n' >"$STUB_BIN/sqlite3"
      chmod +x "$STUB_BIN/sqlite3"
      ;;
    ripgrep)
      printf '#!/bin/sh\nprintf "ripgrep 14.1.0\\n"\n' >"$STUB_BIN/rg"
      chmod +x "$STUB_BIN/rg"
      ;;
  esac
}

write_broken_rg() {
  printf '#!/bin/sh\nprintf "broken rg\\n" >&2\nexit 1\n' >"$STUB_BIN/rg"
  chmod +x "$STUB_BIN/rg"
}

write_unparseable_rg() {
  printf '#!/bin/sh\nprintf "version unavailable\\n"\nexit 0\n' >"$STUB_BIN/rg"
  chmod +x "$STUB_BIN/rg"
}

install_requested_tools() {
  for arg in "$@"; do
    case "$arg" in
      tmux|lsof|sqlite3|ripgrep) write_good_tool "$arg" ;;
    esac
  done
}

case "$APT_MODE" in
  fast-success)
    case " $* " in
      *' install '*) install_requested_tools "$@" ;;
    esac
    exit 0
    ;;
  stall)
    trap '' TERM
    while :; do sleep 1; done
    ;;
  lock-fail)
    printf 'E: Could not get lock /var/lib/dpkg/lock-frontend\n' >&2
    exit 100
    ;;
  fallback-success)
    case " $* " in
      *' update '*) : >"$APT_STATE"; exit 0 ;;
      *' install '*)
        if [ -f "$APT_STATE" ]; then install_requested_tools "$@"; exit 0; fi
        exit 100
        ;;
    esac
    ;;
  success-no-install)
    exit 0
    ;;
  reinstall-repairs)
    case " $* " in
      *' install '*' --reinstall '*) install_requested_tools "$@" ;;
    esac
    exit 0
    ;;
  stale-index)
    case " $* " in
      *' update '*) : >"$APT_STATE"; exit 0 ;;
      *' install '*)
        if [ -f "$APT_STATE" ]; then install_requested_tools "$@"; fi
        exit 0
        ;;
    esac
    ;;
  fallback-broken)
    case " $* " in
      *' update '*) : >"$APT_STATE"; exit 0 ;;
      *' install '*)
        if [ -f "$APT_STATE" ]; then write_broken_rg; exit 0; fi
        exit 100
        ;;
    esac
    ;;
  install-unparseable)
    case " $* " in
      *' update '*) : >"$APT_STATE" ;;
      *' install '*) write_unparseable_rg ;;
    esac
    exit 0
    ;;
  *)
    printf 'unknown APT_MODE=%s\n' "$APT_MODE" >&2
    exit 98
    ;;
esac
SH
  chmod +x "$BIN/apt-get"
}

run_helper() {
  local mode="$1"
  shift
  PATH="$BIN" \
    APT_MODE="$mode" \
    APT_LOG="$APT_LOG" \
    SUDO_LOG="$SUDO_LOG" \
    APT_STATE="$APT_STATE" \
    STUB_BIN="$BIN" \
    "$REAL_BASH" "$HELPER" "$@" >"$OUT" 2>"$ERR"
  RUN_RC=$?
}

setup_case t1-healthy
make_tool tmux 3.5a
make_tool lsof 4.95.0
make_tool sqlite3 3.45.1
make_tool ripgrep 14.1.0
run_helper fast-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" tmux lsof sqlite3 ripgrep
if assert_rc zero "$RUN_RC" "T1 healthy tools should verify" && [[ ! -s "$APT_LOG" ]]; then
  pass "T1 healthy verified tools skip apt entirely"
else
  [[ -s "$APT_LOG" ]] && fail "T1 unexpectedly called apt: $(<"$APT_LOG")"
fi

setup_case t2-fast-install
make_tool tmux 3.5a
make_tool lsof 4.95.0
make_tool sqlite3 3.45.1
run_helper fast-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" tmux lsof sqlite3 ripgrep
install_line="$(grep '^install ' "$APT_LOG" 2>/dev/null || true)"
if assert_rc zero "$RUN_RC" "T2 fast install should succeed" \
  && [[ -n "$install_line" && "$install_line" == *'--reinstall'* && "$install_line" == *'--no-install-recommends'* ]] \
  && [[ "$install_line" == *'DPkg::Lock::Timeout=60'* && "$install_line" == *'Acquire::Retries=2'* ]] \
  && [[ "$install_line" == *'Acquire::http::Timeout=15'* && "$install_line" == *'Acquire::https::Timeout=15'* ]] \
  && [[ "$install_line" == *' ripgrep'* && "$install_line" != *' tmux'* && "$install_line" != *' lsof'* && "$install_line" != *' sqlite3'* ]] \
  && ! grep -q '^update ' "$APT_LOG" \
  && grep -q 'timeout --kill-after=10 2 apt-get' "$SUDO_LOG"; then
  pass "T2 fast path installs only missing rg with bounded canonical argv"
else
  fail "T2 argv mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] sudo=[$(<"$SUDO_LOG")] err=[$(<"$ERR")]"
fi

setup_case t3-stall
make_tool tmux 3.5a
make_tool lsof 4.95.0
make_tool sqlite3 3.45.1
PATH="$BIN" APT_MODE=stall APT_LOG="$APT_LOG" SUDO_LOG="$SUDO_LOG" APT_STATE="$APT_STATE" STUB_BIN="$BIN" \
  "$REAL_TIMEOUT" --kill-after=2 35 "$REAL_BASH" "$HELPER" --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep >"$OUT" 2>"$ERR"
RUN_RC=$?
if [[ "$RUN_RC" -ne 0 && "$RUN_RC" -ne 124 && "$RUN_RC" -ne 137 ]] \
  && [[ -s "$APT_LOG" ]] \
  && grep -q 'phase=fallback-update' "$ERR"; then
  pass "T3 mirror stall is killed by helper before independent watchdog"
else
  fail "T3 helper did not fail-fast itself rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t4-lock
run_helper lock-fail --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc nonzero "$RUN_RC" "T4 lock failure should be fatal" \
  && grep -q 'Could not get lock' "$ERR" \
  && grep -q 'phase=fallback-update' "$ERR" \
  && grep -q 'DPkg::Lock::Timeout=60' "$APT_LOG"; then
  pass "T4 dpkg lock failure is bounded and diagnosed"
else
  fail "T4 lock diagnostics missing rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t5-fallback
run_helper fallback-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc zero "$RUN_RC" "T5 fallback should recover" \
  && [[ "$(grep -c '^update ' "$APT_LOG" || true)" -eq 1 ]] \
  && grep -qx 'http://archive.ubuntu.com/ubuntu' "$MIRROR_FILE"; then
  pass "T5 fast failure swaps mirror and recovers through one update"
else
  fail "T5 fallback mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] mirror=[$(<"$MIRROR_FILE")] err=[$(<"$ERR")]"
fi

setup_case t6-unknown
run_helper fast-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" curl
if assert_rc nonzero "$RUN_RC" "T6 unknown package should fail" && [[ ! -s "$APT_LOG" && ! -s "$SUDO_LOG" ]]; then
  pass "T6 unknown package fails closed before privileged calls"
else
  fail "T6 invoked privileged path rc=$RUN_RC apt=[$(<"$APT_LOG")] sudo=[$(<"$SUDO_LOG")]"
fi

setup_case t7-false-success
run_helper success-no-install --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc nonzero "$RUN_RC" "T7 apt false-success should fail" \
  && grep -q 'phase=verify' "$ERR" \
  && grep -q '^update ' "$APT_LOG"; then
  pass "T7 apt success without a usable binary cannot false-green"
else
  fail "T7 terminal verification missing rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t8-no-mirror-file
missing_mirror="$CASE_DIR/absent-mirrors.txt"
run_helper fallback-success --timeout-secs 2 --mirror-file "$missing_mirror" ripgrep
if assert_rc zero "$RUN_RC" "T8 missing mirror file should still fallback" \
  && grep -q 'phase=mirror-swap.*status=skipped' "$ERR" \
  && grep -q '^update ' "$APT_LOG"; then
  pass "T8 absent mirror file skips swap but still updates and installs"
else
  fail "T8 no-file fallback mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t9-broken
make_tool ripgrep 14.1.0 broken
run_helper reinstall-repairs --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc zero "$RUN_RC" "T9 broken binary should be repaired" \
  && grep -q 'phase=probe.*package=ripgrep.*probe-failed' "$ERR" \
  && grep -q -- '--reinstall' "$APT_LOG"; then
  pass "T9 installed-but-broken binary is reinstalled and reverified"
else
  fail "T9 repair chain mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t10-old-version
make_tool ripgrep 12.0.0
run_helper fast-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc zero "$RUN_RC" "T10 old version should be upgraded" \
  && grep -q 'phase=probe.*package=ripgrep.*version=12.0.*minimum=' "$ERR" \
  && grep -q -- '--reinstall' "$APT_LOG"; then
  pass "T10 below-floor version is diagnosed, reinstalled, and reverified"
else
  fail "T10 version repair mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t11-terminal-broken
run_helper fallback-broken --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc nonzero "$RUN_RC" "T11 broken fallback result should fail" && grep -q 'phase=verify' "$ERR"; then
  pass "T11 terminal verification rejects a still-broken binary"
else
  fail "T11 terminal verification mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t12-stale-index
run_helper stale-index --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if assert_rc zero "$RUN_RC" "T12 stale index should recover" \
  && grep -q 'phase=fast-verify' "$ERR" \
  && [[ "$(grep -c '^update ' "$APT_LOG" || true)" -eq 1 ]]; then
  pass "T12 failed fast verification reaches refreshed-index fallback"
else
  fail "T12 stale-index recovery mismatch rc=$RUN_RC apt=[$(<"$APT_LOG")] err=[$(<"$ERR")]"
fi

setup_case t13-argv
invalid_calls=(
  '--timeout-secs 0 ripgrep'
  '--timeout-secs -1 ripgrep'
  '--timeout-secs nope ripgrep'
  '--timeout-secs 121 ripgrep'
  '--timeout-secs'
  '--mirror-file'
  '--unknown ripgrep'
  ''
)
t13_ok=1
for invalid in "${invalid_calls[@]}"; do
  : >"$APT_LOG"
  : >"$SUDO_LOG"
  # Intentional word splitting: each fixture is a CLI token sequence.
  # shellcheck disable=SC2086
  run_helper fast-success $invalid
  if [[ "$RUN_RC" -eq 0 || -s "$APT_LOG" || -s "$SUDO_LOG" ]]; then
    t13_ok=0
  fi
done
: >"$APT_LOG"
: >"$SUDO_LOG"
run_helper fast-success --mirror-file '' ripgrep
if [[ "$RUN_RC" -eq 0 || -s "$APT_LOG" || -s "$SUDO_LOG" ]]; then
  t13_ok=0
fi
if [[ "$t13_ok" -eq 1 ]]; then
  pass "T13 invalid argv is rejected before all sudo/apt calls"
else
  fail "T13 unsafe argv reached privileged path"
fi

setup_case t14-formats
make_tool tmux 3.5a
make_tool lsof 4.95.0
run_helper fast-success --timeout-secs 2 --mirror-file "$MIRROR_FILE" tmux lsof
t14a_rc=$RUN_RC
t14a_apt="$(<"$APT_LOG")"
setup_case t14-unparseable
make_tool ripgrep 14.1.0 unparseable
run_helper install-unparseable --timeout-secs 2 --mirror-file "$MIRROR_FILE" ripgrep
if [[ "$t14a_rc" -eq 0 && -z "$t14a_apt" && "$RUN_RC" -ne 0 ]] \
  && grep -q 'phase=probe.*version-unparseable' "$ERR" \
  && grep -q 'phase=verify' "$ERR"; then
  pass "T14 real tmux/lsof formats parse; unparseable version fails closed"
else
  fail "T14 parser mismatch healthy_rc=$t14a_rc healthy_apt=[$t14a_apt] bad_rc=$RUN_RC err=[$(<"$ERR")]"
fi

printf '\nci-apt-install.test: %s passed, %s failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
