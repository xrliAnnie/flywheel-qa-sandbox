#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROLLBACK_SCRIPT="$REPO_ROOT/scripts/r4/rollback-r4.sh"

test -x "$ROLLBACK_SCRIPT"
bash -n "$ROLLBACK_SCRIPT"

ROLLBACK_R4_SOURCE_ONLY=1 source "$ROLLBACK_SCRIPT"
declare -F acquire_restart_lock >/dev/null
declare -F release_restart_lock >/dev/null
declare -F assert_launch_authority_empty >/dev/null
declare -F assert_commdb_holders_empty >/dev/null
declare -F rollback_bridge_port >/dev/null
declare -F restore_snapshot >/dev/null
declare -F rollback_r4_main >/dev/null

echo "rollback-r4: contract functions present"

ROLLBACK_R4_BRIDGE_URL=http://127.0.0.1:9988
test "$(rollback_bridge_port)" = 9988
ROLLBACK_R4_BRIDGE_URL=http://localhost
set +e
rollback_bridge_port >/dev/null 2>&1
missing_port_rc=$?
set -e
test "$missing_port_rc" -ne 0
ROLLBACK_R4_BRIDGE_URL=http://127.0.0.1:9876
echo "rollback-r4: listener port follows the configured Bridge URL"

SHARDS=(flywheel geoforge3d growth joycon-typeless personal-assistant sub tidal-echo)

portable_mode() {
	stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"
}

portable_size() {
	stat -f %z "$1" 2>/dev/null || stat -c %s "$1"
}

sha256_file() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	else
		sha256sum "$1" | awk '{print $1}'
	fi
}

make_db() {
	local path="$1" value="$2"
	mkdir -p "$(dirname "$path")"
	sqlite3 "$path" "CREATE TABLE state (value TEXT); INSERT INTO state VALUES ('$value');"
	chmod 0600 "$path"
}

make_snapshot_fixture() {
	local root="$1" canonical="$2" shard file rel snapshot_seed canonical_seed
	mkdir -p "$root/files" "$canonical"
	snapshot_seed="$root/.snapshot-seed.db"
	canonical_seed="$root/.canonical-seed.db"
	make_db "$snapshot_seed" snapshot
	make_db "$canonical_seed" canonical
	for shard in "${SHARDS[@]}"; do
		mkdir -p "$root/files/$shard"
		cp -p "$snapshot_seed" "$root/files/$shard/comm.db"
		mkdir -p "$root/files/$shard/refs/nested"
		printf 'snapshot-ref-%s' "$shard" > "$root/files/$shard/refs/nested/ref.txt"
		chmod 0600 "$root/files/$shard/refs/nested/ref.txt"
		mkdir -p "$canonical/$shard"
		cp -p "$canonical_seed" "$canonical/$shard/comm.db"
		mkdir -p "$canonical/$shard/refs"
		printf 'canonical-ref-%s' "$shard" > "$canonical/$shard/refs/ref.txt"
		chmod 0600 "$canonical/$shard/refs/ref.txt"
	done
	# A preserved forensic suffix is intentionally outside the canonical
	# manifest and must survive a rollback untouched.
	printf 'forensic' > "$canonical/geoforge3d/comm.db-shm.migrated-r2-failed"
	chmod 0444 "$canonical/geoforge3d/comm.db-shm.migrated-r2-failed"
	: > "$root/manifest.tsv"
	while IFS= read -r file; do
		rel="${file#"$root/files/"}"
		printf '%s\t%s\t%s\t%s\n' "$rel" "$(portable_size "$file")" \
			"$(portable_mode "$file")" "$(sha256_file "$file")" >> "$root/manifest.tsv"
	done < <(find "$root/files" -type f -print | sort)
}

TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT
SNAPSHOT_ROOT="$TEST_ROOT/snapshot"
CANONICAL_ROOT="$TEST_ROOT/comm"
make_snapshot_fixture "$SNAPSHOT_ROOT" "$CANONICAL_ROOT"

set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
		source "$1"
		ROLLBACK_R4_COMM_ROOT="$2"
		ROLLBACK_R4_SNAPSHOT_DIR="$3"
		assert_launch_authority_empty() { :; }
		assert_commdb_holders_empty() { :; }
		restore_snapshot
	' _ "$ROLLBACK_SCRIPT" "$CANONICAL_ROOT" "$SNAPSHOT_ROOT"
restore_rc=$?
set -e
test "$restore_rc" -eq 0
for shard in "${SHARDS[@]}"; do
	test "$(sqlite3 "$CANONICAL_ROOT/$shard/comm.db" 'SELECT value FROM state;')" = snapshot
	test "$(cat "$CANONICAL_ROOT/$shard/refs/nested/ref.txt")" = "snapshot-ref-$shard"
done
test "$(cat "$CANONICAL_ROOT/geoforge3d/comm.db-shm.migrated-r2-failed")" = forensic
test -z "$(find "$CANONICAL_ROOT" -maxdepth 1 -name '.fly1649-rollback-quarantine-*' -print -quit)"
echo "rollback-r4: staged snapshot restore preserves noncanonical evidence"

BAD_SNAPSHOT="$TEST_ROOT/bad-snapshot"
BAD_CANONICAL="$TEST_ROOT/bad-comm"
make_snapshot_fixture "$BAD_SNAPSHOT" "$BAD_CANONICAL"
sqlite3 "$BAD_SNAPSHOT/files/growth/comm.db" "UPDATE state SET value = 'corrupted-after-manifest';"
set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_COMM_ROOT="$2"
	ROLLBACK_R4_SNAPSHOT_DIR="$3"
	assert_launch_authority_empty() { :; }
	assert_commdb_holders_empty() { :; }
	restore_snapshot
' _ "$ROLLBACK_SCRIPT" "$BAD_CANONICAL" "$BAD_SNAPSHOT" >/dev/null 2>&1
bad_restore_rc=$?
set -e
test "$bad_restore_rc" -ne 0
for shard in "${SHARDS[@]}"; do
	test "$(sqlite3 "$BAD_CANONICAL/$shard/comm.db" 'SELECT value FROM state;')" = canonical
done
echo "rollback-r4: corrupted snapshot is rejected before canonical replacement"

SWAP_FAIL_SNAPSHOT="$TEST_ROOT/swap-fail-snapshot"
SWAP_FAIL_CANONICAL="$TEST_ROOT/swap-fail-comm"
make_snapshot_fixture "$SWAP_FAIL_SNAPSHOT" "$SWAP_FAIL_CANONICAL"
set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_COMM_ROOT="$2"
	ROLLBACK_R4_SNAPSHOT_DIR="$3"
	assert_launch_authority_empty() { :; }
	assert_commdb_holders_empty() { :; }
	verify_calls=0
	verify_snapshot_sqlite() {
		verify_calls=$((verify_calls + 1))
		(( verify_calls == 1 ))
	}
	install_runtime_traps
	restore_snapshot
' _ "$ROLLBACK_SCRIPT" "$SWAP_FAIL_CANONICAL" "$SWAP_FAIL_SNAPSHOT" >/dev/null 2>&1
swap_fail_rc=$?
set -e
test "$swap_fail_rc" -ne 0
for shard in "${SHARDS[@]}"; do
	test "$(sqlite3 "$SWAP_FAIL_CANONICAL/$shard/comm.db" 'SELECT value FROM state;')" = canonical
	test "$(cat "$SWAP_FAIL_CANONICAL/$shard/refs/ref.txt")" = "canonical-ref-$shard"
done
test -n "$(find "$SWAP_FAIL_CANONICAL" -maxdepth 1 -name '.fly1649-rollback-quarantine-*' -print -quit)"
echo "rollback-r4: post-swap verification failure restores the full canonical image"

LOCK_WAIT_ROOT="$TEST_ROOT/lock-wait"
mkdir -p "$LOCK_WAIT_ROOT/restart.lock.d"
( sleep 0.2; rmdir "$LOCK_WAIT_ROOT/restart.lock.d" ) &
release_pid=$!
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_LOCK_DIR="$2"
	ROLLBACK_R4_LOCK_WAIT_SECS=2
	acquire_restart_lock
	cleanup_owned_lock
' _ "$ROLLBACK_SCRIPT" "$LOCK_WAIT_ROOT/restart.lock.d"
wait "$release_pid" 2>/dev/null || true

LOCK_TIMEOUT_ROOT="$TEST_ROOT/lock-timeout"
mkdir -p "$LOCK_TIMEOUT_ROOT/restart.lock.d"
set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_LOCK_DIR="$2"
	ROLLBACK_R4_LOCK_WAIT_SECS=1
	acquire_restart_lock
' _ "$ROLLBACK_SCRIPT" "$LOCK_TIMEOUT_ROOT/restart.lock.d" >/dev/null 2>&1
lock_timeout_rc=$?
set -e
test "$lock_timeout_rc" -ne 0
test -d "$LOCK_TIMEOUT_ROOT/restart.lock.d"
echo "rollback-r4: occupied lock retries successfully or times out before mutation"

test_release_signal() {
	local signal="$1" expected_rc="$2" signal_root
	signal_root="$TEST_ROOT/release-$signal"
	mkdir -p "$signal_root/restart.lock.d"
	set +e
	ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
		source "$1"
		ROLLBACK_R4_LOCK_DIR="$2"
		TEST_SIGNAL="$3"
		LOCK_OWNED=1
		install_runtime_traps
		rollback_release_seam() {
			command mkdir "$ROLLBACK_R4_LOCK_DIR"
			kill -"$TEST_SIGNAL" $$
		}
		release_restart_lock
	' _ "$ROLLBACK_SCRIPT" "$signal_root/restart.lock.d" "$signal" >/dev/null 2>&1
	local rc=$?
	set -e
	echo "rollback-r4: release seam $signal rc=$rc successor_lock=$([[ -d "$signal_root/restart.lock.d" ]] && echo present || echo missing)"
	test "$rc" -eq "$expected_rc"
	test -d "$signal_root/restart.lock.d"
}
test_release_signal INT 130
test_release_signal TERM 143

RMDIR_ROOT="$TEST_ROOT/release-rmdir-fail"
mkdir -p "$RMDIR_ROOT/restart.lock.d"
printf 'nonempty' > "$RMDIR_ROOT/restart.lock.d/owner-evidence"
set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_LOCK_DIR="$2"
	LOCK_OWNED=1
	release_restart_lock
' _ "$ROLLBACK_SCRIPT" "$RMDIR_ROOT/restart.lock.d" >/dev/null 2>&1
rmdir_rc=$?
set -e
test "$rmdir_rc" -ne 0
test -f "$RMDIR_ROOT/restart.lock.d/owner-evidence"
echo "rollback-r4: release seam delays INT/TERM and never removes a successor lock"

set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	launchctl() { printf "state = running\n"; return 0; }
	assert_launch_authority_empty
' _ "$ROLLBACK_SCRIPT" >/dev/null 2>&1
loaded_rc=$?
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_COMM_ROOT="$2"
	lsof() { printf "holder pid=42\n"; return 0; }
	assert_commdb_holders_empty
' _ "$ROLLBACK_SCRIPT" "$CANONICAL_ROOT" >/dev/null 2>&1
holder_rc=$?
set -e
test "$loaded_rc" -ne 0
test "$holder_rc" -ne 0
echo "rollback-r4: launch authority and every CommDB holder fence fail closed"

FENCE_ROOT="$TEST_ROOT/fence-main"
mkdir -p "$FENCE_ROOT/restart.lock-parent"
set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	MARKERS="$2"
	ROLLBACK_R4_LOCK_DIR="$3/restart.lock.d"
	validate_artifact_config() { :; }
	stop_bridge_listener() { :; }
	assert_launch_authority_empty() { :; }
	assert_commdb_holders_empty() { return 1; }
	git() { printf git >> "$MARKERS"; }
	tar() { printf tar >> "$MARKERS"; }
	restore_snapshot() { printf db >> "$MARKERS"; }
	rollback_r4_main
' _ "$ROLLBACK_SCRIPT" "$FENCE_ROOT/markers" "$FENCE_ROOT/restart.lock-parent" >/dev/null 2>&1
fence_rc=$?
set -e
test "$fence_rc" -ne 0
test ! -e "$FENCE_ROOT/markers"
echo "rollback-r4: holder failure leaves git, dist, and canonical DB untouched"

LEDGER_ROOT="$TEST_ROOT/ledger"
FAKE_REPO="$LEDGER_ROOT/repo"
mkdir -p "$FAKE_REPO/scripts" "$LEDGER_ROOT/comm" "$LEDGER_ROOT/home/.flywheel"
cat > "$FAKE_REPO/scripts/restart-services.sh" <<'EOF'
#!/usr/bin/env bash
cat "$ROLLBACK_R4_DEPLOYED_SHA_FILE" > "$ROLLBACK_R4_RESTART_OBSERVED_SHA"
exit "${ROLLBACK_R4_RESTART_RC:-0}"
EOF
chmod +x "$FAKE_REPO/scripts/restart-services.sh"
KNOWN_GOOD=1111111111111111111111111111111111111111
printf '%s\n' 2222222222222222222222222222222222222222 > "$LEDGER_ROOT/home/.flywheel/deployed-sha"
set +e
HOME="$LEDGER_ROOT/home" ROLLBACK_R4_SOURCE_ONLY=1 \
	ROLLBACK_R4_DEPLOYED_SHA_FILE="$LEDGER_ROOT/home/.flywheel/deployed-sha" \
	ROLLBACK_R4_RESTART_OBSERVED_SHA="$LEDGER_ROOT/observed" \
	ROLLBACK_R4_RESTART_RC=7 bash -c '
		source "$1"
		ROLLBACK_R4_REPO="$2"
		ROLLBACK_R4_COMM_ROOT="$3"
		ROLLBACK_R4_DEPLOYED_SHA_FILE="$4"
		ROLLBACK_R4_KNOWN_GOOD="$5"
		restore_deployed_sha
		restart_old_stack
	' _ "$ROLLBACK_SCRIPT" "$FAKE_REPO" "$LEDGER_ROOT/comm" \
	"$LEDGER_ROOT/home/.flywheel/deployed-sha" "$KNOWN_GOOD" >/dev/null 2>&1
restart_rc=$?
set -e
test "$restart_rc" -eq 7
test "$(cat "$LEDGER_ROOT/home/.flywheel/deployed-sha")" = "$KNOWN_GOOD"
test "$(cat "$LEDGER_ROOT/observed")" = "$KNOWN_GOOD"
test -n "$(find "$LEDGER_ROOT/comm" -maxdepth 1 -name '.fly1649-rollback-deployed-sha-*' -print -quit)"

set +e
ROLLBACK_R4_SOURCE_ONLY=1 bash -c '
	source "$1"
	ROLLBACK_R4_HEALTH_TIMEOUT_SECS=0
	curl() { return 1; }
	wait_for_bridge_health
' _ "$ROLLBACK_SCRIPT" >/dev/null 2>&1
health_rc=$?
set -e
test "$health_rc" -ne 0
echo "rollback-r4: deployed-sha is restored before restart and failures stay fail-loud"

echo "rollback-r4: PASS"
