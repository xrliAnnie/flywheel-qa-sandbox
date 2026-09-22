#!/bin/bash
# Public fail-closed entrypoint for the shared carrier and cmux visibility
# contract. Keep this as a substantive managed script rather than a tiny shim:
# converge-flywheel-bin validates its source before replacing production bytes,
# and a missing helper must remain an explicit inconclusive result (exit 2),
# never a fabricated pass or an identity mismatch.
set -uo pipefail

_agent_visibility_source_dir() {
  local source="${BASH_SOURCE[0]}" directory target hops=0
  while [[ -L "$source" ]]; do
    hops=$((hops + 1)); (( hops <= 32 )) || return 1
    directory="$(cd -P "$(dirname "$source")" && pwd)" || return 1
    target="$(readlink "$source")" || return 1
    case "$target" in /*) source="$target" ;; *) source="$directory/$target" ;; esac
  done
  cd -P "$(dirname "$source")" && pwd
}
AV_SCRIPT_DIR="$(_agent_visibility_source_dir)" || exit 2
unset -f _agent_visibility_source_dir
if [[ ! -r "$AV_SCRIPT_DIR/lib/agent-visibility.sh" ]]; then
  echo "verify-agent-visibility: helper unavailable" >&2
  exit 2
fi
# shellcheck source=lib/agent-visibility.sh
source "$AV_SCRIPT_DIR/lib/agent-visibility.sh"
agent_visibility_main "$@"
rc=$?
if [[ "$rc" == 64 ]]; then
  echo "usage: verify-agent-visibility.sh --project P (--lead L|--exec-id UUID) --level carrier|visible [--json]" >&2
fi
exit "$rc"
