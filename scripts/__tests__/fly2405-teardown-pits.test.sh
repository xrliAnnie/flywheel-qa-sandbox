#!/usr/bin/env bash
# Hermetic regressions: no launchd jobs, real rooms, or process signals.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT=$(mktemp -d /tmp/fly2405-pits.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
failures=0
check() {
  if "$@"; then printf 'PASS: %s\n' "$*";
  else printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); fi
}

# Real socket probes; the only listening server is this fixture's subprocess.
python3 - "$ROOT" "$TEST_ROOT" <<'PY' || failures=$((failures + 1))
import os, pathlib, socket, subprocess, sys, tempfile
root, temp = map(pathlib.Path, sys.argv[1:])
slot = temp / 'slot'
sockets = slot / 'state/cdx-sock'
sockets.mkdir(parents=True)
helper = root / 'scripts/lib/qa-reap-codex-slot-daemons.mjs'
fixture_uid = 2000000 + os.getpid()
preload = temp / 'fixture-uid.mjs'
preload.write_text('process.getuid = () => ' + str(fixture_uid) + ';\n')
def probe():
    return subprocess.run(['node', '--import', str(preload), str(helper), str(slot)], capture_output=True, text=True)
failures = []
link = sockets / 'fixture.sock'
link.symlink_to(temp / 'missing.sock')
result = probe()
if result.returncode or link.is_symlink(): failures.append('dangling symlink must be removed and ignored: ' + result.stderr)
link.unlink(missing_ok=True)
allowed = pathlib.Path('/private/tmp') / ('codex-daemon-' + str(fixture_uid))
allowed.mkdir()
with tempfile.TemporaryDirectory(prefix='f2405-', dir=allowed) as live_dir:
    with socket.socket(socket.AF_UNIX) as server:
        target = pathlib.Path(live_dir) / 's.sock'
        server.bind(str(target)); server.listen(5)
        link.symlink_to(target)
        result = probe()
        if result.returncode != 1 or 'live Codex socket(s) remain' not in result.stderr:
            failures.append('allowed live socket must be probed as residual: ' + result.stderr)
        link.unlink()
allowed.rmdir()
foreign = temp / 'foreign.sock'
with socket.socket(socket.AF_UNIX) as server:
    server.bind(str(foreign)); server.listen(5)
    link.symlink_to(foreign)
    result = probe()
    if result.returncode != 1 or 'outside' not in result.stderr:
        failures.append('foreign target must be rejected: ' + result.stderr)
for failure in failures: print('FAIL:', failure, file=sys.stderr)
if failures: raise SystemExit(1)
print('PASS: dangling, allowed-live, and foreign socket symlinks')
PY

source "$ROOT/scripts/lib/qa-launchd-lead.sh"
qa_launchd_validate_codex_stop_entry() {
  printf 'active\tfixture\t%s\t%s\t%s\t%s\t/bin/true\n' \
    "$TEST_ROOT/home" "$TEST_ROOT/codex" "$TEST_ROOT/state" "$TEST_ROOT/runtime.pid"
}
qa_launchd_lead_pid_exact() { [[ "${LIVE_RUNTIME:-0}" == 1 ]] && printf '%s\n' "$$"; }
qa_launchd_process_incarnation() { [[ -n "$1" ]] && printf 'fixture-live-incarnation\n'; }
qa_launchd_lead_stop() { return 0; }
qa_launchd_wait_job_gone() { return 0; }
qa_launchd_wait_process_gone() { return 0; }
qa_launchd_wait_path_gone() { return 0; }
qa_launchd_stop_codex_updaters() { return 3; }
qa_launchd_codex_home_residue_wait() { touch "$TEST_ROOT/scanned"; [[ "${RESIDUE:-0}" == 0 ]]; }
qa_launchd_retire_codex_home() { rm -rf "$1"; }
printf '#!/bin/bash\nexit 1\n' > "$TEST_ROOT/codex"
chmod +x "$TEST_ROOT/codex"
marker_only() {
  mkdir -p "$TEST_ROOT/home"
  touch "$TEST_ROOT/home/.flywheel-qa-launch-started"
  qa_launchd_stop_codex_entry "$TEST_ROOT/registry.json" '{}' 2> "$TEST_ROOT/err" \
    && [[ ! -d "$TEST_ROOT/home" && -f "$TEST_ROOT/scanned" ]]
}
check marker_only
marker_live() {
  mkdir -p "$TEST_ROOT/home"
  touch "$TEST_ROOT/home/.flywheel-qa-launch-started"
  LIVE_RUNTIME=1
  if qa_launchd_stop_codex_entry "$TEST_ROOT/registry.json" '{}' 2> "$TEST_ROOT/err"; then return 1; fi
  [[ -d "$TEST_ROOT/home" ]] && grep -q 'step=daemon-stop' "$TEST_ROOT/err"
}
check marker_live
marker_residue() {
  LIVE_RUNTIME=0 RESIDUE=1
  mkdir -p "$TEST_ROOT/home"
  touch "$TEST_ROOT/home/.flywheel-qa-launch-started"
  if qa_launchd_stop_codex_entry "$TEST_ROOT/registry.json" '{}' 2> "$TEST_ROOT/err"; then return 1; fi
  [[ -d "$TEST_ROOT/home" ]] && grep -q 'step=home-residue' "$TEST_ROOT/err"
}
check marker_residue

# Execute the actual preflight block against no-op package stubs, preserving
# its redirections. A pnpm banner must never contaminate the final JSON.
python3 - "$ROOT/scripts/test-deploy.sh" "$TEST_ROOT/preflight.sh" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text()
start = text.index('(\n  cd "$REPO_ROOT"', text.index('trap release_preflight_lock EXIT'))
end = text.index('\n\nrelease_preflight_lock', start)
pathlib.Path(sys.argv[2]).write_text(text[start:end])
PY
mkdir -p "$TEST_ROOT/repo/packages/flywheel-comm" "$TEST_ROOT/repo/packages/inbox-mcp" "$TEST_ROOT/native/build/Release"
touch "$TEST_ROOT/native/build/Release/better_sqlite3.node"
stdout_contract() (
  REPO_ROOT="$TEST_ROOT/repo" GENERALIZED=1 VOICE_FIXTURE=fixture
  find() { printf '%s\n' "$TEST_ROOT/native"; }
  pnpm() { echo 'pnpm build fixture banner'; }
  node() { return 0; }
  grep() { return 0; }
  qa_room_claude_lead_mcp_missing() { return 0; }
  fail_preflight() { return 1; }
  { source "$TEST_ROOT/preflight.sh"; printf '{"slot":1}\n'; } > "$TEST_ROOT/stdout" 2> "$TEST_ROOT/stderr"
  [[ "$(cat "$TEST_ROOT/stdout")" == '{"slot":1}' ]] \
    && command grep -q 'pnpm build fixture banner' "$TEST_ROOT/stderr"
)
check stdout_contract
printf 'FLY-2405 teardown pits: %s failure(s)\n' "$failures"
[[ "$failures" == 0 ]]
