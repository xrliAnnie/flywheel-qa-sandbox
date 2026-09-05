#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/f2301-state-root.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/codex-home"
NEW_LINE='STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/codex-lead/${SAFE_PROJECT}__${SAFE_LEAD}-${IDENTITY_HEX}"'
OLD_LINE='STATE_DIR="${HOME}/.flywheel/state/codex-lead/${SAFE_PROJECT}__${SAFE_LEAD}-${IDENTITY_HEX}"'

for variant in new legacy; do
  mkdir -p "$TMP/$variant/scripts/lib" \
    "$TMP/$variant/dist/lead-backends/codex" "$TMP/$variant/workspace" \
    "$TMP/$variant/home" "$TMP/$variant/codex-home"
  cp "$ROOT/packages/teamlead/scripts/codex-lead.sh" "$TMP/$variant/scripts/codex-lead.sh"
  cat > "$TMP/$variant/scripts/lib/canonical-lead-identity.sh" <<'IDENTITY'
canonical_lead_identity_resolve() {
  export FLYWHEEL_PROJECT_NAME="$1"
  export FLYWHEEL_LEAD_ID="$2"
  export FLYWHEEL_LEAD_KEY="$1-$2"
  export FLYWHEEL_LEAD_BACKEND=codex-app-server
  export FLYWHEEL_LEAD_ROLE=companion
}
IDENTITY
  cat > "$TMP/$variant/dist/lead-backends/codex/codex-lead-tui-runtime.js" <<'RUNTIME'
const fs = require("node:fs");
fs.writeFileSync(process.env.FLY2301_DUMP, JSON.stringify(process.env));
RUNTIME
done

python3 - "$TMP/new/scripts/codex-lead.sh" "$TMP/legacy/scripts/codex-lead.sh" "$NEW_LINE" "$OLD_LINE" <<'PY'
from pathlib import Path
import sys

new_path, legacy_path = map(Path, sys.argv[1:3])
new_line, old_line = sys.argv[3:]
text = new_path.read_text()
if text.count(new_line) != 1 or text.count(old_line) != 0:
    raise SystemExit("new state-root line count is not exactly one")
legacy_path.write_text(text.replace(new_line, old_line))
PY
if [ "$?" -ne 0 ]; then
  echo "FAIL: codex-lead state-root implementation line is missing"
  exit 1
fi

diff_lines=$(diff -u "$TMP/legacy/scripts/codex-lead.sh" "$TMP/new/scripts/codex-lead.sh" \
  | grep -Ec '^[-+]STATE_DIR=')
if [ "$diff_lines" -ne 2 ]; then
  echo "FAIL: legacy mirror differs by more than the one state-root line"
  exit 1
fi

run_variant() {
  local variant="$1" state_root="$2" tag="$3"
  local -a env_args
  env_args=(
    "HOME=$TMP/home"
    "CODEX_HOME=$TMP/codex-home"
    "FLYWHEEL_CODEX_LEAD_MODE=tui"
    "FLYWHEEL_CODEX_TUI_CWD=$TMP/$variant/workspace"
    "FLYWHEEL_LEAD_DRY_RUN=1"
    "FLY2301_DUMP=$TMP/$variant/$tag.json"
  )
  if [ -n "$state_root" ]; then
    env_args+=("FLYWHEEL_STATE_DIR=$state_root")
  fi
  env -i PATH="$PATH" "${env_args[@]}" \
    /bin/bash "$TMP/$variant/scripts/codex-lead.sh" qa-lead "$TMP/$variant/workspace" test-slot-7 \
    > "$TMP/$variant/$tag.out" 2> "$TMP/$variant/$tag.err"
}

run_variant new '' default
run_variant legacy '' default
new_default=$(jq -r .FLYWHEEL_CODEX_LEAD_STATE_DIR "$TMP/new/default.json")
legacy_default=$(jq -r .FLYWHEEL_CODEX_LEAD_STATE_DIR "$TMP/legacy/default.json")
new_default_log=$(sed -n 's/.*state: \([^,]*\),.*/\1/p' "$TMP/new/default.err" | tail -1)
legacy_default_log=$(sed -n 's/.*state: \([^,]*\),.*/\1/p' "$TMP/legacy/default.err" | tail -1)
if [[ "$new_default" != "$legacy_default" || "$new_default_log" != "$legacy_default_log" ]]; then
  echo "FAIL: default state-root behavior drifted"
  exit 1
fi

CUSTOM_STATE="$TMP/slot-state"
run_variant new "$CUSTOM_STATE" custom
run_variant legacy "$CUSTOM_STATE" custom
new_custom=$(jq -r .FLYWHEEL_CODEX_LEAD_STATE_DIR "$TMP/new/custom.json")
legacy_custom=$(jq -r .FLYWHEEL_CODEX_LEAD_STATE_DIR "$TMP/legacy/custom.json")
if [[ "$new_custom" != "$CUSTOM_STATE"/state/codex-lead/* ]] \
    || [[ "$legacy_custom" != "$TMP/home/.flywheel"/state/codex-lead/* ]]; then
  echo "FAIL: injected state root did not move only the new launcher"
  exit 1
fi

echo "PASS: codex-lead state root is injectable with byte-compatible default behavior"
