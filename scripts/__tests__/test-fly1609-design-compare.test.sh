#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT="$(python3 "$REPO_ROOT/engineering/doc/FLY-1458-abc-prompt-three-arm-analysis/scripts/design_compare.py" --self-test)"

grep -q "SELF-TEST PASS" <<<"$OUTPUT"
printf '%s\n' "$OUTPUT"
