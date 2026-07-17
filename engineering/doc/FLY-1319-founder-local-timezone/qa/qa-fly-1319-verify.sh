#!/usr/bin/env bash
# QA · FLY-1319 founder local timezone — independent verification harness.
#
# Each check prints PASS/FAIL and is designed to be run from the repo root on a
# machine where the packages are built:
#   pnpm --filter flywheel-config --filter flywheel-comm build
#
# Checks A* verify the shipped behaviour (the founder-time primitive).
# Checks B* reproduce the two defects this QA pass found.

set -uo pipefail
cd "$(dirname "$0")/../../../.." || exit 1

CLI="packages/flywheel-comm/dist/index.js"
pass=0
fail=0
ok() { echo "  PASS - $1"; pass=$((pass + 1)); }
no() { echo "  FAIL - $1"; fail=$((fail + 1)); }

echo "=== A. founder-time primitive (the shipped fix) ==="

# A1 — the auto path must agree with the host device, to the minute.
host_now=$(date '+%Y-%m-%d %H:%M')
cli_now=$(env -u FLYWHEEL_FOUNDER_TZ node "$CLI" founder-time 2>/dev/null | cut -d' ' -f1-2)
if [ "$host_now" = "$cli_now" ]; then
	ok "A1 auto path matches host wall clock ($cli_now)"
else
	no "A1 auto path ($cli_now) != host ($host_now)"
fi

# A2 — POSITIVE CONTROL. If the override cannot move the answer, every other
# check here is measuring a stuck ruler rather than real behaviour.
tokyo=$(FLYWHEEL_FOUNDER_TZ=Asia/Tokyo node "$CLI" founder-time --json 2>/dev/null)
case "$tokyo" in
*'"tz":"Asia/Tokyo"'*'"offsetMinutes":540'*) ok "A2 positive control: override moves the ruler to Tokyo (+540)" ;;
*) no "A2 positive control FAILED — override did not move the ruler: $tokyo" ;;
esac

# A3 — a half-hour zone, east-positive sign convention (plan §A1).
kolkata=$(FLYWHEEL_FOUNDER_TZ=Asia/Kolkata node "$CLI" founder-time --json 2>/dev/null)
case "$kolkata" in
*'"offsetMinutes":330'*) ok "A3 non-integer offset east-positive (Kolkata +330)" ;;
*) no "A3 Kolkata offset wrong: $kolkata" ;;
esac

# A4 — an invalid override must warn and degrade to the host, never crash.
warn=$(FLYWHEEL_FOUNDER_TZ=Not/AZone node "$CLI" founder-time 2>&1 >/dev/null)
out=$(FLYWHEEL_FOUNDER_TZ=Not/AZone node "$CLI" founder-time 2>/dev/null)
if [ -n "$warn" ] && [ -n "$out" ]; then
	ok "A4 invalid override warns + falls back (still prints a time)"
else
	no "A4 invalid override did not warn/fall back cleanly"
fi

echo
echo "=== B. Defects found by this QA pass ==="

# B1 — the production Mufasa TUI launcher must bind the rule's founder-time CLI
# authority itself; ambient shell state is intentionally scrubbed by the launcher
# test, and its node shim captures the exact runtime environment.
if bash packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui-fullaccess.test.sh >/tmp/qa1319-b1.log 2>&1; then
	ok "B1 production Mufasa runtime receives FLYWHEEL_COMM_CLI"
else
	no "B1 production Mufasa runtime still lacks FLYWHEEL_COMM_CLI"
fi

# B2 — the rollback TUI launcher's contract assertions are exact-match globs that
# expect the list to END with companion-safety-contract.md. FLY-1319 appends
# founder-local-time.md after it, so the two byte-compat assertions now fail.
# Proven against the pre-FLY-1319 baseline: 20 passed / 0 failed there.
if bash packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui.test.sh >/tmp/qa1319-b2.log 2>&1; then
	ok "B2 run-codex-lead-mufasa-tui.test.sh green"
else
	no "B2 run-codex-lead-mufasa-tui.test.sh RED ($(grep -c '✗' /tmp/qa1319-b2.log) stale contract assertions) — baseline was 0 failed"
fi

echo
echo "qa-fly-1319: $pass passed, $fail failed"
