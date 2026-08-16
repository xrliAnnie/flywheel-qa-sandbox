#!/usr/bin/env bash
# FLY-1775: hermetic contracts for the generalized 529 room helpers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1775-generalized.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

failures=0
assert_eq() {
	local got="$1" expected="$2" label="$3"
	if [[ "$got" != "$expected" ]]; then
		echo "FAIL: ${label}" >&2
		printf '  expected: %q\n  got:      %q\n' "$expected" "$got" >&2
		failures=$((failures + 1))
	else
		echo "PASS: ${label}"
	fi
}

assert_contains() {
	local got="$1" needle="$2" label="$3"
	if [[ "$got" != *"$needle"* ]]; then
		echo "FAIL: ${label} (missing ${needle})" >&2
		failures=$((failures + 1))
	else
		echo "PASS: ${label}"
	fi
}

# shellcheck source=../lib/qa-multilead.sh
source "$ROOT/scripts/lib/qa-multilead.sh"
# shellcheck source=../lib/qa-generalized.sh
source "$ROOT/scripts/lib/qa-generalized.sh"

codex_stub_kill_log="$TMP_ROOT/codex-stub-kill.log"
slot_for_reap="$TMP_ROOT/flywheel-test-slot-2"
mkdir -p "$slot_for_reap/stub-state"
sqlite3 "$slot_for_reap/teamlead.db" \
	'CREATE TABLE workflow_actor (execution_id TEXT PRIMARY KEY); INSERT INTO workflow_actor VALUES ("implement-owned");'
printf '%s\n' '{"schemaVersion":1,"executionId":"implement-pruned"}' \
	> "$slot_for_reap/stub-state/implement-pruned.json"
printf '%s\n' '{"schemaVersion":1,"executionId":"filename-mismatch"}' \
	> "$slot_for_reap/stub-state/not-owned.json"
pgrep() {
	printf '%s\n' "$*" > "$TMP_ROOT/codex-stub-pgrep.log"
	printf '%s\n' 111 222 333
}
lsof() {
	local pid=''
	while (( $# > 0 )); do
		[[ "$1" == '-p' ]] && { pid="$2"; shift 2; continue; }
		shift
	done
	case "$pid" in
		111) printf 'p111\nn/Users/test/.flywheel/cdx-sock/1111111111111111.sock\n' ;;
		222) printf 'p222\nn/Users/test/.flywheel/cdx-sock/2222222222222222.sock\n' ;;
		333) printf 'p333\nn/Users/test/.flywheel/cdx-sock/3333333333333333.sock\n' ;;
	esac
}
shasum() {
	local value
	value="$(cat)"
	if [[ "$value" == 'implement-owned' ]]; then
		printf '1111111111111111aaaaaaaaaaaaaaaaaaaaaaaa -\n'
	elif [[ "$value" == 'implement-pruned' ]]; then
		printf '3333333333333333aaaaaaaaaaaaaaaaaaaaaaaa -\n'
	else
		printf '9999999999999999aaaaaaaaaaaaaaaaaaaaaaaa -\n'
	fi
}
kill() {
	printf '%s\n' "$*" >> "$codex_stub_kill_log"
	return 0
}
sleep() { :; }
qa_generalized_reap_codex_stub_orphans "$slot_for_reap"
assert_eq "$(<"$codex_stub_kill_log")" $'-TERM 111\n-TERM 333\n-0 111\n-KILL 111\n-0 333\n-KILL 333' \
	'generalized teardown reaps DB-owned and pruned-state Codex stub daemons'
assert_contains "$(<"$TMP_ROOT/codex-stub-pgrep.log")" \
	'qa-529-generalized-codex-stub' \
	'Codex stub reap candidate scan is limited to the deterministic app-server'

# A slot-owned teardown must not derive destructive ownership from a state
# directory redirected outside the canonical room.
external_stub_state="$TMP_ROOT/external-stub-state"
slot_with_symlinked_state="$TMP_ROOT/flywheel-test-slot-symlink"
mkdir -p "$external_stub_state" "$slot_with_symlinked_state"
printf '%s\n' '{"schemaVersion":1,"executionId":"implement-pruned"}' \
	> "$external_stub_state/implement-pruned.json"
ln -s "$external_stub_state" "$slot_with_symlinked_state/stub-state"
: > "$codex_stub_kill_log"
qa_generalized_reap_codex_stub_orphans "$slot_with_symlinked_state"
assert_eq "$(<"$codex_stub_kill_log")" '' \
	'generalized teardown rejects a symlinked stub-state authority directory'
command() {
	if [[ "$1" == '-v' && "$2" == 'lsof' ]]; then return 1; fi
	builtin command "$@"
}
missing_tool_err="$TMP_ROOT/missing-reaper-tool.err"
qa_generalized_reap_codex_stub_orphans "$slot_for_reap" \
	2> "$missing_tool_err"
assert_contains "$(<"$missing_tool_err")" 'lsof unavailable' \
	'generalized teardown reports when orphan proof tooling is unavailable'
unset -f command
unset -f pgrep lsof shasum kill sleep

assert_eq "$(declare -F qa_generalized_terminate_pid >/dev/null && echo yes || echo no)" \
	'yes' 'generalized cleanup exposes a bounded process termination helper'
if declare -F qa_generalized_terminate_pid >/dev/null; then
	terminate_kill_log="$TMP_ROOT/terminate-kill.log"
	terminate_alive=1
	terminate_ignore_kill=0
	kill() {
		printf '%s\n' "$*" >> "$terminate_kill_log"
		case "$1" in
			-0) (( terminate_alive == 1 )) ;;
			-KILL) (( terminate_ignore_kill == 1 )) || terminate_alive=0 ;;
		esac
	}
	sleep() { :; }
	if qa_generalized_terminate_pid 4242 2 2; then
		echo 'PASS: generalized cleanup escalates TERM to KILL and verifies exit'
	else
		echo 'FAIL: generalized cleanup rejected a process that exited after KILL' >&2
		failures=$((failures + 1))
	fi
	assert_contains "$(<"$terminate_kill_log")" '-TERM 4242' \
		'generalized cleanup starts with SIGTERM'
	assert_contains "$(<"$terminate_kill_log")" '-KILL 4242' \
		'generalized cleanup escalates a surviving process to SIGKILL'
	: > "$terminate_kill_log"
	terminate_alive=1
	terminate_ignore_kill=1
	if qa_generalized_terminate_pid 4242 1 1; then
		echo 'FAIL: generalized cleanup accepted a process surviving SIGKILL' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: generalized cleanup fails closed when process exit is unverified'
	fi
	unset -f kill sleep
fi

ordinary="$(qa_multilead_config_yaml test-slot-1)"
assert_eq "$(printf '%s\n' "$ordinary" | tail -n 1)" \
	'    timeout_behavior: fail-close' \
	'ordinary config remains byte-compatible at EOF'
if [[ "$ordinary" == *'pipeline:'* ]]; then
	echo 'FAIL: ordinary config unexpectedly enters the generalized pipeline domain' >&2
	failures=$((failures + 1))
else
	echo 'PASS: ordinary config has no pipeline block'
fi

generalized="$(qa_multilead_config_yaml test-slot-1 generalized)"
assert_contains "$generalized" $'pipeline:\n  dag: true\n  work_kind: true' \
	'generalized config enables DAG and work-kind together'

mapfile_compat=()
while IFS= read -r line; do
	[[ -n "$line" ]] && mapfile_compat+=("$line")
done < <(qa_generalized_feature_env)
assert_eq "${#mapfile_compat[@]}" '5' 'exactly five generalized workflow flags'
assert_eq "$(printf '%s\n' "${mapfile_compat[@]}" | sort -u | wc -l | tr -d ' ')" \
	'5' 'generalized workflow flags are unique'
assert_contains "$(printf '%s\n' "${mapfile_compat[@]}")" \
	'FLYWHEEL_WORKFLOW_GATE_CARRIER=1' 'gate-carrier flag is present'

scrub_names=()
while IFS= read -r name; do
	[[ -n "$name" ]] && scrub_names+=("$name")
done < <(qa_generalized_ambient_scrub_env_names)
assert_eq "$(printf '%s\n' "${scrub_names[@]}" | sort -u | wc -l | tr -d ' ')" \
	"${#scrub_names[@]}" 'generalized ambient scrub names are unique'
repo_roundtable_names=()
while IFS= read -r name; do
	[[ -n "$name" ]] && repo_roundtable_names+=("$name")
done < <(
	rg -o --no-filename 'FLYWHEEL_ROUNDTABLE_[A-Z0-9_]+' \
		"$ROOT/packages" "$ROOT/scripts" \
		--glob '!test-deploy-generalized.test.sh' \
		--glob '!**/feature-flags/truth.ts' \
		--glob '!**/flag-truth.test.ts' | sort -u
)
for name in "${repo_roundtable_names[@]}"; do
	assert_contains "$(printf '%s\n' "${scrub_names[@]}")" "$name" \
		"generalized scrub tracks repository coordinate ${name}"
done
for name in \
	FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS \
	FLYWHEEL_ALERT_SENDER_TOKEN_ENV \
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID \
	FLYWHEEL_ROUNDTABLE_BOT_TOKEN_ENV \
	FLYWHEEL_ROUNDTABLE_THREAD_BUDGET; do
	assert_contains "$(printf '%s\n' "${scrub_names[@]}")" "$name" \
		"generalized scrub includes ${name}"
done
scrub_args=()
for name in "${scrub_names[@]}"; do scrub_args+=(-u "$name"); done
scrubbed=$(FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=prod-cross-dept \
	FLYWHEEL_ALERT_SENDER_TOKEN_ENV=PROD_ALERT_TOKEN \
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID=prod-roundtable \
	env "${scrub_args[@]}" bash -c \
	'printf "%s|%s|%s" "${FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS-unset}" "${FLYWHEEL_ALERT_SENDER_TOKEN_ENV-unset}" "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID-unset}"')
assert_eq "$scrubbed" 'unset|unset|unset' \
	'generalized scrub removes ambient cross-dept, alert-sender, and roundtable values'

wrapper="$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh"
wrapper_flags=(
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=1
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1
	FLYWHEEL_WORKFLOW_CLAIMS_READ=1
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1
	FLYWHEEL_WORKFLOW_GATE_CARRIER=1
)
wrapper_err="$TMP_ROOT/wrapper.err"
if env "${scrub_args[@]}" "${wrapper_flags[@]}" \
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID=prod-roundtable \
	bash "$wrapper" "$TMP_ROOT/rejected-attestation.json" /usr/bin/true \
	>/dev/null 2>"$wrapper_err"; then
	echo 'FAIL: Bridge wrapper accepted an ambient roundtable coordinate' >&2
	failures=$((failures + 1))
else
	echo 'PASS: Bridge wrapper rejects an ambient roundtable coordinate'
fi
assert_contains "$(<"$wrapper_err")" 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID' \
	'Bridge wrapper names the surviving ambient coordinate'
env "${scrub_args[@]}" "${wrapper_flags[@]}" \
	bash "$wrapper" "$TMP_ROOT/wrapper-attestation.json" /usr/bin/true
assert_eq "$(jq -r '.flags | length' "$TMP_ROOT/wrapper-attestation.json")" '5' \
	'Bridge wrapper accepts a clean generalized exec boundary'

short_tmp="$(qa_generalized_safe_tmpdir '/tmp' 501)"
assert_eq "$short_tmp" '/tmp' 'short TMPDIR is preserved'
long_tmp="${TMP_ROOT}/$(printf 'x%.0s' {1..95})"
mkdir -p "$long_tmp"
safe_tmp="$(qa_generalized_safe_tmpdir "$long_tmp" 501)"
assert_eq "$safe_tmp" '/tmp' 'long tmux socket path falls back to /tmp'

head_sha='0123456789abcdef0123456789abcdef01234567'
qa_generalized_validate_expected_head "$head_sha" "$head_sha"
if qa_generalized_validate_expected_head "$head_sha" \
	'ffffffffffffffffffffffffffffffffffffffff' >/dev/null 2>&1; then
	echo 'FAIL: mismatched --expect-head was accepted' >&2
	failures=$((failures + 1))
else
	echo 'PASS: mismatched --expect-head fails before mutation'
fi

attestation="$TMP_ROOT/attestation.json"
(
	export FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES=1
	export FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH=1
	export FLYWHEEL_WORKFLOW_CLAIMS_READ=1
	export FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1
	export FLYWHEEL_WORKFLOW_GATE_CARRIER=1
	qa_generalized_write_env_attestation "$attestation"
)
assert_eq "$(jq -r '.flags | length' "$attestation")" '5' \
	'attestation records all five flags'
assert_eq "$(qa_generalized_file_mode "$attestation")" \
	'600' 'attestation is secret-safe mode 0600'
if rg -q 'TOKEN|SECRET|API' "$attestation"; then
	echo 'FAIL: attestation contains a secret-shaped field' >&2
	failures=$((failures + 1))
else
	echo 'PASS: attestation contains no secret-shaped field'
fi

stub_bin="$TMP_ROOT/stub-bin"
qa_generalized_install_stub "$stub_bin" \
	"$ROOT/scripts/qa-529-generalized-stub.mjs" \
	"$ROOT/scripts/qa-529-generalized-codex-stub.mjs"
assert_eq "$(qa_generalized_file_mode "$stub_bin/claude")" '700' \
	'generalized room installs an owner-only Claude stub'
assert_eq "$(qa_generalized_file_mode "$stub_bin/codex")" '700' \
	'generalized room installs an owner-only Codex stub'
assert_eq "$("$stub_bin/codex" --version)" \
	'codex-cli 0.0.0-flywheel-529-stub' \
	'Codex stub satisfies adapter health preflight without a real model'

room_dir="$TMP_ROOT/stale-room"
mkdir -p "$room_dir"
printf '{}\n' > "$room_dir/room-info.json"
qa_generalized_invalidate_room_info "$room_dir"
if [[ -e "$room_dir/room-info.json" ]]; then
	echo 'FAIL: generalized cleanup retained stale room-info.json' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized cleanup invalidates stale room-info.json'
fi

# Pit 7: a clone that stops growing is killed as a process group, its partial
# directory is discarded, and exactly one fresh clone gets a chance to win.
fake_bin="$TMP_ROOT/fake-bin"
mkdir -p "$fake_bin"
cat > "$fake_bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
set -euo pipefail
destination="${@: -1}"
count=0
[[ ! -f "${QA_CLONE_COUNT}" ]] || count=$(<"${QA_CLONE_COUNT}")
count=$((count + 1))
printf '%s\n' "$count" > "${QA_CLONE_COUNT}"
mkdir -p "$destination"
if [[ "$count" == "1" ]]; then
	printf 'partial\n' > "$destination/partial-only"
	trap 'printf "term\n" >> "${QA_CLONE_KILL_LOG}"; exit 143' TERM
	sleep 30
fi
printf 'complete\n' > "$destination/complete"
FAKE_GIT
chmod +x "$fake_bin/git"
clone_dir="$TMP_ROOT/clone"
QA_CLONE_COUNT="$TMP_ROOT/clone-count" \
QA_CLONE_KILL_LOG="$TMP_ROOT/clone-kill" \
QA_GENERALIZED_CLONE_SAMPLE_S=1 QA_GENERALIZED_CLONE_STALL_S=1 \
	PATH="$fake_bin:$PATH" \
	qa_generalized_clone_with_stall_watchdog remote main "$clone_dir"
assert_eq "$(<"$TMP_ROOT/clone-count")" '2' \
	'clone watchdog performs exactly one retry'
assert_eq "$(<"$clone_dir/complete")" 'complete' \
	'clone retry publishes the complete checkout'
if [[ -e "$clone_dir/partial-only" ]]; then
	echo 'FAIL: clone retry retained first-attempt partial bytes' >&2
	failures=$((failures + 1))
else
	echo 'PASS: clone retry removes first-attempt partial bytes'
fi

# Pit 5: prove write and cleanup authority, not mere channel visibility. The
# fixture also checks that diagnostics never disclose bot-token bytes.
curl() {
	local output='' method='' arg
	while (( $# > 0 )); do
		arg="$1"; shift
		case "$arg" in
			-o) output="$1"; shift ;;
			-X) method="$1"; shift ;;
		esac
	done
	if [[ "$method" == 'POST' ]]; then
		[[ -z "$output" ]] || printf '{"id":"fixture-message"}\n' > "$output"
		printf '%s' "${QA_CURL_POST_CODE:-201}"
	else
		printf '%s' "${QA_CURL_DELETE_CODE:-204}"
	fi
}
export -f curl
QA_CURL_POST_CODE=201 QA_CURL_DELETE_CODE=204 \
	qa_generalized_probe_discord_sender channel slot-bot super-secret-token
probe_err="$TMP_ROOT/probe.err"
if QA_CURL_POST_CODE=403 QA_CURL_DELETE_CODE=204 \
	qa_generalized_probe_discord_sender channel second-bot super-secret-token \
	>/dev/null 2>"$probe_err"; then
	echo 'FAIL: alert probe accepted POST 403' >&2
	failures=$((failures + 1))
else
	echo 'PASS: alert probe rejects a sender-specific POST 403'
fi
assert_contains "$(<"$probe_err")" 'second-bot' \
	'alert probe identifies the bot that needs an invitation'
if rg -q 'super-secret-token' "$probe_err"; then
	echo 'FAIL: alert probe leaked token bytes' >&2
	failures=$((failures + 1))
else
	echo 'PASS: alert probe diagnostics redact token bytes'
fi
if QA_CURL_POST_CODE=201 QA_CURL_DELETE_CODE=403 \
	qa_generalized_probe_discord_sender channel slot-bot super-secret-token \
	>/dev/null 2>&1; then
	echo 'FAIL: alert probe accepted marker DELETE failure' >&2
	failures=$((failures + 1))
else
	echo 'PASS: alert probe fails when marker cleanup is unauthorized'
fi
if (qa_generalized_probe_discord_sender channel slot-bot '' >/dev/null 2>&1); then
	echo 'FAIL: alert probe accepted a missing token' >&2
	failures=$((failures + 1))
else
	echo 'PASS: alert probe rejects a missing token'
fi

driver_help="$(node "$ROOT/scripts/qa-529-generalized-e2e.mjs" --help 2>&1)"
assert_contains "$driver_help" '--issue <FLY-N>' \
	'generalized e2e driver publishes its canonical fixture contract'
assert_contains "$(<"$ROOT/scripts/test-deploy.sh")" \
	'--arg flywheelRepo "$REPO_ROOT"' \
	'room handoff identifies the built checkout separately from the sandbox clone'
assert_contains "$(<"$ROOT/scripts/test-deploy.sh")" \
	'--arg flywheelProjectsFile "$FLYWHEEL_PROJECTS_FILE"' \
	'room handoff publishes the slot canonical projects registry'
assert_contains "$(<"$ROOT/scripts/lib/qa-generalized-e2e-lib.mjs")" \
	'FLYWHEEL_COMM_DB: commString(commDbPath, "commDbPath")' \
	'all driver comm calls bind to the slot CommDB'
assert_contains "$(<"$ROOT/scripts/lib/qa-generalized-e2e-lib.mjs")" \
	'FLYWHEEL_PROJECTS_FILE: commString(' \
	'all driver comm calls bind to the slot canonical projects registry'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'observedRunExecutionIds(db, runId)' \
	'driver reconciles ownership from the current run/node execution set'
if rg -q 'node\?\.execution_id !== implementExecutionId' \
	"$ROOT/scripts/qa-529-generalized-e2e.mjs"; then
	echo 'FAIL: driver still pins implement attempt 2 to the original execution' >&2
	failures=$((failures + 1))
else
	echo 'PASS: implement attempt 2 follows dead-exec replacement dynamically'
fi
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'actorOutcome:' \
	'step 7 evidence distinguishes original-body wake from replacement completion'
if rg -q '"if-match"' "$ROOT/scripts/qa-529-generalized-e2e.mjs"; then
	echo 'FAIL: driver claims unsupported GitHub If-Match write authority' >&2
	failures=$((failures + 1))
else
	echo 'PASS: cleanup never claims unsupported GitHub If-Match write authority'
fi
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'"#{window_id}|#{pane_id}|#{pane_dead}|#{@flywheel_exec_id}"' \
	'pane liveness validates the exact tmux object identity'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'#{@flywheel_exec_id}' \
	'pane liveness binds the tmux object to the current execution'
fixture_branch_select_count="$(rg -c 'selectFixtureBranch\(context, issue\);' \
	"$ROOT/scripts/qa-529-generalized-stub.mjs")"
assert_eq "$fixture_branch_select_count" '2' \
	'design and implement share the same run-scoped fixture branch'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-stub.mjs")" \
	'rejectedControls' \
	'stale release controls are quarantined without killing the stub'
cleanup_contract="$(sed -n '/^cleanup_on_failure()/,/^trap cleanup_on_failure/p' "$ROOT/scripts/test-deploy.sh")"
assert_contains "$cleanup_contract" 'for xsid in' \
	'generalized failure cleanup reaches borrowed campaign rollback'
assert_contains "$cleanup_contract" 'qa_generalized_terminate_pid "$BRIDGE_PID"' \
	'generalized failure cleanup verifies Bridge exit before releasing the room'
assert_contains "$cleanup_contract" 'generalized_bridge_stopped == 1' \
	'generalized failure cleanup retains the slot lock after unverified exit'
if [[ "$cleanup_contract" == *'rm -rf "$SLOT_DIR"'* ]]; then
	echo 'FAIL: generalized failure cleanup destroys bridge.log diagnostics' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized failure cleanup preserves bridge.log diagnostics'
fi

teardown_source="$ROOT/scripts/test-teardown.sh"
bridge_stop_line="$(rg -n 'log "Killing Bridge PID' "$teardown_source" | cut -d: -f1)"
stub_reap_line="$(rg -n 'qa_generalized_reap_codex_stub_orphans "\$CANONICAL_SLOT_DIR"' \
	"$teardown_source" | cut -d: -f1)"
if [[ -n "$bridge_stop_line" && -n "$stub_reap_line" \
	&& "$bridge_stop_line" -lt "$stub_reap_line" ]]; then
	echo 'PASS: generalized teardown stops Bridge before reaping restartable stubs'
else
	echo "FAIL: generalized teardown reaps stubs before Bridge shutdown (bridge=${bridge_stop_line:-missing} reap=${stub_reap_line:-missing})" >&2
	failures=$((failures + 1))
fi
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'runStatus' \
	'durable launch drain snapshots the authoritative workflow run status'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'terminateQaSessionForA3' \
	'A3 exit terminalizes its exact QA session before returning diagnosis exit 20'
assert_contains "$(<"$ROOT/scripts/lib/qa-generalized-e2e-lib.mjs")" \
	'a3QaSessionIsIrreversiblyTerminal' \
	'A3 helper defines the shared irreversible-terminal predicate'
a3_diagnosis_branch="$(sed -n '/if (!preflight.ok)/,/return A3_DIAGNOSIS_EXIT/p' \
	"$ROOT/scripts/qa-529-generalized-e2e.mjs")"
a3_initial_evidence_line="$(rg -n 'closeout: \{ status: "pending" \}' \
	<<<"$a3_diagnosis_branch" | head -1 | cut -d: -f1)"
a3_closeout_line="$(rg -n 'await terminateQaSessionForA3' \
	<<<"$a3_diagnosis_branch" | head -1 | cut -d: -f1)"
if [[ -n "$a3_initial_evidence_line" && -n "$a3_closeout_line" \
	&& "$a3_initial_evidence_line" -lt "$a3_closeout_line" ]]; then
	echo 'PASS: A3 persists its step-8 diagnosis before fallible closeout'
else
	echo "FAIL: A3 closeout can run before step-8 diagnosis persistence (evidence=${a3_initial_evidence_line:-missing} closeout=${a3_closeout_line:-missing})" >&2
	failures=$((failures + 1))
fi
assert_contains "$a3_diagnosis_branch" \
	'closeout: { status: "failed"' \
	'A3 records a failed closeout without erasing its diagnosis'
assert_eq "$(node "$ROOT/scripts/qa-529-generalized-stub.mjs" --version)" \
	'Flywheel 529 generalized persistent stub 1.0.0' \
	'persistent stub has a deterministic version probe'
if node "$ROOT/scripts/qa-529-generalized-e2e.mjs" 2 \
	--issue not-canonical >/dev/null 2>&1; then
	echo 'FAIL: generalized driver accepted a non-canonical issue identifier' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized driver rejects non-canonical fixture issues before room access'
fi

playbook="$ROOT/doc/qa/framework/529-room-playbook.md"
assert_eq "$(rg -c '^\| [0-9]+ \|' "$playbook")" '14' \
	'529 room playbook carries exactly fourteen numbered field pitfalls'
assert_contains "$(<"$playbook")" \
	'无 Runner 演练必须省略 `--from-branch`' \
	'529 room playbook preserves the no-Runner from-branch rule'
assert_contains "$(<"$playbook")" \
	'换 head 孤儿 sandbox PR' \
	'529 room playbook names the sandbox PR cost of rebuilding on a new head'
for orphan_pr in '#107' '#108' '#109'; do
	assert_contains "$(<"$playbook")" "$orphan_pr" \
		"529 room playbook records observed orphan sandbox PR ${orphan_pr}"
done
for contract in \
	'--expect-head' 'sun_path' 'FLYWHEEL_ALERT_SENDER_TOKEN_ENV' \
	'wake_delivered' 'land_head_unavailable' 'FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS' \
	'room-checkout-drift'; do
	if ! rg -Fq -- "$contract" "$playbook"; then
		echo "FAIL: 529 room playbook omits ${contract}" >&2
		failures=$((failures + 1))
	else
		echo "PASS: 529 room playbook names ${contract}"
	fi
done

plan="$ROOT/engineering/doc/FLY-1775-529-generalized-dag-room/plan.md"
assert_contains "$(<"$plan")" \
	'A2 / A3 不得互斥' \
	'implementation plan makes the two replay acceptance paths compatible'
assert_contains "$(<"$plan")" \
	'`terminated + terminal_at`' \
	'implementation plan pins the A3 session terminal postcondition'
assert_contains "$(<"$plan")" \
	'不能用延长 900s timeout 代替证明' \
	'implementation plan forbids timeout inflation as a replay fix'

if (( failures > 0 )); then
	echo "${failures} generalized helper test(s) failed" >&2
	exit 1
fi

echo 'All generalized helper tests passed.'
