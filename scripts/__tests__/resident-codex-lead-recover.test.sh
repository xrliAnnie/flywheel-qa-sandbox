#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUT="$ROOT/scripts/resident-codex-lead-recover.sh"
TMP_ROOT="$(mktemp -d "/tmp/fly2216-codex-residency-recover.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

make_fixture() {
	local t="$1"
	mkdir -p "$t/home/.codex-raya" "$t/bin" \
		"$t/repo/packages/teamlead/dist/lead-backends/codex" "$t/home/Library/LaunchAgents"
	printf '4242\n' > "$t/pid"
	cat > "$t/projects.json" <<JSON
[{"projectName":"raya","projectRoot":"$t/raya-workspace","leads":[{"agentId":"raya","backend":"codex-app-server","codexProfile":"full-access","canSpawnRunners":false,"codexResidencyPatrol":true,"summaryRole":"recipient","chatChannel":"1","match":{"labels":["raya"]}}]}]
JSON
	cat > "$t/manifest.json" <<JSON
{"projectName":"raya","leadId":"raya","projectDir":"$t/raya-workspace","leadBackend":{"backendId":"codex-app-server"}}
JSON
	cat > "$t/plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.flywheel.lead.raya-raya</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>$t/home/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh</string></array></dict></plist>
PLIST
	cat > "$t/heartbeat.json" <<JSON
{"v":1,"generationId":"generation-a","threadId":"thread-a","processPid":4242,"carrierInstanceId":"carrier-a","state":"online","activeTurn":null,"updatedAt":"2026-09-01T06:00:00.000Z"}
JSON
	cat > "$t/bin/launchctl" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'launchctl %s\n' "$*" >> "$CODEX_RESIDENCY_FAKE_ROOT/calls"
case "$1" in
	print)
		printf 'pid = %s\n' "$(cat "$CODEX_RESIDENCY_FAKE_ROOT/pid")"
		;;
	kickstart)
		if [ ! -s "$CODEX_RESIDENCY_FAKE_ROOT/recovery-receipts.jsonl" ]; then
			printf 'mutation-before-receipt\n' >> "$CODEX_RESIDENCY_FAKE_ROOT/calls"
			exit 91
		fi
		printf '5252\n' > "$CODEX_RESIDENCY_FAKE_ROOT/pid"
		if [ "${CODEX_RESIDENCY_FAKE_NO_HEARTBEAT:-0}" != 1 ]; then
			cat > "$CODEX_RESIDENCY_FAKE_ROOT/heartbeat.json" <<JSON
{"v":1,"generationId":"generation-b","threadId":"thread-a","processPid":5252,"carrierInstanceId":"carrier-b","state":"online","activeTurn":null,"updatedAt":"2026-09-01T06:01:00.000Z"}
JSON
		fi
		;;
	*) exit 2 ;;
esac
SH
	cat > "$t/bin/ps" <<'SH'
#!/usr/bin/env bash
set -eu
count=0
[ ! -f "$CODEX_RESIDENCY_FAKE_ROOT/ps-count" ] || count="$(cat "$CODEX_RESIDENCY_FAKE_ROOT/ps-count")"
count=$((count + 1)); printf '%s\n' "$count" > "$CODEX_RESIDENCY_FAKE_ROOT/ps-count"
if [ "${CODEX_RESIDENCY_FAKE_PS_DRIFT:-}" = authority ] && [ "$count" -eq 3 ]; then
	printf '%s\n' '{"projectName":"raya","leadId":"raya","projectDir":"/drift","leadBackend":{"backendId":"claude-code"}}' > "$CODEX_RESIDENCY_FAKE_ROOT/manifest.json"
fi
pid=""
for arg in "$@"; do case "$arg" in [1-9][0-9]*) pid="$arg" ;; esac; done
[ -n "$pid" ] || exit 2
codex_home="${CODEX_RESIDENCY_FAKE_CODEX_HOME:-$CODEX_RESIDENCY_FAKE_ROOT/home/.codex-raya}"
if printf '%s\n' "$*" | grep -q 'lstart='; then
	if [ "$pid" = 4242 ]; then printf 'Tue Sep  1 05:00:00 2026\n'; else printf 'Tue Sep  1 06:01:00 2026\n'; fi
else
	if printf '%s\n' "$*" | grep -q 'eww'; then
		if [ "${CODEX_RESIDENCY_FAKE_PS_SECRET:-0}" = 1 ]; then
			printf "%s=machine-secret' CODEX_HOME=%s /usr/bin/node %s/repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js\n" \
				'SIMBA''_BOT_TOKEN' "$codex_home" "$CODEX_RESIDENCY_FAKE_ROOT"
		else
			printf 'CODEX_HOME=%s /usr/bin/node %s/repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js\n' "$codex_home" "$CODEX_RESIDENCY_FAKE_ROOT"
		fi
	else
		printf '/usr/bin/node %s/repo/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js\n' "$CODEX_RESIDENCY_FAKE_ROOT"
	fi
fi
SH
	cat > "$t/bin/bounded-run" <<'SH'
#!/usr/bin/env bash
set -eu
printf 'bounded %s\n' "$*" >> "$CODEX_RESIDENCY_FAKE_ROOT/calls"
shift
exec "$@"
SH
	chmod +x "$t/bin/launchctl" "$t/bin/ps" "$t/bin/bounded-run"
}

run_helper() {
	local t="$1"; shift
	CODEX_RESIDENCY_FAKE_ROOT="$t" \
	FLYWHEEL_CODEX_RESIDENCY_RECOVERY_TEST_ROOT="$t" \
	FLYWHEEL_CODEX_RESIDENCY_LAUNCHCTL_BIN="$t/bin/launchctl" \
	FLYWHEEL_CODEX_RESIDENCY_PS_BIN="$t/bin/ps" \
	FLYWHEEL_CODEX_RESIDENCY_BOUNDED_RUN_BIN="$t/bin/bounded-run" \
	CODEX_LEAD_RESIDENCY_VERIFY_ATTEMPTS=2 CODEX_LEAD_RESIDENCY_VERIFY_INTERVAL_SECONDS=0 \
		"$SUT" --project raya --lead raya "$@"
}

T1="$TMP_ROOT/success"; make_fixture "$T1"
PROBE="$(run_helper "$T1" --probe 2>/dev/null || true)"
if jq -e --arg home "$T1/home/.codex-raya" '
	.state == "exact" and .pid == 4242 and .codexHome == $home
	and .label == "com.flywheel.lead.raya-raya"
	and .wrapper == "flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh"
	and (.argv | any(endswith("/codex-lead-tui-runtime.js")))' <<<"$PROBE" >/dev/null; then
	pass "probe returns only the exact Raya process identity"
else
	fail "exact probe contract failed: $PROBE"
fi

T_OLD_HOME="$TMP_ROOT/old-shared-home"; make_fixture "$T_OLD_HOME"
CODEX_RESIDENCY_FAKE_CODEX_HOME="$T_OLD_HOME/home/.flywheel/raya/codex-home" \
	run_helper "$T_OLD_HOME" --probe >/dev/null 2>&1
old_probe_rc=$?
CODEX_RESIDENCY_FAKE_CODEX_HOME="$T_OLD_HOME/home/.flywheel/raya/codex-home" \
	run_helper "$T_OLD_HOME" --recover --expected-pid 4242 \
		--expected-lstart 'Tue Sep  1 05:00:00 2026' \
		--expected-generation generation-a --expected-carrier-instance carrier-a >/dev/null 2>&1
old_recover_rc=$?
if [ "$old_probe_rc" -eq 21 ] && [ "$old_recover_rc" -eq 21 ] \
	&& [ "$(grep -cv '^launchctl print gui/' "$T_OLD_HOME/calls" || true)" -eq 0 ] \
	&& ! grep -q 'kickstart\|^bounded ' "$T_OLD_HOME/calls" \
	&& [ ! -e "$T_OLD_HOME/recovery-receipts.jsonl" ]; then
	pass "Raya's retired shared CODEX_HOME is rejected before mutation"
else
	fail "retired shared CODEX_HOME was not zero-mutation (probe=$old_probe_rc recover=$old_recover_rc calls=$(cat "$T_OLD_HOME/calls" 2>/dev/null))"
fi

T_MUFASA="$TMP_ROOT/mufasa-probe"; make_fixture "$T_MUFASA"
mkdir -p "$T_MUFASA/home/.codex-mufasa"
cat > "$T_MUFASA/projects.json" <<JSON
[{"projectName":"growth","projectRoot":"$T_MUFASA/growth-workspace","leads":[{"agentId":"mufasa-lead","backend":"codex-app-server","companion":true,"canSpawnRunners":false,"codexResidencyPatrol":true,"summaryRole":"producer","chatChannel":"1","match":{"labels":["growth"]}}]}]
JSON
cat > "$T_MUFASA/manifest.json" <<JSON
{"projectName":"growth","leadId":"mufasa-lead","projectDir":"$T_MUFASA/growth-workspace","leadBackend":{"backendId":"codex-app-server"}}
JSON
cat > "$T_MUFASA/plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.flywheel.lead.growth-mufasa-lead</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>$T_MUFASA/home/.flywheel/bin/flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh</string></array></dict></plist>
PLIST
MUFASA_PROBE="$(CODEX_RESIDENCY_FAKE_CODEX_HOME="$T_MUFASA/home/.codex-mufasa" \
	CODEX_RESIDENCY_FAKE_ROOT="$T_MUFASA" \
	FLYWHEEL_CODEX_RESIDENCY_RECOVERY_TEST_ROOT="$T_MUFASA" \
	FLYWHEEL_CODEX_RESIDENCY_LAUNCHCTL_BIN="$T_MUFASA/bin/launchctl" \
	FLYWHEEL_CODEX_RESIDENCY_PS_BIN="$T_MUFASA/bin/ps" \
	FLYWHEEL_CODEX_RESIDENCY_BOUNDED_RUN_BIN="$T_MUFASA/bin/bounded-run" \
	"$SUT" --project growth --lead mufasa-lead --probe 2>/dev/null || true)"
if jq -e --arg home "$T_MUFASA/home/.codex-mufasa" '
	.state == "exact" and .pid == 4242 and .codexHome == $home
	and .label == "com.flywheel.lead.growth-mufasa-lead"
	and .wrapper == "flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh"' \
	<<<"$MUFASA_PROBE" >/dev/null; then
	pass "the same recovery helper probes a second resident Codex Lead carrier"
else
	fail "second carrier probe contract failed: $MUFASA_PROBE"
fi

T_SECRET="$TMP_ROOT/secret-env"; make_fixture "$T_SECRET"
SECRET_PROBE="$(CODEX_RESIDENCY_FAKE_PS_SECRET=1 run_helper "$T_SECRET" --probe 2>/dev/null || true)"
if jq -e '.state == "exact" and .pid == 4242' <<<"$SECRET_PROBE" >/dev/null; then
	pass "probe keeps secret-bearing process environment off parser argv"
else
	fail "secret-bearing environment broke exact probe: $SECRET_PROBE"
fi

RECOVER="$(run_helper "$T1" --recover --expected-pid 4242 \
	--expected-lstart 'Tue Sep  1 05:00:00 2026' \
	--expected-generation generation-a --expected-carrier-instance carrier-a 2>/dev/null || true)"
if jq -e '.ok == true and .detail == "converged" and .newPid == 5252' <<<"$RECOVER" >/dev/null \
	&& [ "$(head -n1 "$T1/calls")" = 'launchctl print gui/'"$(id -u)"'/com.flywheel.lead.raya-raya' ] \
	&& ! grep -q 'mutation-before-receipt\|com.xrli.raya.brain' "$T1/calls" \
	&& jq -e '.phase == "pre_mutation" and .old.pid == 4242' "$T1/recovery-receipts.jsonl" >/dev/null; then
	pass "eligible recovery receipts before bounded exact-label kickstart and converges"
else
	fail "exact recovery did not converge safely: $RECOVER"
fi

T2="$TMP_ROOT/backend"; make_fixture "$T2"
jq '.[0].leads[0].backend="claude-code"' "$T2/projects.json" > "$T2/projects.tmp" && mv "$T2/projects.tmp" "$T2/projects.json"
if run_helper "$T2" --recover --expected-pid 4242 --expected-lstart 'Tue Sep  1 05:00:00 2026' \
	--expected-generation generation-a --expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "backend drift gained recovery authority"
elif ! grep -q 'kickstart' "$T2/calls" 2>/dev/null; then pass "backend drift is zero-mutation"; else fail "backend drift mutated launchd"; fi

T_OPT="$TMP_ROOT/opt-in"; make_fixture "$T_OPT"
jq 'del(.[0].leads[0].codexResidencyPatrol)' "$T_OPT/projects.json" > "$T_OPT/projects.tmp" \
	&& mv "$T_OPT/projects.tmp" "$T_OPT/projects.json"
if run_helper "$T_OPT" --probe >/dev/null 2>&1; then
	fail "non-opted existing Codex Lead gained residency authority"
elif [ ! -s "$T_OPT/calls" ]; then
	pass "non-opted existing Codex Lead remains on its unchanged path"
else
	fail "non-opted existing Codex Lead reached process or mutation tools"
fi

T3="$TMP_ROOT/tuple"; make_fixture "$T3"
if run_helper "$T3" --recover --expected-pid 9999 --expected-lstart 'Tue Sep  1 05:00:00 2026' \
	--expected-generation generation-a --expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "wrong expected pid gained recovery authority"
elif ! grep -q 'kickstart' "$T3/calls" 2>/dev/null; then pass "pid+lstart mismatch is zero-mutation"; else fail "tuple mismatch mutated launchd"; fi

T4="$TMP_ROOT/toctou"; make_fixture "$T4"
if CODEX_RESIDENCY_FAKE_PS_DRIFT=authority run_helper "$T4" --recover --expected-pid 4242 \
	--expected-lstart 'Tue Sep  1 05:00:00 2026' --expected-generation generation-a \
	--expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "authority TOCTOU gained recovery authority"
elif ! grep -q 'kickstart' "$T4/calls" 2>/dev/null; then pass "second authority check blocks TOCTOU"; else fail "TOCTOU mutated launchd"; fi

T5="$TMP_ROOT/receipt"; make_fixture "$T5"; mkdir "$T5/recovery-receipts.jsonl"
if run_helper "$T5" --recover --expected-pid 4242 --expected-lstart 'Tue Sep  1 05:00:00 2026' \
	--expected-generation generation-a --expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "receipt write failure gained recovery authority"
elif ! grep -q 'kickstart' "$T5/calls" 2>/dev/null; then pass "receipt failure is zero-mutation"; else fail "receipt failure mutated launchd"; fi

T6="$TMP_ROOT/no-heartbeat"; make_fixture "$T6"
if CODEX_RESIDENCY_FAKE_NO_HEARTBEAT=1 run_helper "$T6" --recover --expected-pid 4242 \
	--expected-lstart 'Tue Sep  1 05:00:00 2026' --expected-generation generation-a \
	--expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "replacement without new generation heartbeat reported success"
elif grep -q 'kickstart -k gui/' "$T6/calls"; then pass "missing new heartbeat is an explicit post-mutation failure"; else fail "convergence negative never exercised mutation"; fi

T7="$TMP_ROOT/observed"; make_fixture "$T7"; rm "$T7/heartbeat.json"
cat > "$T7/observed.json" <<JSON
{"pid":4242,"lstart":"Tue Sep  1 05:00:00 2026","generationId":"generation-a","carrierInstanceId":"carrier-a","observedAt":"2026-09-01T06:00:00.000Z"}
JSON
OBSERVED_RECOVERY="$(run_helper "$T7" --recover --expected-pid 4242 \
	--expected-lstart 'Tue Sep  1 05:00:00 2026' --expected-generation generation-a \
	--expected-carrier-instance carrier-a 2>/dev/null || true)"
if jq -e '.ok == true and .newPid == 5252' <<<"$OBSERVED_RECOVERY" >/dev/null; then
	pass "durably observed generation permits recovery after heartbeat loss"
else
	fail "observed heartbeat-loss recovery failed: $OBSERVED_RECOVERY"
fi

T8="$TMP_ROOT/unobserved"; make_fixture "$T8"; rm "$T8/heartbeat.json"
if run_helper "$T8" --recover --expected-pid 4242 --expected-lstart 'Tue Sep  1 05:00:00 2026' \
	--expected-generation generation-a --expected-carrier-instance carrier-a >/dev/null 2>&1; then
	fail "never-observed generation gained recovery authority"
elif ! grep -q 'kickstart' "$T8/calls" 2>/dev/null; then pass "never-observed heartbeat loss is zero-mutation"; else fail "unobserved generation mutated launchd"; fi

if [ -x "$SUT" ]; then pass "recovery helper is executable"; else fail "recovery helper is missing or not executable"; fi

for closure in \
	"$ROOT/scripts/converge-flywheel-bin.sh" \
	"$ROOT/scripts/package-onboard.sh" \
	"$ROOT/scripts/package-onboard-files.allow" \
	"$ROOT/scripts/lib/path-hygiene.sh" \
	"$ROOT/scripts/provision-fleet-host.sh"; do
	if grep -Fq 'resident-codex-lead-recover.sh' "$closure"; then
		pass "recovery helper ships in ${closure#$ROOT/}"
	else
		fail "recovery helper missing from ${closure#$ROOT/}"
	fi
done

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
