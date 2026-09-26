#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d /tmp/flywheel-run-bridge-boot-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/scripts/lib" "$TMP/packages/config/dist" \
  "$TMP/packages/claude-runner/dist" "$TMP/packages/edge-worker/dist/memory" \
  "$TMP/packages/teamlead/dist/bridge" "$TMP/packages/teamlead/dist"
cp "$ROOT/scripts/run-bridge.ts" "$TMP/scripts/run-bridge.ts"
cp "$ROOT/scripts/lib/run-bridge-isolation-bootstrap.mjs" \
  "$TMP/scripts/lib/run-bridge-isolation-bootstrap.mjs"
cp "$ROOT/packages/claude-runner/dist/isolation-boundary.js" \
  "$TMP/packages/claude-runner/dist/isolation-boundary.js"
cp "$ROOT/scripts/lib/qa-slot-env-contract.json" "$TMP/contract.json"
printf '{"type":"module"}\n' > "$TMP/package.json"

cat > "$TMP/packages/config/dist/index.js" <<'JS'
export function installRotatingStdioFromEnv() {
  process.stdout.write("rotation-installed\n");
}
export function writeBoundedRotationErrorMarker() {}
JS
cat > "$TMP/packages/edge-worker/dist/memory/index.js" <<'JS'
export async function createMemoryService() { return undefined; }
export const CipherWriter = { async create() { return undefined; } };
export class CipherSyncService {}
JS
cat > "$TMP/packages/teamlead/dist/bridge/bounded-shutdown.js" <<'JS'
export async function runBoundedShutdown() {}
JS
cat > "$TMP/packages/teamlead/dist/bridge/linear-transport-rejection-guard.js" <<'JS'
// Boot wiring fixture: classifier and fatal semantics have real-SDK child tests.
export function installLinearTransportRejectionGuard() {
  process.stdout.write("guard-installed\n");
  return () => {};
}
JS
cat > "$TMP/packages/teamlead/dist/bridge/plugin.js" <<'JS'
export async function startBridge() {
  process.stdout.write("main-reached\n");
  return { close() {} };
}
JS
cat > "$TMP/packages/teamlead/dist/config.js" <<'JS'
export function loadConfig() {
  return { dbPath: process.env.TEAMLEAD_DB_PATH, defaultLeadAgentId: "test-lead" };
}
JS
cat > "$TMP/packages/teamlead/dist/ProjectConfig.js" <<'JS'
export function loadProjects() { return [{ leads: [{ agentId: "test-lead" }] }]; }
JS
cat > "$TMP/packages/teamlead/dist/StateStore.js" <<'JS'
export const StateStore = { async create() { return {}; } };
JS

run_bridge() {
  env -i PATH="$PATH" HOME="$HOME" "$ROOT/node_modules/.bin/tsx" \
    "$TMP/scripts/run-bridge.ts" "$@"
}

prod_out="$(run_bridge 2>"$TMP/prod.err")"
[[ "$prod_out" == $'rotation-installed\nguard-installed\n[run-bridge] Starting with 1 project(s)...\n[run-bridge] StateStore initialized: undefined\nmain-reached' ]] \
  || { echo "FAIL: production shape changed: $prod_out" >&2; exit 1; }
[[ ! -s "$TMP/prod.err" ]] || { echo "FAIL: production stderr changed" >&2; exit 1; }

# The teamlead bin is an independent Bridge entry and must install the same guard.
cp "$ROOT/packages/teamlead/src/index.ts" "$TMP/packages/teamlead/dist/index.ts"
cat > "$TMP/packages/teamlead/dist/bridge/EventFilter.js" <<'JS'
export class EventFilter {}
JS
printf '{"type":"module","exports":"./dist/memory/index.js"}\n' > "$TMP/packages/edge-worker/package.json"
mkdir -p "$TMP/node_modules"
ln -s "$TMP/packages/edge-worker" "$TMP/node_modules/flywheel-edge-worker"
bin_out="$(env -i PATH="$PATH" HOME="$HOME" "$ROOT/node_modules/.bin/tsx" \
  "$TMP/packages/teamlead/dist/index.ts" 2>"$TMP/bin.err")"
[[ "$bin_out" == $'guard-installed\nmain-reached' ]] \
  || { echo "FAIL: teamlead bin guard missing: $bin_out" >&2; exit 1; }
[[ ! -s "$TMP/bin.err" ]] || { echo "FAIL: teamlead bin stderr changed" >&2; exit 1; }

# Exercise the real payload compiler: package-relative guard imports must be
# rewritten along with the existing entry imports. Production boot has no
# isolation root; compiled isolation-bootstrap packaging is a separate concern.
PACKAGE_ONBOARD_SOURCED=1 source "$ROOT/scripts/package-onboard.sh"
payload="$TMP/payload"
mkdir -p "$payload/node_modules"
for package in config edge-worker teamlead; do
  mkdir -p "$payload/node_modules/flywheel-$package"
  cp -R "$TMP/packages/$package/dist" "$payload/node_modules/flywheel-$package/dist"
  printf '{"type":"module"}\n' > "$payload/node_modules/flywheel-$package/package.json"
done
po_compile_run_bridge "$ROOT" "$payload"
compiled_out="$(env -i PATH="$PATH" HOME="$HOME" node "$payload/dist/run-bridge.js" 2>"$TMP/compiled.err")"
[[ "$compiled_out" == "$prod_out" ]] \
  || { echo "FAIL: compiled boot shape changed: $compiled_out" >&2; exit 1; }
[[ ! -s "$TMP/compiled.err" ]] || { echo "FAIL: compiled boot stderr changed" >&2; exit 1; }

slot="$TMP/slot"
mkdir -p "$slot/state/comm" "$slot/state/codex-homes" \
  "$slot/state/codex-sessions" "$slot/state/cdx-sock" \
  "$slot/state/codex-home" "$slot/state/kill-ledger" \
  "$slot/state/reports" "$slot/state/complete-failed" \
  "$slot/state/loop-diagnostics" "$slot/bin" "$slot/hooks" \
  "$slot/state/lead-identity-failures" "$slot/state/carrier-assertions" \
  "$slot/state/carrier-receipts" "$slot/tmp"
slot_env=(
  FLYWHEEL_ISOLATION_ROOT="$slot"
  FLYWHEEL_ISOLATION_CONTRACT="$TMP/contract.json"
  FLYWHEEL_STATE_DIR="$slot"
  TEAMLEAD_DB_PATH="$slot/teamlead.db"
  FLYWHEEL_LEAD_CARRIER_EVIDENCE_FILE="$slot/state/lead-carrier-evidence.json"
  FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR="$slot/state/carrier-assertions"
  FLYWHEEL_LEAD_RECEIPT_DIR="$slot/state/carrier-receipts"
  FLYWHEEL_COMM_ROOT="$slot/state/comm"
  FLYWHEEL_CODEX_HOMES_ROOT="$slot/state/codex-homes"
  FLYWHEEL_CODEX_SESSION_DIR="$slot/state/codex-sessions"
  FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT="$slot/state/cdx-sock"
  CODEX_HOME="$slot/state/codex-home"
  TMUX_TMPDIR="$slot"
  TMPDIR="$slot/tmp"
  FLYWHEEL_DELIVERY_SECRET_PATH="$slot/state/delivery-secret"
  FLYWHEEL_KILL_LEDGER_ROOT="$slot/state/kill-ledger"
  FLYWHEEL_REPORTS_DIR="$slot/state/reports"
  FLYWHEEL_COMPLETE_MARKER_DIR="$slot/state/complete-failed"
  FLYWHEEL_LOOP_DIAGNOSTICS_DIR="$slot/state/loop-diagnostics"
  FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH="$slot/state/founder-consent.db"
  FLYWHEEL_BIN_DIR="$slot/bin"
  FLYWHEEL_HOOKS_DIR="$slot/hooks"
  FLYWHEEL_IDENTITY_FAILURE_DIR="$slot/state/lead-identity-failures"
)

env -i PATH="$PATH" HOME="$HOME" "${slot_env[@]}" \
  VERCEL_TOKEN=slot-token FLYWHEEL_REPORT_HOST_OVERRIDE_URL=http://127.0.0.1:1 \
  FLYWHEEL_ROUNDTABLE_CHANNEL_ID=123 "$ROOT/node_modules/.bin/tsx" \
  "$TMP/scripts/run-bridge.ts" >"$TMP/slot.out" 2>"$TMP/slot.err"
grep -q '^main-reached$' "$TMP/slot.out" \
  || { echo "FAIL: valid slot did not reach main" >&2; exit 1; }

set +e
env -i PATH="$PATH" HOME="$HOME" "${slot_env[@]}" \
  FLYWHEEL_COMM_ROOT="$HOME/.flywheel/comm" "$ROOT/node_modules/.bin/tsx" \
  "$TMP/scripts/run-bridge.ts" >"$TMP/bad.out" 2>"$TMP/bad.err"
rc=$?
set -e
[[ "$rc" == "78" ]] || { echo "FAIL: bad coordinate rc=$rc" >&2; exit 1; }
grep -q 'BOOT REFUSED.*FLYWHEEL_COMM_ROOT' "$TMP/bad.err" \
  || { echo "FAIL: missing boot refusal evidence" >&2; exit 1; }
! grep -q 'rotation-installed' "$TMP/bad.out" \
  || { echo "FAIL: logging side effect preceded fence" >&2; exit 1; }
! grep -q 'guard-installed' "$TMP/bad.out" \
  || { echo "FAIL: rejection guard preceded fence" >&2; exit 1; }

set +e
env -i PATH="$PATH" HOME="$HOME" "${slot_env[@]}" \
  FLYWHEEL_TMUX_SOCKET_OVERRIDE=/production/tmux.sock \
  "$ROOT/node_modules/.bin/tsx" "$TMP/scripts/run-bridge.ts" \
  >"$TMP/tmux.out" 2>"$TMP/tmux.err"
rc=$?
set -e
[[ "$rc" == "78" ]] && grep -q 'FLYWHEEL_TMUX_SOCKET_OVERRIDE' "$TMP/tmux.err" \
  || { echo "FAIL: inherited tmux override was not rejected" >&2; exit 1; }

echo "run-bridge isolation boot tests passed"
