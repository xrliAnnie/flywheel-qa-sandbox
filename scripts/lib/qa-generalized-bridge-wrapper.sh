#!/usr/bin/env bash
# FLY-1775: Bridge exec-boundary attestation for generalized 529 rooms.
set -euo pipefail

WRAPPER_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=qa-generalized.sh
source "${WRAPPER_DIR}/qa-generalized.sh"

ATTESTATION_PATH="${1:?attestation path required}"
shift
[[ $# -gt 0 ]] || { echo '[qa-generalized] Bridge command required' >&2; exit 64; }
qa_generalized_assert_ambient_scrubbed
qa_generalized_write_env_attestation "$ATTESTATION_PATH"
exec "$@"
