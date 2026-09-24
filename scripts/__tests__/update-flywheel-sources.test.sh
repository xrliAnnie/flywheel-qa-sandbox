#!/usr/bin/env bash
# FLY-2654: updater accepts only schedule drift or revalidated conditional tickets.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UPDATER="$ROOT/scripts/update-flywheel.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1959-updater.XXXXXX")"
cleanup_test() { rm -rf "$TMP"; }
trap cleanup_test EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

export HOME="$TMP/home"
export FLYWHEEL_HOME="$TMP/state"
export FLYWHEEL_STATE_DIR="$FLYWHEEL_HOME"
export SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/self-ship-urgent.d"
export SELF_SHIP_LOCK_DIR="$FLYWHEEL_HOME/updater.lock.d"
export DEPLOYED_SHA_FILE="$FLYWHEEL_HOME/deployed-sha"
export RESTART_REQUEST_INDEX="$FLYWHEEL_HOME/restart-request-index.json"
export RESTART_REQUEST_AUDIT_DIR="$FLYWHEEL_HOME/restart-request-audit"
export RESTART_WAVE_ACTIVE_TICKET="$FLYWHEEL_HOME/restart-wave-active-ticket.json"
export UPDATER_RESTART_REQUEST_CLI="$TMP/restart-request.js"
export ENV_FILE=/dev/null
export UPDATE_FLYWHEEL_SOURCED=1
export UPDATE_FLYWHEEL_CONVERGE_CMD=true
mkdir -p "$HOME" "$FLYWHEEL_HOME"

export FLYWHEEL_DIR="$TMP/repo"
git init -q "$FLYWHEEL_DIR"
git -C "$FLYWHEEL_DIR" config user.email fly1959@example.test
git -C "$FLYWHEEL_DIR" config user.name FLY-1959
printf 'one\n' > "$FLYWHEEL_DIR/state.txt"
git -C "$FLYWHEEL_DIR" add state.txt
git -C "$FLYWHEEL_DIR" commit -qm one
SHA1="$(git -C "$FLYWHEEL_DIR" rev-parse HEAD)"
SHA2="$(printf 'two\n' | git -C "$FLYWHEEL_DIR" commit-tree "${SHA1}^{tree}" -p "$SHA1")"
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$SHA1"
FOREIGN_SHA=9999999999999999999999999999999999999999

# shellcheck source=/dev/null
source "$UPDATER"
PRODUCTION_FETCH_DEFINITION="$(declare -f updater_fetch_origin)"
PRODUCTION_VERIFY_RESTART_TICKET_DEFINITION="$(declare -f updater_verify_restart_ticket)"

required_functions=(
  updater_enter_active_package
  updater_init_dirs updater_lock_acquire updater_lock_release
  updater_token_shape_valid updater_claim_token updater_urgent_signature
  updater_verify_restart_ticket updater_transition_restart_intent
  updater_scheduled_signature updater_sync_fable_model updater_sync_opus_model update_main
  updater_raya_pass raya_configure_runtime_paths raya_host_capable raya_alert_dispatch
  updater_alert_observation
  shuttle_observation_begin shuttle_observation_record_values shuttle_observation_finish
)
missing_functions=()
for fn in "${required_functions[@]}"; do
  declare -F "$fn" >/dev/null 2>&1 || missing_functions+=("$fn")
done
if [ "${#missing_functions[@]}" -ne 0 ]; then
  fail "new two-source updater API is missing: ${missing_functions[*]}"
  printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
  exit 1
fi

forged_package_log="$TMP/forged-package-active.log"
saved_package_active="${FLYWHEEL_STANDING_PACKAGE_ACTIVE:-}"
saved_package_root="${FLYWHEEL_STANDING_PACKAGE_ROOT:-}"
saved_authority_state="${FLYWHEEL_STANDING_AUTHORITY_STATE_DIR:-}"
FLYWHEEL_STANDING_PACKAGE_ACTIVE=1
FLYWHEEL_STANDING_PACKAGE_ROOT="$TMP/forged-package"
FLYWHEEL_STANDING_AUTHORITY_STATE_DIR="$TMP/missing-standing-authority"
updater_enter_active_package >"$forged_package_log" 2>&1
forged_package_rc=$?
FLYWHEEL_STANDING_PACKAGE_ACTIVE="$saved_package_active"
FLYWHEEL_STANDING_PACKAGE_ROOT="$saved_package_root"
FLYWHEEL_STANDING_AUTHORITY_STATE_DIR="$saved_authority_state"
if [ "$forged_package_rc" -eq 78 ] \
  && grep -Fq 'active-package-pointer-missing' "$forged_package_log"; then
  pass "caller-controlled package-active environment cannot bypass updater package verification"
else
  fail "forged package-active environment bypassed updater verification (rc=$forged_package_rc log=$(cat "$forged_package_log"))"
fi

forged_active_root="$TMP/forged-active-package"
forged_active_state="$TMP/forged-active-state"
forged_active_bin="$TMP/forged-active-bin"
forged_active_cli_rel="packages/teamlead/dist/bin/standing-authority-package-cli.js"
forged_active_entry="$forged_active_root/scripts/update-flywheel.sh"
forged_active_digest="$(printf 'e%.0s' {1..64})"
mkdir -p \
  "$forged_active_root/$(dirname "$forged_active_cli_rel")" \
  "$forged_active_root/scripts" \
  "$forged_active_state" \
  "$forged_active_bin"
printf '%s\n' '// synthetic package verifier' \
  > "$forged_active_root/$forged_active_cli_rel"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$forged_active_entry"
chmod 500 \
  "$forged_active_root/$forged_active_cli_rel" \
  "$forged_active_entry"
forged_active_cli_digest="$(
  shasum -a 256 "$forged_active_root/$forged_active_cli_rel" | awk '{print $1}'
)"
jq -n \
  --arg packageDigest "$forged_active_digest" \
  --arg cliPath "$forged_active_cli_rel" \
  --arg cliDigest "$forged_active_cli_digest" \
  '{packageDigest:$packageDigest,files:[{path:$cliPath,sha256:$cliDigest}]}' \
  > "$forged_active_root/standing-authority-package.json"
forged_active_receipt="$(printf '9%.0s' {1..64})"
jq -n \
  --arg root "$forged_active_root" \
  --arg packageDigest "$forged_active_digest" \
  --arg receipt "$forged_active_receipt" \
  '{schemaVersion:1,immutableRoot:$root,packageDigest:$packageDigest,activatedByReceiptId:$receipt}' \
  > "$forged_active_state/active-package.json"

# FLY-2654 review R7 round 2: an active-package pointer is only a request; the
# fence must read the Bridge confirmation ledger back. Seed a ledger row that
# binds the pointer's activatedByReceiptId to the package digest.
forged_seed_ledger() {
    local ledger="$1" receipt="$2" package_digest="$3"
    mkdir -p "$(dirname "$ledger")"
    # Production shape: WAL StateStore after a clean Bridge close (no -wal/-shm).
    sqlite3 "$ledger" "PRAGMA journal_mode=wal; CREATE TABLE IF NOT EXISTS standing_authority_confirmation (receipt_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_digest TEXT NOT NULL, evidence_body_digest TEXT NOT NULL, package_digest TEXT NOT NULL, confirmer_identity TEXT NOT NULL, confirmer_identity_digest TEXT NOT NULL, carrier_claim TEXT NOT NULL, confirmed_at TEXT NOT NULL, recorded_at TEXT NOT NULL); INSERT OR REPLACE INTO standing_authority_confirmation VALUES ('${receipt}','raya-carrier-follow-main/v1',1,'$(printf 'a%.0s' {1..64})','$(printf 'b%.0s' {1..64})','${package_digest}','flywheel-cos-lead','$(printf 'c%.0s' {1..64})','carrier-claim','2026-09-21T00:00:00.000Z','2026-09-21T00:00:01.000Z');" > /dev/null
    rm -f "${ledger}-wal" "${ledger}-shm"
}

forged_active_ledger="$TMP/forged-active-home/.flywheel/teamlead.db"
forged_seed_ledger "$forged_active_ledger" "$forged_active_receipt" "$forged_active_digest"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'case "${2:-}" in' \
  '  verify) printf '\''{"packageDigest":"%s"}\n'\'' "$FORGED_ACTIVE_PACKAGE_DIGEST" ;;' \
  '  resolve) printf '\''%s\n'\'' "$FORGED_ACTIVE_PACKAGE_ENTRY" ;;' \
  '  *) exit 64 ;;' \
  'esac' \
  > "$forged_active_bin/node"
chmod 500 "$forged_active_bin/node"
forged_active_log="$TMP/forged-active-script.log"
saved_path="$PATH"
PATH="$forged_active_bin:$PATH"
export FORGED_ACTIVE_PACKAGE_DIGEST="$forged_active_digest"
export FORGED_ACTIVE_PACKAGE_ENTRY="$forged_active_entry"
FLYWHEEL_STANDING_PACKAGE_ACTIVE=1
FLYWHEEL_STANDING_PACKAGE_ROOT="$forged_active_root"
FLYWHEEL_STANDING_AUTHORITY_STATE_DIR="$forged_active_state"
saved_ledger_path="${TEAMLEAD_DB_PATH:-}"
# Review R7 round 2: a valid pointer + package with no Bridge confirmation row
# must not elect the package, before any script identity question arises.
TEAMLEAD_DB_PATH="$TMP/forged-active-no-ledger.db"
forged_unconfirmed_log="$TMP/forged-unconfirmed.log"
updater_enter_active_package >"$forged_unconfirmed_log" 2>&1
forged_unconfirmed_rc=$?
if [ "$forged_unconfirmed_rc" -eq 78 ] \
  && grep -Fq 'confirmation-ledger-unavailable' "$forged_unconfirmed_log"; then
  pass "updater refuses an active pointer whose confirmation ledger is unavailable"
else
  fail "updater elected a package without the Bridge confirmation ledger (rc=$forged_unconfirmed_rc log=$(cat "$forged_unconfirmed_log"))"
fi
TEAMLEAD_DB_PATH="$forged_active_ledger"
updater_enter_active_package >"$forged_active_log" 2>&1
forged_active_rc=$?
if [ -n "$saved_ledger_path" ]; then TEAMLEAD_DB_PATH="$saved_ledger_path"; else unset TEAMLEAD_DB_PATH; fi
PATH="$saved_path"
unset FORGED_ACTIVE_PACKAGE_DIGEST FORGED_ACTIVE_PACKAGE_ENTRY
FLYWHEEL_STANDING_PACKAGE_ACTIVE="$saved_package_active"
FLYWHEEL_STANDING_PACKAGE_ROOT="$saved_package_root"
FLYWHEEL_STANDING_AUTHORITY_STATE_DIR="$saved_authority_state"
if [ "$forged_active_rc" -eq 78 ] \
  && grep -Fq 'active-package-script-mismatch' "$forged_active_log"; then
  pass "forged package-active environment cannot run the mutable updater against a valid package"
else
  fail "forged package-active script identity bypassed updater verification (rc=$forged_active_rc log=$(cat "$forged_active_log"))"
fi

bash3_guard='\$\{[^}]*[\^,]{1,2}\}|declare[[:space:]]+-A|local[[:space:]]+-n|readarray|mapfile|coproc|&>>|;;&'
bash3_guard_complete=1
for construct in '${severity^^}' '${severity,,}' '${severity^}' '${severity,}'; do
  printf '%s\n' "$construct" | rg -q "$bash3_guard" || bash3_guard_complete=0
done
if [[ "$bash3_guard_complete" == 1 ]]; then
  pass "Bash 3.2 guard recognizes every case-modification form"
else
  fail "Bash 3.2 guard misses a case-modification form"
fi
if ! rg -n "$bash3_guard" \
  "$UPDATER" "$ROOT/scripts/lib/updater-raya-deploy.sh" \
  "$ROOT/scripts/lib/shuttle-observation.sh" "$ROOT/scripts/lead-patrol-snapshot.sh" >/dev/null; then
  pass "Raya updater path stays compatible with production /bin/bash 3.2"
else
  fail "Raya updater path contains a bash 4+ construct"
fi

# Review round 6 (FLY-2654): a legacy v2 recovery wave is already `started`, so
# its pre-stop refusal must be recorded as a plain `failed`. Passing the
# zero-side-effect flag there is refused by the ledger (side-effects-not-provable)
# and, swallowed by `|| true`, would leave the row consumable at `started`.
rc82_branch="$(awk '/elif \(\( rc == 82 \)\); then/{flag=1; next} flag && /updater_transition_restart_intent/{print; exit}' "$UPDATER")"
if [[ "$rc82_branch" == *'failed "$UPDATER_ACTIVE_WAVE_ID" || true'* && "$rc82_branch" != *'"$UPDATER_ACTIVE_WAVE_ID" 1'* ]]; then
  pass "a started v2 recovery refusal is recorded as a plain failed without the zero-side-effect flag"
else
  fail "rc=82 recovery refusal must record a plain failed (got: $rc82_branch)"
fi

if grep -Fq 'bash scripts/__tests__/updater-raya-deploy.test.sh' "$ROOT/.github/workflows/ci.yml"; then
  pass "CI runs the standalone Raya deploy transaction suite"
else
  fail "CI does not run updater-raya-deploy.test.sh"
fi

last_library_source_line="$(rg -n '^source "\$\{SCRIPT_DIR\}/lib/shuttle-observation\.sh"$' "$UPDATER" | tail -1 | cut -d: -f1)"
last_runtime_pin_line="$(rg -n '^updater_configure_runtime_paths$' "$UPDATER" | tail -1 | cut -d: -f1)"
last_raya_runtime_pin_line="$(rg -n '^raya_configure_runtime_paths$' "$UPDATER" | tail -1 | cut -d: -f1)"
if [[ "$last_library_source_line" =~ ^[0-9]+$ \
  && "$last_runtime_pin_line" =~ ^[0-9]+$ \
  && "$last_raya_runtime_pin_line" =~ ^[0-9]+$ \
  && "$last_runtime_pin_line" -gt "$last_library_source_line" \
  && "$last_raya_runtime_pin_line" -gt "$last_library_source_line" ]]; then
  pass "Flywheel and Raya production path pins run after every library that may re-source .env"
else
  fail "runtime paths can be overwritten by a later .env source (library=$last_library_source_line flywheel_pin=$last_runtime_pin_line raya_pin=$last_raya_runtime_pin_line)"
fi

if declare -F updater_configure_runtime_paths >/dev/null 2>&1; then
  saved_sourced="$UPDATE_FLYWHEEL_SOURCED"
  saved_home="$FLYWHEEL_HOME"
  saved_urgent="$SELF_SHIP_URGENT_DIR"
  saved_lock="$SELF_SHIP_LOCK_DIR"
  saved_raya_home="$RAYA_HOME"
  saved_raya_code="$RAYA_CODE_DIR"
  saved_raya_sha="$RAYA_DEPLOYED_SHA_FILE"
  saved_raya_receipt="$RAYA_DEPLOY_RECEIPT"
  saved_raya_lock="$RAYA_DEPLOY_LOCK_DIR"
  saved_raya_manifest="$RAYA_CANONICAL_MANIFEST"
  saved_raya_migration="$RAYA_MIGRATION_MANIFEST"
  saved_raya_proof="$RAYA_STANDARD_PROOF_FILE"
  saved_raya_workspace="$RAYA_WORKSPACE"
  saved_flywheel_sha="$FLYWHEEL_DEPLOYED_SHA_FILE"
  sandbox_home="$HOME"
  UPDATE_FLYWHEEL_SOURCED=0
  FLYWHEEL_HOME="$TMP/diverted-state"
  SELF_SHIP_URGENT_DIR="$TMP/diverted-urgent"
  SELF_SHIP_LOCK_DIR="$TMP/diverted-lock"
  RAYA_HOME="$TMP/diverted-raya"
  RAYA_CODE_DIR="$TMP/diverted-code"
  RAYA_DEPLOYED_SHA_FILE="$TMP/diverted-raya-sha"
  RAYA_DEPLOY_RECEIPT="$TMP/diverted-raya-receipt"
  RAYA_DEPLOY_LOCK_DIR="$TMP/diverted-raya-lock"
  RAYA_CANONICAL_MANIFEST="$TMP/diverted-manifest"
  RAYA_MIGRATION_MANIFEST="$TMP/diverted-migration"
  RAYA_STANDARD_PROOF_FILE="$TMP/diverted-proof"
  RAYA_WORKSPACE="$TMP/diverted-workspace"
  FLYWHEEL_DEPLOYED_SHA_FILE="$TMP/diverted-flywheel-sha"
  updater_configure_runtime_paths
  raya_configure_runtime_paths
  runtime_home="$FLYWHEEL_HOME"
  runtime_urgent="$SELF_SHIP_URGENT_DIR"
  runtime_lock="$SELF_SHIP_LOCK_DIR"
  runtime_raya_home="$RAYA_HOME"
  runtime_raya_code="$RAYA_CODE_DIR"
  runtime_raya_sha="$RAYA_DEPLOYED_SHA_FILE"
  runtime_raya_receipt="$RAYA_DEPLOY_RECEIPT"
  runtime_raya_lock="$RAYA_DEPLOY_LOCK_DIR"
  runtime_raya_manifest="$RAYA_CANONICAL_MANIFEST"
  runtime_raya_migration="$RAYA_MIGRATION_MANIFEST"
  runtime_raya_proof="$RAYA_STANDARD_PROOF_FILE"
  runtime_raya_workspace="$RAYA_WORKSPACE"
  runtime_flywheel_sha="$FLYWHEEL_DEPLOYED_SHA_FILE"
  UPDATE_FLYWHEEL_SOURCED=1
  FLYWHEEL_HOME="$saved_home"
  SELF_SHIP_URGENT_DIR="$saved_urgent"
  SELF_SHIP_LOCK_DIR="$saved_lock"
  RAYA_HOME="$saved_raya_home"
  RAYA_CODE_DIR="$saved_raya_code"
  RAYA_DEPLOYED_SHA_FILE="$saved_raya_sha"
  RAYA_DEPLOY_RECEIPT="$saved_raya_receipt"
  RAYA_DEPLOY_LOCK_DIR="$saved_raya_lock"
  RAYA_CANONICAL_MANIFEST="$saved_raya_manifest"
  RAYA_MIGRATION_MANIFEST="$saved_raya_migration"
  RAYA_STANDARD_PROOF_FILE="$saved_raya_proof"
  RAYA_WORKSPACE="$saved_raya_workspace"
  FLYWHEEL_DEPLOYED_SHA_FILE="$saved_flywheel_sha"
  updater_configure_runtime_paths
  raya_configure_runtime_paths
  if [ "$runtime_home" = "$sandbox_home/.flywheel" ] \
    && [ "$runtime_urgent" = "$sandbox_home/.flywheel/self-ship-urgent.d" ] \
    && [ "$runtime_lock" = "$sandbox_home/.flywheel/self-ship-updater.lock.d" ] \
    && [ "$runtime_raya_home" = "$sandbox_home/.flywheel/raya" ] \
    && [ "$runtime_raya_code" = "$sandbox_home/.flywheel/raya/code" ] \
    && [ "$runtime_raya_sha" = "$sandbox_home/.flywheel/raya/deployed-sha" ] \
    && [ "$runtime_raya_receipt" = "$sandbox_home/.flywheel/raya/deploy-receipt.json" ] \
    && [ "$runtime_raya_lock" = "$sandbox_home/.flywheel/raya/deploy.lock.d" ] \
    && [ "$runtime_raya_manifest" = "$sandbox_home/.flywheel/manifests/raya-raya.json" ] \
    && [ "$runtime_raya_migration" = "$sandbox_home/.flywheel/raya/migrations/FLY-2445-standard-lead/manifest.json" ] \
    && [ "$runtime_raya_proof" = "$sandbox_home/.flywheel/raya/migrations/FLY-2445-standard-lead/proof.json" ] \
    && [ "$runtime_raya_workspace" = "$sandbox_home/Dev/raya-lead-workspace" ] \
    && [ "$runtime_flywheel_sha" = "$sandbox_home/.flywheel/deployed-sha" ] \
    && [ "$FLYWHEEL_HOME" = "$saved_home" ] \
    && [ "$SELF_SHIP_URGENT_DIR" = "$saved_urgent" ] \
    && [ "$SELF_SHIP_LOCK_DIR" = "$saved_lock" ] \
    && [ "$RAYA_HOME" = "$saved_raya_home" ] \
    && [ "$RAYA_CODE_DIR" = "$saved_raya_code" ] \
    && [ "$RAYA_DEPLOYED_SHA_FILE" = "$saved_raya_sha" ] \
    && [ "$RAYA_DEPLOY_RECEIPT" = "$saved_raya_receipt" ] \
    && [ "$RAYA_DEPLOY_LOCK_DIR" = "$saved_raya_lock" ] \
    && [ "$RAYA_CANONICAL_MANIFEST" = "$saved_raya_manifest" ] \
    && [ "$RAYA_MIGRATION_MANIFEST" = "$saved_raya_migration" ] \
    && [ "$RAYA_STANDARD_PROOF_FILE" = "$saved_raya_proof" ] \
    && [ "$RAYA_WORKSPACE" = "$saved_raya_workspace" ] \
    && [ "$FLYWHEEL_DEPLOYED_SHA_FILE" = "$saved_flywheel_sha" ]; then
    pass "production pins Flywheel and Raya paths while sourced harnesses may override"
  else
    fail "runtime path pinning drifted (flywheel=$runtime_home/$runtime_urgent/$runtime_lock/$runtime_flywheel_sha raya=$runtime_raya_home/$runtime_raya_code/$runtime_raya_sha/$runtime_raya_receipt/$runtime_raya_lock/$runtime_raya_manifest/$runtime_raya_migration/$runtime_raya_proof/$runtime_raya_workspace)"
  fi
  UPDATE_FLYWHEEL_SOURCED="$saved_sourced"
else
  fail "updater lacks explicit production path pinning"
fi

DEPLOY_CALLS="$TMP/deploy.calls"
RAYA_CALLS="$TMP/raya.calls"
ALERT_CALLS="$TMP/alert.calls"
TRANSITION_CALLS="$TMP/transition.calls"
FETCH_MODE=ok
LAUNCHD_PASS_CALLS="$TMP/launchd-pass.calls"
MODEL_SYNC_CALLS="$TMP/model-sync.calls"
OPUS_SYNC_CALLS="$TMP/opus-sync.calls"
CODEX_RECONCILE_CALLS="$TMP/codex-reconcile.calls"
: > "$DEPLOY_CALLS"
: > "$RAYA_CALLS"
: > "$ALERT_CALLS"
: > "$TRANSITION_CALLS"
: > "$LAUNCHD_PASS_CALLS"
: > "$MODEL_SYNC_CALLS"
: > "$OPUS_SYNC_CALLS"
: > "$CODEX_RECONCILE_CALLS"

updater_fetch_origin() {
  case "$FETCH_MODE" in
    ok) return 0 ;;
    missing) return 127 ;;
    *) return 1 ;;
  esac
}
updater_verify_restart_ticket() {
  printf 'verify|%s\n' "$(basename "$1")" >> "$TRANSITION_CALLS"
  [ "${VERIFY_MODE:-ok}" = ok ]
}
updater_transition_restart_intent() {
  printf '%s|%s|%s|%s\n' "$2" "${3:-}" "$(basename "$1")" "${4:-0}" >> "$TRANSITION_CALLS"
  [ "${TRANSITION_MODE:-ok}" = ok ]
}
cat > "$UPDATER_RESTART_REQUEST_CLI" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  intent-state) printf '%s\n' "${MOCK_INTENT_STATE:-prepared}" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$UPDATER_RESTART_REQUEST_CLI"
UPDATER_NODE=bash
updater_converge_bin() { :; }
updater_launchd_pass() { printf 'pass\n' >> "$LAUNCHD_PASS_CALLS"; }
updater_sync_fable_model() {
  printf 'call\n' >> "$MODEL_SYNC_CALLS"
  [ "${MODEL_SYNC_MODE:-ok}" = ok ]
}
PRODUCTION_OPUS_SYNC_DEFINITION="$(declare -f updater_sync_opus_model)"
updater_sync_opus_model() {
  printf 'call\n' >> "$OPUS_SYNC_CALLS"
  [ "${OPUS_SYNC_MODE:-ok}" = ok ]
}
updater_codex_home_reconcile() { printf 'call\n' >> "$CODEX_RECONCILE_CALLS"; }
severe_alert() { printf '%s|%s\n' "$1" "$2" >> "$ALERT_CALLS"; }
PRODUCTION_RAYA_PASS_DEFINITION="$(declare -f updater_raya_pass)"
updater_raya_pass() {
  printf 'call wake=%s result=%s\n' "${UPDATER_WAKE_KIND:-unknown}" "${UPDATER_CYCLE_RESULT:-unknown}" >> "$RAYA_CALLS"
  RAYA_DEPLOY_STATE="${RAYA_STUB_STATE:-current}"
  RAYA_DEPLOY_DETAIL="stub"
  return "${RAYA_STUB_RC:-0}"
}
raya_host_capable() { return "${RAYA_HOST_CAPABLE_RC:-0}"; }

export RAYA_ALERT_ARGV="$TMP/raya-alert.argv"
mkdir -p "$FLYWHEEL_DIR/scripts"
cat > "$FLYWHEEL_DIR/scripts/lead-alert.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${RAYA_ALERT_ARGV:?}"
EOF
chmod +x "$FLYWHEEL_DIR/scripts/lead-alert.sh"
: > "$RAYA_ALERT_ARGV"
UPDATER_UTC_DAY=20260821
FLYWHEEL_FOUNDER_USER_ID=founder-123 raya_alert_dispatch warning raya-fetch-failed ignored warn-body >/dev/null 2>&1
FLYWHEEL_FOUNDER_USER_ID=founder-123 raya_alert_dispatch severe raya-deploy-rolled-back ignored severe-body >/dev/null 2>&1
warning_argv="$(sed -n '1p' "$RAYA_ALERT_ARGV")"
severe_argv="$(sed -n '2p' "$RAYA_ALERT_ARGV")"
: > "$RAYA_ALERT_ARGV"
FLYWHEEL_FOUNDER_USER_ID=founder-123 updater_alert_observation \
  observation-write-failed observation-body >/dev/null 2>&1
observation_argv="$(sed -n '1p' "$RAYA_ALERT_ARGV")"
: > "$RAYA_ALERT_ARGV"
UPDATER_UTC_DAY=20260821 FLYWHEEL_FOUNDER_USER_ID=founder-123 \
  /bin/bash -c 'source "$1"; raya_alert_dispatch warning raya-fetch-failed ignored compat-body' \
  fly2385 "$UPDATER" >/dev/null 2>&1
compat_argv="$(sed -n '1p' "$RAYA_ALERT_ARGV")"
rm -rf "$FLYWHEEL_DIR/scripts"
if [ "$warning_argv" = "--project flywheel --lead updater --kind deploy_degraded --severity warning --title Raya deploy degraded --body warn-body --signature raya-fetch-failed-scheduled-20260821" ] \
  && [ "$severe_argv" = "--project flywheel --lead updater --kind deploy_failed --severity severe --title Raya deploy failed --body severe-body --signature raya-deploy-rolled-back-scheduled-20260821 --mention-user founder-123" ]; then
  pass "Raya alerts use fixed kinds/titles, one class prefix, scheduled dedup, and severe founder mention"
else
  fail "Raya alert argv drifted (warning=$warning_argv severe=$severe_argv)"
fi
if [ "$compat_argv" = "--project flywheel --lead updater --kind deploy_degraded --severity warning --title Raya deploy degraded --body compat-body --signature raya-fetch-failed-scheduled-20260821" ]; then
  pass "production /bin/bash executes the Raya alert path through lead-alert.sh"
else
  fail "production /bin/bash did not deliver the Raya alert path (argv=$compat_argv)"
fi
if [ "$observation_argv" = "--project flywheel --lead updater --kind deploy_degraded --severity warning --title Shuttle observation degraded --body observation-body --signature observation-write-failed-scheduled-20260821" ]; then
  pass "observation failures use degraded warning copy without a founder mention"
else
  fail "observation failure alert is not isolated from deploy_failed/founder paging (argv=$observation_argv)"
fi
stub_deploy_ok() {
  printf 'call\n' >> "$DEPLOY_CALLS"
  if [[ -n "${UPDATER_ACTIVE_TICKET:-}" ]] && updater_token_is_closeout_v3 "$UPDATER_ACTIVE_TICKET"; then
    updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" started "$UPDATER_ACTIVE_WAVE_ID"
    MOCK_INTENT_STATE=started
    export MOCK_INTENT_STATE
  fi
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}
stub_deploy_fail() {
  printf 'call\n' >> "$DEPLOY_CALLS"
  if [[ -n "${UPDATER_ACTIVE_TICKET:-}" ]] && updater_token_is_closeout_v3 "$UPDATER_ACTIVE_TICKET"; then
    updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" started "$UPDATER_ACTIVE_WAVE_ID"
    MOCK_INTENT_STATE=started
    export MOCK_INTENT_STATE
  fi
  return 3
}
stub_deploy_observe_claim() {
  printf 'call watched=%s claimed=%s\n' \
    "$(urgent_count)" \
    "$(find "${UPDATER_CLAIM_DIR:?}" -type f 2>/dev/null | wc -l | tr -d ' ')" \
    >> "$DEPLOY_CALLS"
  updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" started "$UPDATER_ACTIVE_WAVE_ID"
  MOCK_INTENT_STATE=started
  export MOCK_INTENT_STATE
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}
stub_deploy_late() {
  printf 'call\n' >> "$DEPLOY_CALLS"
  updater_transition_restart_intent "$UPDATER_ACTIVE_TICKET" started "$UPDATER_ACTIVE_WAVE_ID"
  MOCK_INTENT_STATE=started
  export MOCK_INTENT_STATE
  write_token late "$SHA1"
  git -C "$FLYWHEEL_DIR" rev-parse origin/main > "$DEPLOYED_SHA_FILE"
  return 0
}

write_token() {
  local nonce="$1" sha="$2" kind="${3:-lead-closeout-restart}" id="" digest=""
  id="$(printf '%s' "$nonce" | shasum -a 256 | awk '{print $1}')"
  id="${id:0:8}-${id:8:4}-4${id:13:3}-8${id:17:3}-${id:20:12}"
  digest="$(printf '%s' "$nonce-ticket" | shasum -a 256 | awk '{print $1}')"
  mkdir -p "$SELF_SHIP_URGENT_DIR"
  jq -n --arg sha "$sha" --arg from "$SHA1" --arg kind "$kind" --arg id "$id" --arg digest "$digest" \
    '{schemaVersion:3,kind:$kind,decisionId:$id,waveId:("wave-"+$id),revision:1,
      authority:{kind:"standing-carve-out",entryId:"lead-closeout-restart/v1"},
      intent:{messageRef:{channelId:"100000000000000001",messageId:"100000000000000002"}},
      scopeSnapshot:{},readiness:{},
      requestedBy:{projectName:"flywheel",leadId:"flywheel-eng-lead",instanceId:"carrier-2654"},
      announcement:{},fromDeployedSha:$from,targetSha:$sha,executionPackage:{},
      createdAt:"2026-09-18T05:00:00.000Z",preMergeHead:$from,
      validatedAt:"2026-09-18T05:00:00.000Z",requestDigest:$digest}' \
    > "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
  chmod 600 "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
}
write_v2_token() {
  local nonce="$1" sha="$2" id="" digest=""
  id="$(printf '%s' "$nonce" | shasum -a 256 | awk '{print $1}')"
  id="${id:0:8}-${id:8:4}-4${id:13:3}-8${id:17:3}-${id:20:12}"
  digest="$(printf '%s' "$nonce-ticket" | shasum -a 256 | awk '{print $1}')"
  mkdir -p "$SELF_SHIP_URGENT_DIR"
  jq -n --arg sha "$sha" --arg from "$SHA1" --arg id "$id" --arg digest "$digest" \
    '{schemaVersion:2,kind:"authorized-urgent-restart",requestId:$id,
      authority:{kind:"founder-per-instance",messageRef:{channelId:"100000000000000001",messageId:"100000000000000002"}},
      trigger:{evidence:{mergedCommit:$sha}},requestedBy:{},announcement:{},
      fromDeployedSha:$from,targetSha:$sha,createdAt:"2026-09-18T05:00:00.000Z",preMergeHead:$from,
      validatedAt:"2026-09-18T05:00:00.000Z",requestDigest:$digest}' \
    > "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
  chmod 600 "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
}
write_founder_direct_token() {
  local nonce="$1" sha="$2"
  mkdir -p "$SELF_SHIP_URGENT_DIR"
  jq -n --arg sha "$sha" \
    '{schemaVersion:1,kind:"founder-urgent-restart",targetSha:$sha,createdAt:1770000000}' \
    > "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
  chmod 600 "$SELF_SHIP_URGENT_DIR/${nonce}.urgent.json"
}
urgent_count() { find "$SELF_SHIP_URGENT_DIR" -type f 2>/dev/null | wc -l | tr -d ' '; }
urgent_entry_count() { find "$SELF_SHIP_URGENT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' '; }
wave_duplicate_audit_count() { find "$RESTART_REQUEST_AUDIT_DIR/restart-wave-duplicates" -type f 2>/dev/null | wc -l | tr -d ' '; }
deploy_count() { grep -c '^call' "$DEPLOY_CALLS" 2>/dev/null || true; }
raya_count() { grep -c '^call' "$RAYA_CALLS" 2>/dev/null || true; }
reset_case() {
  rm -rf "$SELF_SHIP_URGENT_DIR" "$SELF_SHIP_LOCK_DIR" "$RESTART_REQUEST_AUDIT_DIR" \
    "$RESTART_REQUEST_INDEX" "$RESTART_WAVE_ACTIVE_TICKET" "$FLYWHEEL_HOME"/.urgent-claim.*
  mkdir -p "$FLYWHEEL_HOME"
  : > "$DEPLOY_CALLS"
  : > "$RAYA_CALLS"
  : > "$ALERT_CALLS"
  : > "$TRANSITION_CALLS"
  : > "$LAUNCHD_PASS_CALLS"
  : > "$MODEL_SYNC_CALLS"
  : > "$OPUS_SYNC_CALLS"
  : > "$CODEX_RECONCILE_CALLS"
  FETCH_MODE=ok
  VERIFY_MODE=ok
  TRANSITION_MODE=ok
  MODEL_SYNC_MODE=ok
  OPUS_SYNC_MODE=ok
  RAYA_STUB_STATE=current
  RAYA_STUB_RC=0
  RAYA_HOST_CAPABLE_RC=0
  SELF_SHIP_DEPLOY_CMD=stub_deploy_ok
  UPDATER_UTC_DAY=20260821
  MOCK_INTENT_STATE=prepared
  export MOCK_INTENT_STATE
}

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_v2_token retired-v2 "$SHA1"
cp "$SELF_SHIP_URGENT_DIR/retired-v2.urgent.json" "$TMP/retired-v2.original.json"
MOCK_INTENT_STATE=prepared
export MOCK_INTENT_STATE
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
retired_ticket="$(find "$RESTART_REQUEST_AUDIT_DIR/retired-conditional-authority" -name '*.ticket.json' -type f 2>/dev/null | head -1)"
retired_receipt="$(find "$RESTART_REQUEST_AUDIT_DIR/retired-conditional-authority" -name '*.receipt.json' -type f 2>/dev/null | head -1)"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ -n "$retired_ticket" ] && cmp -s "$retired_ticket" "$TMP/retired-v2.original.json" \
  && jq -e '.result == "retired-conditional-authority" and .zeroDeploySideEffects == true' "$retired_receipt" >/dev/null \
  && grep -q '^urgent-retired-conditional-authority-retired-v2.urgent.json|' "$ALERT_CALLS"; then
  pass "unstarted v2 is retired with original bytes and a deterministic zero-deploy audit"
else
  fail "unstarted v2 retirement lost bytes, audit, or fail-closed behavior (rc=$rc deploys=$(deploy_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_v2_token revoked-preflight "$SHA1"
REVOKED_PREFLIGHT_LOG="$TMP/revoked-preflight.log"
cat > "$TMP/revoked-preflight-node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${REVOKED_PREFLIGHT_LOG:?}"
case " $* " in
  *" intent-state "*) printf 'revoked\n'; exit 0 ;;
  *) exit 99 ;;
esac
EOF
chmod +x "$TMP/revoked-preflight-node"
stub_verify_definition="$(declare -f updater_verify_restart_ticket)"
saved_updater_node="$UPDATER_NODE"
export REVOKED_PREFLIGHT_LOG
UPDATER_NODE="$TMP/revoked-preflight-node"
eval "$PRODUCTION_VERIFY_RESTART_TICKET_DEFINITION"
updater_verify_restart_ticket "$SELF_SHIP_URGENT_DIR/revoked-preflight.urgent.json" >/dev/null 2>&1; rc=$?
eval "$stub_verify_definition"
UPDATER_NODE="$saved_updater_node"
if [ "$rc" -ne 0 ] \
  && grep -q ' intent-state ' "$REVOKED_PREFLIGHT_LOG" \
  && ! grep -q ' verify ' "$REVOKED_PREFLIGHT_LOG"; then
  pass "revoked v2 intent stops at the deterministic ledger before Discord natural-language verification"
else
  fail "revoked intent reached mutable/NL verification (rc=$rc calls=$(cat "$REVOKED_PREFLIGHT_LOG" 2>/dev/null))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_v2_token started-v2 "$SHA1"
v2_ticket="$SELF_SHIP_URGENT_DIR/started-v2.urgent.json"
v2_id="$(jq -r .requestId "$v2_ticket")"
v2_digest="$(jq -r .requestDigest "$v2_ticket")"
jq -n --arg id "$v2_id" --arg digest "$v2_digest" \
  '{schemaVersion:1,intents:{key:{requestId:$id,requestDigest:$digest,state:"started",updatedAt:"2026-09-18T05:00:00Z",waveId:"v2-recovery-wave"}}}' \
  > "$RESTART_REQUEST_INDEX"
chmod 600 "$RESTART_REQUEST_INDEX"
MOCK_INTENT_STATE=started
export MOCK_INTENT_STATE
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(grep -c '^started|' "$TRANSITION_CALLS" || true)" = 0 ] \
  && [ "$(grep -c '^succeeded|v2-recovery-wave|' "$TRANSITION_CALLS" || true)" = 1 ]; then
  pass "already-started v2 resumes its bound wave without a second started transition"
else
  fail "started v2 recovery drifted (rc=$rc deploys=$(deploy_count) transitions=$(cat "$TRANSITION_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 0 ] \
  && [ "$(grep -c '^call$' "$MODEL_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^call$' "$OPUS_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^call$' "$CODEX_RECONCILE_CALLS")" = 1 ] \
  && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=scheduled result=scheduled_current$' "$RAYA_CALLS"; then
  pass "caught-up schedule runs one independent Raya pass after the Flywheel cycle"
else
  fail "caught-up schedule/model sync/home reconcile/Raya wiring drifted (rc=$rc deploys=$(deploy_count) raya=$(cat "$RAYA_CALLS") syncs=$(cat "$MODEL_SYNC_CALLS") reconcile=$(cat "$CODEX_RECONCILE_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
(
  # update_main restores its caller's EXIT trap; this subshell must not run
  # the outer suite cleanup and remove fixtures needed by subsequent cases.
  trap - EXIT
  eval "$PRODUCTION_RAYA_PASS_DEFINITION"
  update_main > "$TMP/missing-ledger-wake.log" 2>&1
  [[ "$RAYA_DEPLOY_STATE" == not_configured && "$RAYA_DEPLOY_DETAIL" == migration-ledger-absent ]] \
    && [[ "$(rg -c migration-ledger-absent "$TMP/missing-ledger-wake.log")" == 1 ]] \
    && [[ ! -e "$RAYA_DEPLOY_LOCK_DIR" && ! -e "$RAYA_DEPLOY_RECEIPT" ]] \
    && ! rg -q 'Raya deploy failed' "$TMP/missing-ledger-wake.log"
)
if [[ $? == 0 ]]; then
  pass "scheduled wake reports missing migration ledger exactly once without deployment side effects"
else
  fail "scheduled wake must report missing migration ledger exactly once without deployment side effects"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_token migration-noop "$SHA1"
(
  trap - EXIT
  eval "$PRODUCTION_RAYA_PASS_DEFINITION"
  unset RAYA_DEPLOY_STATE RAYA_DEPLOY_DETAIL
  update_main > "$TMP/missing-ledger-urgent.log" 2>&1
  [[ "$UPDATER_WAKE_KIND" == urgent && "$UPDATER_CYCLE_RESULT" == urgent_deployed ]] \
    && [[ "${RAYA_DEPLOY_STATE:-}" == not_configured && "${RAYA_DEPLOY_DETAIL:-}" == migration-ledger-absent ]] \
    && [[ "$(rg -c migration-ledger-absent "$TMP/missing-ledger-urgent.log")" == 1 ]] \
    && [[ ! -e "$RAYA_DEPLOY_LOCK_DIR" && ! -e "$RAYA_DEPLOY_RECEIPT" ]]
)
if [[ $? == 0 ]]; then
  pass "successful urgent deploy runs the production Raya pass and missing ledger stays a no-op"
else
  fail "successful urgent deploy must run one side-effect-free Raya pass when its ledger is absent"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
RAYA_HOST_CAPABLE_RC=1
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(raya_count)" = 0 ] \
  && [ "$RAYA_DEPLOY_STATE" = not_configured ] \
  && [ "$RAYA_DEPLOY_DETAIL" = host-capability-absent ]; then
  pass "scheduled updater skips Raya silently on hosts without its canonical standard Lead"
else
  fail "host capability gate ran or alerted Raya on an unrelated updater host (rc=$rc raya=$(raya_count) state=${RAYA_DEPLOY_STATE:-unset} detail=${RAYA_DEPLOY_DETAIL:-unset})"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_token host-absent "$SHA1"
RAYA_HOST_CAPABLE_RC=1
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$UPDATER_CYCLE_RESULT" = urgent_deployed ] \
  && [ "$(raya_count)" = 0 ] \
  && [ "$RAYA_DEPLOY_STATE" = not_configured ] \
  && [ "$RAYA_DEPLOY_DETAIL" = host-capability-absent ]; then
  pass "successful urgent deploy still respects the Raya host capability gate"
else
  fail "urgent host capability gate drifted (rc=$rc result=${UPDATER_CYCLE_RESULT:-unset} raya=$(raya_count) state=${RAYA_DEPLOY_STATE:-unset} detail=${RAYA_DEPLOY_DETAIL:-unset})"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
MODEL_SYNC_MODE=fail
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 0 ] \
  && [ "$(grep -c '^call$' "$MODEL_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^pass$' "$LAUNCHD_PASS_CALLS")" = 1 ] \
  && [ "$(raya_count)" = 1 ]; then
  pass "model sync failure is non-fatal and does not suppress the existing updater cycle"
else
  fail "model sync failure changed updater semantics (rc=$rc deploys=$(deploy_count) raya=$(raya_count) syncs=$(cat "$MODEL_SYNC_CALLS") launchd=$(cat "$LAUNCHD_PASS_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
OPUS_SYNC_MODE=fail
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 0 ] \
  && [ "$(grep -c '^call$' "$OPUS_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^call$' "$MODEL_SYNC_CALLS")" = 1 ] \
  && [ "$(grep -c '^pass$' "$LAUNCHD_PASS_CALLS")" = 1 ] \
  && [ "$(raya_count)" = 1 ]; then
  pass "FLY-2775: Opus model sync failure is non-fatal and runs alongside the Fable sync"
else
  fail "FLY-2775: Opus model sync failure changed updater semantics (rc=$rc opus=$(cat "$OPUS_SYNC_CALLS") fable=$(cat "$MODEL_SYNC_CALLS"))"
fi
OPUS_SYNC_MODE=ok

# FLY-2775: the production wrapper passes the authority and alert bin, and is
# a 127 no-op when the compiled CLI is absent (first deploy of the feature).
(
  eval "$PRODUCTION_OPUS_SYNC_DEFINITION"
  unset TEAMLEAD_DB_PATH
  OPUS_ARGV="$TMP/opus-cli.argv"
  : > "$OPUS_ARGV"
  cat > "$TMP/opus-cli.js" <<'EOS'
printf '%s\n' "$*" >> "$OPUS_ARGV_FILE"
EOS
  UPDATER_NODE=bash FLYWHEEL_OPUS_MODEL_SYNC_CLI="$TMP/opus-cli.js" \
    FLYWHEEL_LEAD_ALERT_BIN=/x/lead-alert.sh OPUS_ARGV_FILE="$OPUS_ARGV" \
    updater_sync_opus_model
  got="$(cat "$OPUS_ARGV")"
  FLYWHEEL_OPUS_MODEL_SYNC_CLI="$TMP/does-not-exist.js" updater_sync_opus_model
  missing_rc=$?
  # Production defaults resolve from the VERIFIED package roots, like Fable.
  mkdir -p "$TMP/pkg/teamlead/dist/account-heal" "$TMP/pkg-scripts"
  cp "$TMP/opus-cli.js" "$TMP/pkg/teamlead/dist/account-heal/opus-model-sync-cli.js"
  : > "$OPUS_ARGV"
  (
    unset FLYWHEEL_OPUS_MODEL_SYNC_CLI FLYWHEEL_LEAD_ALERT_BIN
    UPDATER_NODE=bash FLYWHEEL_TEAMLEAD_ROOT="$TMP/pkg/teamlead" \
      UPDATER_RUNTIME_SCRIPT_DIR="$TMP/pkg-scripts" OPUS_ARGV_FILE="$OPUS_ARGV" \
      updater_sync_opus_model
  )
  pkg_got="$(cat "$OPUS_ARGV")"
  # Bridge review 1458e9d5 [1]: the kill switch is read from THIS home's store.
  if [ "$got" = "--authority ${FLYWHEEL_HOME}/models.json --db ${FLYWHEEL_HOME}/teamlead.db --alert-bin /x/lead-alert.sh" ] && [ "$missing_rc" = 127 ] \
    && [ "$pkg_got" = "--authority ${FLYWHEEL_HOME}/models.json --db ${FLYWHEEL_HOME}/teamlead.db --alert-bin $TMP/pkg-scripts/lead-alert.sh" ]; then
    echo "PASS_OPUS_WRAPPER"
  else
    echo "FAIL_OPUS_WRAPPER got=[$got] missing_rc=$missing_rc pkg_got=[$pkg_got]"
  fi
) > "$TMP/opus-wrapper.out" 2>&1
if grep -q '^PASS_OPUS_WRAPPER$' "$TMP/opus-wrapper.out"; then
  pass "FLY-2775: updater_sync_opus_model uses the verified package roots, passes authority/alert-bin, and no-ops (127) without the compiled CLI"
else
  fail "FLY-2775: updater_sync_opus_model wrapper drifted ($(cat "$TMP/opus-wrapper.out"))"
fi

reset_case
FETCH_MODE=fail
update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 2 ] && [ "$(deploy_count)" = 0 ] && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=scheduled result=fetch_failed$' "$RAYA_CALLS"; then
  pass "scheduled Flywheel fetch failure still runs exactly one independent Raya pass and preserves rc"
else
  fail "scheduled fetch failure suppressed or changed the Raya pass (rc=$rc deploys=$(deploy_count) raya=$(cat "$RAYA_CALLS"))"
fi

reset_case
original_launchd_then_cycle="$(declare -f updater_run_launchd_then_cycle)"
updater_run_launchd_then_cycle() {
  printf 'cycle\n' >> "$RAYA_CALLS"
  UPDATER_WAKE_KIND=unknown
  UPDATER_CYCLE_RESULT=unknown
  return 9
}
update_main >/dev/null 2>&1; rc=$?
eval "$original_launchd_then_cycle"
if [ "$rc" -eq 9 ] && [ "$(cat "$RAYA_CALLS")" = cycle ]; then
  pass "unknown wake kind fails closed, skips Raya, and preserves the Flywheel cycle rc"
else
  fail "unknown wake kind ran Raya or changed rc (rc=$rc calls=$(cat "$RAYA_CALLS"))"
fi

saved_observation_record="$(declare -f updater_observation_record)"
updater_observation_record() { printf '%s\n' "$*" > "$TMP/urgent-skip-observation"; }
UPDATER_WAKE_KIND=urgent
unset RAYA_DEPLOY_STATE RAYA_DEPLOY_DETAIL
updater_observation_record_raya
eval "$saved_observation_record"
if grep -Fq 'raya external_repo raya-repo Raya skipped wake-out-of-scope ' "$TMP/urgent-skip-observation"; then
  pass "skipped urgent cycles retain the wake-out-of-scope observation reason"
else
  fail "skipped urgent cycle observation reason drifted ($(cat "$TMP/urgent-skip-observation"))"
fi

if declare -F updater_fetch_origin_once >/dev/null 2>&1 \
  && declare -F updater_retry_sleep >/dev/null 2>&1; then
  BOUNDED_FETCH_LOG="$TMP/bounded-fetch.log"
  export BOUNDED_FETCH_LOG
  fake_bounded_run="$TMP/fake-bounded-run"
  cat > "$fake_bounded_run" <<'EOF'
#!/usr/bin/env bash
printf '%s|%s\n' "${GIT_TERMINAL_PROMPT:-unset}" "$*" > "$BOUNDED_FETCH_LOG"
EOF
  chmod +x "$fake_bounded_run"
  original_bounded_run="$UPDATER_BOUNDED_RUN"
  original_updater_git="$UPDATER_GIT"
  original_fetch_timeout="$UPDATER_FETCH_TIMEOUT_SECONDS"
  UPDATER_BOUNDED_RUN="$fake_bounded_run"
  UPDATER_GIT=git-sentinel
  UPDATER_FETCH_TIMEOUT_SECONDS=17
  updater_fetch_origin_once >/dev/null 2>&1; once_rc=$?
  bounded_fetch_record="$(cat "$BOUNDED_FETCH_LOG" 2>/dev/null || true)"
  UPDATER_BOUNDED_RUN="$original_bounded_run"
  UPDATER_GIT="$original_updater_git"
  UPDATER_FETCH_TIMEOUT_SECONDS="$original_fetch_timeout"

  eval "$PRODUCTION_FETCH_DEFINITION"
  fetch_attempts=0
  retry_sleeps=0
  updater_fetch_origin_once() {
    fetch_attempts=$((fetch_attempts + 1))
    return 127
  }
  updater_retry_sleep() { retry_sleeps=$((retry_sleeps + 1)); }
  updater_fetch_origin >/dev/null 2>&1; missing_rc=$?
  missing_attempts=$fetch_attempts
  missing_sleeps=$retry_sleeps

  fetch_attempts=0
  retry_sleeps=0
  updater_fetch_origin_once() {
    fetch_attempts=$((fetch_attempts + 1))
    [ "$fetch_attempts" -eq 3 ]
  }
  updater_retry_sleep() { retry_sleeps=$((retry_sleeps + 1)); }
  updater_fetch_origin >/dev/null 2>&1; rc=$?
  updater_fetch_origin() {
    case "$FETCH_MODE" in
      ok) return 0 ;;
      missing) return 127 ;;
      *) return 1 ;;
    esac
  }
  if [ "$once_rc" -eq 0 ] \
    && [ "$bounded_fetch_record" = "0|17 git-sentinel -C $FLYWHEEL_DIR fetch origin main --quiet" ] \
    && [ "$missing_rc" -eq 127 ] && [ "$missing_attempts" -eq 1 ] && [ "$missing_sleeps" -eq 0 ] \
    && [ "$rc" -eq 0 ] && [ "$fetch_attempts" -eq 3 ] && [ "$retry_sleeps" -eq 2 ]; then
    pass "origin fetch is bounded, retries transients, and fails fast when its runner is missing"
  else
    fail "origin fetch bounds/retry drifted (once=$once_rc record=$bounded_fetch_record missing=$missing_rc/$missing_attempts/$missing_sleeps rc=$rc attempts=$fetch_attempts sleeps=$retry_sleeps)"
  fi
else
  fail "origin fetch lacks bounded one-shot and retry seams"
fi

# FLY-2190: a custom state root may not have converged the gate yet. The
# updater must use the checked-out gate as its first-deploy fallback and pass
# the configured state root through both the gate and verify calls.
if declare -F updater_host_tmux_gate >/dev/null 2>&1; then
  gate_calls="$TMP/updater-host-tmux-gate.calls"
  mkdir -p "$FLYWHEEL_DIR/scripts"
  cat > "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh" <<'EOF'
#!/bin/bash
printf '%s|%s|%s|%s\n' "$*" "${FLYWHEEL_STATE_DIR:-}" \
  "${FLYWHEEL_HOST_TMUX_TARGET_SHA:-}" "${FLYWHEEL_HOST_TMUX_BOUND_TRANSACTION:-}" \
  >> "${UPDATER_HOST_TMUX_GATE_CALLS:?}"
exit 0
EOF
  chmod +x "$FLYWHEEL_DIR/scripts/host-tmux-selection-gate.sh"
  rm -f "$FLYWHEEL_HOME/bin/host-tmux-selection-gate.sh"
  UPDATER_HOST_TMUX_GATE_CALLS="$gate_calls" updater_host_tmux_gate
  fallback_rc=$?
  rm -rf "$FLYWHEEL_DIR/scripts"
  if [ "$fallback_rc" -eq 0 ] \
    && grep -Fqx "gate updater|$FLYWHEEL_HOME|$SHA1|updater-fast-forward:$SHA1" "$gate_calls" \
    && grep -Fqx "verify updater|$FLYWHEEL_HOME|$SHA1|updater-fast-forward:$SHA1" "$gate_calls"; then
    pass "host tmux gate falls back to checkout and preserves a custom state root"
  else
    fail "host tmux checkout fallback missing (rc=$fallback_rc calls=$(cat "$gate_calls" 2>/dev/null))"
  fi
else
  fail "updater lacks the host tmux gate seam"
fi

if declare -F updater_git_bounded >/dev/null 2>&1 \
  && declare -F updater_merge_remote >/dev/null 2>&1 \
  && declare -F updater_host_tmux_gate >/dev/null 2>&1 \
  && declare -F updater_restart_services >/dev/null 2>&1; then
  deploy_path_calls="$TMP/default-deploy-path.calls"
  : > "$deploy_path_calls"
  saved_fetch="$(declare -f updater_fetch_origin)"
  saved_bounded_git="$(declare -f updater_git_bounded)"
  saved_merge_remote="$(declare -f updater_merge_remote)"
  saved_host_tmux_gate="$(declare -f updater_host_tmux_gate)"
  saved_restart_services="$(declare -f updater_restart_services)"
  saved_pointer_guard="$(declare -f discord_pointer_cutover_required)"
	saved_auto_narrow_precheck="$(declare -f updater_auto_narrow_rollback_precheck)"
	saved_restore_premerge="$(declare -f conditional_restart_restore_premerge)"
  updater_fetch_origin() { printf 'fetch\n' >> "$deploy_path_calls"; }
  updater_git_bounded() { printf 'git|%s\n' "$*" >> "$deploy_path_calls"; }
  updater_merge_remote() { printf 'merge\n' >> "$deploy_path_calls"; }
  updater_host_tmux_gate() { printf 'host-tmux-gate\n' >> "$deploy_path_calls"; }
  updater_restart_services() { printf 'restart\n' >> "$deploy_path_calls"; }
  discord_pointer_cutover_required() { return 1; }
	updater_auto_narrow_rollback_precheck() { return 0; }
  default_deploy >/dev/null 2>&1; rc=$?
  success_calls="$(cat "$deploy_path_calls")"
  : > "$deploy_path_calls"
  updater_host_tmux_gate() { printf 'host-tmux-gate\n' >> "$deploy_path_calls"; return 42; }
  default_deploy >/dev/null 2>&1; gate_held_rc=$?
  gate_held_calls="$(cat "$deploy_path_calls")"
  : > "$deploy_path_calls"
  updater_fetch_origin() { return 127; }
  default_deploy >/dev/null 2>&1; missing_deploy_rc=$?
  missing_deploy_calls="$(cat "$deploy_path_calls")"
	: > "$deploy_path_calls"
	conditional_token="$TMP/default-deploy-conditional.urgent.json"
	jq -n --arg target "$SHA1" --arg from "$SHA1" --arg pre "$SHA1" \
	  '{schemaVersion:3,kind:"lead-closeout-restart",decisionId:"11111111-2222-4333-8444-555555555555",waveId:"wave-default-deploy",targetSha:$target,fromDeployedSha:$from,preMergeHead:$pre}' \
	  > "$conditional_token"
	UPDATER_ACTIVE_TICKET="$conditional_token"
	UPDATER_ACTIVE_WAVE_ID=wave-default-deploy
	updater_fetch_origin() { printf 'fetch\n' >> "$deploy_path_calls"; }
	updater_host_tmux_gate() { printf 'host-tmux-gate\n' >> "$deploy_path_calls"; }
	updater_restart_services() { printf 'restart-refused\n' >> "$deploy_path_calls"; return 82; }
	conditional_restart_restore_premerge() {
	  printf 'restore|%s|%s|%s\n' \
	    "${FLYWHEEL_URGENT_RESTART_TICKET:-}" \
	    "${FLYWHEEL_URGENT_RESTART_TARGET_SHA:-}" \
	    "${FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD:-}" >> "$deploy_path_calls"
	  [ "${FLYWHEEL_URGENT_RESTART_TICKET:-}" = "$conditional_token" ] \
	    && [ "${FLYWHEEL_URGENT_RESTART_TARGET_SHA:-}" = "$SHA1" ] \
	    && [ "${FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD:-}" = "$SHA1" ]
	}
	default_deploy >/dev/null 2>&1; restore_rc=$?
	restore_calls="$(cat "$deploy_path_calls")"
	UPDATER_ACTIVE_TICKET=""
	UPDATER_ACTIVE_WAVE_ID=""
	unset FLYWHEEL_URGENT_RESTART_TICKET FLYWHEEL_URGENT_RESTART_TARGET_SHA \
	  FLYWHEEL_URGENT_RESTART_FROM_SHA FLYWHEEL_URGENT_RESTART_PRE_MERGE_HEAD \
	  FLYWHEEL_URGENT_RESTART_TRIGGER_SHA FLYWHEEL_URGENT_RESTART_INDEX \
	  FLYWHEEL_URGENT_RESTART_WAVE_ID FLYWHEEL_URGENT_RESTART_NODE \
	  FLYWHEEL_URGENT_RESTART_CLI
  eval "$saved_fetch"
  eval "$saved_bounded_git"
  eval "$saved_merge_remote"
  eval "$saved_host_tmux_gate"
  eval "$saved_restart_services"
  eval "$saved_pointer_guard"
	eval "$saved_auto_narrow_precheck"
	eval "$saved_restore_premerge"
  if [ "$rc" -eq 0 ] \
    && [ "$success_calls" = $'fetch\nhost-tmux-gate\nmerge\nrestart' ] \
    && ! printf '%s\n' "$success_calls" | grep -q '^git|' \
    && [ "$gate_held_rc" -eq 3 ] \
    && [ "$gate_held_calls" = $'fetch\nhost-tmux-gate' ] \
    && [ "$missing_deploy_rc" -eq 127 ] && [ -z "$missing_deploy_calls" ] \
		&& [ "$restore_rc" -eq 82 ] \
		&& grep -Fqx "restore|$conditional_token|$SHA1|$SHA1" <<<"$restore_calls"; then
		pass "default deploy gates targets and restores refused conditional deploys with parent-shell evidence"
  else
		fail "default deploy wiring drifted (rc=$rc calls=$success_calls held=$gate_held_rc/$gate_held_calls missing=$missing_deploy_rc/$missing_deploy_calls restore=$restore_rc/$restore_calls)"
  fi
else
  fail "default deploy lacks bounded-fetch/host-gate/local-merge/restart seams"
fi

reset_case
printf '%040d\n' 0 > "$DEPLOYED_SHA_FILE"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=scheduled result=scheduled_deployed$' "$RAYA_CALLS"; then
  pass "schedule drift performs exactly one Flywheel deploy then one Raya pass"
else
  fail "schedule drift wiring changed (rc=$rc deploys=$(deploy_count) raya=$(cat "$RAYA_CALLS"))"
fi

reset_case
printf '%040d\n' 0 > "$DEPLOYED_SHA_FILE"
SELF_SHIP_DEPLOY_CMD=stub_deploy_fail update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 3 ] && [ "$(deploy_count)" = 1 ] && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=scheduled result=scheduled_failed$' "$RAYA_CALLS"; then
  pass "scheduled Flywheel deploy failure still runs Raya once without changing the cycle rc"
else
  fail "scheduled deploy failure suppressed Raya or changed rc (rc=$rc deploys=$(deploy_count) raya=$(cat "$RAYA_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_founder_direct_token founder-direct "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] \
  && [ "$(urgent_count)" = 0 ] \
  && [ ! -s "$TRANSITION_CALLS" ] \
  && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=urgent result=urgent_deployed$' "$RAYA_CALLS"; then
  pass "founder-direct v1 urgent ticket remains verdict-free, deploys once, and runs Raya once"
else
  fail "founder-direct urgent ticket regressed (rc=$rc deploys=$(deploy_count) urgent=$(urgent_count) transitions=$(cat "$TRANSITION_CALLS") raya=$(raya_count))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_founder_direct_token duplicate-a "$SHA1"
write_founder_direct_token duplicate-b "$SHA1"
write_founder_direct_token duplicate-c "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] \
  && [ "$(urgent_count)" = 0 ] \
  && [ "$(wave_duplicate_audit_count)" = 2 ] \
  && [ "$(raya_count)" = 1 ]; then
  pass "legacy duplicate founder-direct tickets coalesce into one fleet wave with one audit per duplicate"
else
  fail "legacy duplicate tickets escaped single-wave coalescing (rc=$rc deploys=$(deploy_count) urgent=$(urgent_count) audits=$(wave_duplicate_audit_count) raya=$(raya_count))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$SHA2"
write_founder_direct_token founder-direct-ancestor "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
git -C "$FLYWHEEL_DIR" update-ref refs/remotes/origin/main "$SHA1"
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] \
  && [ "$(cat "$DEPLOYED_SHA_FILE")" = "$SHA2" ] \
  && [ "$(urgent_count)" = 0 ] \
  && [ ! -s "$TRANSITION_CALLS" ] \
  && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=urgent result=urgent_deployed$' "$RAYA_CALLS"; then
  pass "founder-direct v1 accepts an ancestor target and deploys the latest main"
else
  fail "founder-direct ancestor target was dropped (rc=$rc deploys=$(deploy_count) deployed=$(cat "$DEPLOYED_SHA_FILE") urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
printf '%s\n' "$SHA1" > "$DEPLOYED_SHA_FILE"
write_token batch-a "$SHA1"
write_token batch-b "$SHA1"
before_status="$(git -C "$FLYWHEEL_DIR" status --porcelain)"
SELF_SHIP_DEPLOY_CMD=stub_deploy_observe_claim update_main >/dev/null 2>&1; rc=$?
after_status="$(git -C "$FLYWHEEL_DIR" status --porcelain)"
if [ "$rc" -eq 0 ] && [ "$(deploy_count)" = 1 ] \
  && grep -q '^call watched=0 claimed=2$' "$DEPLOY_CALLS" \
  && [ "$(urgent_count)" = 0 ] \
  && [ "$(wave_duplicate_audit_count)" = 1 ] \
  && [ "$(grep -c '^started|' "$TRANSITION_CALLS")" = 1 ] \
  && [ "$(grep -c '^succeeded|' "$TRANSITION_CALLS")" = 1 ] \
  && [ "$(raya_count)" = 1 ] \
  && grep -q '^call wake=urgent result=urgent_deployed$' "$RAYA_CALLS" \
  && [ -z "$before_status" ] && [ -z "$after_status" ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ]; then
  pass "urgent duplicates coalesce into one audited wave and one Raya pass without dirtying checkout"
else
  fail "urgent coalescing drifted (rc=$rc calls=$(cat "$DEPLOY_CALLS") urgent=$(urgent_count) audits=$(wave_duplicate_audit_count) transitions=$(cat "$TRANSITION_CALLS") raya=$(cat "$RAYA_CALLS") before=$before_status after=$after_status)"
fi

reset_case
write_token current "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_late update_main >/dev/null 2>&1; rc=$?
first_calls="$(deploy_count)"
left_after_first="$(urgent_count)"
: > "$DEPLOY_CALLS"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] \
  && [ "$first_calls" = 1 ] && [ "$left_after_first" = 0 ] \
  && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(wave_duplicate_audit_count)" = 1 ]; then
  pass "a token arriving during deploy is absorbed into the active wave instead of arming a follow-on restart"
else
  fail "late token escaped the active lifecycle window (rc=$rc/$rc2 first=$first_calls left=$left_after_first second=$(deploy_count) audits=$(wave_duplicate_audit_count))"
fi

reset_case
write_token fail-once "$SHA1"
SELF_SHIP_DEPLOY_CMD=stub_deploy_fail update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 1 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(raya_count)" = 0 ] \
  && [ "$(grep -c '^started|' "$TRANSITION_CALLS")" = 1 ] \
  && [ "$(grep -c '^failed|' "$TRANSITION_CALLS")" = 1 ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ] \
  && grep -q '^urgent-deploy-failed-fail-once.urgent.json|' "$ALERT_CALLS"; then
  pass "urgent deploy failure is claim-once, alerting, and non-retrying"
else
  fail "urgent failure retained/retried/silenced (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token source-changed "$SHA1"
VERIFY_MODE=fail
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(grep -c '^verify|' "$TRANSITION_CALLS")" = 1 ] \
  && [ "$(grep -c '^started|' "$TRANSITION_CALLS")" = 0 ] \
  && grep -q '^urgent-evidence-invalid-source-changed.urgent.json|' "$ALERT_CALLS"; then
  pass "changed source evidence is consumed and refused before one-use start"
else
  fail "changed source evidence reached deploy or lost audit (rc=$rc deploys=$(deploy_count) urgent=$(urgent_count) transitions=$(cat "$TRANSITION_CALLS") alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
updater_init_dirs
printf '{ bad json\n' > "$SELF_SHIP_URGENT_DIR/bad-json.urgent.json"
write_token wrong-kind "$SHA1" wrong-kind
write_token foreign "$FOREIGN_SHA"
printf 'junk\n' > "$SELF_SHIP_URGENT_DIR/junk.txt"
mkdir -p "$SELF_SHIP_URGENT_DIR/nested.urgent.json"
printf 'must not survive claim cleanup\n' > "$SELF_SHIP_URGENT_DIR/nested.urgent.json/child"
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_entry_count)" = 0 ] \
  && [ "$(raya_count)" = 0 ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ')" = 0 ] \
  && [ "$(grep -c '^urgent-invalid-' "$ALERT_CALLS" || true)" = 5 ]; then
  pass "provably invalid entries are removed, alerted individually, and never deploy"
else
  fail "invalid token policy drifted (rc=$rc calls=$(deploy_count) urgent=$(urgent_entry_count) claims=$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-claim.*' | wc -l | tr -d ' ') alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token claim-failure "$SHA1"
original_claim_token="$(declare -f updater_claim_token)"
updater_claim_token() { return 1; }
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
eval "$original_claim_token"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(raya_count)" = 0 ] \
  && [ "$(urgent_count)" = 1 ] \
  && grep -q '^urgent-claim-failed-claim-failure.urgent.json|' "$ALERT_CALLS"; then
  pass "urgent claim failure never authorizes a Raya pass"
else
  fail "urgent claim failure leaked into Raya (rc=$rc deploys=$(deploy_count) raya=$(cat "$RAYA_CALLS") urgent=$(urgent_count))"
fi

reset_case
write_token hold-on-fetch "$SHA1"
FETCH_MODE=fail
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(raya_count)" = 0 ] \
  && grep -q '^urgent-probe-indeterminate-hold-on-fetch.urgent.json|' "$ALERT_CALLS"; then
  pass "indeterminate fetch failure consumes the claim once and cannot relaunch QueueDirectories"
else
  fail "indeterminate fetch token retried, deployed, or went silent (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token missing-bounded-runner "$SHA1"
FETCH_MODE=missing
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 127 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(raya_count)" = 0 ] \
  && grep -q '^urgent-probe-runtime-missing-missing-bounded-runner.urgent.json|' "$ALERT_CALLS"; then
  pass "missing bounded runner is fail-fast and reported without blaming the network"
else
  fail "missing bounded runner was misclassified (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token probe-error "$SHA1"
original_target_state="$(declare -f updater_token_target_state)"
updater_token_target_state() { printf 'indeterminate\n'; }
SELF_SHIP_DEPLOY_CMD=stub_deploy_ok update_main >/dev/null 2>&1; rc=$?
eval "$original_target_state"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] && [ "$(urgent_count)" = 0 ] \
  && [ "$(raya_count)" = 0 ] \
  && grep -q '^urgent-probe-indeterminate-probe-error.urgent.json|' "$ALERT_CALLS"; then
  pass "indeterminate ancestry probe consumes the claim once and cannot wedge later tickets"
else
  fail "indeterminate probe token retried, deployed, or went silent (rc=$rc calls=$(deploy_count) urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
write_token signal-before-probe-alert "$SHA1"
FETCH_MODE=fail
original_urgent_alert="$(declare -f updater_alert_urgent)"
signal_before_alert=1
updater_alert_urgent() {
  if [ "$1" = probe-indeterminate ] && [ "$signal_before_alert" -eq 1 ]; then
    signal_before_alert=0
    updater_signal_cleanup
  fi
  severe_alert "$(updater_urgent_signature "$1" "$2")" "$3"
}
( update_main ) >/dev/null 2>&1; rc=$?
eval "$original_urgent_alert"
if [ "$rc" -eq 130 ] && [ "$(urgent_count)" = 0 ] \
  && grep -q '^urgent-interrupted-signal-before-probe-alert.urgent.json|' "$ALERT_CALLS"; then
  pass "signal between indeterminate claim and primary alert gets interrupted-ticket coverage"
else
  fail "indeterminate claim-to-alert signal window was silent (rc=$rc urgent=$(urgent_count) alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
UPDATER_CLAIMED=1
UPDATER_COMPLETED=1
UPDATER_ALERTED=1
UPDATER_CLAIMED_BASENAMES=(existing.urgent.json)
updater_alert_consumed_no_deploy invalid consumed.urgent.json test >/dev/null 2>&1
if [ "$UPDATER_CLAIMED" -eq 1 ] && [ "$UPDATER_COMPLETED" -eq 1 ] \
  && [ "$UPDATER_ALERTED" -eq 1 ] \
  && [ "${UPDATER_CLAIMED_BASENAMES[*]-}" = existing.urgent.json ]; then
  pass "consumed-ticket alert helper restores the caller's claim state"
else
  fail "consumed-ticket helper clobbered claim state (${UPDATER_CLAIMED}/${UPDATER_COMPLETED}/${UPDATER_ALERTED}/${UPDATER_CLAIMED_BASENAMES[*]-})"
fi

reset_case
updater_init_dirs
claim_dir="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")"
watched_device="$(stat -c %d "$SELF_SHIP_URGENT_DIR" 2>/dev/null || stat -f %d "$SELF_SHIP_URGENT_DIR")"
claim_device="$(stat -c %d "$claim_dir" 2>/dev/null || stat -f %d "$claim_dir")"
case "$claim_dir" in "$FLYWHEEL_DIR"/*) inside_repo=1 ;; *) inside_repo=0 ;; esac
rm -rf "$claim_dir"
if [ "$watched_device" = "$claim_device" ] && [ "$inside_repo" -eq 0 ]; then
  pass "claim directory is on the watched device and outside the git checkout"
else
  fail "claim directory placement is unsafe (watched=$watched_device claim=$claim_device path=$claim_dir)"
fi

reset_case
UPDATER_CLAIM_DIR="$(mktemp -d "${FLYWHEEL_HOME}/.urgent-claim.XXXXXX")"
printf '{}\n' > "$UPDATER_CLAIM_DIR/interrupted.urgent.json"
mkdir -p "$RAYA_DEPLOY_LOCK_DIR"
printf '%s\n' "$$" > "$RAYA_DEPLOY_LOCK_DIR/pid"
RAYA_LOCK_OWNED=1
UPDATER_CLAIMED=1
UPDATER_COMPLETED=0
UPDATER_ALERTED=0
UPDATER_CLEANUP_DONE=0
UPDATER_CLAIMED_BASENAMES=(interrupted.urgent.json)
( updater_signal_cleanup ) >/dev/null 2>&1
signal_rc=$?
if [ "$signal_rc" -eq 130 ] && [ ! -e "$UPDATER_CLAIM_DIR" ] \
  && [ ! -e "$RAYA_DEPLOY_LOCK_DIR" ] \
  && grep -q '^urgent-interrupted-interrupted.urgent.json|' "$ALERT_CALLS"; then
  pass "TERM/INT cleanup releases the Raya lock and alerts for incomplete urgent intent"
else
  fail "signal cleanup lost the Raya lock or at-most-once warning (rc=$signal_rc claim_dir=$([ -e "$UPDATER_CLAIM_DIR" ] && echo yes || echo no) raya_lock=$([ -e "$RAYA_DEPLOY_LOCK_DIR" ] && echo yes || echo no) alerts=$(cat "$ALERT_CALLS"))"
fi
RAYA_LOCK_OWNED=0

reset_case
mkdir -p "$SELF_SHIP_LOCK_DIR"
printf '12345\n' > "$SELF_SHIP_LOCK_DIR/pid"
printf 'update-flywheel\n' > "$SELF_SHIP_LOCK_DIR/ident"
updater_pid_alive() { return 0; }
updater_pid_command() { printf '/bin/bash /repo/scripts/update-flywheel.sh\n'; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 75 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = 12345 ]; then
  pass "live identity-matching lock is never reclaimed"
else
  fail "live matching lock was reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi

updater_pid_command() { return 1; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 75 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = 12345 ]; then
  pass "live uninspectable lock is never reclaimed"
else
  fail "live uninspectable lock was reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi

updater_pid_command() { printf '/usr/bin/unrelated-process\n'; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = "$$" ]; then
  pass "live inspectable PID reuse is reclaimed"
else
  fail "PID reuse was not reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi
updater_lock_release

mkdir -p "$SELF_SHIP_LOCK_DIR"
printf '12345\n' > "$SELF_SHIP_LOCK_DIR/pid"
updater_pid_alive() { return 1; }
updater_lock_acquire update-flywheel >/dev/null 2>&1; rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$SELF_SHIP_LOCK_DIR/pid")" = "$$" ]; then
  pass "dead-owner stale lock is reclaimed"
else
  fail "dead lock was not reclaimed (rc=$rc owner=$(cat "$SELF_SHIP_LOCK_DIR/pid" 2>/dev/null))"
fi
updater_lock_release

reset_case
original_lock_writer="$(declare -f _updater_lock_write_owner)"
_updater_lock_write_owner() { return 1; }
lock_output="$(update_main 2>&1)"; rc=$?
eval "$original_lock_writer"
if [ "$rc" -ne 0 ] && [ "$(deploy_count)" = 0 ] \
  && [[ "$lock_output" == *"could not persist singleton lock owner"* ]] \
  && grep -q '^lock-state-failed-scheduled-' "$ALERT_CALLS"; then
  pass "lock owner write failure is fail-loud and distinct from live contention"
else
  fail "lock state failure was reported as benign contention (rc=$rc calls=$(deploy_count) output=$lock_output alerts=$(cat "$ALERT_CALLS"))"
fi

reset_case
original_init_dirs="$(declare -f updater_init_dirs)"
updater_init_dirs() { return 1; }
init_output="$(update_main 2>&1)"; rc=$?
eval "$original_init_dirs"
if [ "$rc" -eq 1 ] && [ "$(deploy_count)" = 0 ] \
  && [[ "$init_output" == *"could not initialize updater state directories"* ]] \
  && grep -q '^init-failed-scheduled-' "$ALERT_CALLS"; then
  pass "state-directory initialization failure is independently alerted"
else
  fail "state-directory initialization failure became silent (rc=$rc calls=$(deploy_count) output=$init_output alerts=$(cat "$ALERT_CALLS"))"
fi

# Exercise the real durable dedup implementation with every output/state seam
# redirected to the sandbox and curl shadowed before any production PATH entry.
ALERT_BIN="$TMP/alert-bin"
mkdir -p "$ALERT_BIN" "$TMP/alert-home"
cat > "$ALERT_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '204'
EOF
chmod +x "$ALERT_BIN/curl"
export FLYWHEEL_CLAIMS_DB="$TMP/alert-home/claims.db"
export FLYWHEEL_ALERT_QUEUE_DIR="$TMP/alert-home/queue"
export FLYWHEEL_ALERT_DEADLETTER_DIR="$TMP/alert-home/deadletter"
export FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=sandbox-channel
export FLYWHEEL_ALERT_SENDER_TOKEN_ENV=FLY1959_FAKE_TOKEN
export FLY1959_FAKE_TOKEN=sandbox-token

send_real_alert() {
  local signature="$1"
  PATH="$ALERT_BIN:$PATH" HOME="$TMP/alert-home" \
    "$ROOT/scripts/lead-alert.sh" --project flywheel --lead updater \
      --kind deploy_failed --severity severe --title test --body test \
      --signature "$signature" --strict-delivery >/dev/null 2>&1
}

rm -f "$FLYWHEEL_CLAIMS_DB"
sig_same="$(updater_urgent_signature deploy-failed same.urgent.json)"
sig_other="$(updater_urgent_signature deploy-failed other.urgent.json)"
send_real_alert "$sig_same"
send_real_alert "$sig_same"
send_real_alert "$sig_other"
urgent_receipts="$(sqlite3 "$FLYWHEEL_CLAIMS_DB" "select count(*) from alert_deliveries where state='sent';")"
UPDATER_UTC_DAY=20260821
sig_day1="$(updater_scheduled_signature deploy-failed)"
send_real_alert "$sig_day1"
send_real_alert "$sig_day1"
UPDATER_UTC_DAY=20260822
sig_day2="$(updater_scheduled_signature deploy-failed)"
send_real_alert "$sig_day2"
all_receipts="$(sqlite3 "$FLYWHEEL_CLAIMS_DB" "select count(*) from alert_deliveries where state='sent';")"
if [ "$urgent_receipts" = 2 ] && [ "$all_receipts" = 4 ] \
  && [ "$sig_same" != "$sig_other" ] && [ "$sig_day1" != "$sig_day2" ]; then
  pass "real lead-alert dedups one urgent ticket/day and preserves new ticket/day alerts"
else
  fail "real alert dedup drifted (urgent=$urgent_receipts all=$all_receipts sigs=$sig_same/$sig_other/$sig_day1/$sig_day2)"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
