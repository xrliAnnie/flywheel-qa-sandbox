#!/usr/bin/env bash
# FLY-1764: crash-safe retirement of the old per-Lead swap mailbox fan-out.
#
# Caller contract: the old Bridge has stopped and the replacement bytes no
# longer produce swap-broadcast:* rows. Any unreadable database, unknown schema,
# exhausted lock retry, or non-zero postcondition fails closed before restart.

legacy_swap_trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Keep this byte-for-byte in semantic lockstep with commDbRootDir():
# FLYWHEEL_COMM_ROOT > FLYWHEEL_COMM_DIR > $HOME/.flywheel/comm, after trim.
legacy_swap_comm_root() {
  local root dir
  root="$(legacy_swap_trim "${FLYWHEEL_COMM_ROOT:-}")"
  dir="$(legacy_swap_trim "${FLYWHEEL_COMM_DIR:-}")"
  if [[ -n "$root" ]]; then
    printf '%s\n' "$root"
  elif [[ -n "$dir" ]]; then
    printf '%s\n' "$dir"
  else
    printf '%s\n' "${HOME}/.flywheel/comm"
  fi
}

legacy_swap_sqlite_retry() {
  local db="$1" busy_timeout_ms="$2" max_attempts="$3" label="$4"
  local sql result attempt
  sql="$(cat)"
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if result=$(sqlite3 -batch -noheader -cmd ".timeout ${busy_timeout_ms}" "$db" 2>&1 <<<"$sql"); then
      printf '%s\n' "$result"
      return 0
    fi
    if grep -Eiq 'database( table)? is locked|database is busy' <<<"$result"; then
      if (( attempt < max_attempts )); then
        echo "[restart] WARNING: legacy swap retirement lock contention for ${db}; retrying (${attempt}/${max_attempts})" >&2
        sleep 0.1
        continue
      fi
      echo "[restart] ERROR: legacy swap retirement lock retries exhausted for ${db} (${label}): ${result}" >&2
    else
      echo "[restart] ERROR: legacy swap retirement schema/open failure for ${db} (${label}): ${result}" >&2
    fi
    return 1
  done
  return 1
}

legacy_swap_find_dbs() {
  local comm_root="$1"
  find "$comm_root" -mindepth 2 -maxdepth 2 -type f -name comm.db -print 2>/dev/null | LC_ALL=C sort
}

legacy_swap_has_column() {
  local columns="$1" column="$2"
  grep -Fxq "$column" <<<"$columns"
}

# Return 0 only when the currently deployed source is proven to contain the
# retired producer. Missing/unresolvable provenance returns 1: availability
# wins because the replacement bytes cannot create new legacy rows, while
# aborting after the old Bridge stops would turn a missing marker into a
# self-sustaining outage.
# The deployed-sha fence makes this a one-time cutover while preserving crash
# reruns: deployed-sha advances only after the new Bridge passes health checks.
legacy_swap_retirement_required() {
  local deployed_sha="$1" repo_root="$2" source
  if [[ ! "$deployed_sha" =~ ^[0-9a-f]{40}$ ]] ||
     ! git -C "$repo_root" cat-file -e "${deployed_sha}^{commit}" 2>/dev/null; then
    echo "[restart] WARNING: cannot verify deployed source for legacy swap retirement (${deployed_sha:-missing}); skipping one-time fence" >&2
    return 1
  fi
  if ! source=$(git -C "$repo_root" show "${deployed_sha}:packages/teamlead/src/bridge/fleet-sensors.ts" 2>/dev/null); then
    # The sensor did not exist in that deployed generation, so it could not
    # have produced this row family.
    return 1
  fi
  grep -q 'broadcastLoadShed' <<<"$source"
}

retire_legacy_swap_broadcasts() {
  local comm_root="${1:-$(legacy_swap_comm_root)}"
  local now="${2:-$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')}"
  local busy_timeout_ms="${LEGACY_SWAP_BUSY_TIMEOUT_MS:-5000}"
  local max_busy_attempts="${LEGACY_SWAP_MAX_BUSY_ATTEMPTS:-3}"
  local failed=0 db result matched changed remaining columns set_clause
  local -a dbs=() post_dbs=()

  if [[ ! "$busy_timeout_ms" =~ ^[0-9]+$ ]]; then busy_timeout_ms=5000; fi
  if [[ ! "$max_busy_attempts" =~ ^[1-9][0-9]*$ ]]; then max_busy_attempts=3; fi
  if [[ ! "$now" =~ ^[0-9T:._+-]+Z$ ]]; then
    echo "[restart] ERROR: invalid legacy swap retirement timestamp: ${now}" >&2
    return 1
  fi
  if [[ ! -d "$comm_root" ]]; then
    echo "[restart] ERROR: legacy swap retirement cannot enumerate ${comm_root}" >&2
    return 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "[restart] ERROR: sqlite3 is required for legacy swap retirement" >&2
    return 1
  fi

  while IFS= read -r db; do
    [[ -n "$db" ]] && dbs+=("$db")
  done < <(legacy_swap_find_dbs "$comm_root")
  if (( ${#dbs[@]} == 0 )); then
    echo "[restart] ERROR: legacy swap retirement found no comm.db files under ${comm_root}" >&2
    return 1
  fi

  for db in "${dbs[@]}"; do
    if [[ ! -f "$db" ]]; then
      echo "[restart] ERROR: comm.db disappeared during legacy swap retirement: ${db}" >&2
      failed=1
      continue
    fi
    # Older but valid CommDB shards can predate queue-era lease columns. First
    # prove there is actual retirement work using only the four identity/state
    # columns shared by every supported mailbox generation. A zero-match shard
    # is deliberately not subjected to an UPDATE it does not need.
    if ! matched=$(legacy_swap_sqlite_retry "$db" "$busy_timeout_ms" "$max_busy_attempts" count <<'SQL'
.bail on
SELECT COUNT(*) FROM mailbox
 WHERE id LIKE 'swap-broadcast:%'
   AND from_agent = 'bridge'
   AND type = 'instruction'
   AND state IN ('QUEUED','LEASED');
SQL
    ); then
      failed=1
      continue
    fi
    if [[ ! "$matched" =~ ^[0-9]+$ ]]; then
      echo "[restart] ERROR: legacy swap retirement count unreadable for ${db} (matched=${matched:-?})" >&2
      failed=1
      continue
    fi
    if [[ "$matched" == "0" ]]; then
      echo "[restart] legacy swap retirement ${db}: matched=0 changed=0"
      continue
    fi

    if ! columns=$(legacy_swap_sqlite_retry "$db" "$busy_timeout_ms" "$max_busy_attempts" schema <<'SQL'
.bail on
SELECT name FROM pragma_table_info('mailbox') ORDER BY cid;
SQL
    ); then
      failed=1
      continue
    fi
    # `state` is guaranteed by the count query. Every other cleanup field is
    # generation-dependent, so construct the SET list from PRAGMA evidence
    # rather than assuming the newest schema.
    set_clause="state = 'ACKED'"
    if legacy_swap_has_column "$columns" acked_at; then
      set_clause+=", acked_at = COALESCE(acked_at, '${now}')"
    fi
    if legacy_swap_has_column "$columns" claimed_by; then
      set_clause+=", claimed_by = NULL"
    fi
    if legacy_swap_has_column "$columns" claim_expires_at; then
      set_clause+=", claim_expires_at = NULL"
    fi
    if legacy_swap_has_column "$columns" delivered_at; then
      set_clause+=", delivered_at = NULL"
    fi
    if legacy_swap_has_column "$columns" retry_count; then
      set_clause+=", retry_count = 0"
    fi
    if legacy_swap_has_column "$columns" lease_retry_count; then
      set_clause+=", lease_retry_count = 0"
    fi
    if legacy_swap_has_column "$columns" next_retry_at; then
      set_clause+=", next_retry_at = NULL"
    fi
    if legacy_swap_has_column "$columns" last_error; then
      set_clause+=", last_error = NULL"
    fi
    if legacy_swap_has_column "$columns" batch_id; then
      set_clause+=", batch_id = NULL"
    fi
    if legacy_swap_has_column "$columns" dead_at; then
      set_clause+=", dead_at = NULL"
    fi
    if legacy_swap_has_column "$columns" dead_reason; then
      set_clause+=", dead_reason = NULL"
    fi

    if ! result=$(legacy_swap_sqlite_retry "$db" "$busy_timeout_ms" "$max_busy_attempts" update <<SQL
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE fly1764_legacy_swap_ids(id TEXT PRIMARY KEY);
INSERT INTO fly1764_legacy_swap_ids(id)
SELECT id FROM mailbox
 WHERE id LIKE 'swap-broadcast:%'
   AND from_agent = 'bridge'
   AND type = 'instruction'
   AND state IN ('QUEUED','LEASED');
UPDATE mailbox
   SET ${set_clause}
 WHERE id IN (SELECT id FROM fly1764_legacy_swap_ids);
SELECT (SELECT COUNT(*) FROM fly1764_legacy_swap_ids) || '|' || changes();
COMMIT;
SQL
    ); then
      failed=1
      continue
    fi
    IFS='|' read -r matched changed <<<"$result"
    if [[ ! "$matched" =~ ^[0-9]+$ || ! "$changed" =~ ^[0-9]+$ || "$matched" != "$changed" ]]; then
      echo "[restart] ERROR: legacy swap retirement update mismatch for ${db} (matched=${matched:-?} changed=${changed:-?})" >&2
      failed=1
      continue
    fi
    echo "[restart] legacy swap retirement ${db}: matched=${matched} changed=${changed}"
  done

  # Re-enumerate the on-disk universe for the postcondition. This catches a
  # config-removed project and any comm.db that appeared during the first pass.
  while IFS= read -r db; do
    [[ -n "$db" ]] && post_dbs+=("$db")
  done < <(legacy_swap_find_dbs "$comm_root")
  if (( ${#post_dbs[@]} == 0 )); then
    echo "[restart] ERROR: no comm.db files remained for legacy swap postcondition" >&2
    return 1
  fi
  for db in "${post_dbs[@]}"; do
    if [[ ! -f "$db" ]]; then
      echo "[restart] ERROR: comm.db disappeared before legacy swap postcondition: ${db}" >&2
      failed=1
      continue
    fi
    if ! remaining=$(legacy_swap_sqlite_retry "$db" "$busy_timeout_ms" "$max_busy_attempts" postcondition <<'SQL'
.bail on
SELECT COUNT(*) FROM mailbox
 WHERE id LIKE 'swap-broadcast:%'
   AND from_agent = 'bridge'
   AND type = 'instruction'
   AND state IN ('QUEUED','LEASED');
SQL
    ); then
      failed=1
      continue
    fi
    if [[ ! "$remaining" =~ ^[0-9]+$ || "$remaining" != "0" ]]; then
      echo "[restart] ERROR: legacy swap retirement postcondition failed for ${db} (remaining=${remaining:-?})" >&2
      failed=1
    fi
  done

  [[ "$failed" == "0" ]]
}
