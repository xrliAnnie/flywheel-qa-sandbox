#!/bin/sh
# Self-test for verify-candidate.sh. Uses only throwaway fixtures under a
# private temp directory; never touches a real state DB or the candidate.
#
#   sh engineering/doc/FLY-3143-runner-process-claim/verify-candidate.test.sh
#
# exit 0 = every case returned its expected exit code · 1 = at least one did not.

LC_ALL=C
export LC_ALL

V=$(dirname "$0")/verify-candidate.sh
command -v sqlite3 >/dev/null 2>&1 || {
	echo "sqlite3 is not installed"
	exit 1
}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/fly3143-verify.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

bad=0
count=0

# expect <name> <expected-exit> <command...>
expect() {
	name=$1
	want=$2
	shift 2
	"$@" >"$tmp/out" 2>&1
	got=$?
	count=$((count + 1))
	if [ "$got" -eq "$want" ]; then
		echo "ok   $name (exit $got)"
	else
		bad=$((bad + 1))
		echo "FAIL $name: expected exit $want, got $got"
		sed 's/^/     | /' "$tmp/out"
	fi
}

DB=$tmp/state.db
sqlite3 "$DB" "
	CREATE TABLE sessions (execution_id TEXT PRIMARY KEY, status TEXT, adapter_type TEXT, last_error TEXT);
	CREATE TABLE execution_process_owner (
		execution_id TEXT PRIMARY KEY, generation INTEGER, spawn_epoch INTEGER,
		binding_spawn_epoch INTEGER, spawn_inflight INTEGER, close_requested INTEGER,
		reconcile_required INTEGER, bind_attempt_count INTEGER, last_bind_diagnostic_json TEXT);
	CREATE TABLE workflow_execution_process_body (execution_id TEXT PRIMARY KEY, generation INTEGER, state TEXT);
	CREATE TABLE workflow_execution_resume_attempt (
		id INTEGER PRIMARY KEY, execution_id TEXT, generation INTEGER, kind TEXT,
		state TEXT, reason_code TEXT, startup_ms INTEGER);
" || exit 1

# seed <n> <owner-gen> <close> <body-gen or NULL> <session-status>
seed() {
	sqlite3 "$DB" "
		INSERT INTO sessions VALUES ('0000000$1-0000-0000-0000-000000000000', '$5', 'claude-tmux', NULL);
		INSERT INTO execution_process_owner VALUES ('0000000$1-0000-0000-0000-000000000000', $2, 1, 1, 0, $3, 0, 1, NULL);
	" || exit 1
	if [ "$4" != NULL ]; then
		sqlite3 "$DB" "INSERT INTO workflow_execution_process_body VALUES ('0000000$1-0000-0000-0000-000000000000', $4, 'active');" || exit 1
	fi
}
# attempt <n> <generation> <state>
attempt() {
	sqlite3 "$DB" "INSERT INTO workflow_execution_resume_attempt (execution_id, generation, kind, state)
		VALUES ('0000000$1-0000-0000-0000-000000000000', $2, 'original_session', '$3');" || exit 1
}
id() { echo "0000000$1-0000-0000-0000-000000000000"; }

seed 1 1 0 NULL running # fresh body, never parked
seed 2 2 0 2 running    # pulled back once, succeeded
attempt 2 2 succeeded
seed 3 3 0 3 running # older success, current attempt in flight
attempt 3 2 succeeded
attempt 3 3 started
seed 4 3 0 3 running # older success, current attempt failed
attempt 4 2 succeeded
attempt 4 3 failed
seed 5 3 0 3 running # older success, nothing for the current generation
attempt 5 2 succeeded
seed 6 2 1 2 running # current success but the owner is closing
attempt 6 2 succeeded
seed 7 1 0 2 running # current success but owner generation lags the body
attempt 7 2 succeeded
sqlite3 "$DB" "
	INSERT INTO sessions VALUES ('00000008-0000-0000-0000-000000000000', 'x' || char(10) || 'accepted=yes', 'claude-tmux', NULL);
	INSERT INTO execution_process_owner VALUES ('00000008-0000-0000-0000-000000000000', 1, 1, NULL, 1, 0, 0, 3, NULL);
" || exit 1

# Claim verdict.
expect "body: fresh accepted body" 0 sh "$V" body "$(id 1)" "$DB"
# The documented output shape: line 1 identity, lines 2-4 the verdict inputs.
count=$((count + 1))
shape=$(sh "$V" body "$(id 1)" "$DB" | sed -n '1,4p')
want_shape="execution=$(id 1)
accepted=yes
generation_consistent=no_body
resume_current_state=none"
if [ "$shape" = "$want_shape" ]; then
	echo "ok   body: first four output lines have the documented shape"
else
	bad=$((bad + 1))
	echo "FAIL body: first four output lines have the documented shape"
	printf '%s\n' "$shape" | sed 's/^/     | /'
fi
expect "body: unknown execution id" 1 sh "$V" body "$(id 9)" "$DB"
expect "body: DB text cannot forge an accepted line" 1 sh "$V" body "$(id 8)" "$DB"

# Resume verdict is bound to the current generation.
expect "resume: never pulled back" 4 sh "$V" resume "$(id 1)" "$DB"
expect "resume: current generation succeeded" 0 sh "$V" resume "$(id 2)" "$DB"
expect "resume: old success, current in flight" 2 sh "$V" resume "$(id 3)" "$DB"
expect "resume: old success, current failed" 1 sh "$V" resume "$(id 4)" "$DB"
expect "resume: old success, current not attempted" 4 sh "$V" resume "$(id 5)" "$DB"
expect "resume: success but owner closing" 1 sh "$V" resume "$(id 6)" "$DB"
expect "resume: success but generations disagree" 1 sh "$V" resume "$(id 7)" "$DB"

# Input boundary: the whole argument must be one lowercase UUID.
expect "id: single-line SQL text" 2 sh "$V" body "x' OR 1=1 --" "$DB"
expect "id: multiline SQL around a UUID line" 2 sh "$V" body "$(id 1)' /*
$(id 9)
*/ || (SELECT '') || '" "$DB"
expect "id: two UUID lines" 2 sh "$V" body "$(id 1)
$(id 1)" "$DB"
expect "id: uppercase" 2 sh "$V" body "0000000A-0000-0000-0000-000000000000" "$DB"
expect "id: 36 chars, dashes misplaced" 2 sh "$V" body "000000010-000-0000-0000-000000000000" "$DB"
expect "id: 36 dashes" 2 sh "$V" body "------------------------------------" "$DB"
expect "id: empty" 2 sh "$V" body "" "$DB"
expect "id: resume mode rejects the same" 2 sh "$V" resume "$(id 2)
x" "$DB"

# Unreadable or wrong-shaped inputs.
expect "db: missing file" 2 sh "$V" body "$(id 1)" "$tmp/missing.db"
sqlite3 "$tmp/empty.db" "CREATE TABLE t (x);" || exit 1
expect "db: no such tables" 2 sh "$V" body "$(id 1)" "$tmp/empty.db"
expect "candidate: missing directory" 2 sh "$V" candidate "$tmp/missing-dir"
expect "candidate: no directory and no FLYWHEEL_COMM_CLI" 2 env -u FLYWHEEL_COMM_CLI sh "$V" candidate
mkdir "$tmp/plain" || exit 1
expect "candidate: directory without a git HEAD" 2 env GIT_CEILING_DIRECTORIES="$tmp" sh "$V" candidate "$tmp/plain"
git init -q "$tmp/other" &&
	git -C "$tmp/other" -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m other ||
	exit 1
expect "candidate: a different head is STALE" 3 sh "$V" candidate "$tmp/other"
expect "no mode" 2 sh "$V"

echo "cases=$count failed=$bad"
[ "$bad" -eq 0 ]
