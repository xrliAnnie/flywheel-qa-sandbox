#!/bin/bash
# state.sh — SQLite-based agent state management for QA Framework
# Generic version: agent types and step templates loaded from qa-config.yaml via shell-export.
# Source this file to use the API.

_STATE_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Core: SQL helpers
# ---------------------------------------------------------------------------

sql_escape() {
    printf '%s' "$1" | sed "s/'/''/g"
}

_sql() {
    local retries=3 delay=1
    for i in $(seq 1 $retries); do
        result=$(sqlite3 \
            -cmd ".timeout 5000" \
            -cmd "PRAGMA foreign_keys=ON;" \
            "$DB_PATH" "$1" 2>&1)
        local rc=$?
        if [ $rc -eq 0 ]; then
            [ -n "$result" ] && echo "$result"
            return 0
        fi
        if echo "$result" | grep -q "database is locked"; then
            sleep $delay
            delay=$((delay * 2))
            continue
        fi
        echo "ERROR: sqlite3 failed: $result" >&2
        return $rc
    done
    echo "ERROR: sqlite3 failed after $retries retries (database locked)" >&2
    return 1
}

# ---------------------------------------------------------------------------
# Failure wrappers (3-tier)
# ---------------------------------------------------------------------------

# Tier 2: fail-closed + retry — for lifecycle-critical writes
state_critical() {
    local retries=3
    for i in $(seq 1 $retries); do
        "$@" && return 0
        echo "WARNING: critical state write failed (attempt $i/$retries): $*" >&2
        sleep 1
    done
    echo "ERROR: critical state write failed after $retries retries: $*" >&2
    return 1
}

# Tier 3: fail-open — for telemetry/non-critical writes
state_try() {
    "$@" 2>/dev/null || echo "WARNING: state tracking call failed: $*" >&2
    return 0
}

# ---------------------------------------------------------------------------
# Database initialization
# ---------------------------------------------------------------------------

# Seed step_templates from config (shell-export environment variables).
# Called by init_db. Expects QA_AGENT_TYPE_*_STEP_* vars to be set.
init_step_templates() {
    # Find all agent types from exported env vars
    local agent_types=()
    while IFS= read -r var; do
        local type_name="${var#QA_AGENT_TYPE_}"
        type_name="${type_name%%_STEP_COUNT}"
        # Deduplicate
        local found=0
        for existing in "${agent_types[@]}"; do
            [ "$existing" = "$type_name" ] && found=1 && break
        done
        [ "$found" -eq 0 ] && agent_types+=("$type_name")
    done < <(env | grep '^QA_AGENT_TYPE_.*_STEP_COUNT=' | cut -d= -f1)

    if [ ${#agent_types[@]} -eq 0 ]; then
        echo "WARNING: No agent types found in environment (QA_AGENT_TYPE_*_STEP_COUNT). Step templates not seeded." >&2
        return 0
    fi

    for type_name in "${agent_types[@]}"; do
        local count_var="QA_AGENT_TYPE_${type_name}_STEP_COUNT"
        local expected_count="${!count_var}"
        [ -z "$expected_count" ] && continue

        # Convert underscores back to hyphens for DB storage
        local db_type_name="${type_name//_/-}"

        local current_count
        current_count=$(_sql "SELECT count(*) FROM step_templates WHERE agent_type='$(sql_escape "$db_type_name")';")

        # Build a content hash from config to detect changes beyond just count
        local config_hash=""
        for j in $(seq 0 $((expected_count - 1))); do
            local key_var="QA_AGENT_TYPE_${type_name}_STEP_${j}_KEY"
            local name_var="QA_AGENT_TYPE_${type_name}_STEP_${j}_NAME"
            local order_var="QA_AGENT_TYPE_${type_name}_STEP_${j}_ORDER"
            local prereq_var="QA_AGENT_TYPE_${type_name}_STEP_${j}_PREREQ"
            config_hash+="${!key_var:-}:${!name_var:-}:${!order_var:-}:${!prereq_var:-},"
        done
        # Remove trailing comma
        config_hash="${config_hash%,}"

        if [ "$current_count" -eq "$expected_count" ]; then
            # Check if content matches (names, order, prerequisites)
            local db_hash
            db_hash=$(_sql "SELECT group_concat(step_key || ':' || step_name || ':' || step_order || ':' || COALESCE(prerequisite,''), ',')
                FROM step_templates WHERE agent_type='$(sql_escape "$db_type_name")' ORDER BY step_order;")
            if [ "$db_hash" = "$config_hash" ]; then
                continue  # Content matches, skip reseed
            fi
            echo "[STATE] $db_type_name template content changed — reseeding"
        elif [ "$current_count" -gt 0 ]; then
            echo "[STATE] $db_type_name template count mismatch ($current_count, expected $expected_count) — reseeding"
        fi

        # Reseed: delete and re-insert
        if [ "$current_count" -gt 0 ]; then
            _sql "DELETE FROM step_templates WHERE agent_type='$(sql_escape "$db_type_name")';"
        fi

        local sql="BEGIN IMMEDIATE;"
        for j in $(seq 0 $((expected_count - 1))); do
            local key="${!prefix_key}"
            local prefix="QA_AGENT_TYPE_${type_name}_STEP_${j}"
            local key_var="${prefix}_KEY"
            local name_var="${prefix}_NAME"
            local order_var="${prefix}_ORDER"
            local prereq_var="${prefix}_PREREQ"

            local step_key="${!key_var}"
            local step_name="${!name_var}"
            local step_order="${!order_var}"
            local step_prereq="${!prereq_var}"

            [ -z "$step_key" ] && continue

            local prereq_sql="NULL"
            [ -n "$step_prereq" ] && prereq_sql="'$(sql_escape "$step_prereq")'"

            sql+="INSERT OR IGNORE INTO step_templates (agent_type, step_key, step_name, step_order, prerequisite)
                VALUES ('$(sql_escape "$db_type_name")', '$(sql_escape "$step_key")', '$(sql_escape "$step_name")', $step_order, $prereq_sql);"
        done
        sql+="COMMIT;"
        _sql "$sql"
    done

    echo "[STATE] Step templates seeded for: ${agent_types[*]}"
}

init_db() {
    if ! command -v sqlite3 &>/dev/null; then
        echo "ERROR: sqlite3 not found." >&2
        return 1
    fi

    local db_dir
    db_dir=$(dirname "$DB_PATH")
    mkdir -p "$db_dir"

    if [ ! -f "$DB_PATH" ]; then
        sqlite3 "$DB_PATH" < "$_STATE_SH_DIR/schema.sql"
        if [ $? -ne 0 ]; then
            echo "ERROR: Failed to create database" >&2
            rm -f "$DB_PATH"
            return 1
        fi
        local wal_result
        wal_result=$(sqlite3 "$DB_PATH" "PRAGMA journal_mode=WAL;")
        if [ "$wal_result" != "wal" ]; then
            echo "WARNING: journal_mode='$wal_result' instead of 'wal'" >&2
        fi
        local tables
        tables=$(sqlite3 "$DB_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('agents','step_templates','agent_steps','artifacts');")
        if [ "$tables" != "4" ]; then
            echo "ERROR: Schema incomplete — expected 4 tables, found $tables" >&2
            rm -f "$DB_PATH"
            return 1
        fi
        echo "[STATE] Created database (WAL mode) at $DB_PATH"
    fi

    # Seed templates from config
    init_step_templates || return 1
    echo "[STATE] Database ready (templates verified)"
}

# ---------------------------------------------------------------------------
# Agent lifecycle
# ---------------------------------------------------------------------------

create_agent() {
    local id=$(sql_escape "$1")
    local domain=$(sql_escape "$2")
    local version=$(sql_escape "$3")
    local slug=$(sql_escape "$4")
    local issue_id=$(sql_escape "$5")
    local plan_file=$(sql_escape "${6:-}")
    local branch=$(sql_escape "${7:-}")
    local worktree_path=$(sql_escape "${8:-}")

    _sql "INSERT INTO agents (id, domain, version, slug, issue_id, plan_file, branch, worktree_path)
        VALUES ('$id', '$domain', '$version', '$slug', '$issue_id', '$plan_file', '$branch', '$worktree_path');"

    local count
    count=$(_sql "SELECT count(*) FROM agents WHERE id='$id';")
    if [ "$count" != "1" ]; then
        echo "[STATE] ERROR: create_agent '$1' — INSERT succeeded but record not found (count=$count)" >&2
        return 1
    fi
}

update_agent_status() {
    local agent_id=$(sql_escape "$1")
    local new_status=$(sql_escape "$2")

    _sql "UPDATE agents SET
        status='$new_status',
        updated_at=datetime('now'),
        completed_at = CASE WHEN '$new_status' IN ('completed','failed','stopped')
            THEN datetime('now') ELSE completed_at END
        WHERE id='$agent_id'
        AND status NOT IN ('completed','failed','stopped');"
}

set_agent_pr() {
    local agent_id=$(sql_escape "$1")
    local pr_number="$2"
    if ! [[ "$pr_number" =~ ^[0-9]+$ ]]; then
        echo "ERROR: set_agent_pr: pr_number must be an integer, got '$pr_number'" >&2
        return 1
    fi
    _sql "UPDATE agents SET pr_number=$pr_number, updated_at=datetime('now') WHERE id='$agent_id';"
}

set_agent_error() {
    local agent_id=$(sql_escape "$1")
    local msg=$(sql_escape "$2")
    _sql "UPDATE agents SET error_message='$msg', updated_at=datetime('now') WHERE id='$agent_id';"
}

set_agent_field() {
    local agent_id=$(sql_escape "$1")
    local field="$2"
    local value=$(sql_escape "$3")
    case "$field" in
        plan_file|branch|worktree_path) ;;
        *) echo "ERROR: set_agent_field: field '$field' not in whitelist (plan_file, branch, worktree_path)" >&2; return 1 ;;
    esac
    _sql "UPDATE agents SET ${field}='$value', updated_at=datetime('now')
          WHERE id='$agent_id'
            AND status NOT IN ('completed','failed','stopped');"
}

# ---------------------------------------------------------------------------
# Step tracking
# ---------------------------------------------------------------------------

init_steps() {
    local agent_id=$(sql_escape "$1")
    local agent_type=$(sql_escape "$2")

    _sql "INSERT INTO agent_steps (agent_id, step_key, step_name, step_order, prerequisite, is_aggregate)
        SELECT '$agent_id', step_key, step_name, step_order, prerequisite, is_aggregate
        FROM step_templates WHERE agent_type='$agent_type'
        ORDER BY step_order;"

    local count
    count=$(_sql "SELECT count(*) FROM agent_steps WHERE agent_id='$agent_id';")
    if [ "$count" -eq 0 ]; then
        echo "ERROR: init_steps inserted 0 rows for $1 (type=$2) — step_templates may be empty" >&2
        return 1
    fi
}

start_step() {
    local agent_id=$(sql_escape "$1")
    local step_key=$(sql_escape "$2")
    _sql "UPDATE agent_steps SET status='in_progress', started_at=datetime('now')
        WHERE agent_id='$agent_id' AND step_key='$step_key';"
}

complete_step() {
    local agent_id=$(sql_escape "$1")
    local step_key=$(sql_escape "$2")
    _sql "UPDATE agent_steps SET status='completed', completed_at=datetime('now')
        WHERE agent_id='$agent_id' AND step_key='$step_key';"
}

fail_step() {
    local agent_id=$(sql_escape "$1")
    local step_key=$(sql_escape "$2")
    local notes=$(sql_escape "${3:-}")
    _sql "UPDATE agent_steps SET status='failed', completed_at=datetime('now'), notes='$notes'
        WHERE agent_id='$agent_id' AND step_key='$step_key';"
}

skip_step() {
    local agent_id=$(sql_escape "$1")
    local step_key=$(sql_escape "$2")
    local notes=$(sql_escape "${3:-}")
    _sql "UPDATE agent_steps SET status='skipped', completed_at=datetime('now'), notes='$notes'
        WHERE agent_id='$agent_id' AND step_key='$step_key';"
}

get_current_step() {
    local agent_id=$(sql_escape "$1")
    _sql "SELECT step_key || '|' || step_name FROM agent_steps
        WHERE agent_id='$agent_id' AND is_aggregate=0
        AND status NOT IN ('completed', 'skipped')
        ORDER BY step_order ASC LIMIT 1;"
}

check_step_completed() {
    local agent_id=$(sql_escape "$1")
    local step_key=$(sql_escape "$2")
    local status
    status=$(_sql "SELECT status FROM agent_steps
        WHERE agent_id='$agent_id' AND step_key='$step_key';")
    [ "$status" = "completed" ]
}

# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------

add_artifact() {
    local agent_id=$(sql_escape "$1")
    local artifact_type=$(sql_escape "$2")
    local value=$(sql_escape "$3")
    local metadata=$(sql_escape "${4:-}")
    if [ -n "$metadata" ]; then
        _sql "INSERT INTO artifacts (agent_id, artifact_type, value, metadata)
            VALUES ('$agent_id', '$artifact_type', '$value', '$metadata');"
    else
        _sql "INSERT INTO artifacts (agent_id, artifact_type, value)
            VALUES ('$agent_id', '$artifact_type', '$value');"
    fi
}

get_artifact_value() {
    local agent_id=$(sql_escape "$1")
    local type=$(sql_escape "$2")
    _sql "SELECT value FROM artifacts
          WHERE agent_id='$agent_id' AND artifact_type='$type'
          ORDER BY id DESC LIMIT 1;"
}

# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

list_active_agents() {
    _sql "SELECT id || '|' || worktree_path || '|' || domain || '|' || version || '|' || status
        FROM agents WHERE status NOT IN ('completed', 'failed', 'stopped')
        ORDER BY spawned_at DESC;"
}

get_agent_summary() {
    local agent_id=$(sql_escape "$1")
    _sql "SELECT a.id, a.domain, a.version, a.status, a.pr_number, a.issue_id,
        s.step_key, s.step_name,
        CAST((julianday('now') - julianday(a.spawned_at)) * 1440 AS INTEGER) AS minutes_elapsed
        FROM agents a
        LEFT JOIN (
            SELECT agent_id, step_key, step_name,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY step_order ASC) AS rn
            FROM agent_steps
            WHERE is_aggregate = 0 AND status NOT IN ('completed', 'skipped')
        ) s ON a.id = s.agent_id AND s.rn = 1
        WHERE a.id = '$agent_id';"
}

get_agent_steps() {
    local agent_id=$(sql_escape "$1")
    _sql "SELECT step_key, step_name, step_order, is_aggregate, status, started_at, completed_at, notes
        FROM agent_steps WHERE agent_id='$agent_id' ORDER BY step_order ASC;"
}

get_agent_artifacts() {
    local agent_id=$(sql_escape "$1")
    _sql "SELECT artifact_type, value, metadata, created_at
        FROM artifacts WHERE agent_id='$agent_id' ORDER BY created_at ASC;"
}
