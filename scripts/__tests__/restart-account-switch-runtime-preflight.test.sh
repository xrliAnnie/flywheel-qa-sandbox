#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESTART="$ROOT/scripts/restart-services.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/flywheel-switch-preflight.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FUNCS="$TMP/preflight.sh"
sed -n '/^account_switch_runtime_preflight()/,/^}/p' "$RESTART" > "$FUNCS"
grep -q '^account_switch_runtime_preflight()' "$FUNCS" || {
	echo "FAIL: restart-services lacks account_switch_runtime_preflight" >&2
	exit 1
}

mkdir -p "$TMP/repo/packages/teamlead/bin" "$TMP/repo/packages/teamlead/dist/account-heal"
: > "$TMP/repo/packages/teamlead/dist/account-heal/account-switch-cli.js"
cat > "$TMP/repo/packages/teamlead/bin/flywheel-claude-switch" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "--runtime-check" ]] || exit 9
echo runtime-ok
EOF
chmod +x "$TMP/repo/packages/teamlead/bin/flywheel-claude-switch"

log() { :; }
# shellcheck disable=SC1090
source "$FUNCS"
FLYWHEEL_DIR="$TMP/repo"
account_switch_runtime_preflight

rm "$TMP/repo/packages/teamlead/dist/account-heal/account-switch-cli.js"
if account_switch_runtime_preflight; then
	echo "FAIL: missing built account switch runtime passed preflight" >&2
	exit 1
fi

rm "$TMP/repo/packages/teamlead/bin/flywheel-claude-switch"
if ! account_switch_runtime_preflight; then
	echo "FAIL: a pre-FLY-2240 checkout with neither runtime artifact must remain rollback-compatible" >&2
	exit 1
fi

deploy_body="$(sed -n '/^deploy_and_verify()/,/^}/p' "$RESTART")"
build_line="$(grep -n 'build_project' <<<"$deploy_body" | tail -1 | cut -d: -f1)"
preflight_line="$(grep -n 'account_switch_runtime_preflight' <<<"$deploy_body" | tail -1 | cut -d: -f1)"
skip_line="$(grep -n 'Build skipped (no build-relevant code delta)' <<<"$deploy_body" | tail -1 | cut -d: -f1)"
start_line="$(grep -n 'start_bridge' <<<"$deploy_body" | tail -1 | cut -d: -f1)"
if [[ -z "$build_line" || -z "$preflight_line" || -z "$skip_line" || -z "$start_line" ]] \
	|| (( preflight_line <= build_line || preflight_line >= skip_line || preflight_line >= start_line )); then
	echo "FAIL: runtime preflight must run only after a real build and before the skip-build/Bridge paths" >&2
	exit 1
fi

rollback_body="$(sed -n '/^rollback_and_restart()/,/^}/p' "$RESTART")"
if grep -q 'account_switch_runtime_preflight' <<<"$rollback_body"; then
	echo "FAIL: a known-good rollback must not require the newer account-switch runtime" >&2
	exit 1
fi

# FLY-2240 QA retry: exercise the real Bash mutation binary in the shared
# process-group shape used by a non-detached caller. A rejected mutation that
# has already written its transition journal must not let the caller's
# long-lived PGID wedge every later switch after the actual writer exits.
PROFILE_BIN="${FLYWHEEL_PROFILE_BIN_UNDER_TEST:-$ROOT/packages/claude-runner/bin/flywheel-claude-profile}"
SEQUENCE_ROOT="$TMP/shared-group-sequence"
POOL="$SEQUENCE_ROOT/pool"
STATE="$SEQUENCE_ROOT/keychain"
SECURITY_BIN="$SEQUENCE_ROOT/security"
FRESHNESS_BIN="$SEQUENCE_ROOT/freshness"
QUOTA_BIN="$SEQUENCE_ROOT/quota-guard"
CURL_BIN="$SEQUENCE_ROOT/curl"
PS_BIN="$SEQUENCE_ROOT/ps"
ACCOUNTS_STORE="$SEQUENCE_ROOT/claude-accounts.json"
TRANSITION_JOURNAL="$SEQUENCE_ROOT/transition-journal.json"
mkdir -p "$POOL/alpha" "$POOL/bravo"

SECRET_ALPHA='{"claudeAiOauth":{"accessToken":"ALPHA-CI-TOKEN","refreshToken":"ALPHA-CI-REFRESH"}}'
SECRET_BRAVO='{"claudeAiOauth":{"accessToken":"BRAVO-CI-TOKEN","refreshToken":"BRAVO-CI-REFRESH"}}'
printf '%s' "$SECRET_ALPHA" >"$POOL/alpha/.credentials.json"
printf '%s' "$SECRET_BRAVO" >"$POOL/bravo/.credentials.json"
chmod 600 "$POOL/alpha/.credentials.json" "$POOL/bravo/.credentials.json"
printf '%s' "$SECRET_ALPHA" >"$STATE"
printf 'alpha' >"$POOL/.active"
printf '{"generation":1,"activeAccount":"alpha","accounts":[{"name":"alpha"},{"name":"bravo"}]}' >"$ACCOUNTS_STORE"
printf '{"oauthAccount":{"emailAddress":"alpha@test.invalid"}}' >"$SEQUENCE_ROOT/claude.json"

seed_anchor() {
	local name="$1" uuid="$2" email="$3"
	printf '{"accountUuid":"%s","email":"%s","anchoredAt":"2026-09-02T00:00:00.000Z","anchoredBy":"ci","confirmedBy":"ci"}' \
		"$uuid" "$email" >"$POOL/$name/identity-anchor.json"
	chmod 600 "$POOL/$name/identity-anchor.json"
}
seed_anchor alpha uuid-alpha alpha@test.invalid
seed_anchor bravo uuid-bravo bravo@test.invalid

cat >"$SECURITY_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
	find-generic-password)
		cat "$FAKE_SECURITY_STATE"
		;;
	-i)
		command_text="$(cat)"
		value="$(printf '%s' "$command_text" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
		[[ -n "$value" ]]
		printf '%s' "$value" >"$FAKE_SECURITY_STATE"
		;;
	delete-generic-password)
		rm -f "$FAKE_SECURITY_STATE"
		;;
	*)
		exit 2
		;;
esac
EOF

cat >"$FRESHNESS_BIN" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat >"$QUOTA_BIN" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "check" ]] || exit 2
exit 0
EOF

cat >"$CURL_BIN" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
config="$(cat)"
case "$config" in
	*ALPHA-CI-TOKEN*) printf '{"account":{"uuid":"uuid-alpha","email":"alpha@test.invalid"}}' ;;
	*BRAVO-CI-TOKEN*) printf '{"account":{"uuid":"uuid-bravo","email":"bravo@test.invalid"}}' ;;
	*) exit 22 ;;
esac
EOF

CALLER_PGID="$(python3 -c 'import os; print(os.getpgrp())')"
CALLER_BASELINE_PID="$$"
PS_AXO_CALLS="$SEQUENCE_ROOT/ps-axo-calls"
cat >"$PS_BIN" <<EOF
#!/usr/bin/env bash
case "\$*" in
	"-axo pid=,pgid=,lstart=")
		calls=0
		[[ -f "\$FAKE_PS_AXO_CALLS" ]] && calls="\$(cat "\$FAKE_PS_AXO_CALLS")"
		calls=\$((calls + 1))
		printf '%s' "\$calls" >"\$FAKE_PS_AXO_CALLS"
		printf '%s %s %s\n' "$CALLER_BASELINE_PID" "$CALLER_PGID" 'Wed Sep  2 00:00:00 2026'
		# A post-journal snapshot must differ from the pre-journal baseline. This
		# catches shared-group descendant fencing that mistakes an unrelated
		# caller-group member for a still-running mutation writer.
		if (( calls > 1 )); then
			printf '%s %s %s\n' '2147483646' "$CALLER_PGID" 'Wed Sep  2 00:00:01 2026'
		fi
		;;
	*"pgid="*) printf '%s\n' "$CALLER_PGID" ;;
	*"lstart="*) printf '%s\n' 'Wed Sep  2 00:00:00 2026' ;;
	*) exit 1 ;;
esac
EOF
chmod +x "$SECURITY_BIN" "$FRESHNESS_BIN" "$QUOTA_BIN" "$CURL_BIN" "$PS_BIN"

export FLYWHEEL_CLAUDE_PROFILES_DIR="$POOL"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$SEQUENCE_ROOT/lock"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$ACCOUNTS_STORE"
export FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN="$QUOTA_BIN"
export FLYWHEEL_CLAUDE_SECURITY_BIN="$SECURITY_BIN"
export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="FLY-2240-CI-credentials"
export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="ci"
export FLYWHEEL_CLAUDE_JSON="$SEQUENCE_ROOT/claude.json"
export FLYWHEEL_CLAUDE_JSON_LOCK="$SEQUENCE_ROOT/claude-json.lock"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$FRESHNESS_BIN"
export FLYWHEEL_CLAUDE_TRANSITION_JOURNAL="$TRANSITION_JOURNAL"
export FLYWHEEL_CLAUDE_PS_BIN="$PS_BIN"
export FLYWHEEL_PROFILE_CURL_BIN="$CURL_BIN"
export FLYWHEEL_PROFILE_IDENTITY_ENDPOINT="https://identity.test.invalid/oauth/profile"
export FLYWHEEL_PROFILE_AUDIT_LOG="$SEQUENCE_ROOT/audit.log"
export FAKE_SECURITY_STATE="$STATE"
export FAKE_PS_AXO_CALLS="$PS_AXO_CALLS"
unset FLYWHEEL_CLAUDE_QUOTA_PREVERIFIED FLYWHEEL_PROFILE_IDENTITY_BYPASS \
	FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL

invoke_delegated_use() {
	local target="$1" holder_pid token marker rc
	holder_pid="${BASHPID:-$$}"
	token="fly2240-${holder_pid}-${RANDOM}"
	marker="$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK/holder.${holder_pid}.${token}"
	mkdir "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK" || return 1
	printf '{"pid":%d,"at":%d,"token":"%s"}' \
		"$holder_pid" "$(( $(date +%s) * 1000 ))" "$token" >"$marker"
	chmod 600 "$marker"
	if FLYWHEEL_CLAUDE_LOCK_DELEGATED="$holder_pid" \
		FLYWHEEL_ATOMIC_SWITCH_APPLY=1 \
		bash "$PROFILE_BIN" use "$target"; then
		rc=0
	else
		rc=$?
	fi
	rm -f "$marker"
	rmdir "$FLYWHEEL_CLAUDE_ACCOUNTS_LOCK" 2>/dev/null || true
	return "$rc"
}

PAUSE="$SEQUENCE_ROOT/journal-pause"
FIRST_LOG="$SEQUENCE_ROOT/first-switch.log"
(
	export FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL="$PAUSE"
	invoke_delegated_use bravo
) >"$FIRST_LOG" 2>&1 &
FIRST_JOB_PID=$!
PAUSE_READY=0
for _ in $(seq 1 500); do
	if [[ -e "$PAUSE.ready" ]]; then
		PAUSE_READY=1
		break
	fi
	sleep 0.01
done
if [[ "$PAUSE_READY" -ne 1 ]]; then
	kill "$FIRST_JOB_PID" 2>/dev/null || true
	wait "$FIRST_JOB_PID" 2>/dev/null || true
	echo "FAIL: first switch never reached the post-journal pause" >&2
	exit 1
fi
chmod 500 "$POOL"
: >"$PAUSE.continue"
set +e
wait "$FIRST_JOB_PID"
FIRST_RC=$?
set -e
chmod 700 "$POOL"
FIRST_OUTPUT="$(cat "$FIRST_LOG")"
if [[ "$FIRST_RC" -eq 0 || "$FIRST_OUTPUT" != *"active marker commit failed"* ]]; then
	echo "FAIL: first switch must be rejected after journaling (rc=$FIRST_RC output=$FIRST_OUTPUT)" >&2
	exit 1
fi
if [[ "$(cat "$STATE")" != "$SECRET_ALPHA" || "$(cat "$POOL/.active")" != "alpha" || ! -f "$TRANSITION_JOURNAL" ]]; then
	echo "FAIL: rejected switch must restore alpha and retain a recoverable journal" >&2
	exit 1
fi

read -r WRITER_PGID LEADER_PID < <(
	node -e 'const j=require(process.argv[1]); process.stdout.write(`${j.writerPgid} ${j.leaderPid}\n`)' \
		"$TRANSITION_JOURNAL"
)
if [[ "$WRITER_PGID" != "$CALLER_PGID" || "$WRITER_PGID" == "$LEADER_PID" ]]; then
	echo "FAIL: fixture did not produce a shared caller group (caller=$CALLER_PGID writer=$WRITER_PGID leader=$LEADER_PID)" >&2
	exit 1
fi
if kill -0 "$LEADER_PID" 2>/dev/null || ! kill -0 -- "-$WRITER_PGID" 2>/dev/null; then
	echo "FAIL: expected dead writer leader inside a still-live caller group" >&2
	exit 1
fi

set +e
SECOND_OUTPUT="$(invoke_delegated_use bravo 2>&1)"
SECOND_RC=$?
set -e
if [[ "$SECOND_RC" -ne 0 || "$(cat "$STATE")" != "$SECRET_BRAVO" || "$(cat "$POOL/.active")" != "bravo" ]]; then
	echo "FAIL: healthy retry after rejected shared-group writer did not switch once (rc=$SECOND_RC output=$SECOND_OUTPUT)" >&2
	exit 1
fi
if [[ -e "$TRANSITION_JOURNAL" ]]; then
	echo "FAIL: healthy retry left transition journal residue" >&2
	exit 1
fi
echo "restart account switch runtime preflight + shared-group retry: passed"
