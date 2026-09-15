#!/usr/bin/env bash
# FLY-1948: coordinates are per Lead and independent of room-info.json.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
source "$repo/scripts/lib/qa-lead-artifacts.sh"
declare -F qa_lead_write_coordinates >/dev/null || {
  echo 'FAIL: qa_lead_write_coordinates missing' >&2; exit 1;
}
export -f qa_lead_write_coordinates
python3 - <<'PY'
import json
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="fly1948-coordinates-") as tmp:
    root = Path(tmp)
    def write(agent="flywheel-test-2", carrier="claude-code", mode="slot", primary="111", mirror="", roundtable="", slot="2"):
        runtime = root / "launchd" / agent
        runtime.mkdir(parents=True, exist_ok=True)
        state = root / ("discord-state" if slot == "2" else "extra-leads/slot-3/discord-state")
        out = runtime / "lead-coordinates.json"
        args = [str(out), slot, agent, carrier, mode, "2026-09-14T20:24:17Z", str(state), str(root / "lead.sock"), primary, mirror, roundtable, "444", "test-slot-2", str(root / "state/comm/test-slot-2/comm.db"), f"com.flywheel.qa.lead.slot-{slot}.{agent}"]
        result = subprocess.run(["bash", "-c", 'qa_lead_write_coordinates "$@"', "test", *args], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        value = json.loads(out.read_text())
        assert out.stat().st_mode & 0o777 == 0o600
        assert value["schemaVersion"] == 1
        assert value["agentId"] == agent
        assert value["manifestPath"] == str(runtime / "manifest.json")
        assert value["livenessPath"] == str(runtime / "channel-liveness.json")
        assert value["launchdLabel"] == args[-1]
        assert value["discordStateDir"] == str(state)
        # Re-rendering identical inputs preserves bytes; no ambient mode lookup.
        before = out.read_bytes()
        subprocess.run(["bash", "-c", 'qa_lead_write_coordinates "$@"', "test", *args], check=True, env={**os.environ, "MODE": "roundtable", "DISCORD_EXPECTED_BOT_USER_ID": "999"})
        assert out.read_bytes() == before
        assert value["botUserId"] == "444"
        return value

    ordinary = write()
    assert ordinary["roundtripChannelId"] == "111"
    assert ordinary["bodyStatusPath"].endswith("/flywheel-test-2/body-status.json")
    assert write(mode="mirror", primary="222", mirror="222")["roundtripChannelId"] == "222"
    assert write(mode="roundtable", roundtable="333")["roundtripChannelId"] == "333"
    extra = write(agent="flywheel-test-3", primary="555", slot="3")
    assert extra["roundtripChannelId"] == "555" and extra["slot"] == 3
    codex = write(carrier="codex-app-server")
    assert codex["roundtripChannelId"] is None
    assert codex["socketPath"] is None and codex["bodyStatusPath"] is None
    # --no-lead is a deployment decision, covered by integration tests.
    print("PASS: ordinary, mirror, roundtable, extra Lead, Codex coordinates; private deterministic artifacts")
PY

# Exercise the actual shared post-lease gate with observation seams. No room,
# Lead, launchd job, or real Discord channel is started by this test.
eval "$(sed -n '/^qa_slot_channel_ready()/,/^}/p' "$repo/scripts/test-deploy.sh")"
SLOT_DIR="$(mktemp -d /tmp/fly1948-channel-gate.XXXXXX)"
trap 'rm -rf "$SLOT_DIR"' EXIT
mkdir -p "$SLOT_DIR/launchd/lead-1"
printf '%s\n' '{"startedAt":"2026-09-14T20:00:00Z"}' > "$SLOT_DIR/launchd/lead-1/lead-coordinates.json"
LEAD_CHANNEL_TIMEOUT_SEC=7
REPO_ROOT="$repo"
log() { printf '%s\n' "$*" >> "$SLOT_DIR/gate.log"; }
qa_discord_liveness_wait() {
  [[ "$2" == '2026-09-14T20:00:00Z' && "$4" == 7 ]] || return 2
  if [[ "$GATE_SCENARIO" == live ]]; then
    printf '%s\n' '{"live":true,"adapter":{"pid":42},"gateway":{"state":"ready"},"socket":{"established":1}}' > "$3"
    return 0
  fi
  printf '%s\n' '{"live":false,"reason":"adapter_missing"}' > "$3"
  return 1
}
qa_launchd_failure_snapshot() {
  [[ "$1" == channel && "$2" == fixture-label ]] || return 2
  [[ "$4" == "$SLOT_DIR/launchd/lead-1/manifest.json" ]] || return 2
  jq -e '.live == false and .reason == "adapter_missing"' "$SLOT_DIR/launchd/lead-1/channel-liveness.json" >/dev/null || return 2
  touch "$SLOT_DIR/snapshot-observed"
}
GATE_SCENARIO=live
qa_slot_channel_ready lead-1 fixture-label "$SLOT_DIR/lead.log"
[[ ! -e "$SLOT_DIR/snapshot-observed" ]]
GATE_SCENARIO=missing
if qa_slot_channel_ready lead-1 fixture-label "$SLOT_DIR/lead.log"; then
  echo 'FAIL: missing adapter accepted by post-lease gate'; exit 1
fi
[[ -f "$SLOT_DIR/snapshot-observed" ]]
grep -q 'phase=channel reason=adapter_missing' "$SLOT_DIR/gate.log"
echo 'PASS: shared post-lease gate preserves failure evidence and rejects missing adapter'
