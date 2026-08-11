#!/usr/bin/env bash
# FLY-1678 — regenerate the zero-regression goldens.
#
# The ruler is baseline-statusline-command.sh: a FROZEN copy of the script as it
# was BEFORE this issue's functional change. Never point this at the live
# scripts/statusline-command.sh — that would regenerate the goldens from the code
# under test and silently delete the regression contract.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/__tests__/fixtures/fly1678/harness.sh
source "$HERE/harness.sh"
set +u; fly1678_setup; set -u
fly1678_render "$FLY1678_BASELINE" "@$HERE/cache/live-snapshot-20260810.json"
[ "$FLY1678_RC" -eq 0 ] || { echo "baseline render failed" >&2; exit 1; }
# Goldens are stored WITHOUT their trailing newline so the suite can assert
# "line 2 begins with exactly these bytes, then the new separator".
sed -n '1p' "$FLY1678_OUT" | perl -0pe 's/\n\z//' > "$HERE/golden/line1.bin"
sed -n '2p' "$FLY1678_OUT" | perl -0pe 's/\n\z//' > "$HERE/golden/line2-prefix.bin"
fly1678_teardown
echo "goldens regenerated from the frozen baseline:"
wc -c "$HERE/golden/line1.bin" "$HERE/golden/line2-prefix.bin"
