#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/supervisor.sh
source "$SELF_DIR/lib/supervisor.sh"

wrapper="$SELF_DIR/flywheel-bridge-wrapper.sh"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wrapper)
      [[ $# -ge 2 ]] || { echo "ERROR: --wrapper requires an absolute path" >&2; exit 2; }
      wrapper="$2"
      shift 2
      ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -x "$wrapper" ]] || { echo "ERROR: Bridge wrapper is not executable: $wrapper" >&2; exit 1; }
spec="$(supervisor_bridge_spec "$wrapper")"
FLYWHEEL_SUPERVISOR_BACKEND=launchd \
FLYWHEEL_SUPERVISOR_DARWIN_INSTALL=1 \
  supervisor_install "$spec"
FLYWHEEL_SUPERVISOR_BACKEND=launchd supervisor_assert_keepalive bridge \
  || { echo "ERROR: com.flywheel.bridge did not load with KeepAlive=true" >&2; exit 1; }
echo "Bridge launchd job installed: com.flywheel.bridge"
