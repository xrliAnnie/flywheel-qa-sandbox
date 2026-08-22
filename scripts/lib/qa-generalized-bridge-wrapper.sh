#!/usr/bin/env bash
# FLY-1775: scrub ambient production coordinates at generalized QA boundaries.
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=qa-generalized.sh
source "${WRAPPER_DIR}/qa-generalized.sh"

[[ $# -gt 0 ]] || { echo '[qa-generalized] Bridge command required' >&2; exit 64; }
qa_generalized_assert_ambient_scrubbed
exec "$@"
