#!/usr/bin/env bash
set -euo pipefail

# FLY-1649 canonical template. Before the r4 window, render the four
# __FLY1649_*__ placeholders into the copied ~/.flywheel/r4 artifact, then make
# that copy read-only. The executable artifact must not depend on new-code
# helpers: checkout deliberately replaces the repository with KNOWN_GOOD.
ROLLBACK_R4_REPO="__FLY1649_REPO__"
ROLLBACK_R4_KNOWN_GOOD="__FLY1649_KNOWN_GOOD__"
ROLLBACK_R4_DIST_TAR="__FLY1649_DIST_TAR__"
ROLLBACK_R4_SNAPSHOT_DIR="__FLY1649_SNAPSHOT_DIR__"
ROLLBACK_R4_COMM_ROOT="${ROLLBACK_R4_COMM_ROOT:-${HOME}/.flywheel/comm}"
ROLLBACK_R4_DEPLOYED_SHA_FILE="${ROLLBACK_R4_DEPLOYED_SHA_FILE:-${HOME}/.flywheel/deployed-sha}"
ROLLBACK_R4_LOCK_DIR="${ROLLBACK_R4_LOCK_DIR:-${HOME}/.flywheel/restart.lock.d}"
ROLLBACK_R4_BRIDGE_URL="${ROLLBACK_R4_BRIDGE_URL:-http://127.0.0.1:9876}"
ROLLBACK_R4_LOCK_WAIT_SECS=600
ROLLBACK_R4_HEALTH_TIMEOUT_SECS=300
ROLLBACK_R4_HEALTH_POLL_SECS=10
ROLLBACK_R4_SHARDS=(
    flywheel
    geoforge3d
    growth
    joycon-typeless
    personal-assistant
    sub
    tidal-echo
)

LOCK_OWNED=0
RELEASE_IN_PROGRESS=0
PENDING_SIG=""
SNAPSHOT_SWAP_ACTIVE=0
SNAPSHOT_STAGE_ROOT=""
SNAPSHOT_QUARANTINE_ROOT=""

r4_log() {
    printf '[rollback-r4] %s\n' "$*" >&2
}

r4_alert() {
    local signature="$1" title="$2" body="$3"
    r4_log "FAILED [$signature] $title: $body"
    if [[ -x "${HOME}/.flywheel/bin/lead-alert.sh" ]]; then
        "${HOME}/.flywheel/bin/lead-alert.sh" severe "$signature" "$title" "$body" >/dev/null 2>&1 || true
    fi
}

r4_epoch() { date +%s; }

r4_file_mtime() {
    stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

r4_file_mode() {
    stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1" 2>/dev/null
}

r4_file_size() {
    stat -f %z "$1" 2>/dev/null || stat -c %s "$1" 2>/dev/null
}

r4_sha256() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        sha256sum "$1" | awk '{print $1}'
    fi
}

r4_fsync_dir() {
    python3 - "$1" <<'PY'
import os
import sys

fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
}

validate_artifact_config() {
    local value
    for value in \
        "$ROLLBACK_R4_REPO" \
        "$ROLLBACK_R4_KNOWN_GOOD" \
        "$ROLLBACK_R4_DIST_TAR" \
        "$ROLLBACK_R4_SNAPSHOT_DIR"; do
        if [[ "$value" == __FLY1649_*__ ]]; then
            r4_log "ERROR: rollback artifact still contains an unrendered placeholder: $value"
            return 1
        fi
    done
    [[ "$ROLLBACK_R4_REPO" == /* && "$ROLLBACK_R4_REPO" != "/" ]] || {
        r4_log "ERROR: rendered repository path must be an absolute non-root path"
        return 1
    }
    [[ "$ROLLBACK_R4_COMM_ROOT" == /* && "$ROLLBACK_R4_COMM_ROOT" != "/" ]] || {
        r4_log "ERROR: CommDB root must be an absolute non-root path"
        return 1
    }
    [[ "$ROLLBACK_R4_KNOWN_GOOD" =~ ^[0-9a-f]{40}$ ]] || {
        r4_log "ERROR: KNOWN_GOOD must be one exact 40-hex commit"
        return 1
    }
    [[ -d "$ROLLBACK_R4_REPO/.git" || -f "$ROLLBACK_R4_REPO/.git" ]] || {
        r4_log "ERROR: rendered repository is not a git checkout: $ROLLBACK_R4_REPO"
        return 1
    }
    [[ -f "$ROLLBACK_R4_DIST_TAR" ]] || {
        r4_log "ERROR: verified dist tar is missing: $ROLLBACK_R4_DIST_TAR"
        return 1
    }
    [[ -d "$ROLLBACK_R4_SNAPSHOT_DIR/files" && -f "$ROLLBACK_R4_SNAPSHOT_DIR/manifest.tsv" ]] || {
        r4_log "ERROR: verified snapshot files/manifest are missing: $ROLLBACK_R4_SNAPSHOT_DIR"
        return 1
    }
}

cleanup_owned_lock() {
    if (( LOCK_OWNED == 1 )); then
        if rmdir "$ROLLBACK_R4_LOCK_DIR" 2>/dev/null; then
            LOCK_OWNED=0
        else
            r4_log "ERROR: owned restart lock could not be removed: $ROLLBACK_R4_LOCK_DIR"
            return 1
        fi
    fi
}

restore_quarantined_canonical() {
    (( SNAPSHOT_SWAP_ACTIVE == 1 )) || return 0
    r4_log "snapshot swap failed; restoring the pre-rollback canonical image"
    local failed_root="${SNAPSHOT_QUARANTINE_ROOT}/failed-new" shard item
    mkdir -p "$failed_root"
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        mkdir -p "$failed_root/$shard" "$ROLLBACK_R4_COMM_ROOT/$shard"
        for item in comm.db comm.db-wal comm.db-shm refs; do
            if [[ -e "$ROLLBACK_R4_COMM_ROOT/$shard/$item" ]]; then
                mv "$ROLLBACK_R4_COMM_ROOT/$shard/$item" "$failed_root/$shard/$item"
            fi
            if [[ -e "$SNAPSHOT_QUARANTINE_ROOT/$shard/$item" ]]; then
                mv "$SNAPSHOT_QUARANTINE_ROOT/$shard/$item" "$ROLLBACK_R4_COMM_ROOT/$shard/$item"
            fi
        done
        r4_fsync_dir "$ROLLBACK_R4_COMM_ROOT/$shard"
    done
    SNAPSHOT_SWAP_ACTIVE=0
}

rollback_r4_on_exit() {
    local rc="$1"
    if (( rc != 0 )); then
        restore_quarantined_canonical || true
    fi
    cleanup_owned_lock || true
    return "$rc"
}

rollback_r4_signal() {
    local signal="$1" rc=143
    [[ "$signal" == "INT" ]] && rc=130
    if (( RELEASE_IN_PROGRESS == 1 )); then
        PENDING_SIG="$signal"
        return 0
    fi
    cleanup_owned_lock || true
    exit "$rc"
}

install_runtime_traps() {
    trap 'rollback_r4_on_exit "$?"' EXIT
    trap 'rollback_r4_signal INT' INT
    trap 'rollback_r4_signal TERM' TERM
}

acquire_restart_lock() {
    local started deadline now remaining sleep_secs lock_mtime lock_age
    started=$(r4_epoch)
    deadline=$(( started + ROLLBACK_R4_LOCK_WAIT_SECS ))
    while ! mkdir "$ROLLBACK_R4_LOCK_DIR" 2>/dev/null; do
        now=$(r4_epoch)
        if (( now >= deadline )); then
            r4_alert "rollback-r4-lock-timeout" "r4 rollback lock timeout" \
                "No mutation was started because restart.lock.d remained owned for ${ROLLBACK_R4_LOCK_WAIT_SECS}s."
            return 1
        fi
        lock_mtime=$(r4_file_mtime "$ROLLBACK_R4_LOCK_DIR" 2>/dev/null || printf '0')
        lock_age=$(( now - lock_mtime ))
        remaining=$(( deadline - now ))
        sleep_secs=5
        (( remaining < sleep_secs )) && sleep_secs="$remaining"
        r4_log "restart lock held (${lock_age}s old); waiting (${remaining}s remaining)"
        sleep "$sleep_secs"
    done
    LOCK_OWNED=1
    install_runtime_traps
    r4_log "restart lock acquired; rollback mutation may begin"
}

rollback_release_seam() { :; }

release_restart_lock() {
    (( LOCK_OWNED == 1 )) || {
        r4_log "ERROR: cannot release restart lock that this process does not own"
        return 1
    }
    RELEASE_IN_PROGRESS=1
    PENDING_SIG=""
    trap 'PENDING_SIG=INT' INT
    trap 'PENDING_SIG=TERM' TERM
    if ! rmdir "$ROLLBACK_R4_LOCK_DIR"; then
        RELEASE_IN_PROGRESS=0
        install_runtime_traps
        r4_log "ERROR: owned restart lock release failed; restart will not run"
        return 1
    fi
    rollback_release_seam
    LOCK_OWNED=0
    RELEASE_IN_PROGRESS=0
    install_runtime_traps
    case "$PENDING_SIG" in
        INT) return 130 ;;
        TERM) return 143 ;;
    esac
    r4_log "restart lock released"
}

launchd_label_is_unloaded() {
    local label="$1" output rc
    set +e
    output=$(launchctl print "gui/$(id -u)/$label" 2>&1)
    rc=$?
    set -e
    if (( rc == 0 )); then
        r4_log "ERROR: launch authority is still loaded: $label"
        return 1
    fi
    if [[ "$output" != *"Could not find service"* && "$output" != *"service not found"* ]]; then
        r4_log "ERROR: launch authority state is unreadable for $label: $output"
        return 1
    fi
}

assert_launch_authority_empty() {
    local plist label
    launchd_label_is_unloaded com.flywheel.bridge || return 1
    launchd_label_is_unloaded com.flywheel.updater || return 1
    for plist in "${HOME}/Library/LaunchAgents"/com.flywheel.lead.*.plist; do
        [[ -e "$plist" ]] || continue
        label="$(basename "$plist" .plist)"
        launchd_label_is_unloaded "$label" || return 1
    done
}

assert_commdb_holders_empty() {
    local shard db output rc
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        db="$ROLLBACK_R4_COMM_ROOT/$shard/comm.db"
        [[ -e "$db" ]] || continue
        set +e
        output=$(lsof "$db" 2>&1)
        rc=$?
        set -e
        if (( rc == 0 )); then
            r4_log "ERROR: CommDB still has an open holder: $db: $output"
            return 1
        fi
        if (( rc != 1 )); then
            r4_log "ERROR: CommDB holder scan failed for $db: $output"
            return 1
        fi
    done
}

stop_bridge_listener() {
    local pids pid deadline alive
    set +e
    pids=$(lsof -nP -tiTCP:9876 -sTCP:LISTEN 2>/dev/null)
    local rc=$?
    set -e
    (( rc == 0 || rc == 1 )) || {
        r4_log "ERROR: Bridge listener census failed"
        return 1
    }
    [[ -n "$pids" ]] || return 0
    for pid in $pids; do
        [[ "$pid" =~ ^[0-9]+$ ]] || {
            r4_log "ERROR: invalid Bridge listener PID: $pid"
            return 1
        }
        kill -TERM "$pid"
    done
    deadline=$(( $(r4_epoch) + 30 ))
    while (( $(r4_epoch) < deadline )); do
        alive=0
        for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
        (( alive == 0 )) && break
        sleep 1
    done
    for pid in $pids; do
        kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
    done
    pids=$(lsof -nP -tiTCP:9876 -sTCP:LISTEN 2>/dev/null || true)
    [[ -z "$pids" ]] || {
        r4_log "ERROR: Bridge port :9876 is still held after TERM/KILL"
        return 1
    }
}

manifest_entry_is_safe() {
    local rel="$1" shard rest matched=0
    [[ "$rel" != /* && "$rel" != *".."* && "$rel" != *$'\n'* && "$rel" != *$'\r'* ]] || return 1
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        if [[ "$rel" == "$shard/"* ]]; then
            matched=1
            rest="${rel#"$shard/"}"
            [[ "$rest" == "comm.db" || "$rest" == "comm.db-wal" || "$rest" == "comm.db-shm" || "$rest" == refs/* ]] || return 1
            break
        fi
    done
    (( matched == 1 ))
}

verify_manifest_tree() {
    local root="$1" manifest="$ROLLBACK_R4_SNAPSHOT_DIR/manifest.tsv"
    local rel bytes mode sha actual_count=0 expected_count=0
    local seen="" shard
    while IFS=$'\t' read -r rel bytes mode sha; do
        [[ -n "$rel" && -n "$bytes" && -n "$mode" && -n "$sha" ]] || {
            r4_log "ERROR: malformed snapshot manifest row"
            return 1
        }
        manifest_entry_is_safe "$rel" || {
            r4_log "ERROR: unsafe snapshot manifest path: $rel"
            return 1
        }
        [[ "$bytes" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ && "$sha" =~ ^[0-9a-f]{64}$ ]] || {
            r4_log "ERROR: malformed snapshot metadata: $rel"
            return 1
        }
        [[ "$seen" != *$'\n'"$rel"$'\n'* ]] || {
            r4_log "ERROR: duplicate snapshot manifest path: $rel"
            return 1
        }
        seen="${seen}"$'\n'"${rel}"$'\n'
        [[ -f "$root/$rel" && ! -L "$root/$rel" ]] || {
            r4_log "ERROR: snapshot member missing or not a regular file: $rel"
            return 1
        }
        [[ "$(r4_file_size "$root/$rel")" == "$bytes" ]] || return 1
        [[ "$(r4_file_mode "$root/$rel")" == "$mode" ]] || return 1
        [[ "$(r4_sha256 "$root/$rel")" == "$sha" ]] || return 1
        expected_count=$(( expected_count + 1 ))
    done < "$manifest"
    actual_count=0
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        [[ -f "$root/$shard/comm.db" ]] && actual_count=$(( actual_count + 1 ))
        [[ -f "$root/$shard/comm.db-wal" ]] && actual_count=$(( actual_count + 1 ))
        [[ -f "$root/$shard/comm.db-shm" ]] && actual_count=$(( actual_count + 1 ))
        if [[ -d "$root/$shard/refs" ]]; then
            actual_count=$(( actual_count + $(find "$root/$shard/refs" -type f -print | wc -l | tr -d ' ') ))
        fi
    done
    (( actual_count == expected_count )) || {
        r4_log "ERROR: snapshot file set differs from manifest ($actual_count != $expected_count)"
        return 1
    }
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        [[ "$seen" == *$'\n'"$shard/comm.db"$'\n'* ]] || {
            r4_log "ERROR: snapshot lacks canonical database for shard: $shard"
            return 1
        }
    done
}

verify_snapshot_sqlite() {
    local root="$1" shard result
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        result=$(sqlite3 "file:$root/$shard/comm.db?mode=ro" 'PRAGMA quick_check;') || return 1
        [[ "$result" == "ok" ]] || {
            r4_log "ERROR: SQLite quick_check failed for $shard: $result"
            return 1
        }
    done
}

copy_snapshot_to_stage() {
    local rel bytes mode sha destination
    SNAPSHOT_STAGE_ROOT=$(mktemp -d "$ROLLBACK_R4_COMM_ROOT/.fly1649-rollback-stage.XXXXXX")
    while IFS=$'\t' read -r rel bytes mode sha; do
        destination="$SNAPSHOT_STAGE_ROOT/$rel"
        mkdir -p "$(dirname "$destination")"
        cp "$ROLLBACK_R4_SNAPSHOT_DIR/files/$rel" "$destination"
        chmod "$mode" "$destination"
    done < "$ROLLBACK_R4_SNAPSHOT_DIR/manifest.tsv"
    verify_manifest_tree "$SNAPSHOT_STAGE_ROOT"
    verify_snapshot_sqlite "$SNAPSHOT_STAGE_ROOT"
}

restore_snapshot() {
    local shard item
    verify_manifest_tree "$ROLLBACK_R4_SNAPSHOT_DIR/files"
    copy_snapshot_to_stage
    assert_launch_authority_empty
    assert_commdb_holders_empty
    SNAPSHOT_QUARANTINE_ROOT="$ROLLBACK_R4_COMM_ROOT/.fly1649-rollback-quarantine-$(date +%Y%m%dT%H%M%S)-$$"
    mkdir "$SNAPSHOT_QUARANTINE_ROOT"
    SNAPSHOT_SWAP_ACTIVE=1
    for shard in "${ROLLBACK_R4_SHARDS[@]}"; do
        mkdir -p "$SNAPSHOT_QUARANTINE_ROOT/$shard" "$ROLLBACK_R4_COMM_ROOT/$shard"
        for item in comm.db comm.db-wal comm.db-shm refs; do
            if [[ -e "$ROLLBACK_R4_COMM_ROOT/$shard/$item" ]]; then
                mv "$ROLLBACK_R4_COMM_ROOT/$shard/$item" "$SNAPSHOT_QUARANTINE_ROOT/$shard/$item"
            fi
            if [[ -e "$SNAPSHOT_STAGE_ROOT/$shard/$item" ]]; then
                mv "$SNAPSHOT_STAGE_ROOT/$shard/$item" "$ROLLBACK_R4_COMM_ROOT/$shard/$item"
            fi
        done
        r4_fsync_dir "$ROLLBACK_R4_COMM_ROOT/$shard"
    done
    verify_manifest_tree "$ROLLBACK_R4_COMM_ROOT"
    verify_snapshot_sqlite "$ROLLBACK_R4_COMM_ROOT"
    SNAPSHOT_SWAP_ACTIVE=0
    rm -rf "$SNAPSHOT_QUARANTINE_ROOT" "$SNAPSHOT_STAGE_ROOT"
    r4_fsync_dir "$ROLLBACK_R4_COMM_ROOT"
}

validate_dist_tar() {
    local entry
    while IFS= read -r entry; do
        [[ -n "$entry" ]] || continue
        [[ "$entry" != /* && "$entry" != *".."* ]] || {
            r4_log "ERROR: unsafe dist tar member: $entry"
            return 1
        }
    done < <(tar -tf "$ROLLBACK_R4_DIST_TAR")
}

restore_deployed_sha() {
    local parent temp evidence
    parent=$(dirname "$ROLLBACK_R4_DEPLOYED_SHA_FILE")
    mkdir -p "$parent"
    evidence="$ROLLBACK_R4_COMM_ROOT/.fly1649-rollback-deployed-sha-$(date +%Y%m%dT%H%M%S)-$$"
    if [[ -e "$ROLLBACK_R4_DEPLOYED_SHA_FILE" ]]; then
        cp "$ROLLBACK_R4_DEPLOYED_SHA_FILE" "$evidence"
    fi
    temp="$parent/.deployed-sha.fly1649.$$"
    printf '%s\n' "$ROLLBACK_R4_KNOWN_GOOD" > "$temp"
    chmod 0600 "$temp"
    mv "$temp" "$ROLLBACK_R4_DEPLOYED_SHA_FILE"
    r4_fsync_dir "$parent"
    [[ "$(cat "$ROLLBACK_R4_DEPLOYED_SHA_FILE")" == "$ROLLBACK_R4_KNOWN_GOOD" ]] || {
        r4_log "ERROR: deployed-sha readback verification failed"
        return 1
    }
}

restart_old_stack() {
    local rc
    if FLYWHEEL_RESTART_FOREGROUND=1 \
        "$ROLLBACK_R4_REPO/scripts/restart-services.sh" --reason fly1572-r4-rollback; then
        return 0
    else
        rc=$?
        r4_alert "rollback-r4-restart-failed" "r4 rollback restart failed" \
            "The old code and legacy snapshot are restored, but restart-services exited $rc. Bridge recovery is not complete."
        return "$rc"
    fi
}

wait_for_bridge_health() {
    local started deadline now
    started=$(r4_epoch)
    deadline=$(( started + ROLLBACK_R4_HEALTH_TIMEOUT_SECS ))
    while true; do
        if curl -fsS "$ROLLBACK_R4_BRIDGE_URL/health" 2>/dev/null | jq -e '.ok == true' >/dev/null 2>&1; then
            return 0
        fi
        now=$(r4_epoch)
        (( now >= deadline )) && break
        sleep "$ROLLBACK_R4_HEALTH_POLL_SECS"
    done
    r4_alert "rollback-r4-health-timeout" "r4 rollback Bridge health timeout" \
        "The old code and legacy snapshot are restored, but Bridge did not become healthy within ${ROLLBACK_R4_HEALTH_TIMEOUT_SECS}s."
    return 1
}

rollback_r4_main() {
    validate_artifact_config || return 1
    acquire_restart_lock || return 1
    stop_bridge_listener || return 1
    assert_launch_authority_empty || return 1
    assert_commdb_holders_empty || return 1

    git -C "$ROLLBACK_R4_REPO" checkout -f -B main "$ROLLBACK_R4_KNOWN_GOOD"
    validate_dist_tar
    tar -xpf "$ROLLBACK_R4_DIST_TAR" -C "$ROLLBACK_R4_REPO"

    assert_launch_authority_empty || return 1
    assert_commdb_holders_empty || return 1
    restore_snapshot
    restore_deployed_sha

    local release_rc=0
    release_restart_lock || release_rc=$?
    (( release_rc == 0 )) || return "$release_rc"
    restart_old_stack || return $?
    wait_for_bridge_health || return 1
    r4_log "rollback complete: old code, legacy CommDB snapshot, and Bridge health agree"
}

if [[ "${ROLLBACK_R4_SOURCE_ONLY:-0}" != "1" ]]; then
    rollback_r4_main "$@"
fi
