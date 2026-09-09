#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT/scripts/lib/raya-standard-migration.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2445-migration.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

if [[ ! -f "$LIB" ]]; then
  fail "source-only migration helper exists"
  printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
  exit 1
fi

# shellcheck source=/dev/null
source "$LIB"
for fn in raya_standard_seed_inbound_cursor raya_standard_manifest_checkpoint raya_standard_preinstall_ready; do
  if declare -F "$fn" >/dev/null 2>&1; then pass "exports $fn"; else fail "exports $fn"; fi
done

TOOL="$TMP/seed-tool.js"
CALLS="$TMP/calls"
cat > "$TOOL" <<'JS'
process.stdout.write(JSON.stringify({status:"seeded",migrationId:"fly-2445-test",sha256:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",channels:2})+"\n");
JS
chmod 600 "$TOOL"
INPUT="$TMP/seed.json"
printf '%s\n' '{"schemaVersion":1}' > "$INPUT"
chmod 600 "$INPUT"
CURSOR="$TMP/inbound-cursor.json"
export RAYA_STANDARD_SEED_TOOL="$TOOL"
export RAYA_STANDARD_NODE_BIN="$(command -v node)"

if raya_standard_seed_inbound_cursor "$CURSOR" "$INPUT" > "$CALLS"; then
  pass "invokes the bounded one-shot cursor tool"
else
  fail "invokes the bounded one-shot cursor tool"
fi
if jq -e '.status == "seeded" and .channels == 2' "$CALLS" >/dev/null; then
  pass "preserves the tool receipt"
else
  fail "preserves the tool receipt"
fi

ln -s "$TOOL" "$TMP/tool-link.js"
RAYA_STANDARD_SEED_TOOL="$TMP/tool-link.js"
if raya_standard_seed_inbound_cursor "$CURSOR" "$INPUT" >/dev/null 2>&1; then
  fail "refuses a symlink tool"
else
  pass "refuses a symlink tool"
fi
RAYA_STANDARD_SEED_TOOL="$TOOL"

MANIFEST="$TMP/manifest.json"
printf '%s\n' '{"schemaVersion":1,"migration_id":"fly-2445-test","checkpoint":"P4b","unresolved":[],"cursor":{"status":"seeded","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' > "$MANIFEST"
chmod 600 "$MANIFEST"
printf '{}\n' > "$CURSOR"
chmod 600 "$CURSOR"
CURSOR_SHA="$(shasum -a 256 "$CURSOR" | awk '{print $1}')"
jq --arg sha "$CURSOR_SHA" '.cursor.sha256=$sha' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
chmod 600 "$MANIFEST"

if raya_standard_manifest_checkpoint "$MANIFEST" P4b && raya_standard_preinstall_ready "$MANIFEST" "$CURSOR"; then
  pass "P4b manifest and exact cursor digest permit install"
else
  fail "P4b manifest and exact cursor digest permit install"
fi

jq '.unresolved=["unknown"]' "$MANIFEST" > "$MANIFEST.tmp" && mv "$MANIFEST.tmp" "$MANIFEST"
chmod 600 "$MANIFEST"
if raya_standard_preinstall_ready "$MANIFEST" "$CURSOR" >/dev/null 2>&1; then
  fail "unresolved side effects block install"
else
  pass "unresolved side effects block install"
fi

legacy_paths=(
  "$ROOT/scripts/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
  "$ROOT/packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh"
  "$ROOT/packages/teamlead/scripts/raya-activation-preflight.sh"
  "$ROOT/packages/teamlead/scripts/templates/com.flywheel.lead.raya-raya.tui.plist"
)
legacy_present=0
for path in "${legacy_paths[@]}"; do
  [[ ! -e "$path" && ! -L "$path" ]] || legacy_present=1
done
if [[ "$legacy_present" == 0 ]]; then
  pass "dedicated Raya wrapper, launcher, preflight, and plist are absent"
else
  fail "dedicated Raya runtime entrypoints must be removed"
fi

if ! rg -n 'flywheel-codex-lead-wrapper-raya-tui-fullaccess|run-codex-lead-raya-tui-fullaccess|raya-activation-preflight|com\.flywheel\.lead\.raya-raya\.tui' \
  "$ROOT/scripts" "$ROOT/packages/teamlead" \
  --glob '!**/__tests__/**' --glob '!lib/updater-raya-deploy.sh' >/dev/null; then
  pass "active Flywheel runtime has no dedicated Raya carrier reference"
else
  fail "active Flywheel runtime still references a dedicated Raya carrier"
fi

if ! rg -n 'flywheel-codex-lead-wrapper-raya|codex_home_key=raya' \
  "$ROOT/scripts/resident-codex-lead-recover.sh" >/dev/null; then
  pass "legacy resident recovery cannot select Raya"
else
  fail "legacy resident recovery still admits Raya"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
