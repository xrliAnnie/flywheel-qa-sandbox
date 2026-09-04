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

test_deploy_source="$(<"$ROOT/scripts/test-deploy.sh")"
qa_generalized_source="$(<"$ROOT/scripts/lib/qa-generalized.sh")"

# FLY-2174: generalized master auth and Runner ingest auth are separate
# credentials. Invalid bearer shapes fail closed without logging bytes.
if declare -F qa_generalized_resolve_ingest_token >/dev/null; then
	resolver_err="$TMP_ROOT/ingest-resolver.err"
	resolver_out=''
	if resolver_out="$(qa_generalized_resolve_ingest_token 'fixture-ingest' 'fixture-master' 2>"$resolver_err")"; then
		assert_eq "$resolver_out" 'fixture-ingest' \
			'explicit generalized ingest token is preserved byte-for-byte'
	else
		echo 'FAIL: explicit generalized ingest token was rejected' >&2
		failures=$((failures + 1))
	fi
	if qa_generalized_resolve_ingest_token 'fixture-master' 'fixture-master' \
		>/dev/null 2>"$resolver_err"; then
		echo 'FAIL: generalized ingest token reused the master credential' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: generalized ingest token rejects master-token reuse'
	fi
	uuidgen() { printf '01234567-89AB-CDEF-0123-456789ABCDEF\n'; }
	if resolver_out="$(qa_generalized_resolve_ingest_token '' 'fixture-master' 2>"$resolver_err")"; then
		assert_eq "$resolver_out" 'fly-2174-ingest-0123456789AB' \
			'generated generalized ingest token uses an independent namespace'
	else
		echo 'FAIL: generalized ingest token generation failed' >&2
		failures=$((failures + 1))
	fi
	unset -f uuidgen
	uuidgen() { printf 'not-a-uuid\n'; }
	if qa_generalized_resolve_ingest_token '' 'fixture-master' \
		>/dev/null 2>"$resolver_err"; then
		echo 'FAIL: generalized ingest resolver accepted malformed uuidgen output' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: generalized ingest resolver rejects malformed uuidgen output'
	fi
	unset -f uuidgen

	outer_whitespace_values=(
		$' fixture-ingest' $'fixture-ingest '
		$'\tfixture-ingest' $'fixture-ingest\t'
		$'\nfixture-ingest' $'fixture-ingest\n'
		$' \t\n'
	)
	for bad_bearer in "${outer_whitespace_values[@]}"; do
		if qa_generalized_resolve_ingest_token "$bad_bearer" 'fixture-master' \
			>/dev/null 2>"$resolver_err"; then
			echo 'FAIL: configured ingest token accepted outer whitespace' >&2
			failures=$((failures + 1))
		fi
		if qa_generalized_resolve_ingest_token 'fixture-ingest' "$bad_bearer" \
			>/dev/null 2>"$resolver_err"; then
			echo 'FAIL: master token accepted outer whitespace' >&2
			failures=$((failures + 1))
		fi
	done
	if qa_generalized_resolve_ingest_token 'fixture-ingest' '' \
		>/dev/null 2>"$resolver_err"; then
		echo 'FAIL: generalized ingest resolver accepted an empty master token' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: generalized ingest resolver rejects empty/outer-whitespace bearers'
	fi
	internal_bearer=$'fixture internal\tbytes'
	if resolver_out="$(qa_generalized_resolve_ingest_token "$internal_bearer" 'fixture-master' 2>"$resolver_err")"; then
		assert_eq "$resolver_out" "$internal_bearer" \
			'generalized ingest resolver preserves internal bearer bytes'
	else
		echo 'FAIL: generalized ingest resolver rejected internal whitespace' >&2
		failures=$((failures + 1))
	fi
	secret_bearer='fly2174-secret-bearer-bytes'
	qa_generalized_resolve_ingest_token "$secret_bearer" "$secret_bearer" \
		>/dev/null 2>"$resolver_err" || true
	if rg -Fq "$secret_bearer" "$resolver_err"; then
		echo 'FAIL: generalized ingest diagnostics leaked bearer bytes' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: generalized ingest diagnostics redact bearer bytes'
	fi
else
	echo 'FAIL: generalized ingest token resolver is missing' >&2
	failures=$((failures + 1))
fi

# The exec helper is intentionally background/subshell-only: exec makes the
# captured $! the real Bridge PID used by cleanup, room-info, and teardown.
if declare -F qa_generalized_exec_with_ingest_token >/dev/null; then
	if (qa_generalized_exec_with_ingest_token '' /usr/bin/true >/dev/null 2>&1); then
		echo 'FAIL: ingest exec helper accepted an empty token' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: ingest exec helper rejects an empty token before exec'
	fi
	if (qa_generalized_exec_with_ingest_token 'fixture-slot-ingest' >/dev/null 2>&1); then
		echo 'FAIL: ingest exec helper accepted an empty command' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: ingest exec helper rejects an empty command before exec'
	fi
	ingest_child_pid_file="$TMP_ROOT/ingest-child.pid"
	ingest_child_env_file="$TMP_ROOT/ingest-child.env"
	TEAMLEAD_INGEST_TOKEN='fixture-production-ingest' \
		qa_generalized_exec_with_ingest_token 'fixture-slot-ingest' \
		/bin/bash -c 'printf "%s\n" "$$" > "$1"; env | LC_ALL=C sort > "$2"; sleep 30' \
		_ "$ingest_child_pid_file" "$ingest_child_env_file" &
	ingest_exec_pid=$!
	for _ in {1..100}; do
		[[ -s "$ingest_child_pid_file" && -s "$ingest_child_env_file" ]] && break
		sleep 0.02
	done
	if [[ -s "$ingest_child_pid_file" && -s "$ingest_child_env_file" ]]; then
		assert_eq "$(<"$ingest_child_pid_file")" "$ingest_exec_pid" \
			'ingest exec helper keeps $! bound to the real child PID'
		assert_eq "$(rg -c '^TEAMLEAD_INGEST_TOKEN=' "$ingest_child_env_file")" '1' \
			'ingest exec helper exposes exactly one ingest coordinate'
		assert_eq "$(rg '^TEAMLEAD_INGEST_TOKEN=' "$ingest_child_env_file")" \
			'TEAMLEAD_INGEST_TOKEN=fixture-slot-ingest' \
			'ingest exec helper replaces ambient production auth with slot auth'
		if rg -Fq 'fixture-production-ingest' "$ingest_child_env_file"; then
			echo 'FAIL: ingest exec helper retained ambient production auth' >&2
			failures=$((failures + 1))
		else
			echo 'PASS: ingest exec helper removes ambient production auth'
		fi
	else
		echo 'FAIL: ingest exec helper child did not publish PID/env evidence' >&2
		failures=$((failures + 1))
	fi
	kill "$ingest_exec_pid" 2>/dev/null || true
	wait "$ingest_exec_pid" 2>/dev/null || true
else
	echo 'FAIL: generalized ingest exec helper is missing' >&2
	failures=$((failures + 1))
fi

assert_contains "$qa_generalized_source" 'Background/subshell-only:' \
	'ingest exec helper documents its destructive foreground-call contract'
assert_contains "$test_deploy_source" \
	'TEST_TEAMLEAD_INGEST_TOKEN=$(qa_generalized_resolve_ingest_token' \
	'generalized room resolves ingest auth immediately after master auth'
ingest_unset_count="$(
	rg -F -c -- '-u TEAMLEAD_INGEST_TOKEN' "$ROOT/scripts/test-deploy.sh" || true
)"
assert_eq "${ingest_unset_count:-0}" '2' \
	'default and reply Bridge branches scrub ambient ingest auth'
for codex_root_assignment in \
	'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOMES_ROOT=${SLOT_DIR}/state/codex-homes")' \
	'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_SESSION_DIR=${SLOT_DIR}/state/codex-sessions")' \
	'BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=${SLOT_DIR}/state/cdx-sock")'
do
	assignment_count="$(
		rg -F -x -c "$codex_root_assignment" "$ROOT/scripts/test-deploy.sh" || true
	)"
	assert_eq "${assignment_count:-0}" '1' \
		'QA Bridge binds each destructive Codex reaper root to the slot tree exactly once'
done
generalized_bridge_launch="$(awk '
	/^if \[\[ "\$GENERALIZED" == "1" \]\]; then$/ { block=$0 ORS; capture=1; next }
	capture { block=block $0 ORS }
	capture && /^elif \[\[ "\$\{TEST_REPLY_BY_ISSUE:-0\}" == "1" \]\]; then$/ {
		selected=block; capture=0
	}
	END { printf "%s", selected }
' "$ROOT/scripts/test-deploy.sh")"
if [[ "$generalized_bridge_launch" == *'( qa_generalized_exec_with_ingest_token "$TEST_TEAMLEAD_INGEST_TOKEN" env'* \
	&& "$generalized_bridge_launch" == *'qa-slot-bridge-spec.mjs" capture'* \
	&& "$test_deploy_source" == *'qa_slot_bridge_exec_spec "$BRIDGE_LAUNCH_SPEC"'* \
	&& "$test_deploy_source" == *'>> "${SLOT_DIR}/bridge.log" 2>&1 &'* ]]; then
	echo 'PASS: generalized ingest auth is captured in the final child env and the shared spec executor owns background PID identity'
else
	echo 'FAIL: generalized Bridge does not couple final-env capture to the shared background executor' >&2
	failures=$((failures + 1))
fi

assert_contains "$test_deploy_source" \
	'"TEAMLEAD_DB_PATH=${SLOT_DIR}/teamlead.db"' \
	'QA Lead manifest pins the slot-local StateStore DB'
assert_contains "$test_deploy_source" \
	'"FLYWHEEL_STATE_DIR=${state}"' \
	'QA Lead manifest pins the slot-local state directory'
assert_contains "$test_deploy_source" \
	'([.nodes[].id] | sort) == ["eng_design","founder_gate","implement","qa"]' \
	'generalized code-menu readiness follows stable backend node ids'
if [[ "$test_deploy_source" == *'["design","implement","qa"]'* ]]; then
	echo 'FAIL: generalized code-menu readiness still asserts retired role names' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized code-menu readiness has no retired role-name tuple'
fi

# FLY-2163: the slot Bridge must override an inherited production state root.
# Evaluate the exact repo-owned array append against a fake production root,
# then exercise a real state writer. Nothing here touches ~/.flywheel or the
# desktop notification channel.
linear_started_assignment='BRIDGE_EXTRA_ENV+=("FLYWHEEL_LINEAR_STARTED_SYNC=0")'
linear_started_assignment_count="$(
	rg -F -x -c "$linear_started_assignment" "$ROOT/scripts/test-deploy.sh" || true
)"
assert_eq "${linear_started_assignment_count:-0}" '1' \
	'QA Bridge disables Linear started-state writes exactly once'
bridge_state_assignment='BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=${SLOT_DIR}")'
bridge_state_assignment_count="$(
	rg -F -x -c "$bridge_state_assignment" "$ROOT/scripts/test-deploy.sh" || true
)"
assert_eq "${bridge_state_assignment_count:-0}" '1' \
	'Bridge state root has exactly one slot-local assignment'
bridge_last_append="$(
	rg '^BRIDGE_EXTRA_ENV\+=' "$ROOT/scripts/test-deploy.sh" | tail -1
)"
assert_eq "$bridge_last_append" "$bridge_state_assignment" \
	'Bridge state root is the final later-wins environment append'
linear_started_assignment_line="$(
	rg -F -x -n "$linear_started_assignment" "$ROOT/scripts/test-deploy.sh" \
		| cut -d: -f1 || true
)"
bridge_state_assignment_line="$(
	rg -F -x -n "$bridge_state_assignment" "$ROOT/scripts/test-deploy.sh" \
		| cut -d: -f1 || true
)"
if [[ -n "$linear_started_assignment_line" \
	&& "$linear_started_assignment_line" -lt "$bridge_state_assignment_line" ]]; then
	echo 'PASS: Linear started-state kill switch precedes the final state-dir append'
else
	echo 'FAIL: Linear started-state kill switch must precede the final state-dir append' >&2
	failures=$((failures + 1))
fi
bridge_env_expansion_count="$(
	rg -F -c '${BRIDGE_EXTRA_ENV[@]+"${BRIDGE_EXTRA_ENV[@]}"}' \
		"$ROOT/scripts/test-deploy.sh" || true
)"
assert_eq "${bridge_env_expansion_count:-0}" '3' \
	'all three Bridge launch branches expand the isolated environment'

fake_production_state="$TMP_ROOT/fake-production-state"
slot_state_root="$TMP_ROOT/flywheel-test-slot-state"
state_writer_bin="$TMP_ROOT/state-writer-bin"
mkdir -p "$fake_production_state" "$slot_state_root" "$state_writer_bin"
slot_state_root="$(cd "$slot_state_root" && pwd -P)"
printf 'production-sentinel\n' > "$fake_production_state/sentinel.txt"
cat > "$state_writer_bin/osascript" <<'FAKE_OSASCRIPT'
#!/usr/bin/env bash
exit 0
FAKE_OSASCRIPT
chmod +x "$state_writer_bin/osascript"
external_shasum="$(type -P shasum)"
production_before="$(
	find "$fake_production_state" -type f -print | LC_ALL=C sort \
		| while IFS= read -r path; do "$external_shasum" "$path"; done
)"

SLOT_DIR="$slot_state_root"
BRIDGE_EXTRA_ENV=()
actual_bridge_state_assignment="$(
	rg -F -x -m 1 "$bridge_state_assignment" "$ROOT/scripts/test-deploy.sh" || true
)"
[[ -z "$actual_bridge_state_assignment" ]] || eval "$actual_bridge_state_assignment"
FLYWHEEL_STATE_DIR="$fake_production_state" \
FLYWHEEL_META_ALERT_DEBOUNCE_MS=0 \
PATH="$state_writer_bin:$PATH" \
	env ${BRIDGE_EXTRA_ENV[@]+"${BRIDGE_EXTRA_ENV[@]}"} \
	"$ROOT/scripts/meta-alert.sh" \
	fly2163_slot_state_probe 'FLY-2163 slot state probe' \
	'fly2163 unique slot state probe'

slot_marker="$slot_state_root/meta-alert/fly2163_slot_state_probe.txt"
if [[ -f "$slot_marker" ]]; then
	echo 'PASS: real state writer creates its marker under the slot root'
else
	echo "FAIL: slot state marker missing: $slot_marker" >&2
	failures=$((failures + 1))
fi
if [[ -f "$slot_marker" ]] && rg -Fq 'fly2163 unique slot state probe' "$slot_marker"; then
	echo 'PASS: slot state marker contains the probe payload'
else
	echo 'FAIL: slot state marker does not contain the probe payload' >&2
	failures=$((failures + 1))
fi
production_after="$(
	find "$fake_production_state" -type f -print | LC_ALL=C sort \
		| while IFS= read -r path; do "$external_shasum" "$path"; done
)"
assert_eq "$production_after" "$production_before" \
	'fake production state tree remains byte-for-byte unchanged'

bridge_state_value=''
if (( ${#BRIDGE_EXTRA_ENV[@]} > 0 )); then
	bridge_state_value="${BRIDGE_EXTRA_ENV[0]#*=}"
fi
bridge_marker_path='<missing Bridge state assignment>'
if [[ -n "$bridge_state_value" ]]; then
	bridge_marker_path="$(
		cd "$ROOT"
		FLYWHEEL_STATE_DIR="$bridge_state_value" pnpm exec tsx -e \
			'import { bridgeMarkerPath } from "./packages/teamlead/src/bridge/bridge-exit-marker.ts"; process.stdout.write(bridgeMarkerPath());'
	)"
fi
assert_eq "$bridge_marker_path" "$slot_state_root/state/bridge-running-marker.json" \
	'root-convention Bridge marker resolves without a state/state double nest'

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
assert_contains "$ordinary" $'doc_flow:\n  default_department: engineering' \
	'ordinary config carries non-flag DOC-FLOW metadata'
if [[ "$ordinary" == *'pipeline:'* ]]; then
	echo 'FAIL: ordinary config unexpectedly enters the generalized pipeline domain' >&2
	failures=$((failures + 1))
else
	echo 'PASS: ordinary config has no pipeline block'
fi

generalized="$(qa_multilead_config_yaml test-slot-1 generalized)"
assert_contains "$generalized" $'doc_flow:\n  default_department: engineering' \
	'generalized config carries non-flag DOC-FLOW metadata'
if [[ "$generalized" == *'pipeline:'* ]]; then
	echo 'FAIL: generalized config emitted retired pipeline project flags' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized config leaves DAG and work-kind in the scoped store'
fi

codex_generalized="$(qa_multilead_config_yaml test-slot-1 generalized codex)"
assert_contains "$codex_generalized" $'runners:\n  default: codex' \
	'Codex generalized room selects the Codex runner'
assert_contains "$codex_generalized" $'    codex:\n      type: openai' \
	'Codex generalized room declares Codex as available'
assert_contains "$codex_generalized" $'roles:\n  runner:\n    backend: codex-tmux' \
	'Codex generalized room selects the real Codex tmux adapter'
assert_contains "$codex_generalized" $'      - type: dag\n        runner: codex' \
	'Codex generalized room routes DAG workers through Codex'
assert_contains "$test_deploy_source" 'CODEX_RUNNER=0' \
	'529 deploy defaults the real Codex runner option off'
assert_contains "$test_deploy_source" '--codex-runner)' \
	'529 deploy accepts an explicit real Codex runner option'
assert_contains "$test_deploy_source" \
	'ERROR: --codex-runner requires --generalized' \
	'529 deploy rejects the Codex runner option outside an isolated generalized room'
assert_contains "$test_deploy_source" \
	'ERROR: --codex-runner cannot be combined with --stub-runner' \
	'529 deploy refuses to label a stub-backed room as a real Codex drill room'
assert_contains "$test_deploy_source" \
	'qa_multilead_config_yaml "${TEST_PROJECT_NAME}" "$QA_CONFIG_MODE" "$QA_CONFIG_RUNNER"' \
	'529 deploy forwards the selected runner into the generated project config'

retired_workflow_env_names=(
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH
	FLYWHEEL_WORKFLOW_CLAIMS_READ
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE
	FLYWHEEL_WORKFLOW_GATE_CARRIER
)
for retired_name in "${retired_workflow_env_names[@]}"; do
	for retired_surface in \
		"$ROOT/scripts/lib/qa-generalized.sh" \
		"$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" \
		"$ROOT/scripts/test-deploy.sh" \
		"$ROOT/scripts/qa-fly-1707-incident-dispatcher.ts"; do
		if rg -q --fixed-strings "$retired_name" "$retired_surface"; then
			echo "FAIL: retired ${retired_name} remains in ${retired_surface#$ROOT/}" >&2
			failures=$((failures + 1))
		else
			echo "PASS: retired ${retired_name} absent from ${retired_surface#$ROOT/}"
		fi
	done
done
for retired_contract in \
	qa_generalized_feature_env \
	qa_generalized_write_env_attestation \
	generalized-env-attestation \
	envAttestationPath; do
	if rg -q --fixed-strings "$retired_contract" \
		"$ROOT/scripts/lib/qa-generalized.sh" \
		"$ROOT/scripts/lib/qa-generalized-bridge-wrapper.sh" \
		"$ROOT/scripts/test-deploy.sh"; then
		echo "FAIL: retired generalized contract remains: ${retired_contract}" >&2
		failures=$((failures + 1))
	else
		echo "PASS: retired generalized contract absent: ${retired_contract}"
	fi
done

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
wrapper_err="$TMP_ROOT/wrapper.err"
if env "${scrub_args[@]}" \
	FLYWHEEL_ROUNDTABLE_CHANNEL_ID=prod-roundtable \
	bash "$wrapper" /usr/bin/true \
	>/dev/null 2>"$wrapper_err"; then
	echo 'FAIL: Bridge wrapper accepted an ambient roundtable coordinate' >&2
	failures=$((failures + 1))
else
	echo 'PASS: Bridge wrapper rejects an ambient roundtable coordinate'
fi
assert_contains "$(<"$wrapper_err")" 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID' \
	'Bridge wrapper names the surviving ambient coordinate'
env "${scrub_args[@]}" bash "$wrapper" /usr/bin/true
echo 'PASS: Bridge wrapper accepts a clean generalized exec boundary without retired flag attestation'

slot_tmp="$(qa_slot_child_tmpdir '/tmp/flywheel-test-slot-501')"
assert_eq "$slot_tmp" '/tmp/flywheel-test-slot-501/tmp' \
	'slot children use a deterministic room-local TMPDIR'
long_caller_tmp="${TMP_ROOT}/$(printf 'x%.0s' {1..95})"
slot_tmp_with_long_caller="$(TMPDIR="$long_caller_tmp" qa_slot_child_tmpdir '/tmp/flywheel-test-slot-501')"
assert_eq "$slot_tmp_with_long_caller" "$slot_tmp" \
	'slot child TMPDIR is independent of the caller environment'
socket_path="${slot_tmp}/tsx-65535/99999.pipe"
(( ${#socket_path} < 104 )) \
	|| { echo "FAIL: slot child IPC socket path is ${#socket_path} bytes" >&2; failures=$((failures + 1)); }
(( ${#socket_path} < 104 )) && echo 'PASS: worst-case slot child IPC socket path fits macOS sun_path'

head_sha='0123456789abcdef0123456789abcdef01234567'
qa_generalized_validate_expected_head "$head_sha" "$head_sha"
if qa_generalized_validate_expected_head "$head_sha" \
	'ffffffffffffffffffffffffffffffffffffffff' >/dev/null 2>&1; then
	echo 'FAIL: mismatched --expect-head was accepted' >&2
	failures=$((failures + 1))
else
	echo 'PASS: mismatched --expect-head fails before mutation'
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
assert_contains "$(<"$ROOT/scripts/test-deploy.sh")" \
	'--arg summaryConfigHome "$QA_SUMMARY_CONFIG_HOME"' \
	'room handoff passes the slot-local summary identity home to jq'
assert_contains "$(<"$ROOT/scripts/test-deploy.sh")" \
	'summaryConfigHome:$summaryConfigHome' \
	'room handoff publishes the slot-local summary identity home'
assert_contains "$(<"$ROOT/scripts/lib/qa-generalized-e2e-lib.mjs")" \
	'FLYWHEEL_COMM_DB: commString("commDbPath")' \
	'all driver comm calls bind to the slot CommDB'
assert_contains "$(<"$ROOT/scripts/lib/qa-generalized-e2e-lib.mjs")" \
	'FLYWHEEL_PROJECTS_FILE: commString("flywheelProjectsFile")' \
	'all driver comm calls bind to the slot canonical projects registry'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'parseIdentityEnvProjection(' \
	'driver consumes the canonical env projection instead of a JSON identity mirror'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'"--summary-config-home"' \
	'driver resolves identity from the room summary home'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'leaseDbPath: join(slotDir, "lead-lease.db")' \
	'driver isolates identity-integrity audit writes in the slot'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-stub.mjs")" \
	'const prContext = pullRequestContext(context);' \
	'stub discovers durable or open PR authority before pushing'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-stub.mjs")" \
	'await convergeRemotePrAuthority({' \
	'stub waits for the pushed head through the tested convergence helper'
assert_contains "$(<"$ROOT/scripts/qa-529-generalized-e2e.mjs")" \
	'const remotePrAuthority = await pollRemotePrAuthority({' \
	'driver waits for the stub PR head before applying the A3 preflight'
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
assert_contains "$cleanup_contract" 'rm -f "$BRIDGE_LAUNCH_SPEC"' \
	'failed deploy cleanup removes the replayable Bridge launch spec'
assert_contains "$cleanup_contract" 'rm -rf "${SLOT_DIR}/state/bridge-env-secrets"' \
	'failed deploy cleanup removes captured Bridge secret files'
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

# FLY-2174: the real codex-tmux daemon is detached from Bridge and can survive
# its bounded shutdown. Teardown must use the runner's hardened ledger + live
# socket-holder proof before deleting the slot-local session/socket roots.
real_reap_script="$ROOT/scripts/lib/qa-reap-codex-slot-daemons.mjs"
real_reap_line="$(rg -n 'qa-reap-codex-slot-daemons\.mjs' "$teardown_source" \
	| head -1 | cut -d: -f1 || true)"
slot_delete_line="$(rg -n 'rm -rf "\$SLOT_DIR"' "$teardown_source" \
	| tail -1 | cut -d: -f1 || true)"
if [[ -n "$bridge_stop_line" && -n "$real_reap_line" && -n "$slot_delete_line" \
	&& "$bridge_stop_line" -lt "$real_reap_line" \
	&& "$real_reap_line" -lt "$slot_delete_line" ]]; then
	echo 'PASS: generalized teardown proves real Codex daemons gone before deleting slot state'
else
	echo "FAIL: real Codex daemon reap is not ordered bridge-stop -> reap -> slot-delete (bridge=${bridge_stop_line:-missing} reap=${real_reap_line:-missing} delete=${slot_delete_line:-missing})" >&2
	failures=$((failures + 1))
fi
if [[ -f "$real_reap_script" ]]; then
	real_reap_source="$(<"$real_reap_script")"
	assert_contains "$real_reap_source" 'reapCodexDaemonForExecution' \
		'real daemon teardown delegates destructive proof to the hardened runner reaper'
	assert_contains "$real_reap_source" 'FLYWHEEL_CODEX_SESSION_DIR' \
		'real daemon teardown binds session authority to the slot-local root'
	assert_contains "$real_reap_source" 'FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT' \
		'real daemon teardown binds socket authority to the slot-local root'
	assert_contains "$real_reap_source" 'residual' \
		'real daemon teardown fails closed when a proven process group survives'
	dynamic_import_line="$(rg -n 'reapCodexDaemonForExecution.*await import' \
		"$real_reap_script" | cut -d: -f1 || true)"
	empty_room_return_line="$(rg -n 'if \(!sessionRoot && !socketRoot\) return' \
		"$real_reap_script" | cut -d: -f1 || true)"
	if [[ -n "$dynamic_import_line" && -n "$empty_room_return_line" \
		&& "$empty_room_return_line" -lt "$dynamic_import_line" ]]; then
		echo 'PASS: empty non-Codex rooms do not require a built claude-runner dist'
	else
		echo "FAIL: claude-runner dist loads before empty-room teardown can return (return=${empty_room_return_line:-missing} import=${dynamic_import_line:-missing})" >&2
		failures=$((failures + 1))
	fi

	empty_real_slot="$TMP_ROOT/empty-real-slot"
	mkdir -p "$empty_real_slot"
	if node "$real_reap_script" "$empty_real_slot" >/dev/null 2>&1; then
		echo 'PASS: real daemon teardown treats an unused slot as already clean'
	else
		echo 'FAIL: real daemon teardown rejects an unused slot' >&2
		failures=$((failures + 1))
	fi
	if (
		cd "$(dirname "$empty_real_slot")"
		node "$real_reap_script" "$(basename "$empty_real_slot")" >/dev/null 2>&1
	); then
		echo 'FAIL: real daemon teardown accepted a relative destructive root' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: real daemon teardown requires an absolute slot root'
	fi

	# Keep this fixture below macOS sockaddr_un.sun_path while the main test
	# root intentionally exercises arbitrary TMPDIR lengths elsewhere.
	live_unowned_root="$(mktemp -d /tmp/fly2174-reap.XXXXXX)"
	live_unowned_slot="$live_unowned_root/live-slot"
	live_unowned_socket="$live_unowned_slot/state/cdx-sock/unowned.sock"
	live_unowned_ready="$live_unowned_slot/socket-ready"
	mkdir -p "$live_unowned_slot/state/cdx-sock"
	node -e '
		const fs = require("node:fs");
		const net = require("node:net");
		const server = net.createServer();
		server.listen(process.argv[1], () => fs.writeFileSync(process.argv[2], "ready\n"));
		process.on("SIGTERM", () => server.close(() => process.exit(0)));
		setTimeout(() => process.exit(0), 5000).unref();
	' "$live_unowned_socket" "$live_unowned_ready" &
	live_unowned_pid=$!
	for _ in $(seq 1 50); do
		[[ -f "$live_unowned_ready" ]] && break
		sleep 0.1
	done
	if [[ ! -f "$live_unowned_ready" ]]; then
		echo 'FAIL: live unowned socket fixture did not start' >&2
		failures=$((failures + 1))
	elif node "$real_reap_script" "$live_unowned_slot" >/dev/null 2>&1; then
		echo 'FAIL: real daemon teardown accepted a live socket without ledger proof' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: real daemon teardown fails closed on a live socket without ledger proof'
	fi
	kill "$live_unowned_pid" 2>/dev/null || true
	wait "$live_unowned_pid" 2>/dev/null || true
	rm -rf "$live_unowned_root"

	# Positive macOS path contract: Bridge binds the lexical /tmp socket string,
	# while realpath resolves the same slot beneath /private/tmp. The reaper must
	# preserve the lexical string for lsof's holder proof and kill the detached
	# process group before reporting success.
	owned_real_root="$(mktemp -d /tmp/fly2174-owned.XXXXXX)"
	owned_real_slot="$owned_real_root/live-slot"
	owned_execution='implement-owned-real'
	owned_hash="$(printf '%s' "$owned_execution" | shasum -a 1 | awk '{print substr($1,1,16)}')"
	owned_socket="$owned_real_slot/state/cdx-sock/${owned_hash}.sock"
	owned_ready="$owned_real_slot/socket-ready"
	owned_pid_file="$owned_real_slot/socket-pid"
	owned_reap_err="$owned_real_slot/reap.err"
	owned_session_dir="$owned_real_slot/state/codex-sessions/$owned_execution"
	owned_fake_bin="$owned_real_slot/fake-bin"
	mkdir -p "$owned_real_slot/state/cdx-sock" "$owned_session_dir" "$owned_fake_bin"
	printf '%s\n' \
		'#!/bin/sh' \
		'last=""' \
		'for arg do last="$arg"; done' \
		'case "$last" in ""|*[!0-9]*) exit 1 ;; esac' \
		'printf "%s\\n" "$last"' \
		> "$owned_fake_bin/ps"
	chmod 700 "$owned_fake_bin/ps"
	node -e '
		const { spawn } = require("node:child_process");
		const fs = require("node:fs");
		const source = `
			const fs = require("node:fs");
			const net = require("node:net");
			const server = net.createServer();
			server.listen(process.argv[1], () => fs.writeFileSync(process.argv[2], "ready\\n"));
			process.on("SIGTERM", () => server.close(() => process.exit(0)));
			setTimeout(() => process.exit(0), 30000).unref();
		`;
		const child = spawn(process.execPath, ["-e", source, process.argv[1], process.argv[2]], {
			detached: true,
			stdio: "ignore",
		});
		if (!Number.isInteger(child.pid)) process.exit(1);
		fs.writeFileSync(process.argv[3], `${child.pid}\n`);
		child.unref();
	' "$owned_socket" "$owned_ready" "$owned_pid_file"
	for _ in $(seq 1 50); do
		[[ -f "$owned_ready" && -f "$owned_pid_file" ]] && break
		sleep 0.1
	done
	owned_pid="$(cat "$owned_pid_file" 2>/dev/null || true)"
	if [[ ! "$owned_pid" =~ ^[1-9][0-9]*$ ]]; then
		echo 'FAIL: owned real Codex socket fixture did not start' >&2
		failures=$((failures + 1))
	else
		owned_holder_pids="$(lsof -t -- "$owned_socket" 2>/dev/null || true)"
		assert_contains "$owned_holder_pids" "$owned_pid" \
			'positive real daemon fixture is the lexical /tmp socket holder'
		printf '{"executionId":"%s","daemonPgid":%s}\n' \
			"$owned_execution" "$owned_pid" > "$owned_session_dir/session.json"
		if PATH="$owned_fake_bin:$PATH" node "$real_reap_script" "$owned_real_slot" \
			>/dev/null 2>"$owned_reap_err"; then
			for _ in $(seq 1 50); do
				kill -0 "$owned_pid" 2>/dev/null || break
				sleep 0.1
			done
			if kill -0 "$owned_pid" 2>/dev/null; then
				echo 'FAIL: real daemon teardown returned success before its owned process group exited' >&2
				failures=$((failures + 1))
			else
				echo 'PASS: real daemon teardown reaps a ledger-and-socket-proven detached process group'
			fi
		else
			echo 'FAIL: real daemon teardown could not reap a ledger-and-socket-proven detached process group' >&2
			sed 's/^/  reaper: /' "$owned_reap_err" >&2
			failures=$((failures + 1))
		fi
		if kill -0 "$owned_pid" 2>/dev/null; then
			node -e 'try { process.kill(-Number(process.argv[1]), "SIGKILL"); } catch {}' \
				"$owned_pid"
		fi
	fi
	rm -rf "$owned_real_root"

	external_real_sessions="$TMP_ROOT/external-real-sessions"
	symlinked_real_slot="$TMP_ROOT/symlinked-real-slot"
	mkdir -p "$external_real_sessions" "$symlinked_real_slot/state"
	ln -s "$external_real_sessions" "$symlinked_real_slot/state/codex-sessions"
	if node "$real_reap_script" "$symlinked_real_slot" >/dev/null 2>&1; then
		echo 'FAIL: real daemon teardown accepted a symlinked session authority root' >&2
		failures=$((failures + 1))
	else
		echo 'PASS: real daemon teardown rejects a symlinked session authority root'
	fi
else
	echo 'FAIL: real Codex daemon teardown helper is missing' >&2
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
	'Flywheel 529 generalized persistent stub 1.1.0' \
	'persistent stub has a deterministic version probe'
if node "$ROOT/scripts/qa-529-generalized-e2e.mjs" 2 \
	--issue not-canonical >/dev/null 2>&1; then
	echo 'FAIL: generalized driver accepted a non-canonical issue identifier' >&2
	failures=$((failures + 1))
else
	echo 'PASS: generalized driver rejects non-canonical fixture issues before room access'
fi

playbook="$ROOT/doc/qa/framework/529-room-playbook.md"
assert_eq "$(rg -c '^\| [0-9]+ \|' "$playbook")" '15' \
	'529 room playbook carries exactly fifteen numbered field pitfalls'
assert_contains "$(<"$playbook")" \
	'无 Runner 演练必须省略 `--from-branch`' \
	'529 room playbook preserves the no-Runner from-branch rule'
assert_contains "$(<"$playbook")" \
	'scripts/test-deploy.sh 2 --generalized --codex-runner --no-lead' \
	'529 room playbook publishes the real Codex restart-drill room command'
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
