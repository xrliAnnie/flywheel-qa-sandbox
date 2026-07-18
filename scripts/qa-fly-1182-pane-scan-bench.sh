#!/usr/bin/env bash
# FLY-1182: isolated 40-pane wall/CPU measurement for the production scanner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEAMLEAD_DIR="$REPO_DIR/packages/teamlead"
FIXTURE="$TEAMLEAD_DIR/src/__tests__/fixtures/lead-panes/idle-product-lead.txt"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1182-scan-bench.XXXXXX")"
TMUX_SOCKET="fly1182-scan-bench-$$"

cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

for tool in node pnpm jq tmux; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing prerequisite: $tool" >&2; exit 1; }
done
[[ -f "$FIXTURE" ]] || { echo "missing fixture: $FIXTURE" >&2; exit 1; }

pnpm --dir "$TEAMLEAD_DIR" build >/dev/null
cat > "$ROOT/pane.sh" <<PANE
#!/usr/bin/env bash
cat "$FIXTURE"
while :; do sleep 60; done
PANE
chmod +x "$ROOT/pane.sh"

tmux -L "$TMUX_SOCKET" new-session -d -x 220 -y 50 \
  -s flywheel-quota-qa -n FLY-1182-qa-01 "$ROOT/pane.sh"
for index in $(seq -w 2 40); do
  tmux -L "$TMUX_SOCKET" new-window -d -t flywheel-quota-qa \
    -n "FLY-1182-qa-$index" "$ROOT/pane.sh"
done
for pane_id in $(tmux -L "$TMUX_SOCKET" list-panes -a -F '#{pane_id}'); do
  tmux -L "$TMUX_SOCKET" set-option -p -t "$pane_id" @flywheel_quota_qa 1
done

for _ in $(seq 1 50); do
  [[ "$(tmux -L "$TMUX_SOCKET" list-panes -a -F '#{pane_id}' | wc -l | tr -d ' ')" == "40" ]] \
    && tmux -L "$TMUX_SOCKET" capture-pane -p -t flywheel-quota-qa:FLY-1182-qa-40.0 \
      | grep -q 'bypass permissions' \
    && break
  sleep 0.1
done

node --input-type=module - "$TEAMLEAD_DIR" "$TMUX_SOCKET" <<'NODE' | tee "$ROOT/result.json"
import { pathToFileURL } from "node:url";

const [teamleadDir, socket] = process.argv.slice(2);
const moduleUrl = pathToFileURL(`${teamleadDir}/dist/account-heal/quota-revive-scan.js`).href;
const { makeTmuxReviveDeps, scanQuotaPanes } = await import(moduleUrl);
const tmux = makeTmuxReviveDeps({ socket });
const before = process.resourceUsage();
const started = performance.now();
const snapshot = await scanQuotaPanes({
  nowMs: Date.now(),
  socket,
  qaInjectionEnabled: true,
  listPanes: tmux.listPanes,
  capturePane: tmux.capturePane,
});
const wallMs = performance.now() - started;
const after = process.resourceUsage();
const result = {
  listedCount: snapshot.listedCount,
  observedCount: snapshot.observations.length,
  managedCount: snapshot.observations.filter((entry) => entry.managed).length,
  captureFailures: snapshot.observations.filter((entry) => entry.capture === null).length,
  omittedCount: snapshot.omittedPanes.length,
  complete: snapshot.complete,
  wallMs: Math.round(wallMs * 100) / 100,
  userCpuMs: Math.round((after.userCPUTime - before.userCPUTime) / 10) / 100,
  systemCpuMs: Math.round((after.systemCPUTime - before.systemCPUTime) / 10) / 100,
};
console.log(JSON.stringify(result));
if (
  result.listedCount !== 40 ||
  result.observedCount !== 40 ||
  result.managedCount !== 40 ||
  result.captureFailures !== 0 ||
  result.omittedCount !== 0 ||
  !result.complete ||
  result.wallMs > 10_000
) process.exit(1);
NODE

jq -e '.complete and .listedCount == 40 and .managedCount == 40 and .wallMs <= 10000' \
  "$ROOT/result.json" >/dev/null
echo "[FLY-1182 scan bench] PASS: bounded production scanner captured 40/40 isolated panes"
