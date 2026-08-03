#!/usr/bin/env bash
# FLY-1608: the FLY-1502 v2 guard must resolve from the Lead package, never
# from the caller's cwd. Hermetic HOME keeps production cutover authority out.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LEAD_SCRIPT="${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh"
SANDBOX="$(mktemp -d /tmp/fly1608-lead-guard-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "${SANDBOX}/home"

NODE_BIN_DIR="$(dirname "$(command -v node)")"
BASH_BIN_DIR="$(dirname "$(command -v bash)")"
SAFE_PATH="${NODE_BIN_DIR}:${BASH_BIN_DIR}:/usr/bin:/bin:/usr/sbin:/sbin"

run_case() {
  local name="$1" cwd="$2"
  local stdout="${SANDBOX}/${name}.stdout"
  local stderr="${SANDBOX}/${name}.stderr"
  local combined="${SANDBOX}/${name}.combined"

  if (
    cd "$cwd"
    env -i \
      HOME="${SANDBOX}/home" \
      PATH="$SAFE_PATH" \
      FLYWHEEL_LEAD_DRY_RUN=0 \
      bash "$LEAD_SCRIPT" >"$stdout" 2>"$stderr"
  ); then
    echo "FAIL: ${name}: no-argument launcher should stop at usage validation" >&2
    return 1
  fi

  cp "$stdout" "$combined"
  printf '\n' >> "$combined"
  sed -n '1,240p' "$stderr" >> "$combined"
  if ! grep -q "Usage:" "$combined"; then
    echo "FAIL: ${name}: guard did not pass through to argument validation" >&2
    sed -n '1,160p' "$combined" >&2
    return 1
  fi
  if grep -q "ERR_MODULE_NOT_FOUND" "$combined"; then
    echo "FAIL: ${name}: guard resolved flywheel-v2-kernel from caller cwd" >&2
    sed -n '1,160p' "$combined" >&2
    return 1
  fi
  echo "PASS: ${name}: guard is caller-cwd independent"
}

run_case repo-root "$REPO_ROOT"
run_case unrelated-dir "$SANDBOX"
