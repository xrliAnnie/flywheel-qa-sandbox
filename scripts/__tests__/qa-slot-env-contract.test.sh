#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACT="$ROOT/scripts/lib/qa-slot-env-contract.json"
RENDERER="$ROOT/scripts/lib/qa-slot-env-contract.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }

jq -e '
  type == "array" and length > 0 and
  all(.[];
    type == "object" and
    (.name | type == "string" and test("^[A-Z_][A-Z0-9_]*$")) and
    (.disposition == "redirect" or .disposition == "clear" or .disposition == "passthrough") and
    (.boot == "mustBeUnderRoot" or .boot == "mustBeAbsent" or
      .boot == "mustBeUnderRootIfSet" or .boot == "unchecked") and
    (if .disposition == "redirect" then (.value | type == "string" and length > 0)
     elif .disposition == "passthrough" then (.reason | type == "string" and length > 0)
     else true end)) and
  ([.[].name] | length == (unique | length)) and
  all(.[] | select(.boot == "mustBeAbsent");
    .name | test("^(TMUX.*|.*_(DB|DIR|ROOT|OVERRIDE))$"))
' "$CONTRACT" >/dev/null || fail "invalid contract shape"

if jq -er '.[].value? // empty' "$CONTRACT" \
  | rg -v '^\$\{(SLOT_DIR|REPO_ROOT|SLOT_TMPDIR|TEST_PROJECT_NAME)\}(/.*)?$' \
  | rg . >/dev/null; then
  fail "contract value contains an unsupported template"
fi

jq -e 'any(.[]; .name == "FLYWHEEL_STATE_DIR" and (.unconfinedConsumers | type == "array" and length > 0))' "$CONTRACT" >/dev/null || fail "missing unconfinedConsumers disclosure"

# shellcheck source=../lib/qa-slot-env-contract.sh
source "$RENDERER"
slot="$(mktemp -d /tmp/flywheel-contract-slot-XXXXXX)"
trap 'rm -rf "$slot"' EXIT
rendered="$(qa_slot_env_contract_render "$slot" "flywheel-test-91")"
[[ "$(printf '%s\n' "$rendered" | cut -d= -f1 | sort | uniq -d)" == "" ]] \
  || fail "renderer emitted duplicate names"
[[ "$rendered" == *"FLYWHEEL_ISOLATION_ROOT=$slot"* ]] \
  || fail "renderer omitted isolation root"
[[ "$rendered" == *"FLYWHEEL_COMM_ROOT=$slot/state/comm"* ]] \
  || fail "renderer omitted slot CommDB root"
[[ "$rendered" == *"TMPDIR=$slot/tmp"* ]] \
  || fail "renderer omitted slot TMPDIR"
[[ "$rendered" != *'${'* ]] || fail "renderer left an unexpanded template"

for disposition in redirect clear passthrough; do
  [[ -n "$(qa_slot_env_contract_names "$disposition")" ]] \
    || fail "missing $disposition names"
done

TEARDOWN="$ROOT/scripts/test-teardown.sh"
rg -Fq 'local COMMDB_DIR="${SLOT_DIR}/state/comm/${PROJECT_NAME}"' "$TEARDOWN" \
  || fail "teardown does not follow the slot-local CommDB directory"
rg -Fq 'legacy HOME comm dir present; not touched' "$TEARDOWN" \
  || fail "teardown lacks the read-only legacy CommDB notice"
! rg -Fq 'rm -rf "$LEGACY_COMMDB_DIR"' "$TEARDOWN" \
  || fail "teardown must not delete the legacy HOME CommDB directory"

# Execute the actual manifest assignment with both an empty and a populated
# array. /bin/bash is 3.2 on the supported macOS host; CI also runs this code.
python3 - "$ROOT/scripts/test-deploy.sh" "$slot/manifest-array.sh" <<'PYTEST'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index("UNCLASSIFIED_COORDINATES_CLEARED_JSON=$(")
end = source.index("\nqa_lead_write_launch_manifest", start)
assignment = source[start:end]
pathlib.Path(sys.argv[2]).write_text(
    "set -euo pipefail\nUNCLASSIFIED_COORDINATES_CLEARED=()\n" + assignment +
    '\n[[ "$UNCLASSIFIED_COORDINATES_CLEARED_JSON" == "[]" ]]\n' +
    "UNCLASSIFIED_COORDINATES_CLEARED=(FLYWHEEL_NOVEL_ROOT)\n" + assignment +
    '''
[[ "$UNCLASSIFIED_COORDINATES_CLEARED_JSON" == '["FLYWHEEL_NOVEL_ROOT"]' ]]
''')
PYTEST
/bin/bash "$slot/manifest-array.sh" || fail "empty/populated manifest array expansion"

echo "qa-slot env contract tests passed"
