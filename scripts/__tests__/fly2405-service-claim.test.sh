#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_ROOT=$(mktemp -d /tmp/fly2405-claims.XXXXXX)
trap 'rm -rf "$TEST_ROOT"' EXIT
failures=0
check() {
  if ( "$@" ); then printf 'PASS: %s\n' "$*";
  else printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); fi
}
source "$ROOT/scripts/lib/qa-multilead.sh"
[[ ! -f "$ROOT/scripts/lib/qa-slot-claim.sh" ]] || source "$ROOT/scripts/lib/qa-slot-claim.sh"

# Exercise production functions without loading real slot credentials or
# performing global deploy/teardown setup. Rewrite only fixture coordinates.
python3 - "$ROOT" "$TEST_ROOT" <<'PY'
import pathlib, re, sys
root, temp = map(pathlib.Path, sys.argv[1:])
out = ''
for file, names in [('test-deploy.sh', ['claim_slot', 'cleanup_on_failure']),
                    ('test-teardown.sh', ['teardown_slot', 'test_teardown_main'])]:
    text = (root / 'scripts' / file).read_text()
    for name in names:
        found = re.search(r'^' + name + r'\(\) \{\n.*?^\}', text, re.M | re.S)
        assert found, name
        out += found.group() + '\n'
text = (root / 'scripts/test-deploy.sh').read_text()
start = text.index('if ! MAIN_LEAD_SHAPE=')
end = text.index('\nfi', start) + 3
out += 'early_deploy_failure() {\n' + text[start:end] + '\n}\n'
out = out.replace('/tmp/flywheel-test-slot-', str(temp) + '/flywheel-test-slot-')
out = out.replace('${HOME}', '${TEST_ROOT}/fake-home')
out = out.replace('qa_slot_teardown_claims "$SLOT"', 'qa_slot_teardown_claims "$SLOT" "$TEST_ROOT"')
out = out.replace('qa_slot_teardown_claims "$target"', 'qa_slot_teardown_claims "$target" "$TEST_ROOT"')
out = out.replace('"$CAMPAIGN_MANIFEST" "/tmp"', '"$CAMPAIGN_MANIFEST" "$TEST_ROOT"')
(temp / 'functions.sh').write_text(out)
PY
source "$TEST_ROOT/functions.sh"
SCRIPT_DIR="$TEST_ROOT/stub-scripts"
mkdir -p "$SCRIPT_DIR"
export TEST_ROOT
cat > "$SCRIPT_DIR/test-teardown.sh" <<'STUB'
echo stale >> "$TEST_ROOT/stale"
rm -rf "$TEST_ROOT/flywheel-test-slot-$1.lock"
STUB
log() { printf '%s\n' "$*" >> "$TEST_ROOT/log"; }
service_claim() {
  local slot="$1" token="${2:-owner}" pid="${3:-claiming}"
  local slots="${4:-[$slot]}"
  mkdir -p "$TEST_ROOT/flywheel-test-slot-$slot.lock"
  jq -n --arg token "$token" --argjson slots "$slots" \
    '{room_id:"fixture-room",claim_token:$token,slots:$slots}' \
    > "$TEST_ROOT/flywheel-test-slot-$slot.lock/service-claim"
  chmod 600 "$TEST_ROOT/flywheel-test-slot-$slot.lock/service-claim"
  printf '%s\n' "$pid" > "$TEST_ROOT/flywheel-test-slot-$slot.lock/pid"
}
stale_teardown() { echo stale >> "$TEST_ROOT/stale"; rm -rf "$TEST_ROOT/flywheel-test-slot-$1.lock"; }
claim_matching() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  for marker in claiming 99999999 service-failed service-cleaned; do
    service_claim 1 owner "$marker"
    claim_slot 1 && qa_multilead_claim_one "$TEST_ROOT/flywheel-test-slot-1.lock" stale_teardown 1 || return 1
    [[ "$(cat "$TEST_ROOT/flywheel-test-slot-1.lock/pid")" == "$marker" ]] || return 1
  done
}
check claim_matching
claim_mismatch() {
  rm -f "$TEST_ROOT/stale"
  for token in '' foreign; do
    export FLYWHEEL_QA_ROOM_CLAIM="$token"
    for marker in claiming 99999999 service-failed service-cleaned; do
      service_claim 2 owner "$marker"
      touch -t 200001010000 "$TEST_ROOT/flywheel-test-slot-2.lock/pid"
      if claim_slot 2 || qa_multilead_claim_one "$TEST_ROOT/flywheel-test-slot-2.lock" stale_teardown 2; then return 1; fi
      [[ "$(cat "$TEST_ROOT/flywheel-test-slot-2.lock/pid")" == "$marker" ]] || return 1
    done
  done
  [[ ! -e "$TEST_ROOT/stale" ]]
}
check claim_mismatch
markers_without_sidecar() {
  unset FLYWHEEL_QA_ROOM_CLAIM
  rm -f "$TEST_ROOT/stale"
  for marker in service-failed service-cleaned; do
    mkdir -p "$TEST_ROOT/flywheel-test-slot-3.lock"
    printf '%s\n' "$marker" > "$TEST_ROOT/flywheel-test-slot-3.lock/pid"
    if claim_slot 3 || qa_multilead_claim_one "$TEST_ROOT/flywheel-test-slot-3.lock" stale_teardown 3; then return 1; fi
  done
  [[ ! -e "$TEST_ROOT/stale" ]]
}
check markers_without_sidecar
campaign_rollback() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  service_claim 10 owner claiming '[10,11,12]'
  service_claim 12 foreign claiming '[10,11,12]'
  if qa_multilead_claim_set "$TEST_ROOT" stale_teardown 10 11 12 > "$TEST_ROOT/claims"; then return 1; fi
  [[ -f "$TEST_ROOT/flywheel-test-slot-10.lock/service-claim" \
    && ! -e "$TEST_ROOT/flywheel-test-slot-11.lock" \
    && -f "$TEST_ROOT/flywheel-test-slot-12.lock/service-claim" ]]
}
check campaign_rollback
campaign_adoption() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  service_claim 14 owner claiming '[14,15]'
  service_claim 15 owner claiming '[14,15]'
  qa_multilead_claim_set "$TEST_ROOT" stale_teardown 15 14 > "$TEST_ROOT/adopted" || return 1
  [[ "$(cat "$TEST_ROOT/adopted")" == "$(printf '%s\n' "$TEST_ROOT/flywheel-test-slot-14.lock" "$TEST_ROOT/flywheel-test-slot-15.lock")" ]]
}
check campaign_adoption
malformed_claim() {
  declare -F qa_release_slot_lock >/dev/null || return 1
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  service_claim 13
  echo invalid > "$TEST_ROOT/flywheel-test-slot-13.lock/service-claim"
  if claim_slot 13 || qa_multilead_claim_one "$TEST_ROOT/flywheel-test-slot-13.lock" stale_teardown 13; then return 1; fi
  qa_release_slot_lock "$TEST_ROOT/flywheel-test-slot-13.lock" && return 1
  [[ -d "$TEST_ROOT/flywheel-test-slot-13.lock" ]]
}
check malformed_claim
deploy_cleanup() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  SLOT=20 SLOT_DIR="$TEST_ROOT/flywheel-test-slot-20" CAMPAIGN_SLOT_IDS=(20 21)
  service_claim 20 owner claiming '[20,21]'
  service_claim 21 owner claiming '[20,21]'
  qa_slot_evidence_allows_release() { return 0; }
  cleanup_on_failure
  for s in 20 21; do
    [[ -f "$TEST_ROOT/flywheel-test-slot-$s.lock/service-claim" \
      && "$(cat "$TEST_ROOT/flywheel-test-slot-$s.lock/pid")" == service-failed ]] || return 1
  done
  service_claim 20 owner 987654 '[20,21]'
  GENERALIZED_READINESS_PENDING=1
  qa_generalized_invalidate_room_info() { return 0; }
  cleanup_on_failure
  [[ "$(cat "$TEST_ROOT/flywheel-test-slot-20.lock/pid")" == service-failed ]]
}
check deploy_cleanup
deploy_failed_stop() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  SLOT=24 SLOT_DIR="$TEST_ROOT/flywheel-test-slot-24" CAMPAIGN_SLOT_IDS=(24 25)
  service_claim 24 owner claiming '[24,25]'
  service_claim 25 owner 987654 '[24,25]'
  QA_LEAD_REGISTRY="$TEST_ROOT/failed-stop.json"
  echo '[]' > "$QA_LEAD_REGISTRY"
  qa_launchd_stop_registry() { return 1; }
  qa_slot_evidence_allows_release() { return 0; }
  cleanup_on_failure
  for s in 24 25; do
    [[ -f "$TEST_ROOT/flywheel-test-slot-$s.lock/service-claim" \
      && "$(cat "$TEST_ROOT/flywheel-test-slot-$s.lock/pid")" == service-failed ]] || return 1
  done
}
check deploy_failed_stop
early_failure() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  SLOT=22 SLOT_IDX=21 SLOT_BACKEND=bad SLOT_RETIRED_CODEX_SOURCE_HOME='' SLOT_CODEX_PROFILE=''
  service_claim 22
  ( early_deploy_failure ) && return 1
  [[ -f "$TEST_ROOT/flywheel-test-slot-22.lock/service-claim" \
    && "$(cat "$TEST_ROOT/flywheel-test-slot-22.lock/pid")" == service-failed ]]
}
check early_failure
manual_and_foreign_release() {
  declare -F qa_release_slot_lock >/dev/null || return 1
  unset FLYWHEEL_QA_ROOM_CLAIM
  mkdir -p "$TEST_ROOT/manual.lock"
  qa_release_slot_lock "$TEST_ROOT/manual.lock" && [[ ! -d "$TEST_ROOT/manual.lock" ]] || return 1
  service_claim 23
  if qa_release_slot_lock "$TEST_ROOT/flywheel-test-slot-23.lock"; then return 1; fi
  [[ "$(cat "$TEST_ROOT/flywheel-test-slot-23.lock/pid")" == claiming ]]
}
check manual_and_foreign_release

# Runtime commands are stubs; all paths inside teardown are fixture-local.
TEARDOWN_SCRIPT_DIR="$ROOT/scripts"
qa_launchd_require_tmux_bin() { return 0; }
qa_slot_bridge_guard_acquire() { echo guard >> "$TEST_ROOT/effects"; }
qa_slot_bridge_guard_release() { return 0; }
qa_slot_bridge_live_cycle_holder() { return 1; }
qa_launchd_stop_registry() { echo stop >> "$TEST_ROOT/effects"; return 0; }
qa_multilead_teardown_extra_leads() { echo extra >> "$TEST_ROOT/effects"; [[ "${FAIL_EXTRA:-0}" == 0 ]]; }
qa_generalized_reap_codex_stub_orphans() { return 0; }
qa_archive_slot_isolation_evidence() { return 0; }
prune_trust_entries() { return 0; }
prune_codex_workspace_trust_prefix() { return 0; }
tmux() { return 1; }
pgrep() { return 1; }
lsof() { return 1; }
node() { [[ "$1" != *qa-reap-codex-slot-daemons.mjs || "${FAIL_REAP:-0}" == 0 ]]; }
campaign_fixture() {
  service_claim 30 owner claiming '[30,31]'
  service_claim 31 "${1:-owner}" claiming '[30,31]'
  mkdir -p "$TEST_ROOT/flywheel-test-slot-30"
  echo '{"borrowedSlots":[31],"extraLeads":[]}' > "$TEST_ROOT/flywheel-test-slot-30/campaign-manifest.json"
  echo '{"ownerSlot":30,"borrowed":true}' > "$TEST_ROOT/flywheel-test-slot-31.lock/campaign.json"
  rm -f "$TEST_ROOT/effects"
}
teardown_mismatch() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture foreign
  if teardown_slot 30 2> "$TEST_ROOT/mismatch.err"; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" && -f "$TEST_ROOT/flywheel-test-slot-30/campaign-manifest.json" ]] || return 1
  grep -q claim_mismatch "$TEST_ROOT/mismatch.err" || return 1
  service_claim 30 foreign
  if teardown_slot 30; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" ]]
}
check teardown_mismatch
teardown_retries() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture
  FAIL_EXTRA=1
  if teardown_slot 30; then return 1; fi
  [[ -f "$TEST_ROOT/flywheel-test-slot-31.lock/service-claim" ]] || return 1
  FAIL_EXTRA=0 FAIL_REAP=1
  if teardown_slot 30; then return 1; fi
  [[ -f "$TEST_ROOT/flywheel-test-slot-31.lock/service-claim" \
    && -f "$TEST_ROOT/flywheel-test-slot-30/campaign-manifest.json" ]] || return 1
  FAIL_REAP=0
  teardown_slot 30 || return 1
  for s in 30 31; do
    [[ -f "$TEST_ROOT/flywheel-test-slot-$s.lock/service-claim" \
      && "$(cat "$TEST_ROOT/flywheel-test-slot-$s.lock/pid")" == service-cleaned ]] || return 1
  done
  [[ ! -d "$TEST_ROOT/flywheel-test-slot-30" ]] || return 1
  rm -f "$TEST_ROOT/effects"
  teardown_slot 30 && [[ ! -e "$TEST_ROOT/effects" ]]
}
check teardown_retries
teardown_marker_retry() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture
  eval "$(declare -f qa_release_slot_lock | sed '1s/qa_release_slot_lock/real_qa_release_slot_lock/')"
  qa_release_slot_lock() {
    [[ "$1" != *slot-31.lock || "${FAIL_MARKER:-0}" != 1 ]] || return 1
    real_qa_release_slot_lock "$@"
  }
  FAIL_MARKER=1
  if teardown_slot 30; then return 1; fi
  [[ ! -d "$TEST_ROOT/flywheel-test-slot-30" \
    && "$(cat "$TEST_ROOT/flywheel-test-slot-30.lock/pid")" == service-cleaned \
    && "$(cat "$TEST_ROOT/flywheel-test-slot-31.lock/pid")" == claiming ]] || return 1
  FAIL_MARKER=0
  teardown_slot 30 && [[ "$(cat "$TEST_ROOT/flywheel-test-slot-31.lock/pid")" == service-cleaned ]]
}
check teardown_marker_retry
teardown_before_manifest() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture
  rm "$TEST_ROOT/flywheel-test-slot-30/campaign-manifest.json"
  teardown_slot 30 && [[ "$(cat "$TEST_ROOT/flywheel-test-slot-31.lock/pid")" == service-cleaned ]]
}
check teardown_before_manifest
teardown_claim_metadata_mismatch() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture
  service_claim 31 owner claiming '[31]'
  if teardown_slot 30; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" ]] || return 1
  service_claim 31 owner claiming '[30,31]'
  jq '.room_id = "foreign-room"' "$TEST_ROOT/flywheel-test-slot-31.lock/service-claim" > "$TEST_ROOT/foreign.json"
  mv "$TEST_ROOT/foreign.json" "$TEST_ROOT/flywheel-test-slot-31.lock/service-claim"
  if teardown_slot 30; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" ]] || return 1
  campaign_fixture
  jq 'del(.slots)' "$TEST_ROOT/flywheel-test-slot-30.lock/service-claim" > "$TEST_ROOT/no-slots.json"
  mv "$TEST_ROOT/no-slots.json" "$TEST_ROOT/flywheel-test-slot-30.lock/service-claim"
  if teardown_slot 30; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" ]]
}
check teardown_claim_metadata_mismatch
manual_teardown() {
  unset FLYWHEEL_QA_ROOM_CLAIM
  mkdir -p "$TEST_ROOT/flywheel-test-slot-40.lock" "$TEST_ROOT/flywheel-test-slot-40"
  teardown_slot 40 && [[ ! -d "$TEST_ROOT/flywheel-test-slot-40.lock" && ! -d "$TEST_ROOT/flywheel-test-slot-40" ]]
}
check manual_teardown
manual_campaign_teardown() {
  unset FLYWHEEL_QA_ROOM_CLAIM
  campaign_fixture
  rm "$TEST_ROOT/flywheel-test-slot-30.lock/service-claim" "$TEST_ROOT/flywheel-test-slot-31.lock/service-claim"
  if teardown_slot 31; then return 1; fi
  [[ -d "$TEST_ROOT/flywheel-test-slot-31.lock" ]] || return 1
  teardown_slot 30 && [[ ! -d "$TEST_ROOT/flywheel-test-slot-30.lock" && ! -d "$TEST_ROOT/flywheel-test-slot-31.lock" ]]
}
check manual_campaign_teardown
teardown_entry_mismatch() {
  export FLYWHEEL_QA_ROOM_CLAIM=owner
  campaign_fixture foreign
  CMUX_MAINTENANCE_MARKER="$TEST_ROOT/no-marker" CMUX_OPS_REBUILD_CLAIM="$TEST_ROOT/no-ops"
  acquire_cmux_qa_teardown_claim() { echo cmux >> "$TEST_ROOT/effects"; return 1; }
  if test_teardown_main 30; then return 1; fi
  [[ ! -e "$TEST_ROOT/effects" ]]
}
check teardown_entry_mismatch
if rg 'rm -rf "(/tmp/flywheel-test-slot-.*\.lock|\$(lock|xlock))"' "$ROOT/scripts/test-deploy.sh"; then
  echo 'FAIL: deploy contains a direct slot-lock removal' >&2
  failures=$((failures + 1))
fi
printf 'FLY-2405 service claims: %s failure(s)\n' "$failures"
[[ "$failures" == 0 ]]
