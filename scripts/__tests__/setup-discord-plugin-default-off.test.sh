#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/setup-discord-plugin-default-off.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1715-discord-default-off.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "ok $PASS - $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "not ok $((PASS + FAIL)) - $1" >&2
}

assert() {
  local label="$1"
  shift
  if "$@"; then
    pass "$label"
  else
    fail "$label"
  fi
}

json_value_is() {
  local file="$1"
  local key="$2"
  local expected="$3"
  python3 - "$file" "$key" "$expected" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)["enabledPlugins"][sys.argv[2]]

expected = {"true": True, "false": False}[sys.argv[3]]
raise SystemExit(0 if value is expected else 1)
PY
}

file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

new_settings() {
  local case_name="$1"
  local content="$2"
  local case_dir="$TEST_ROOT/$case_name"
  mkdir -p "$case_dir/.claude"
  printf '%s\n' "$content" > "$case_dir/.claude/settings.json"
  printf '%s\n' "$case_dir/.claude/settings.json"
}

count_backups() {
  local settings="$1"
  find "$(dirname "$settings")" -maxdepth 1 -type f \
    -name 'settings.json.bak-discord-plugin-default-off.*' | wc -l | tr -d ' '
}

extract_backup() {
  sed -n 's/.*backup: \(.*\))$/\1/p'
}

echo "1..20"

# Apply writes both forbidden keys, preserves unrelated JSON/mode, and creates
# one byte-for-byte recovery backup.
settings="$(new_settings apply '{"enabledPlugins":{"discord@flywheel-plugins":true,"other@plugin":true},"theme":"dark"}')"
chmod 0640 "$settings"
original="$TEST_ROOT/apply-original.json"
cp "$settings" "$original"
output="$(HOME="$(dirname "$(dirname "$settings")")" bash "$SCRIPT")"
backup="$(printf '%s\n' "$output" | extract_backup)"
assert "apply disables fork Discord plugin" json_value_is "$settings" 'discord@flywheel-plugins' false
assert "apply disables official Discord plugin" json_value_is "$settings" 'discord@claude-plugins-official' false
assert "apply preserves unrelated JSON" python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); raise SystemExit(0 if d["enabledPlugins"]["other@plugin"] is True and d["theme"] == "dark" else 1)' "$settings"
assert "apply preserves target mode" test "$(file_mode "$settings")" = 640
assert "apply prints an existing backup path" test -f "$backup"
assert "apply backup is byte-identical" cmp -s "$original" "$backup"

# Running again is a true no-op: bytes stay stable and no backup is added.
before_hash="$(shasum -a 256 "$settings" | awk '{print $1}')"
before_count="$(count_backups "$settings")"
noop_output="$(HOME="$(dirname "$(dirname "$settings")")" bash "$SCRIPT")"
assert "second apply reports no-op" grep -q 'no-op:' <<<"$noop_output"
assert "second apply does not rewrite bytes" test "$(shasum -a 256 "$settings" | awk '{print $1}')" = "$before_hash"
assert "second apply does not create backup" test "$(count_backups "$settings")" = "$before_count"

# Restore is an explicit script path, not a manual copy.
restore_output="$(HOME="$(dirname "$(dirname "$settings")")" bash "$SCRIPT" --restore "$backup")"
assert "restore reports success" grep -q 'restored:' <<<"$restore_output"
assert "restore returns original bytes" cmp -s "$settings" "$original"
assert "restore preserves target mode" test "$(file_mode "$settings")" = 640

# Apply refuses malformed targets without mutation or backup.
bad_settings="$(new_settings bad-json '{bad json')"
bad_before="$(shasum -a 256 "$bad_settings" | awk '{print $1}')"
if HOME="$(dirname "$(dirname "$bad_settings")")" bash "$SCRIPT" >"$TEST_ROOT/bad.out" 2>"$TEST_ROOT/bad.err"; then
  fail "malformed target is rejected"
else
  pass "malformed target is rejected"
fi
assert "malformed target stays byte-identical" test "$(shasum -a 256 "$bad_settings" | awk '{print $1}')" = "$bad_before"
assert "malformed target creates no backup" test "$(count_backups "$bad_settings")" = 0

# Target symlinks are refused in both directions.
link_dir="$TEST_ROOT/symlink"
mkdir -p "$link_dir/.claude"
printf '%s\n' '{}' > "$link_dir/real.json"
ln -s "$link_dir/real.json" "$link_dir/.claude/settings.json"
if HOME="$link_dir" bash "$SCRIPT" >"$TEST_ROOT/link.out" 2>"$TEST_ROOT/link.err"; then
  fail "apply refuses target symlink"
else
  pass "apply refuses target symlink"
fi
if bash "$SCRIPT" --restore "$link_dir/real.json" "$link_dir/.claude/settings.json" >"$TEST_ROOT/restore-target-link.out" 2>"$TEST_ROOT/restore-target-link.err"; then
  fail "restore refuses target symlink"
else
  pass "restore refuses target symlink"
fi

# Restore refuses a symlinked or malformed backup and leaves the target alone.
restore_settings="$(new_settings restore-refusal '{"enabledPlugins":{}}')"
restore_before="$(shasum -a 256 "$restore_settings" | awk '{print $1}')"
valid_backup="$TEST_ROOT/valid-backup.json"
printf '%s\n' '{"enabledPlugins":{"discord@flywheel-plugins":true}}' > "$valid_backup"
backup_link="$TEST_ROOT/backup-link.json"
ln -s "$valid_backup" "$backup_link"
if bash "$SCRIPT" --restore "$backup_link" "$restore_settings" >"$TEST_ROOT/restore-link.out" 2>"$TEST_ROOT/restore-link.err"; then
  fail "restore refuses backup symlink"
else
  pass "restore refuses backup symlink"
fi
malformed_backup="$TEST_ROOT/malformed-backup.json"
printf '%s\n' '{bad backup' > "$malformed_backup"
if bash "$SCRIPT" --restore "$malformed_backup" "$restore_settings" >"$TEST_ROOT/restore-bad.out" 2>"$TEST_ROOT/restore-bad.err"; then
  fail "restore refuses malformed backup"
else
  pass "restore refuses malformed backup"
fi
assert "rejected restores leave target byte-identical" test "$(shasum -a 256 "$restore_settings" | awk '{print $1}')" = "$restore_before"

if [ "$FAIL" -ne 0 ]; then
  echo "FAILED: $FAIL assertions failed, $PASS passed" >&2
  exit 1
fi

echo "PASS: $PASS assertions"
