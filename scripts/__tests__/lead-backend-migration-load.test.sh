#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/root/scripts" "$test_root/home/Library/LaunchAgents"
printf 'staged bytes\n' > "$test_root/home/Library/LaunchAgents/target.plist"
cat > "$test_root/root/scripts/flywheel-lead.sh" <<'STUB'
load_common() { [ "$1" = paths-only ]; }
resolve_lifecycle_target() {
 [ "$*" = "--project flywheel --lead flywheel-product-lead" ] || return 1
 LIFECYCLE_MANIFEST="$HOME/source.json"
 LIFECYCLE_PLIST="$HOME/Library/LaunchAgents/target.plist"
}
preflight_manifest() { [ "${TEST_FAIL_PREFLIGHT:-0}" != 1 ]; }
assert_lifecycle_carrier() { return 0; }
plist_matches_lifecycle_target() { [ "$1" = "$LIFECYCLE_PLIST" ]; }
launchctl() {
 [ "$1" = bootstrap ] && [ "$2" = "gui/$(id -u)" ] && [ "$3" = "$LIFECYCLE_PLIST" ] || return 1
 printf 'bootstrap\n' >> "$HOME/load-events"
}
STUB
source "$ROOT/scripts/lib/lead-backend-migration.sh"
bash -c 'source "$1"; declare -F resolve_lifecycle_target >/dev/null' test "$ROOT/scripts/flywheel-lead.sh"
lead_backend_migration_load_staged "$test_root/home" "$test_root/root"
[ "$(cat "$test_root/home/Library/LaunchAgents/target.plist")" = "staged bytes" ]
[ "$(cat "$test_root/home/load-events")" = bootstrap ]
if TEST_FAIL_PREFLIGHT=1 lead_backend_migration_load_staged "$test_root/home" "$test_root/root"; then
 echo 'FAIL: preflight failure allowed bootstrap' >&2; exit 1
fi
[ "$(wc -l < "$test_root/home/load-events" | tr -d " ")" = 1 ]
printf 'PASS staged migration load preserves bytes and respects preflight\n'
