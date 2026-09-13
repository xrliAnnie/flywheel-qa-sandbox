#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_TMP="$(mktemp -d)"
trap 'rm -rf "$TASK_TMP"' EXIT
HELPER="$ROOT/scripts/lib/lead-backend-migration.sh"
# Source must have no control-plane effects. No intent means an immediate no-op.
source "$HELPER"
FLYWHEEL_DIR="$TASK_TMP/repo"
lead_backend_migration_run "$TASK_TMP/home"
mkdir -p "$TASK_TMP/home/.flywheel/lead-backend-migrations"
printf '{}\n' > "$TASK_TMP/home/.flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json"
RESTART_REASON=manual
if lead_backend_migration_run "$TASK_TMP/home"; then echo 'FAIL manual window accepted'; exit 1; fi
RESTART_REASON=updater
ADMISSION_PAUSE_LEASE_ID='11111111-1111-4111-8111-111111111111'
LOCK_DIR="$TASK_TMP/home/.flywheel/restart.lock.d"
if lead_backend_migration_run "$TASK_TMP/home"; then echo 'FAIL absent lock accepted'; exit 1; fi
mkdir "$LOCK_DIR"
if lead_backend_migration_run "$TASK_TMP/home"; then echo 'FAIL absent compiled entry accepted'; exit 1; fi
if bash "$HELPER"; then echo 'FAIL direct execution accepted'; exit 1; fi
printf 'PASS migration source-only entry guards\n'

# Static target checks reuse existing tools without loading/stopping a service.
STATIC_ROOT="$TASK_TMP/static-repo"
STATIC_HOME="$TASK_TMP/static-home"
STATIC_PROJECT="$TASK_TMP/project"
mkdir -p "$STATIC_ROOT/scripts/lib" "$STATIC_ROOT/packages/flywheel-comm/dist" \
 "$STATIC_ROOT/packages/teamlead/dist/bin" "$STATIC_ROOT/packages/teamlead/dist/lead-backends/codex/lead-actions" \
 "$STATIC_ROOT/packages/teamlead/scripts" "$STATIC_HOME/.codex-flywheel-product-lead/packages/standalone/current" \
 "$STATIC_PROJECT/.lead/flywheel-product-lead"
cp "$ROOT/scripts/lib/lead-address.sh" "$STATIC_ROOT/scripts/lib/lead-address.sh"
printf 'identity\n' > "$STATIC_PROJECT/.lead/flywheel-product-lead/identity.md"
printf 'fixture-credential\n' > "$STATIC_HOME/truth.json"
ln -s "$STATIC_HOME/truth.json" "$STATIC_HOME/.codex-flywheel-product-lead/auth.json"
printf '#!/bin/bash\nexit 0\n' > "$STATIC_HOME/.codex-flywheel-product-lead/packages/standalone/current/codex"
chmod +x "$STATIC_HOME/.codex-flywheel-product-lead/packages/standalone/current/codex"
printf 'console.log("full-access");\n' > "$STATIC_ROOT/packages/flywheel-comm/dist/index.js"
printf 'process.exit(process.argv.includes("--project-root") ? 0 : 1);\n' > "$STATIC_ROOT/packages/teamlead/dist/bin/preflight-codex-project-root.js"
touch "$STATIC_ROOT/packages/teamlead/dist/lead-backends/codex/lead-actions/lead-actions-main.js" \
 "$STATIC_ROOT/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js"
cat > "$STATIC_ROOT/scripts/codex-home-link-truth.sh" <<'SH'
#!/bin/bash
[ "$1" = --inspect ] || exit 99
printf '{"state":"already"}\n'
SH
cat > "$STATIC_ROOT/scripts/host-tmux-selection-gate.sh" <<'SH'
#!/bin/bash
[ "$1 $2" = 'probe codex-generic' ] || exit 99
exit 0
SH
cat > "$STATIC_ROOT/packages/teamlead/scripts/codex-lead.sh" <<'SH'
#!/bin/bash
[ "$1 $2 $3" = '--print-state-dir flywheel-product-lead flywheel' ] || exit 99
printf '%s/state/codex-lead/test\n' "$FLYWHEEL_STATE_DIR"
SH
chmod +x "$STATIC_ROOT/scripts/"*.sh "$STATIC_ROOT/packages/teamlead/scripts/codex-lead.sh"
STATIC_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
FLYWHEEL_API_TOKEN=fixture-token
MIGRATION_TEST_BOT_TOKEN=fixture-bot
export FLYWHEEL_API_TOKEN MIGRATION_TEST_BOT_TOKEN
lead_backend_migration_static_preflight "$STATIC_HOME" "$STATIC_ROOT" "$STATIC_PROJECT" "$STATIC_SHA" MIGRATION_TEST_BOT_TOKEN > "$TASK_TMP/static.json"
jq -e --arg home "$STATIC_HOME/.codex-flywheel-product-lead" '.codexHome == $home' "$TASK_TMP/static.json" >/dev/null
[ "$(cat "$STATIC_HOME/truth.json")" = fixture-credential ]
unset MIGRATION_TEST_BOT_TOKEN
if lead_backend_migration_static_preflight "$STATIC_HOME" "$STATIC_ROOT" "$STATIC_PROJECT" "$STATIC_SHA" MIGRATION_TEST_BOT_TOKEN; then echo 'FAIL missing bot accepted'; exit 1; fi
printf 'PASS static target prerequisite checks\n'
MIGRATION_TEST_BOT_TOKEN=fixture-bot
export MIGRATION_TEST_BOT_TOKEN
cat > "$STATIC_ROOT/scripts/codex-home-link-truth.sh" <<'SH'
#!/bin/bash
[ "$1" = --inspect ] || exit 99
printf '{"state":"requires-migration"}\n'
SH
if lead_backend_migration_static_preflight "$STATIC_HOME" "$STATIC_ROOT" "$STATIC_PROJECT" "$STATIC_SHA" MIGRATION_TEST_BOT_TOKEN; then echo 'FAIL unlinked auth accepted'; exit 1; fi
[ "$(cat "$STATIC_HOME/truth.json")" = fixture-credential ]
printf 'PASS unprepared auth refuses without migration\n'
