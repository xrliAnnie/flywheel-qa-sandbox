#!/usr/bin/env bash
# FLY-2139 — stopped-service database backup/checkpoint/weekly VACUUM window.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLYWHEEL_ROOT="$HOME/.flywheel"
TEAMLEAD_DB="$FLYWHEEL_ROOT/teamlead.db"
COMM_ROOT="$FLYWHEEL_ROOT/comm"
ARCHIVE_ROOT="$FLYWHEEL_ROOT/archive/db-backups"
EVIDENCE_ROOT="$FLYWHEEL_ROOT/maintenance/fly-2139/db-maintenance"
STATE_ROOT="$FLYWHEEL_ROOT/state/db-maintenance"
LOCK_DIR="$STATE_ROOT/lock.d"
RETENTION_CLI="$SCRIPT_DIR/fly-1998-database-retention-sweep.mjs"
MAX_DURATION_MS="${FLYWHEEL_DB_MAINTENANCE_MAX_DURATION_MS:-1800000}"
WEEK_SECONDS=604800
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SQLITE3_BIN="$(command -v sqlite3 2>/dev/null || true)"
NODE_BIN="$(command -v node 2>/dev/null || true)"
FAILED=0
EVIDENCE_KEEP_PER_DATABASE=2

log() { printf '[db-maintenance] %s\n' "$*" >&2; }
alert() { log "ALERT $*"; }

sha256_file() {
  shasum -a 256 "$1" | sed 's/[[:space:]].*$//'
}

seal_file() {
  local path="$1" digest
  digest="$(sha256_file "$path")" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$digest" > "$path.sha256"
}

verify_seal() {
  local path="$1" expected actual
  [[ -f "$path" && ! -L "$path" \
    && -f "$path.sha256" && ! -L "$path.sha256" ]] || return 1
  expected="$(sed -n '1p' "$path.sha256" | tr -d '[:space:]')"
  actual="$(sha256_file "$path")" || return 1
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$expected" == "$actual" ]]
}

write_failure() {
  local evidence_dir="$1" label="$2" reason="$3" detail="$4" path tmp
  mkdir -p "$evidence_dir" || return 1
  path="$evidence_dir/failure.json"
  [[ ! -e "$path" && ! -L "$path" ]] || return 0
  tmp="$(mktemp "$evidence_dir/.failure.XXXXXX")" || return 1
  jq -n \
    --arg issue FLY-2139 \
    --arg status failed \
    --arg label "$label" \
    --arg reason "$reason" \
    --arg detail "$detail" \
    --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{issue:$issue,status:$status,label:$label,reason:$reason,detail:$detail,recordedAt:$recordedAt}' \
    > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  if ! mv -n "$tmp" "$path" || [[ -e "$tmp" ]]; then
    rm -f "$tmp"
    return 1
  fi
  seal_file "$path"
}

write_run_complete() {
  local evidence_dir="$1" label="$2" outcome="$3" artifact="$4"
  local path tmp artifact_sha
  [[ -f "$artifact" && ! -L "$artifact" ]] || return 1
  artifact_sha="$(sha256_file "$artifact")" || return 1
  [[ "$artifact_sha" =~ ^[0-9a-f]{64}$ ]] || return 1
  path="$evidence_dir/run.json"
  [[ ! -e "$path" && ! -L "$path" ]] || return 1
  tmp="$(mktemp "$evidence_dir/.run.XXXXXX")" || return 1
  jq -n \
    --arg issue FLY-2139 \
    --arg status complete \
    --arg label "$label" \
    --arg outcome "$outcome" \
    --arg artifact "$artifact" \
    --arg artifactSha256 "$artifact_sha" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{issue:$issue,status:$status,label:$label,outcome:$outcome,artifact:$artifact,artifactSha256:$artifactSha256,completedAt:$completedAt}' \
    > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  if ! mv -n "$tmp" "$path" || [[ -e "$tmp" ]]; then
    rm -f "$tmp"
    return 1
  fi
  seal_file "$path"
}

marker_current() {
  local marker="$1" now mtime
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  jq -e '.schemaVersion == 1 and .issue == "FLY-2139"
    and (.receiptSha256 | test("^[0-9a-f]{64}$"))' "$marker" >/dev/null 2>&1 \
    || return 1
  now="$(date +%s)" || return 1
  mtime="$(stat -f %m "$marker" 2>/dev/null)" || mtime=""
  if [[ ! "$mtime" =~ ^[0-9]+$ ]]; then
    mtime="$(stat -c %Y "$marker" 2>/dev/null)" || return 1
  fi
  [[ "$now" =~ ^[0-9]+$ && "$mtime" =~ ^[0-9]+$ \
    && "$mtime" -le "$now" && $((now - mtime)) -lt "$WEEK_SECONDS" ]]
}

write_success_marker() {
  local marker="$1" receipt="$2" tmp receipt_sha
  receipt_sha="$(sha256_file "$receipt")" || return 1
  [[ "$receipt_sha" =~ ^[0-9a-f]{64}$ && ! -L "$marker" ]] || return 1
  tmp="$(mktemp "$STATE_ROOT/.success.XXXXXX")" || return 1
  jq -n \
    --arg issue FLY-2139 \
    --arg runId "$RUN_ID" \
    --arg receipt "$receipt" \
    --arg receiptSha256 "$receipt_sha" \
    --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,issue:$issue,runId:$runId,receipt:$receipt,receiptSha256:$receiptSha256,completedAt:$completedAt}' \
    > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$marker"
}

rotate_backups() {
  local label="$1" count=0 path
  while IFS= read -r path; do
    count=$((count + 1))
    [[ "$count" -le 2 ]] && continue
    [[ -f "$path" && ! -L "$path" ]] && rm -f -- "$path"
  done < <(find "$ARCHIVE_ROOT" -maxdepth 1 -type f -name "$label-*.db" -print \
    2>/dev/null | LC_ALL=C sort -r)
}

rotate_evidence() {
  local label="$1" keep_before_current="$2" root dir name prefix count=0
  local seal=""
  [[ "$keep_before_current" =~ ^[0-9]+$ ]] || return 1
  [[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || return 0
  root="$(cd -P "$EVIDENCE_ROOT" 2>/dev/null && pwd -P)" || return 1
  while IFS= read -r dir; do
    name="${dir##*/}"
    [[ "$name" == *"-$label" ]] || continue
    prefix="${name%-"$label"}"
    [[ "$prefix" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || continue
    [[ ! -L "$dir" && "$(cd -P "$dir" 2>/dev/null && pwd -P)" == "$root/$name" ]] \
      || continue
    seal=""
    if [[ -f "$dir/failure.json" && ! -L "$dir/failure.json" ]] \
      && jq -e --arg label "$label" '.issue == "FLY-2139" and .label == $label' \
        "$dir/failure.json" >/dev/null 2>&1; then
      seal="$dir/failure.json"
    elif [[ -f "$dir/run.json" && ! -L "$dir/run.json" ]] \
      && jq -e --arg label "$label" '.issue == "FLY-2139" and .status == "complete"
        and .label == $label and (.outcome == "weekly-skip" or .outcome == "vacuum-complete")
        and (.artifactSha256 | test("^[0-9a-f]{64}$"))' \
        "$dir/run.json" >/dev/null 2>&1; then
      seal="$dir/run.json"
    fi
    if [[ -z "$seal" ]] || ! verify_seal "$seal"; then
      continue
    fi
    count=$((count + 1))
    [[ "$count" -le "$keep_before_current" ]] && continue
    [[ "$(cd -P "$dir" 2>/dev/null && pwd -P)" == "$root/$name" ]] || return 1
    rm -rf -- "$dir" || return 1
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print 2>/dev/null | LC_ALL=C sort -r)
}

backup_database() {
  local database_path="$1" label="$2" final tmp escaped integrity
  final="$ARCHIVE_ROOT/$label-$RUN_ID.db"
  tmp="$final.tmp"
  [[ ! -e "$final" && ! -L "$final" && ! -e "$tmp" && ! -L "$tmp" ]] \
    || return 1
  escaped="${tmp//\'/\'\'}"
  if ! "$SQLITE3_BIN" "$database_path" ".timeout 0" ".backup '$escaped'"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  [[ -f "$tmp" && ! -L "$tmp" ]] || return 1
  integrity="$("$SQLITE3_BIN" "$tmp" "PRAGMA integrity_check;" 2>&1)" || {
    rm -f "$tmp"
    return 1
  }
  [[ "$integrity" == "ok" ]] || { rm -f "$tmp"; return 1; }
  if ! mv -n "$tmp" "$final" || [[ -e "$tmp" ]]; then
    rm -f "$tmp"
    return 1
  fi
  rotate_backups "$label"
}

checkpoint_database() {
  local database_path="$1" evidence_dir="$2" label="$3"
  local output busy log_pages checkpointed receipt
  output="$("$SQLITE3_BIN" "$database_path" \
    "PRAGMA busy_timeout=0; PRAGMA wal_checkpoint(TRUNCATE);" 2>&1)" || return 1
  output="$(printf '%s\n' "$output" | tail -n 1)"
  IFS='|' read -r busy log_pages checkpointed <<< "$output"
  [[ "$busy" =~ ^[0-9]+$ && "$log_pages" =~ ^[0-9]+$ \
    && "$checkpointed" =~ ^[0-9]+$ ]] || return 1
  receipt="$evidence_dir/checkpoint.json"
  jq -n \
    --arg issue FLY-2139 \
    --arg label "$label" \
    --argjson busy "$busy" \
    --argjson log "$log_pages" \
    --argjson checkpointed "$checkpointed" \
    --arg recordedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{issue:$issue,status:(if $busy == 0 then "complete" elif $log == $checkpointed then "checkpointed_not_truncated" else "busy" end),label:$label,checkpoint:{busy:$busy,log:$log,checkpointed:$checkpointed},recordedAt:$recordedAt}' \
    > "$receipt" 2>/dev/null || return 1
  seal_file "$receipt" || return 1
  [[ "$busy" -eq 0 || "$log_pages" -eq "$checkpointed" ]]
}

validate_vacuum_receipt() {
  local receipt="$1" database="$2" database_path="$3"
  verify_seal "$receipt" || return 1
  jq -e --arg database "$database" --arg database_path "$database_path" '
    .issue == "FLY-2139" and .status == "complete"
    and .database == $database and .databasePath == $database_path
    and ((.checkpoint.before.busy == 0) or (.checkpoint.before.log == .checkpoint.before.checkpointed))
    and ((.checkpoint.after.busy == 0) or (.checkpoint.after.log == .checkpoint.after.checkpointed))
    and .integrity.quickCheck == "ok" and .integrity.integrityCheck == "ok"
  ' "$receipt" >/dev/null 2>&1
}

process_database() {
  local database="$1" project="$2" database_path="$3"
  local label evidence_dir marker output rc receipt
  database_path="$(cd -P "${database_path%/*}" 2>/dev/null && pwd -P)/${database_path##*/}" \
    || { FAILED=1; return; }
  label="$project-$database"
  evidence_dir="$EVIDENCE_ROOT/$RUN_ID-$label"
  marker="$STATE_ROOT/$label-last-success.json"
  if ! rotate_evidence "$label" "$((EVIDENCE_KEEP_PER_DATABASE - 1))"; then
    alert "evidence-rotation-failed label=$label"
    FAILED=1
    return
  fi
  mkdir -p "$evidence_dir" || { FAILED=1; return; }

  if ! backup_database "$database_path" "$label"; then
    write_failure "$evidence_dir" "$label" backup-failed "SQLite backup or backup integrity check failed" || true
    alert "backup-failed label=$label"
    FAILED=1
    return
  fi
  if ! checkpoint_database "$database_path" "$evidence_dir" "$label"; then
    write_failure "$evidence_dir" "$label" checkpoint-busy "checkpoint failed or returned busy" || true
    alert "checkpoint-busy label=$label"
    FAILED=1
    return
  fi
  if marker_current "$marker"; then
    if ! write_run_complete "$evidence_dir" "$label" weekly-skip "$marker"; then
      write_failure "$evidence_dir" "$label" run-receipt-write-failed "$marker" || true
      alert "run-receipt-write-failed label=$label"
      FAILED=1
      return
    fi
    log "skip $label weekly-success-marker-current"
    return
  fi

  output="$("$NODE_BIN" "$RETENTION_CLI" maintenance-vacuum \
    --database "$database" \
    --database-path "$database_path" \
    --evidence-dir "$evidence_dir" \
    --max-duration-ms "$MAX_DURATION_MS" 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    write_failure "$evidence_dir" "$label" "maintenance-vacuum-failed-rc-$rc" "$output" || true
    alert "maintenance-vacuum-failed label=$label rc=$rc"
    FAILED=1
    return
  fi
  receipt="$(printf '%s\n' "$output" | tail -n 1 \
    | jq -er '.vacuumReceiptPath' 2>/dev/null)" || receipt=""
  if ! validate_vacuum_receipt "$receipt" "$database" "$database_path"; then
    write_failure "$evidence_dir" "$label" maintenance-receipt-invalid "$output" || true
    alert "maintenance-receipt-invalid label=$label"
    FAILED=1
    return
  fi
  if ! write_success_marker "$marker" "$receipt"; then
    write_failure "$evidence_dir" "$label" marker-write-failed "$receipt" || true
    alert "marker-write-failed label=$label"
    FAILED=1
    return
  fi
  if ! write_run_complete "$evidence_dir" "$label" vacuum-complete "$receipt"; then
    write_failure "$evidence_dir" "$label" run-receipt-write-failed "$receipt" || true
    alert "run-receipt-write-failed label=$label"
    FAILED=1
    return
  fi
  log "complete $label receipt=$receipt"
}

main() {
  [[ "$MAX_DURATION_MS" =~ ^[1-9][0-9]*$ ]] || {
    alert "configuration-invalid max-duration-ms=$MAX_DURATION_MS"
    return 2
  }
  [[ -n "$SQLITE3_BIN" && -n "$NODE_BIN" && -f "$RETENTION_CLI" \
    && ! -L "$RETENTION_CLI" ]] || {
    alert "tooling-unavailable"
    return 2
  }
  for path in "$FLYWHEEL_ROOT" "$ARCHIVE_ROOT" "$EVIDENCE_ROOT" "$STATE_ROOT"; do
    [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* && ! -L "$path" ]] \
      || { alert "unsafe-path path=$path"; return 2; }
  done
  mkdir -p "$ARCHIVE_ROOT" "$EVIDENCE_ROOT" "$STATE_ROOT" || return 2
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "skip lock-held"
    return 0
  fi
  trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

  if [[ -f "$TEAMLEAD_DB" && ! -L "$TEAMLEAD_DB" ]]; then
    process_database teamlead teamlead "$TEAMLEAD_DB"
  fi
  if [[ -d "$COMM_ROOT" && ! -L "$COMM_ROOT" ]]; then
    local database_path project
    while IFS= read -r -d '' database_path; do
      project="${database_path%/*}"
      project="${project##*/}"
      if [[ ! "$project" =~ ^[A-Za-z0-9._-]+$ || "$project" == "." || "$project" == ".." ]]; then
        alert "unsafe-project project=$project"
        FAILED=1
        continue
      fi
      process_database comm "$project" "$database_path"
    done < <(find "$COMM_ROOT" -mindepth 2 -maxdepth 2 -type f -name comm.db -print0 2>/dev/null)
  fi
  [[ "$FAILED" -eq 0 ]]
}

main "$@"
