#!/bin/bash
# FLY-1402: independently verify the Lead rules bundle loading chain.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${SCRIPT_DIR}/check-rules-truth.mjs" "$@"
