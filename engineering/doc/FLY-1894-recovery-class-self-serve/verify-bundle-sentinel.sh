#!/usr/bin/env bash
# FLY-1894 — assert against a REALLY MATERIALIZED bundle.
#
# Head-bound code review R4: the previous version said it checked the materialized
# bundle but only called compute_lead_rule_bundle and then grepped the source files,
# so a materializer that dropped a file or corrupted its output would still pass.
# This version calls rules_bundle_materialize and counts occurrences in the ONE
# produced artifact.
#
# Still NOT proven here: that any running Lead loaded this bundle. That needs the
# deployed commit, a Lead restart and a live receipt.
set -uo pipefail
cd /Users/xiaorongli/Dev/flywheel-FLY-1894 || exit 1

BASE="$PWD/packages/teamlead/lead-rules-base"
# shellcheck disable=SC1091
. packages/teamlead/scripts/lead-rules-bundle.sh

SENTINEL='no mechanism authorized yet'
# The materializer chmods its output DIRECTORY, so the artifact must live in a
# directory we own — not /tmp itself (chmod there is "Operation not permitted").
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1894-sentinel.XXXXXX")/art"
mkdir -p "$TMP"
trap 'rm -rf "$(dirname "$TMP")"' EXIT
fail=0

check() {                      # check <role> <governance_required> <expected-count>
  local role="$1" gov="$2" want="$3" out art n

  # the materializer reads TWO parallel arrays; populating only FILES leaves
  # RULES_BUNDLE_LABELS unbound and it dies under `set -u`.
  RULES_BUNDLE_FILES=()
  RULES_BUNDLE_LABELS=()
  if ! out="$(compute_lead_rule_bundle "$role" "$BASE" mailbox "$gov" 2>/dev/null)"; then
    printf '  ❌ %-10s compute_lead_rule_bundle failed\n' "$role"; fail=1; return
  fi
  # feed the computed plan into the real materializer
  while read -r f; do
    [ -z "$f" ] && continue
    if [ -f "$f" ]; then
      RULES_BUNDLE_FILES+=("$f")
      RULES_BUNDLE_LABELS+=("base")
    fi
  done <<< "$(printf '%s\n' "$out" | awk '{print $1}')"

  art="$TMP/${role}-${gov}.md"
  if ! rules_bundle_materialize "$art" "$role" "lead-$role" fly1894 >/dev/null 2>&1; then
    printf '  ❌ %-10s rules_bundle_materialize failed\n' "$role"; fail=1; return
  fi
  if [ "${#RULES_BUNDLE_FILES[@]}" -gt 0 ] && [ ! -s "$art" ]; then
    printf '  ❌ %-10s materialized artifact is empty\n' "$role"; fail=1; return
  fi

  # occurrences, not matching lines (review R2: two on one line read as 1)
  n="$(grep -oF "$SENTINEL" "$art" 2>/dev/null | wc -l | tr -d ' ')"
  [ -z "$n" ] && n=0
  if [ "$n" -eq "$want" ]; then
    printf '  ✅ %-10s sentinel appears %s time(s) in the materialized bundle — expected %s\n' \
           "$role" "$n" "$want"
  else
    printf '  ❌ %-10s sentinel appears %s time(s) in the materialized bundle — expected %s\n' \
           "$role" "$n" "$want"; fail=1
  fi
}

echo "=== R5 sentinel in the MATERIALIZED bundle ==="
check dept      0 1
check cos       0 1
check companion 0 0

echo
echo "  ℹ  external: this script does NOT materialize external's prompt."
echo "     It only asserts the guard that excludes it is present. Proving zero"
echo "     occurrences in a materialized external prompt is NOT done here."
# Scope the check to the founder-only block itself. The generic
# companion+external condition appears FIVE times in claude-lead.sh, so grepping
# for it passed even after the external clause was deleted from the block that
# matters (false green found by head-bound code review R5).
if awk '/BASE_FOUNDER_AUTH_RULES=/{f=1} f&&/^if \[/{print; exit}' \
        packages/teamlead/scripts/claude-lead.sh \
     | grep -q 'IS_EXTERNAL_ROLE" != true'; then
  echo "  ✅ external  guard present in the BASE_FOUNDER_AUTH_RULES block"
else
  echo "  ❌ external  guard MISSING from the BASE_FOUNDER_AUTH_RULES block"; fail=1
fi

echo
echo "=== the same, with governance_required=1 (Codex full-access) ==="
check dept 1 1
check cos  1 1

exit "$fail"
