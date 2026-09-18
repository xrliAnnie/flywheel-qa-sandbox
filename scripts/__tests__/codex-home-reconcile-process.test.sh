#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/lib/codex-home-reconcile-process.mjs"
TMP="$(mktemp -d /tmp/fly2523-process.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
STATE="$TMP/home/.flywheel/codex-quota/home-migration"
FENCE="$STATE/process-fence"
mkdir -p "$STATE"

PS_BIN="$TMP/ps"
cat > "$PS_BIN" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
pid="${*: -1}"
printf 'start-%s\n' "$pid"
SH
chmod +x "$PS_BIN"
export FLYWHEEL_CODEX_RECONCILE_PS_BIN="$PS_BIN"
PROBE_BIN="$TMP/probe"
cat > "$PROBE_BIN" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ -n "${FORCE_LIVE_FILE:-}" ] && [ -f "$FORCE_LIVE_FILE" ]; then
	rm -f "$FORCE_LIVE_FILE"
	exit 0
fi
kill -0 "$1" >/dev/null 2>&1 && exit 0
exit 1
SH
SIGNAL_BIN="$TMP/signal"
cat > "$SIGNAL_BIN" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
kill "-${2#SIG}" "$1" >/dev/null 2>&1 || exit 1
SH
chmod +x "$PROBE_BIN" "$SIGNAL_BIN"
export FLYWHEEL_CODEX_RECONCILE_GROUP_PROBE_BIN="$PROBE_BIN"
export FLYWHEEL_CODEX_RECONCILE_SIGNAL_BIN="$SIGNAL_BIN"

run_manager() {
	node "$SUT" --fence "$FENCE" --timeout-ms "$1" --kill-grace-ms "$2" --proof-ms "$3" -- "${@:4}"
}

out="$(run_manager 1000 50 500 /bin/bash -c 'printf success')"
[ "$out" = success ]
[ ! -e "$FENCE" ]

set +e
run_manager 1000 50 500 /bin/bash -c 'exit 7'
rc=$?
set -e
[ "$rc" -eq 7 ]
[ ! -e "$FENCE" ]

# TERM-resistant direct child and its inherited sleep are killed by the
# manager-owned KILL timer; the fence releases only after the group disappears.
set +e
run_manager 100 50 1000 /bin/bash -c 'trap "" TERM; while :; do :; done'
rc=$?
set -e
[ "$rc" -eq 124 ]
[ ! -e "$FENCE" ]

# A direct child that exits while leaving a detached-in-the-group descendant is
# still a failed attempt, but the manager reaps it and proves the group empty.
set +e
FORCE_LIVE_FILE="$TMP/force-live"; : > "$FORCE_LIVE_FILE"
FORCE_LIVE_FILE="$FORCE_LIVE_FILE" run_manager 1000 50 1000 /bin/bash -c 'exit 0'
rc=$?
set -e
[ "$rc" -eq 74 ]
[ ! -e "$FENCE" ]

# Unknown group state retains the durable fence. A later invocation may reclaim
# it only after PID+start evidence proves both recorded owners are gone.
set +e
FLYWHEEL_CODEX_RECONCILE_FORCE_GROUP_UNKNOWN=1 \
	run_manager 1000 50 100 /bin/bash -c 'exit 0'
rc=$?
set -e
[ "$rc" -eq 75 ]
[ -f "$FENCE/owner.json" ]
jq -e '.status == "exit_unproven"' "$FENCE/owner.json" >/dev/null
run_manager 1000 50 500 /bin/bash -c 'exit 0'
[ ! -e "$FENCE" ]

echo "PASS Codex home reconcile bounded process manager"
