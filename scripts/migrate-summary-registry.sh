#!/usr/bin/env bash
# FLY-2030: data-first summary assignment migration under the existing
# projects-config write lock. The CLI refuses mutation unless this wrapper's
# lock-held receipt is present.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <projects.json> <assignments.json> <receipt.json> <expected-sha256>" >&2
  exit 64
fi

PROJECTS_PATH="$1"
ASSIGNMENTS_PATH="$2"
RECEIPT_PATH="$3"
EXPECTED_SHA256="$4"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOCK_PATH="${FLYWHEEL_CONFIG_LOCK_FILE:-${PROJECTS_PATH}.cfglock}"
LOCK_DEADLINE="${FLYWHEEL_CONFIG_LOCK_DEADLINE:-5}"

if [[ -z "${FLYWHEEL_COMM_CLI:-}" ]]; then
  HOST_CONFIG_LIB="${SCRIPT_DIR}/lib/host-config.sh"
  if [[ -f "$HOST_CONFIG_LIB" && ! -L "$HOST_CONFIG_LIB" ]]; then
    # shellcheck source=lib/host-config.sh
    source "$HOST_CONFIG_LIB"
    host_config_load || exit $?
    DIST_CLI="${FLYWHEEL_DIR}/packages/flywheel-comm/dist/index.js"
    if [[ -f "$DIST_CLI" && ! -L "$DIST_CLI" ]]; then
      FLYWHEEL_COMM_CLI="$DIST_CLI"
      DIST_VALIDATOR="${FLYWHEEL_DIR}/packages/teamlead/dist/bin/validate-projects.js"
      if [[ -z "${FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR:-}" \
        && -f "$DIST_VALIDATOR" && ! -L "$DIST_VALIDATOR" ]]; then
        export FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR="$DIST_VALIDATOR"
      fi
    fi
  fi
fi

if [[ -n "${FLYWHEEL_COMM_CLI:-}" ]]; then
  exec "${SCRIPT_DIR}/flywheel-config-lock.sh" "$LOCK_PATH" "$LOCK_DEADLINE" \
    env FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
    node "$FLYWHEEL_COMM_CLI" summary-registry migrate \
      --projects-file "$PROJECTS_PATH" \
      --assignments-file "$ASSIGNMENTS_PATH" \
      --receipt-file "$RECEIPT_PATH" \
      --expected-sha256 "$EXPECTED_SHA256"
fi

exec "${SCRIPT_DIR}/flywheel-config-lock.sh" "$LOCK_PATH" "$LOCK_DEADLINE" \
  env FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD=1 \
  pnpm --dir "$REPO_ROOT" exec tsx \
    packages/flywheel-comm/src/bin/summary-registry.ts migrate \
      --projects-file "$PROJECTS_PATH" \
      --assignments-file "$ASSIGNMENTS_PATH" \
      --receipt-file "$RECEIPT_PATH" \
      --expected-sha256 "$EXPECTED_SHA256"
