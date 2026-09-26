#!/usr/bin/env bash
# FLY-1775: scrub ambient production coordinates at generalized QA boundaries.
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=qa-generalized.sh
source "${WRAPPER_DIR}/qa-generalized.sh"

[[ $# -gt 0 ]] || { echo '[qa-generalized] Bridge command required' >&2; exit 64; }
dispatcher_env=""
if [[ "${1:-}" == --alert-dispatcher-env ]]; then
  dispatcher_env="${2:?dispatcher variable required}"; shift 2
fi
[[ $# -gt 0 ]] || exit 64
qa_generalized_assert_ambient_scrubbed "$dispatcher_env"
exec "$@"
