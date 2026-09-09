#!/usr/bin/env bash
# FLY-2445: source-only helpers for the updater-owned Raya standard Lead cutover.
# This file never schedules, starts, stops, or deploys anything on its own.

RAYA_STANDARD_NODE_BIN="${RAYA_STANDARD_NODE_BIN:-${UPDATER_NODE:-node}}"
RAYA_STANDARD_SEED_TOOL="${RAYA_STANDARD_SEED_TOOL:-${FLYWHEEL_TEAMLEAD_ROOT:-}/dist/bin/seed-lead-inbound-cursor.js}"

raya_standard_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

raya_standard_owner_file() {
  local mode=""
  [[ -f "$1" && ! -L "$1" ]] || return 1
  mode="$(raya_standard_mode "$1")" || return 1
  [[ "$mode" =~ ^[046][0-7]00$ || "$mode" =~ ^[046]00$ ]]
}

raya_standard_sha256() {
  shasum -a 256 "$1" 2>/dev/null | awk 'NF == 2 { print $1 }'
}

raya_standard_seed_inbound_cursor() {
  local cursor_path="$1" input_path="$2"
  [[ -n "$RAYA_STANDARD_SEED_TOOL" && -f "$RAYA_STANDARD_SEED_TOOL" \
    && ! -L "$RAYA_STANDARD_SEED_TOOL" ]] || return 64
  raya_standard_owner_file "$input_path" || return 65
  command -v "$RAYA_STANDARD_NODE_BIN" >/dev/null 2>&1 \
    || [[ -x "$RAYA_STANDARD_NODE_BIN" ]] || return 69
  "$RAYA_STANDARD_NODE_BIN" "$RAYA_STANDARD_SEED_TOOL" \
    --path "$cursor_path" --input "$input_path"
}

raya_standard_manifest_checkpoint() {
  local manifest="$1" expected="$2"
  raya_standard_owner_file "$manifest" || return 65
  jq -e --arg checkpoint "$expected" '
    type == "object"
    and .schemaVersion == 1
    and (.migration_id | type == "string" and length > 0)
    and .checkpoint == $checkpoint
    and (.unresolved | type == "array")
    and (.cursor | type == "object")
    and (.cursor.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
  ' "$manifest" >/dev/null 2>&1
}

raya_standard_preinstall_ready() {
  local manifest="$1" cursor_path="$2" expected="" actual=""
  raya_standard_manifest_checkpoint "$manifest" P4b || return 1
  [[ -f "$cursor_path" && ! -L "$cursor_path" ]] || return 1
  jq -e '
    (.unresolved | length) == 0
    and (.cursor.status == "seeded" or .cursor.status == "already_seeded")
  ' "$manifest" >/dev/null 2>&1 || return 1
  expected="$(jq -r '.cursor.sha256' "$manifest")" || return 1
  actual="$(raya_standard_sha256 "$cursor_path")" || return 1
  [[ -n "$actual" && "$actual" == "$expected" ]]
}
