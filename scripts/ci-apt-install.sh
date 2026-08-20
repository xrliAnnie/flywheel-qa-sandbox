#!/usr/bin/env bash
# FLY-1905: verify CI tools before skipping installation, and bound every apt
# call when installation is genuinely required.

set -euo pipefail

TIMEOUT_SECS=120
MIRROR_FILE=/etc/apt/apt-mirrors.txt
PACKAGES=()

usage() {
  printf '%s\n' \
    'usage: ci-apt-install.sh [--timeout-secs N] [--mirror-file PATH] <tmux|lsof|sqlite3|ripgrep>...' >&2
}

log() {
  printf '[ci-apt-install] %s\n' "$*" >&2
}

die_argv() {
  log "phase=argv status=error reason=$1"
  usage
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --timeout-secs)
      (($# >= 2)) || die_argv 'missing-timeout-value'
      TIMEOUT_SECS="$2"
      shift 2
      ;;
    --mirror-file)
      (($# >= 2)) || die_argv 'missing-mirror-file-value'
      [[ -n "$2" ]] || die_argv 'empty-mirror-file-value'
      MIRROR_FILE="$2"
      shift 2
      ;;
    --*)
      die_argv "unknown-option:$1"
      ;;
    *)
      PACKAGES+=("$1")
      shift
      ;;
  esac
done

[[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]] || die_argv 'timeout-must-be-positive-integer'
((TIMEOUT_SECS <= 120)) || die_argv 'timeout-exceeds-120-seconds'
((${#PACKAGES[@]} > 0)) || die_argv 'empty-package-list'

# Validate and deduplicate the full request before probing or invoking sudo.
REQUESTED=()
for package in "${PACKAGES[@]}"; do
  case "$package" in
    tmux|lsof|sqlite3|ripgrep) ;;
    *) die_argv "unknown-package:$package" ;;
  esac
  case " ${REQUESTED[*]-} " in
    *" $package "*) ;;
    *) REQUESTED+=("$package") ;;
  esac
done

package_spec() {
  case "$1" in
    tmux)
      BINARY=tmux
      MIN_MAJOR=3
      MIN_MINOR=2
      # Ubuntu 22.04's tmux 3.2a is the oldest supported GitHub LTS image
      # baseline and supports the real-session/socket options used by the suites.
      ;;
    lsof)
      BINARY=lsof
      MIN_MAJOR=4
      MIN_MINOR=93
      # Ubuntu 22.04's lsof 4.93 supports the -a/-d cwd/-F probes used by the
      # worktree reaper; keeping that LTS floor avoids a purely cosmetic update.
      ;;
    sqlite3)
      BINARY=sqlite3
      MIN_MAJOR=3
      MIN_MINOR=37
      # Ubuntu 22.04's SQLite 3.37 covers URI filenames, UPSERT/RETURNING,
      # STRICT tables, and the CLI timeout/batch options exercised in scripts.
      ;;
    ripgrep)
      BINARY=rg
      MIN_MAJOR=13
      MIN_MINOR=0
      # Ubuntu 22.04's ripgrep 13 supports the --files/--hidden/PCRE2/source
      # anchor options used by the shell contract suites.
      ;;
  esac
  MIN_VERSION="$MIN_MAJOR.$MIN_MINOR"
}

probe_package() {
  local phase="$1" package="$2" output rc major minor
  package_spec "$package"

  if ! command -v "$BINARY" >/dev/null 2>&1; then
    log "phase=$phase package=$package reason=binary-missing binary=$BINARY"
    return 1
  fi

  rc=0
  case "$package" in
    tmux)
      output="$(tmux -V 2>&1)" || rc=$?
      ;;
    lsof)
      output="$(lsof -v 2>&1)" || rc=$?
      ;;
    sqlite3)
      output="$(sqlite3 --version 2>&1)" || rc=$?
      ;;
    ripgrep)
      output="$(rg --version 2>&1)" || rc=$?
      ;;
  esac

  if ((rc != 0)); then
    log "phase=$phase package=$package reason=probe-failed rc=$rc"
    return 1
  fi

  if [[ ! "$output" =~ ([0-9]+)\.([0-9]+) ]]; then
    log "phase=$phase package=$package reason=version-unparseable"
    return 1
  fi

  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  if ((major > MIN_MAJOR || (major == MIN_MAJOR && minor >= MIN_MINOR))); then
    log "phase=$phase package=$package version=$major.$minor minimum=$MIN_VERSION status=ok"
    return 0
  fi

  log "phase=$phase package=$package version=$major.$minor minimum=$MIN_VERSION status=below-minimum"
  return 1
}

MISSING=()
for package in "${REQUESTED[@]}"; do
  if ! probe_package probe "$package"; then
    MISSING+=("$package")
  fi
done

if ((${#MISSING[@]} == 0)); then
  log 'phase=complete status=ok apt_calls=0'
  exit 0
fi

APT_OPTIONS=(
  -o DPkg::Lock::Timeout=60
  -o Acquire::Retries=2
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
)

run_install() {
  sudo timeout --kill-after=10 "$TIMEOUT_SECS" \
    apt-get install -y --reinstall --no-install-recommends \
    "${APT_OPTIONS[@]}" "$@"
}

run_update() {
  sudo timeout --kill-after=10 "$TIMEOUT_SECS" \
    apt-get update "${APT_OPTIONS[@]}"
}

fast_install_ok=0
if run_install "${MISSING[@]}"; then
  fast_install_ok=1
else
  fast_rc=$?
  log "phase=fast-install packages=${MISSING[*]} status=failed rc=$fast_rc"
fi

if ((fast_install_ok == 1)); then
  fast_verify_ok=1
  for package in "${MISSING[@]}"; do
    if ! probe_package fast-verify "$package"; then
      fast_verify_ok=0
    fi
  done
  if ((fast_verify_ok == 1)); then
    log "phase=fast-install packages=${MISSING[*]} status=ok"
    exit 0
  fi
  log "phase=fast-verify packages=${MISSING[*]} status=failed action=fallback"
fi

if [[ -f "$MIRROR_FILE" ]]; then
  if printf '%s\n' 'http://archive.ubuntu.com/ubuntu' | sudo tee "$MIRROR_FILE" >/dev/null; then
    log "phase=mirror-swap status=ok file=$MIRROR_FILE mirror=http://archive.ubuntu.com/ubuntu"
  else
    mirror_rc=$?
    log "phase=mirror-swap status=failed file=$MIRROR_FILE rc=$mirror_rc"
    exit 1
  fi
else
  log "phase=mirror-swap status=skipped reason=file-missing file=$MIRROR_FILE"
fi

if run_update; then
  log 'phase=fallback-update status=ok'
else
  update_rc=$?
  log "phase=fallback-update packages=${MISSING[*]} status=failed rc=$update_rc"
  exit 1
fi

if run_install "${MISSING[@]}"; then
  log "phase=fallback-install packages=${MISSING[*]} status=ok"
else
  install_rc=$?
  log "phase=fallback-install packages=${MISSING[*]} status=failed rc=$install_rc"
  exit 1
fi

verify_ok=1
for package in "${REQUESTED[@]}"; do
  if ! probe_package verify "$package"; then
    verify_ok=0
  fi
done

if ((verify_ok == 0)); then
  log "phase=verify packages=${REQUESTED[*]} status=failed"
  exit 1
fi

log "phase=verify packages=${REQUESTED[*]} status=ok"
