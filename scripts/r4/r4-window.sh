#!/usr/bin/env bash
set -euo pipefail

# Canonical FLY-1649 r4 migration-window controller. Render the placeholders in
# the copied ~/.flywheel/r4 artifact; never run this repository template.
R4_REPO="${R4_REPO:-__FLY1649_REPO__}"
R4_TARGET_SHA="${R4_TARGET_SHA:-__FLY1649_TARGET_SHA__}"
R4_ROOT="${R4_ROOT:-${HOME}/.flywheel/r4}"
R4_COMM_ROOT="${R4_COMM_ROOT:-${HOME}/.flywheel/comm}"
R4_BRIDGE_URL="${R4_BRIDGE_URL:-http://127.0.0.1:9876}"
R4_RESTART_SCRIPT="${R4_RESTART_SCRIPT:-$R4_REPO/scripts/restart-services.sh}"
R4_ROLLBACK_SCRIPT="${R4_ROLLBACK_SCRIPT:-$R4_ROOT/rollback-r4.sh}"
R4_ROLLBACK_TEMPLATE="${R4_ROLLBACK_TEMPLATE:-$R4_ROOT/rollback-r4.template.sh}"
R4_SNAPSHOT_SCRIPT="${R4_SNAPSHOT_SCRIPT:-$R4_ROOT/snapshot-r4.sh}"
R4_SNAPSHOT_DIR="${R4_SNAPSHOT_DIR:-$R4_ROOT/db-snapshot}"
R4_PROGRESS_LOG="${R4_PROGRESS_LOG:-$R4_ROOT/progress.log}"
R4_STATE_FILE="${R4_STATE_FILE:-$R4_ROOT/state}"
R4_STORMWATCH_SAMPLES="${R4_STORMWATCH_SAMPLES:-5}"
R4_STORMWATCH_INTERVAL_SECS="${R4_STORMWATCH_INTERVAL_SECS:-60}"
R4_TRIAL_HEALTH_TRIES="${R4_TRIAL_HEALTH_TRIES:-60}"
R4_TRIAL_HEALTH_INTERVAL_SECS="${R4_TRIAL_HEALTH_INTERVAL_SECS:-5}"
R4_SHARDS=(flywheel geoforge3d growth joycon-typeless personal-assistant sub tidal-echo)
R4_NONFLY_SHARDS=(geoforge3d growth joycon-typeless personal-assistant sub tidal-echo)

R4_PHASE="init"
R4_MUTATED=0
R4_COMMITTED=0
R4_TRIAL_PID=""
R4_BRIDGE_LOG_START_LINES=0
R4_BRIDGE_ORIGINAL_STATE=""
R4_QUIESCE_STARTED=0
R4_LEAD_LABELS_FILE="${R4_LEAD_LABELS_FILE:-$R4_ROOT/lead-labels.txt}"
R4_LOADED_LEAD_LABELS_FILE="${R4_LOADED_LEAD_LABELS_FILE:-$R4_ROOT/loaded-lead-labels.txt}"

# Consumed by the dynamically sourced Bridge process-tree helper.
# shellcheck disable=SC2034
BRIDGE_URL="$R4_BRIDGE_URL"
if [[ "$R4_REPO" != __FLY1649_REPO__ && -f "$R4_REPO/scripts/lib/bridge-process-tree.sh" ]]; then
    # shellcheck source=../lib/bridge-process-tree.sh
    # shellcheck disable=SC1091
    source "$R4_REPO/scripts/lib/bridge-process-tree.sh"
else
    # The immutable r4 artifact bundle must remain usable while the main repo is
    # still on KNOWN_GOOD (before this helper exists there).
    R4_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [[ -f "$R4_SCRIPT_DIR/bridge-process-tree.sh" ]]; then
        # shellcheck source=../lib/bridge-process-tree.sh
        # shellcheck disable=SC1091
        source "$R4_SCRIPT_DIR/bridge-process-tree.sh"
    else
        # Source from this checkout for syntax/tests; validation blocks an
        # unrendered production execution.
        # shellcheck source=../lib/bridge-process-tree.sh
        # shellcheck disable=SC1091
        source "$R4_SCRIPT_DIR/../lib/bridge-process-tree.sh"
    fi
fi

r4_log() {
    local line
    line="[$(date '+%Y-%m-%d %H:%M:%S')] [$R4_PHASE] $*"
    printf '%s\n' "$line" >&2
    [[ -d "$(dirname "$R4_PROGRESS_LOG")" ]] && printf '%s\n' "$line" >> "$R4_PROGRESS_LOG"
}

r4_write_state() {
    local value="$1" temp="${R4_STATE_FILE}.tmp.$$"
    mkdir -p "$(dirname "$R4_STATE_FILE")" || return 1
    printf '%s\n' "$value" > "$temp" || return 1
    mv "$temp" "$R4_STATE_FILE" || return 1
}

r4_validate_config() {
    [[ "${R4_FOUNDER_AUTHORIZED:-0}" == 1 ]] || {
        r4_log "ERROR: set R4_FOUNDER_AUTHORIZED=1 only after the founder approves this exact window"
        return 1
    }
    [[ "$R4_REPO" == /* && "$R4_REPO" != / && "$R4_REPO" != __FLY1649_*__ ]] || return 1
    [[ "$R4_TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1
    [[ -d "$R4_REPO/.git" || -f "$R4_REPO/.git" ]] || return 1
    [[ "$R4_STORMWATCH_SAMPLES" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$R4_STORMWATCH_INTERVAL_SECS" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$R4_TRIAL_HEALTH_TRIES" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ "$R4_TRIAL_HEALTH_INTERVAL_SECS" =~ ^[1-9][0-9]*$ ]] || return 1
    [[ -x "$R4_RESTART_SCRIPT" ]] || return 1
    [[ -x "$R4_SNAPSHOT_SCRIPT" ]] || return 1
    [[ -f "$R4_ROLLBACK_TEMPLATE" ]] || return 1
}

r4_launch_state() {
    local label="$1" output rc=0
    output="$(launchctl print "gui/$(id -u)/$label" 2>&1)" || rc=$?
    if (( rc == 0 )); then
        printf 'loaded\n'
    elif [[ "$output" == *"Could not find service"* || "$output" == *"service not found"* ]]; then
        printf 'unloaded\n'
    else
        r4_log "ERROR: launchctl state is unreadable for $label: $output"
        return 1
    fi
}

r4_manifest_lead_labels() {
    local manifest project lead_id had_nullglob=0
    local manifests=() labels=()
    if shopt -q nullglob; then had_nullglob=1; fi
    shopt -s nullglob || return 1
    manifests=("${HOME}/.flywheel/manifests"/*.json)
    (( had_nullglob == 1 )) || shopt -u nullglob || return 1
    for manifest in "${manifests[@]+"${manifests[@]}"}"; do
        project="$(jq -er '.projectName | select(type == "string" and length > 0)' "$manifest")" || return 1
        lead_id="$(jq -er '.leadId | select(type == "string" and length > 0)' "$manifest")" || return 1
        case "$lead_id" in flywheel-test-*) continue ;; esac
        labels+=("com.flywheel.lead.$project-$lead_id")
    done
    (( ${#labels[@]} > 0 )) || return 0
    printf '%s\n' "${labels[@]}" | LC_ALL=C sort -u || return 1
}

r4_installed_lead_labels() {
    local plist label had_nullglob=0
    local plists=() labels=()
    if shopt -q nullglob; then had_nullglob=1; fi
    shopt -s nullglob || return 1
    plists=("${HOME}/Library/LaunchAgents"/com.flywheel.lead.*.plist)
    (( had_nullglob == 1 )) || shopt -u nullglob || return 1
    for plist in "${plists[@]+"${plists[@]}"}"; do
        label="$(basename "$plist" .plist)" || return 1
        labels+=("$label")
    done
    (( ${#labels[@]} > 0 )) || return 0
    printf '%s\n' "${labels[@]}" | LC_ALL=C sort -u || return 1
}

r4_assert_all_manifest_leads_loaded() {
    local labels label state count=0
    labels="$(r4_manifest_lead_labels)" || return 1
    [[ -n "$labels" ]] || {
        r4_log "ERROR: no production Lead manifests found"
        return 1
    }
    : > "$R4_LEAD_LABELS_FILE" || return 1
    while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        count=$((count + 1))
        state="$(r4_launch_state "$label")" || return 1
        [[ "$state" == loaded ]] || {
            r4_log "ERROR: production Lead manifest exists but job is unloaded: $label"
            return 1
        }
        [[ -f "${HOME}/Library/LaunchAgents/$label.plist" ]] || {
            r4_log "ERROR: production Lead plist missing: $label"
            return 1
        }
        printf '%s\n' "$label" >> "$R4_LEAD_LABELS_FILE" || return 1
    done <<< "$labels"
    (( count > 0 ))
}

r4_prepare_urgent_dir() {
    local dir="${HOME}/.flywheel/self-ship-urgent.d" mode uid
    mkdir -p "$dir" || return 1
    chmod 0700 "$dir" || return 1
    mode="$(stat -c %a "$dir" 2>/dev/null || stat -f %Lp "$dir")" || return 1
    uid="$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir")" || return 1
    [[ "$mode" == 700 && "$uid" == "$(id -u)" ]]
}

r4_assert_updater_quiet() {
    local urgent
    [[ "$(r4_launch_state com.flywheel.updater)" == unloaded ]] || {
        r4_log "ERROR: updater must be unloaded throughout Q-S-M-B-C"
        return 1
    }
    r4_prepare_urgent_dir || return 1
    urgent="$(find "${HOME}/.flywheel/self-ship-urgent.d" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
    [[ -z "$urgent" ]] || {
        r4_log "ERROR: founder urgent directory is not empty"
        return 1
    }
}

r4_assert_authority_empty() {
    local label labels
    for label in com.flywheel.bridge com.flywheel.updater; do
        [[ "$(r4_launch_state "$label")" == unloaded ]] || return 1
    done
    labels="$(r4_installed_lead_labels)" || return 1
    while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        [[ "$(r4_launch_state "$label")" == unloaded ]] || return 1
    done <<< "$labels"
}

r4_assert_no_db_holders() {
    local shard db output rc
    for shard in "${R4_SHARDS[@]}"; do
        db="$R4_COMM_ROOT/$shard/comm.db"
        [[ -e "$db" ]] || continue
        rc=0
        output="$(lsof -t -- "$db" 2>&1)" || rc=$?
        if (( rc == 0 )) && [[ -n "$output" ]]; then
            r4_log "ERROR: CommDB holder survived quiesce: $db pid=$output"
            return 1
        fi
        (( rc == 0 || rc == 1 )) || return 1
    done
}

r4_assert_canonical_modes() {
    local shard suffix path mode
    for shard in "${R4_SHARDS[@]}"; do
        path="$R4_COMM_ROOT/$shard/comm.db"
        [[ -f "$path" ]] || {
            r4_log "ERROR: canonical DB is missing before snapshot: $path"
            return 1
        }
        for suffix in "" -wal -shm; do
            path="$R4_COMM_ROOT/$shard/comm.db$suffix"
            [[ -e "$path" ]] || continue
            mode="$(stat -c %a "$path" 2>/dev/null || stat -f %Lp "$path")" || return 1
            (( (8#$mode & 8#200) != 0 )) || {
                r4_log "ERROR: canonical file is not owner-writable: $path mode=$mode"
                return 1
            }
        done
    done
}

r4_classify_db() {
    local db="$1" legacy_count meta_type generation
    [[ -f "$db" ]] || {
        r4_log "ERROR: canonical DB is missing during classification: $db"
        return 1
    }
    legacy_count="$(sqlite3 "$db" \
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('messages','lead_inbox');")" || return 1
    meta_type="$(sqlite3 "$db" \
        "SELECT type FROM sqlite_master WHERE name='mailbox_migration_meta';")" || return 1
    if [[ "$meta_type" == table ]]; then
        generation="$(sqlite3 "$db" \
            "SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1;")" || return 1
        [[ "$generation" == mailbox_v1 ]] || { printf 'unknown\n'; return; }
        if (( legacy_count > 0 )); then printf 'mixed\n'; else printf 'migrated\n'; fi
    elif [[ "$legacy_count" == 2 ]]; then
        printf 'legacy\n'
    else
        printf 'unknown\n'
    fi
}

r4_inventory() {
    local output="$R4_ROOT/inventory-before.json" rows="$R4_ROOT/inventory-before.tsv"
    local shard path state
    : > "$rows" || return 1
    for shard in "${R4_SHARDS[@]}"; do
        path="$R4_COMM_ROOT/$shard/comm.db"
        state="$(r4_classify_db "$path")" || return 1
        printf '%s\t%s\n' "$path" "$state" >> "$rows" || return 1
    done
    jq -Rn '[inputs | split("\t") | {path: .[0], state: .[1]}] | {inventory: .}' \
        < "$rows" > "$output" || return 1
    jq -e '
        (.inventory | length) == 7 and
        ([.inventory[].state] | all(. == "legacy" or . == "migrated")) and
        ([.inventory[] | select(.path | endswith("/growth/comm.db"))] | length) == 1 and
        ([.inventory[] | select((.path | endswith("/growth/comm.db")) and .state == "legacy")] | length) == 1
    ' "$output" >/dev/null || {
        r4_log "ERROR: seven-shard inventory is mixed/unknown or growth is not clean legacy"
        return 1
    }
}

r4_descendant_pids() {
    local root="$1" child
    [[ "$root" =~ ^[1-9][0-9]*$ ]] || return 0
    while IFS= read -r child; do
        [[ "$child" =~ ^[1-9][0-9]*$ ]] || continue
        r4_descendant_pids "$child"
    done < <(pgrep -P "$root" 2>/dev/null || true)
    printf '%s\n' "$root"
}

r4_reap_trial_bridge() {
    local pids="" pid alive
    pids="$(bridge_target_pids || true)"
    if [[ -n "$R4_TRIAL_PID" ]]; then
        pids="$(printf '%s\n%s\n' "$pids" "$(r4_descendant_pids "$R4_TRIAL_PID")" | awk 'NF && !seen[$0]++')"
    fi
    [[ -n "$pids" ]] || {
        [[ -z "$(_listeners_on_port "$(bridge_port)")" ]]
        return
    }
    for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
    for _ in $(seq 1 50); do
        alive=0
        for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
        (( alive == 0 )) && break
        sleep 0.1
    done
    for pid in $pids; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done
    if [[ "$R4_TRIAL_PID" =~ ^[1-9][0-9]*$ ]]; then
        wait "$R4_TRIAL_PID" 2>/dev/null || true
    fi
    sleep 0.1
    for pid in $pids; do
        kill -0 "$pid" 2>/dev/null && {
            r4_log "ERROR: trial Bridge process survived cleanup: $pid"
            return 1
        }
    done
    [[ -z "$(_listeners_on_port "$(bridge_port)")" ]] || {
        r4_log "ERROR: Bridge trial port remains bound after cleanup"
        return 1
    }
    R4_TRIAL_PID=""
}

r4_quiesce() {
    r4_assert_updater_quiet || return 1
    R4_BRIDGE_ORIGINAL_STATE="$(r4_launch_state com.flywheel.bridge)" || return 1
    local label labels state
    : > "$R4_LOADED_LEAD_LABELS_FILE" || return 1
    labels="$(r4_installed_lead_labels)" || return 1
    while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        state="$(r4_launch_state "$label")" || return 1
        [[ "$state" == loaded ]] || continue
        printf '%s\n' "$label" >> "$R4_LOADED_LEAD_LABELS_FILE" || return 1
        launchctl bootout "gui/$(id -u)/$label" || return 1
    done <<< "$labels"
    if [[ "$R4_BRIDGE_ORIGINAL_STATE" == loaded ]]; then
        launchctl bootout "gui/$(id -u)/com.flywheel.bridge" || return 1
    fi
    r4_reap_trial_bridge || return 1
    r4_assert_authority_empty || return 1
    r4_assert_no_db_holders || return 1
}

r4_snapshot_dist() {
    local list="$R4_ROOT/dist-members.txt" member members
    : > "$list" || return 1
    members="$(find "$R4_REPO/packages" -type d -name dist -prune | LC_ALL=C sort)" || return 1
    while IFS= read -r member; do
        [[ -n "$member" ]] || continue
        printf '%s\n' "${member#"$R4_REPO/"}" >> "$list" || return 1
    done <<< "$members"
    [[ -s "$list" ]] || { r4_log "ERROR: no known-good dist directories found"; return 1; }
    tar -cpf "$R4_ROOT/known-good-dist.tar" -C "$R4_REPO" -T "$list" || return 1
}

r4_render_rollback() {
    local known_good="$1" output="$R4_ROLLBACK_SCRIPT" template="$R4_ROLLBACK_TEMPLATE"
    cp "$template" "$output" || return 1
    python3 - "$output" "$R4_REPO" "$known_good" "$R4_ROOT/known-good-dist.tar" "$R4_SNAPSHOT_DIR" <<'PY' || return 1
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
for marker, value in zip(
    ("__FLY1649_REPO__", "__FLY1649_KNOWN_GOOD__", "__FLY1649_DIST_TAR__", "__FLY1649_SNAPSHOT_DIR__"),
    sys.argv[2:],
):
    if marker not in text:
        raise SystemExit(f"missing rollback marker: {marker}")
    text = text.replace(marker, value)
path.write_text(text)
PY
    chmod 0500 "$output" || return 1
    if grep -q '__FLY1649_' "$output"; then
        r4_log "ERROR: rendered rollback artifact still contains a placeholder"
        return 1
    fi
}

r4_snapshot() {
    r4_assert_authority_empty || return 1
    r4_assert_no_db_holders || return 1
    [[ ! -e "$R4_SNAPSHOT_DIR" ]] || {
        r4_log "ERROR: snapshot destination already exists"
        return 1
    }
    R4_SNAPSHOT_COMM_ROOT="$R4_COMM_ROOT" R4_SNAPSHOT_OUTPUT="$R4_SNAPSHOT_DIR" \
        bash "$R4_SNAPSHOT_SCRIPT" || return 1
    local known_good
    known_good="$(git -C "$R4_REPO" rev-parse HEAD)" || return 1
    [[ "$known_good" =~ ^[0-9a-f]{40}$ ]] || return 1
    printf '%s\n' "$known_good" > "$R4_ROOT/known-good.sha" || return 1
    r4_snapshot_dist || return 1
    r4_render_rollback "$known_good" || return 1
}

r4_reset_nonfly() {
    local stamp shard dir retired suffix
    stamp="$(date +%Y%m%dT%H%M%S)" || return 1
    for shard in "${R4_NONFLY_SHARDS[@]}"; do
        dir="$R4_COMM_ROOT/$shard"
        retired="$dir/retired-r4-$stamp"
        mkdir -p "$retired" || return 1
        for suffix in "" -wal -shm; do
            if [[ -e "$dir/comm.db$suffix" ]]; then
                mv "$dir/comm.db$suffix" "$retired/comm.db$suffix" || return 1
            fi
        done
        [[ ! -e "$dir/comm.db" ]] || return 1
    done
}

r4_deploy_target() {
    git -C "$R4_REPO" checkout -f main || return 1
    git -C "$R4_REPO" merge --ff-only origin/main || return 1
    [[ "$(git -C "$R4_REPO" rev-parse HEAD)" == "$R4_TARGET_SHA" ]] || {
        r4_log "ERROR: checked-out target does not match rendered SHA"
        return 1
    }
    pnpm -C "$R4_REPO" install --frozen-lockfile || return 1
    pnpm -C "$R4_REPO" build || return 1
}

r4_migrate() {
    cd "$R4_REPO" || return 1
    unset FLYWHEEL_COMM_DB
    FLYWHEEL_HOME="${HOME}/.flywheel" npx tsx scripts/migrate-fly1572-mailbox.ts --confirm-quiesced || return 1
}

r4_preflight() {
    cd "$R4_REPO" || return 1
    FLYWHEEL_COMM_ROOT="$R4_COMM_ROOT" npx tsx scripts/r4/preflight-r4.ts || return 1
}

r4_start_trial() {
    cd "$R4_REPO" || return 1
    R4_BRIDGE_LOG_START_LINES="$(wc -l < /tmp/flywheel-bridge.log 2>/dev/null || printf '0')"
    nohup npx tsx scripts/run-bridge.ts >> /tmp/flywheel-bridge.log 2>&1 < /dev/null &
    R4_TRIAL_PID=$!
    [[ "$R4_TRIAL_PID" =~ ^[1-9][0-9]*$ ]] || return 1
    r4_log "Bridge-only trial root PID=$R4_TRIAL_PID" || return 1
}

r4_health_ok() {
    curl -sf "$R4_BRIDGE_URL/health" | jq -e '.ok == true' >/dev/null 2>&1
}

r4_assert_trial_authority() {
    local holder bridge_pids shard db
    r4_assert_authority_empty || return 1
    bridge_pids="$(bridge_target_pids)" || return 1
    [[ -n "$bridge_pids" ]] || return 1
    for shard in "${R4_SHARDS[@]}"; do
        db="$R4_COMM_ROOT/$shard/comm.db"
        while IFS= read -r holder; do
            [[ -n "$holder" ]] || continue
            printf '%s\n' "$bridge_pids" | grep -qx "$holder" || {
                r4_log "ERROR: non-trial holder opened $db: pid=$holder"
                return 1
            }
        done < <(lsof -t -- "$db" 2>/dev/null || true)
    done
}

r4_wait_trial_health() {
    local attempt
    for (( attempt=1; attempt<=R4_TRIAL_HEALTH_TRIES; attempt++ )); do
        if r4_health_ok; then
            r4_assert_trial_authority || return 1
            return 0
        fi
        kill -0 "$R4_TRIAL_PID" 2>/dev/null || return 1
        sleep "$R4_TRIAL_HEALTH_INTERVAL_SECS" || return 1
    done
    return 1
}

r4_stormwatch() {
    local sample shard pending total new_logs
    for (( sample=1; sample<=R4_STORMWATCH_SAMPLES; sample++ )); do
        sleep "$R4_STORMWATCH_INTERVAL_SECS" || return 1
        r4_health_ok || return 1
        r4_assert_trial_authority || return 1
        total=0
        for shard in "${R4_SHARDS[@]}"; do
            pending="$(sqlite3 "$R4_COMM_ROOT/$shard/comm.db" \
                "PRAGMA busy_timeout=8000; SELECT COUNT(*) FROM mailbox WHERE state IN ('QUEUED','LEASED');" 2>/dev/null | tail -1)" || return 1
            [[ "$pending" =~ ^[0-9]+$ ]] || return 1
            total=$((total + pending))
        done
        new_logs="$(tail -n "+$((R4_BRIDGE_LOG_START_LINES + 1))" /tmp/flywheel-bridge.log 2>/dev/null)" || return 1
        if grep -q 'Fatal' <<< "$new_logs"; then
            return 1
        fi
        r4_log "stormwatch sample $sample/$R4_STORMWATCH_SAMPLES fleet-pending=$total" || return 1
    done
}

r4_restore_lead_authority() {
    local label plist state
    [[ -f "$R4_LOADED_LEAD_LABELS_FILE" ]] || return 1
    while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        state="$(r4_launch_state "$label")" || return 1
        [[ "$state" == loaded ]] && continue
        plist="${HOME}/Library/LaunchAgents/$label.plist"
        launchctl bootstrap "gui/$(id -u)" "$plist" || return 1
        [[ "$(r4_launch_state "$label")" == loaded ]] || return 1
    done < "$R4_LOADED_LEAD_LABELS_FILE"
}

r4_restore_bridge_authority() {
    r4_reap_trial_bridge || return 1
    launchctl bootstrap "gui/$(id -u)" "${HOME}/Library/LaunchAgents/com.flywheel.bridge.plist" || return 1
    [[ "$(r4_launch_state com.flywheel.bridge)" == loaded ]]
}

r4_activate() {
    local output rc=0
    output="$(FLYWHEEL_RESTART_FOREGROUND=1 \
        FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1 \
        bash "$R4_RESTART_SCRIPT" --reason fly1572-r4-activate 2>&1)" || rc=$?
    printf '%s\n' "$output"
    (( rc == 0 )) || return "$rc"
    [[ "$output" != *"[restart] detached"* ]] || {
        r4_log "ERROR: foreground activation unexpectedly detached"
        return 1
    }
}

r4_verify_fleet() {
    local label
    r4_health_ok || return 1
    while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        [[ "$(r4_launch_state "$label")" == loaded ]] || return 1
    done < "$R4_LEAD_LABELS_FILE"
}

r4_validate_updater_plist() {
    local plist="$1"
    plutil -lint "$plist" >/dev/null || return 1
    plutil -convert json -o - "$plist" | jq -e '
        .QueueDirectories == [($ENV.HOME + "/.flywheel/self-ship-urgent.d")] and
        ([.StartCalendarInterval[] | [.Hour, .Minute]] | sort) == [[0,0],[12,0]] and
        .ThrottleInterval == 60
    ' >/dev/null || return 1
}

r4_restore_updater() {
    local source="$R4_REPO/scripts/launchd/com.flywheel.updater.plist"
    local target="${HOME}/Library/LaunchAgents/com.flywheel.updater.plist"
    local stage mode uid urgent
    r4_validate_updater_plist "$source" || return 1
    stage="$(mktemp "$(dirname "$target")/.com.flywheel.updater.plist.r4.XXXXXX")" || return 1
    cp "$source" "$stage" || return 1
    chmod 0644 "$stage" || return 1
    mode="$(stat -c %a "$stage" 2>/dev/null || stat -f %Lp "$stage")" || return 1
    uid="$(stat -c %u "$stage" 2>/dev/null || stat -f %u "$stage")" || return 1
    [[ "$mode" == 644 && "$uid" == "$(id -u)" ]] || return 1
    r4_validate_updater_plist "$stage" || return 1
    mv "$stage" "$target" || return 1
    r4_validate_updater_plist "$target" || return 1
    r4_prepare_urgent_dir || return 1
    urgent="$(find "${HOME}/.flywheel/self-ship-urgent.d" -mindepth 1 -maxdepth 1 -print -quit)" || return 1
    [[ -z "$urgent" ]] || {
        r4_log "ERROR: founder urgent directory became nonempty immediately before bootstrap"
        return 1
    }
    launchctl bootstrap "gui/$(id -u)" "$target" || return 1
    [[ "$(r4_launch_state com.flywheel.updater)" == loaded ]]
}

r4_verify_final() {
    local listeners count
    listeners="$(_listeners_on_port "$(bridge_port)")" || return 1
    count="$(printf '%s\n' "$listeners" | awk 'NF {n++} END {print n+0}')" || return 1
    [[ "$count" == 1 ]] || {
        r4_log "ERROR: expected exactly one Bridge listener, found $count"
        return 1
    }
    r4_health_ok || return 1
    r4_verify_fleet || return 1
    [[ "$(r4_launch_state com.flywheel.updater)" == loaded ]]
}

r4_run_rollback() {
    bash "$R4_ROLLBACK_SCRIPT" || return 1
}

r4_restore_pre_window() {
    local bridge_state listeners port rc=0
    (( R4_QUIESCE_STARTED == 1 )) || return 0
    case "$R4_BRIDGE_ORIGINAL_STATE" in
        loaded)
            bridge_state="$(r4_launch_state com.flywheel.bridge)" || rc=1
            if [[ "$bridge_state" == unloaded ]] && \
                ! launchctl bootstrap "gui/$(id -u)" \
                    "${HOME}/Library/LaunchAgents/com.flywheel.bridge.plist"; then
                rc=1
            fi
            ;;
        unloaded)
            port="$(bridge_port)" || rc=1
            if (( rc == 0 )); then
                listeners="$(_listeners_on_port "$port")" || rc=1
            fi
            if (( rc == 0 )) && [[ -z "$listeners" ]]; then
                r4_start_trial || rc=1
            fi
            ;;
        *)
            r4_log "ERROR: original Bridge authority state was not recorded" || true
            rc=1
            ;;
    esac
    r4_restore_lead_authority || rc=1
    return "$rc"
}

r4_fail() {
    local reason="$1" cleanup_rc=0 rollback_rc=0
    r4_log "FAILED: $reason" || true
    if [[ "$R4_PHASE" == B* ]]; then
        r4_reap_trial_bridge || cleanup_rc=$?
    fi
    if (( R4_MUTATED == 1 && R4_COMMITTED == 0 )); then
        (( cleanup_rc == 0 )) || {
            r4_log "ERROR: refusing rollback until the Bridge trial tree is fully reaped" || true
            r4_write_state "FAILED cleanup-before-rollback" || {
                r4_log "ERROR: failed to persist cleanup failure state" || true
            }
            return 1
        }
        r4_run_rollback || rollback_rc=$?
        (( rollback_rc == 0 )) || {
            r4_write_state "FAILED rollback rc=$rollback_rc" || {
                r4_log "ERROR: failed to persist rollback failure state" || true
            }
            return "$rollback_rc"
        }
    elif (( R4_MUTATED == 0 )); then
        r4_restore_pre_window || {
            r4_log "ERROR: pre-window authority restoration failed" || true
        }
    else
        r4_log "COMMIT boundary crossed: automatic whole-state rollback is forbidden; re-quiesce and escalate" || true
    fi
    r4_write_state "FAILED $R4_PHASE $reason" || {
        r4_log "ERROR: failed to persist failure state" || true
    }
    return 1
}

r4_window_main() {
    r4_validate_config || return 1
    mkdir -p "$R4_ROOT" || return 1
    : > "$R4_PROGRESS_LOG" || return 1
    # Recovery may only use Lead labels captured by this exact window. Clear a
    # prior run's ledger before R4_QUIESCE_STARTED can become true.
    : > "$R4_LOADED_LEAD_LABELS_FILE" || return 1
    r4_write_state RUNNING || return 1

    R4_PHASE=Q-preflight
    r4_assert_all_manifest_leads_loaded || { r4_fail "production Lead manifest is unloaded"; return 1; }
    R4_PHASE=Q-quiesce
    R4_QUIESCE_STARTED=1
    r4_quiesce || { r4_fail "quiesce failed"; return 1; }
    r4_assert_canonical_modes || { r4_fail "canonical permission scan failed"; return 1; }
    r4_inventory || { r4_fail "seven-shard generation inventory failed"; return 1; }

    R4_PHASE=S-snapshot
    r4_snapshot || { r4_fail "snapshot failed"; return 1; }

    R4_PHASE=M-reset
    R4_MUTATED=1
    r4_reset_nonfly || { r4_fail "six-shard reset failed"; return 1; }
    R4_PHASE=M-code
    r4_deploy_target || { r4_fail "target checkout/build failed"; return 1; }
    R4_PHASE=M-migrate
    r4_migrate || { r4_fail "migration failed"; return 1; }
    R4_PHASE=M-preflight
    r4_preflight || { r4_fail "seven-shard open preflight failed"; return 1; }

    R4_PHASE=B-trial-start
    r4_start_trial || { r4_fail "Bridge-only trial start failed"; return 1; }
    r4_wait_trial_health || { r4_fail "Bridge-only trial health failed"; return 1; }
    R4_PHASE=B-stormwatch
    r4_stormwatch || { r4_fail "Bridge-only stormwatch failed"; return 1; }

    R4_COMMITTED=1
    R4_PHASE=C-authority
    r4_restore_lead_authority || { r4_fail "Lead authority activation failed"; return 1; }
    if [[ "$R4_BRIDGE_ORIGINAL_STATE" == loaded ]]; then
        r4_restore_bridge_authority || { r4_fail "Bridge launchd authority restore failed"; return 1; }
    fi
    R4_PHASE=C-activate
    r4_activate || { r4_fail "foreground fleet activation failed"; return 1; }
    r4_verify_fleet || { r4_fail "fleet activation evidence failed"; return 1; }

    R4_PHASE=R-updater
    r4_restore_updater || { r4_fail "updater staged restore failed"; return 1; }
    R4_PHASE=R-final
    r4_verify_final || { r4_fail "final authority/health census failed"; return 1; }
    r4_write_state "DONE target=$R4_TARGET_SHA" || return 1
    r4_log "r4 window complete" || return 1
}

if [[ "${R4_WINDOW_SOURCE_ONLY:-0}" != "1" ]]; then
    r4_window_main "$@"
fi
