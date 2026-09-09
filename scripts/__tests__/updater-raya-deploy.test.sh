#!/usr/bin/env bash
# FLY-2445: the updater may deploy Raya only through the standard Lead carrier.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2445-updater.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }
expect_eq() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$label"; else
    fail "$label (expected=$expected actual=$actual)"
  fi
}

export UPDATE_FLYWHEEL_SOURCED=1
export HOME="$TMP/home"
export FLYWHEEL_HOME="$HOME/.flywheel"
export RAYA_HOME="$FLYWHEEL_HOME/raya"
export RAYA_CODE_DIR="$RAYA_HOME/code"
export RAYA_DEPLOYED_SHA_FILE="$RAYA_HOME/deployed-sha"
export RAYA_DEPLOY_RECEIPT="$RAYA_HOME/deploy-receipt.json"
export RAYA_DEPLOY_LOCK_DIR="$RAYA_HOME/deploy.lock.d"
export RAYA_CANONICAL_MANIFEST="$FLYWHEEL_HOME/manifests/raya-raya.json"
export RAYA_MIGRATION_MANIFEST="$RAYA_HOME/migrations/fly-2445-test/manifest.json"
export RAYA_STANDARD_PROOF_FILE="$RAYA_HOME/migrations/fly-2445-test/proof.json"
export RAYA_STANDARD_MIGRATION_LIB="$ROOT/scripts/lib/raya-standard-migration.sh"
mkdir -p "$(dirname "$RAYA_CANONICAL_MANIFEST")" "$(dirname "$RAYA_MIGRATION_MANIFEST")" \
  "$RAYA_CODE_DIR" "$HOME/Dev/raya-lead-workspace"

# shellcheck source=/dev/null
source "$ROOT/scripts/lib/updater-raya-deploy.sh"
raya_configure_runtime_paths

write_canonical() {
  jq -n --arg root "$HOME/Dev/raya-lead-workspace" '{
    projectName:"raya", leadId:"raya", projectDir:$root,
    leadBackend:{backendId:"codex-app-server"}
  }' > "$RAYA_CANONICAL_MANIFEST"
  chmod 600 "$RAYA_CANONICAL_MANIFEST"
}

write_p2_manifest() {
  local unresolved="${1:-[]}" cursor="$TMP/inbound-cursor.json" seed="$TMP/seed.json"
  printf '%s\n' '{"schemaVersion":1}' > "$seed"
  chmod 600 "$seed"
  jq -n \
    --arg migration "fly-2445-test" \
    --arg cursor "$cursor" --arg seed "$seed" --argjson unresolved "$unresolved" '{
      schemaVersion:1, migration_id:$migration, checkpoint:"P2",
      unresolved:$unresolved,
      cursor:{path:$cursor,seed_input:$seed,status:null,sha256:null}
    }' > "$RAYA_MIGRATION_MANIFEST"
  chmod 600 "$RAYA_MIGRATION_MANIFEST"
}

write_p6_manifest() {
  local raya_sha="${1:-${frozen_raya:-1111111111111111111111111111111111111111}}"
  local flywheel_sha="${2:-2222222222222222222222222222222222222222}"
  local manifest_digest=""
  manifest_digest="$(shasum -a 256 "$RAYA_CANONICAL_MANIFEST" | awk '{print $1}')"
  printf '%s\n' "$flywheel_sha" > "$FLYWHEEL_DEPLOYED_SHA_FILE"
  chmod 600 "$FLYWHEEL_DEPLOYED_SHA_FILE"
  jq -n \
    --arg migration "fly-2445-test" --arg raya "$raya_sha" --arg flywheel "$flywheel_sha" \
    --arg manifest "$manifest_digest" --arg workspace "$HOME/Dev/raya-lead-workspace" \
    --arg artifact "$RAYA_ARTIFACT_DIGEST" --arg persona "$RAYA_PERSONA_DIGEST" '{
      schemaVersion:1, migration_id:$migration, checkpoint:"P6", unresolved:[],
      flywheel_deployed_sha:$flywheel, raya_sha:$raya,
      registry_digest:("a"*64), summary_receipt_digest:("b"*64),
      canonical_manifest_digest:$manifest,
      artifact:{digest:$artifact,persona_digest:$persona,workspace:$workspace,state_schema_version:1},
      cursor:{status:"seeded",sha256:("9"*64)},
      lead:{project:"raya",id:"raya",key:"raya-raya",identity_digest:("f"*64),
        registry_digest:("a"*64),summary_receipt_digest:("b"*64),manifest_digest:$manifest,
        pid:4321,process_started_at:"2026-09-08T10:00:00Z",activation_id:"activation-1",
        thread_id:"thread-1",tui_visible:true},
      business:{source_sha:$raya,artifact_digest:$artifact,persona_digest:$persona,
        workspace:$workspace,state_schema_version:1},
      checks:{preflight:true,unique_owner:true,pump:true,text_delivery_id:"chat:raya:100",
        outbound_message_id:"200",summary_round_id:"round-1",summary_delivery_id:"summary:1",
        mailbox_acked:true,bridge_sent:true,bridge_identity_verified:true,
        alert_channel_id:"300",alert_delivery_id:"400",alert_reachable:true},
      cutover:{seed_digest:("9"*64),seeded_at:"2026-09-08T09:58:00Z",
        old_stopped_at:"2026-09-08T09:59:00Z",activated_at:"2026-09-08T10:00:00Z",
        activation_id:"activation-1",channels:[{channel_id:"500",seeded_after:"600"}],
        window_message_id:"700",window_delivery_id:"chat:raya:700",
        window_outbound_message_id:"800",unresolved_count:0}
    }' > "$RAYA_MIGRATION_MANIFEST"
  chmod 600 "$RAYA_MIGRATION_MANIFEST"
}

write_canonical
if raya_host_capable; then pass "canonical codex-app-server manifest enables the Raya shuttle"; else
  fail "canonical codex-app-server manifest enables the Raya shuttle"
fi
jq '.leadBackend.backendId="claude-code"' "$RAYA_CANONICAL_MANIFEST" > "$TMP/wrong.json"
mv "$TMP/wrong.json" "$RAYA_CANONICAL_MANIFEST"
chmod 600 "$RAYA_CANONICAL_MANIFEST"
if raya_host_capable; then fail "non-standard Raya carrier is not host capability"; else
  pass "non-standard Raya carrier is not host capability"
fi
write_canonical

python3 - "$TMP/foreign.plist" "$RAYA_CODE_DIR/apps/brain/dist/cli.js" "$RAYA_CODE_DIR" <<'PY'
import plistlib, sys
path, cli, cwd = sys.argv[1:]
with open(path, "wb") as handle:
    plistlib.dump({
        "Label": "com.example.foreign",
        "ProgramArguments": ["/usr/bin/node", cli, "run"],
        "WorkingDirectory": cwd,
        "EnvironmentVariables": {"RAYA_ENV_FILE": "foreign"},
    }, handle)
PY
if raya_legacy_plist_matches "$TMP/foreign.plist" brain com.xrli.raya.brain; then
  fail "legacy quiesce must refuse a foreign launchd identity"
else
  pass "legacy quiesce refuses a foreign launchd identity"
fi

mkdir -p "$RAYA_CODE_DIR/.lead/raya" "$RAYA_CODE_DIR/packages/cos/dist" \
  "$RAYA_CODE_DIR/packages/cos/node_modules" "$RAYA_WORKSPACE/memory" "$RAYA_WORKSPACE/state"
printf 'raya persona\n' > "$RAYA_CODE_DIR/.lead/raya/identity.md"
printf 'console.log("cos")\n' > "$RAYA_CODE_DIR/packages/cos/dist/cli.js"
printf '%s\n' '{"name":"@raya/cos","type":"module"}' > "$RAYA_CODE_DIR/packages/cos/package.json"
printf 'must not deploy\n' > "$RAYA_CODE_DIR/packages/cos/node_modules/private-cache"
printf 'memory stays\n' > "$RAYA_WORKSPACE/memory/MEMORY.md"
printf 'state stays\n' > "$RAYA_WORKSPACE/state/business.json"
RAYA_NEW_HEAD="1111111111111111111111111111111111111111"
if raya_materialize_business; then pass "materializes the bounded Raya business artifact"; else
  fail "materializes the bounded Raya business artifact"
fi
version="$RAYA_WORKSPACE/.flywheel-managed/versions/$RAYA_NEW_HEAD"
if [[ -f "$version/packages/cos/dist/cli.js" \
  && -f "$version/packages/cos/package.json" \
  && ! -e "$version/packages/cos/node_modules" \
  && "$(cat "$RAYA_WORKSPACE/memory/MEMORY.md")" == "memory stays" \
  && "$(cat "$RAYA_WORKSPACE/state/business.json")" == "state stays" ]]; then
  pass "artifact export excludes install caches and preserves memory/state"
else
  fail "artifact export must contain only the managed build and preserve memory/state"
fi
if raya_materialize_business; then
  pass "artifact projection is restart-idempotent before the first receipt"
else
  fail "artifact projection must resume safely before the first receipt"
fi

git init -q "$RAYA_CODE_DIR"
git -C "$RAYA_CODE_DIR" config user.email fly2445@example.test
git -C "$RAYA_CODE_DIR" config user.name FLY-2445
git -C "$RAYA_CODE_DIR" add .
git -C "$RAYA_CODE_DIR" commit -qm seed
git -C "$RAYA_CODE_DIR" branch -M main
frozen_raya="$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)"
frozen_version="$RAYA_WORKSPACE/.flywheel-managed/versions/$frozen_raya"
cp -R "$version" "$frozen_version"
rm "$RAYA_WORKSPACE/business/current"
ln -s "$frozen_version" "$RAYA_WORKSPACE/business/current"
frozen_flywheel="6666666666666666666666666666666666666666"
printf '%s\n' "$frozen_flywheel" > "$FLYWHEEL_DEPLOYED_SHA_FILE"
chmod 600 "$FLYWHEEL_DEPLOYED_SHA_FILE"
canonical_digest="$(shasum -a 256 "$RAYA_CANONICAL_MANIFEST" | awk '{print $1}')"
mkdir -p "$(dirname "$RAYA_MIGRATION_MANIFEST")"
jq -n --arg raya "$frozen_raya" --arg flywheel "$frozen_flywheel" \
  --arg manifest "$canonical_digest" --arg artifact "$RAYA_ARTIFACT_DIGEST" \
  --arg persona "$RAYA_PERSONA_DIGEST" --arg workspace "$RAYA_WORKSPACE" '{
    schemaVersion:1,migration_id:"fly-2445-test",checkpoint:"P3",unresolved:[],
    raya_sha:$raya,flywheel_deployed_sha:$flywheel,canonical_manifest_digest:$manifest,
    artifact:{digest:$artifact,persona_digest:$persona,workspace:$workspace,state_schema_version:1},
    cursor:{path:"/tmp/not-used",seed_input:"/tmp/not-used"}
  }' > "$RAYA_MIGRATION_MANIFEST"
chmod 600 "$RAYA_MIGRATION_MANIFEST"
: > "$TMP/fetch-calls"
saved_fetch="$(declare -f raya_git_fetch_bounded)"
raya_git_fetch_bounded() { printf 'fetch\n' >> "$TMP/fetch-calls"; return 99; }
if raya_prepare_source && [[ ! -s "$TMP/fetch-calls" ]]; then
  pass "P3+ resume verifies the frozen two-repository artifact without fetching"
else
  fail "P3+ resume must not move the frozen source after legacy ownership stopped"
fi
eval "$saved_fetch"
version="$frozen_version"

v1_keys='["brain_pid","checked_at","checkout_before","deployed_sha","failure","gen_before","generation","head","identity","interrupt_notice","ledger","node_bin","origin_main","outcome","preflight_rc","rollback_sha","schemaVersion","session_at_cutover","session_grace","state","voice","voice_pid"]'
v2_keys='["brain_pid","business","carrier","checked_at","checkout_before","checks","cutover","deployed_sha","failure","flywheel_deployed_sha","gen_before","generation","head","identity","interrupt_notice","lead","ledger","migration_id","node_bin","origin_main","outcome","preflight_rc","rollback_sha","rollback_target","schemaVersion","session_at_cutover","session_grace","state","voice","voice_pid"]'

jq -n '{
  schemaVersion:1,checked_at:0,outcome:"current",state:"current",failure:null,
  checkout_before:null,head:null,origin_main:null,ledger:null,rollback_sha:null,deployed_sha:null,
  identity:null,session_grace:null,session_at_cutover:null,generation:null,gen_before:null,
  interrupt_notice:null,brain_pid:null,voice:null,voice_pid:null,node_bin:null,preflight_rc:null
}' > "$TMP/v1.json"
if raya_receipt_keys_valid "$TMP/v1.json"; then pass "legacy v1 receipt retains exactly 22 keys"; else
  fail "legacy v1 receipt retains exactly 22 keys"
fi
expect_eq "$v1_keys" "$(jq -c 'keys' "$TMP/v1.json")" "v1 receipt key set is pinned"

write_p6_manifest
RAYA_CHECKOUT_BEFORE="0000000000000000000000000000000000000000"
RAYA_TARGET="$frozen_raya"
RAYA_NEW_HEAD="$RAYA_TARGET"
RAYA_LEDGER_STATE=missing
RAYA_ROLLBACK_SHA=""
RAYA_PREFLIGHT_RC=0
if raya_write_standard_receipt deployed "standard-lead activated"; then
  pass "writes a standard Lead v2 deploy receipt"
else
  fail "writes a standard Lead v2 deploy receipt"
fi
expect_eq "$v2_keys" "$(jq -c 'keys' "$RAYA_DEPLOY_RECEIPT")" "v2 receipt key set is pinned at 30"
if jq -e --arg raya "$frozen_raya" '
  .schemaVersion == 2 and .carrier == "standard-lead" and
  .deployed_sha == $raya and
  .flywheel_deployed_sha == "2222222222222222222222222222222222222222" and
  .lead.key == "raya-raya" and .business.state_schema_version == 1 and
  .checks.preflight and .checks.mailbox_acked and .cutover.unresolved_count == 0 and
  .identity == null and .generation == null and .brain_pid == null and .voice_pid == null
' "$RAYA_DEPLOY_RECEIPT" >/dev/null; then
  pass "v2 success carries current standard evidence without inventing legacy process evidence"
else
  fail "v2 success evidence is malformed"
fi

cp "$RAYA_CANONICAL_MANIFEST" "$TMP/canonical.before"
jq '.tampered=true' "$RAYA_CANONICAL_MANIFEST" > "$TMP/canonical.tampered"
mv "$TMP/canonical.tampered" "$RAYA_CANONICAL_MANIFEST"
chmod 600 "$RAYA_CANONICAL_MANIFEST"
if raya_write_standard_receipt deployed "must refuse stale manifest proof" >/dev/null 2>&1; then
  fail "stale canonical manifest digest must block a success receipt"
else
  pass "stale canonical manifest digest blocks a success receipt"
fi
mv "$TMP/canonical.before" "$RAYA_CANONICAL_MANIFEST"
chmod 600 "$RAYA_CANONICAL_MANIFEST"

printf 'tampered artifact\n' > "$version/packages/cos/dist/cli.js"
if raya_write_standard_receipt deployed "must refuse stale artifact proof" >/dev/null 2>&1; then
  fail "stale business artifact digest must block a success receipt"
else
  pass "stale business artifact digest blocks a success receipt"
fi
printf 'console.log("cos")\n' > "$version/packages/cos/dist/cli.js"

first_receipt_digest="$(shasum -a 256 "$RAYA_DEPLOY_RECEIPT" | awk '{print $1}')"
next_raya="3333333333333333333333333333333333333333"
next_flywheel="4444444444444444444444444444444444444444"
next_version="$RAYA_WORKSPACE/.flywheel-managed/versions/$next_raya"
cp -R "$version" "$next_version"
rm "$RAYA_WORKSPACE/business/current"
ln -s "$next_version" "$RAYA_WORKSPACE/business/current"
RAYA_TARGET="$next_raya"
write_p6_manifest "$next_raya" "$next_flywheel"
if raya_write_standard_receipt deployed "paired update" \
  && jq -e --arg digest "$first_receipt_digest" --arg previous "$frozen_raya" '
    .rollback_target.carrier == "standard-lead" and
    .rollback_target.raya_sha == $previous and
    .rollback_target.flywheel_sha == "2222222222222222222222222222222222222222" and
    .rollback_target.receipt_digest == $digest
  ' "$RAYA_DEPLOY_RECEIPT" >/dev/null; then
  pass "rollback target pairs the previous verified Raya and Flywheel SHAs"
else
  fail "rollback target must preserve the previous verified two-repository pair"
fi
rm "$RAYA_WORKSPACE/business/current"
ln -s "$version" "$RAYA_WORKSPACE/business/current"
RAYA_TARGET="$frozen_raya"
write_p6_manifest

CALLS="$TMP/calls"
: > "$CALLS"
saved_quiesce="$(declare -f raya_quiesce_legacy_owner)"
raya_quiesce_legacy_owner() { printf '%s\n' quiesce >> "$CALLS"; }
raya_standard_seed_inbound_cursor() {
  printf '{}\n' > "$1"; chmod 600 "$1"
  local digest; digest="$(shasum -a 256 "$1" | awk '{print $1}')"
  printf '%s\n' "{\"status\":\"seeded\",\"migrationId\":\"fly-2445-test\",\"sha256\":\"$digest\",\"channels\":1}"
}
raya_standard_lead() { printf '%s\n' "$*" >> "$CALLS"; }
raya_bridge_token_ready() { return 0; }
write_p2_manifest
if raya_standard_cutover; then pass "runs P3-P5 through the standard Lead lifecycle"; else
  fail "runs P3-P5 through the standard Lead lifecycle"
fi
expect_eq "P5" "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" "successful install advances the durable checkpoint to P5"
expected_calls=$'quiesce\npreflight '$RAYA_CANONICAL_MANIFEST$'\ninstall --project raya --lead raya\nverify --stage installed '$RAYA_CANONICAL_MANIFEST
expect_eq "$expected_calls" "$(cat "$CALLS")" "cutover orders quiesce, seed fence, preflight, install, verify"

: > "$CALLS"
write_p2_manifest '["message-unknown-side-effect"]'
if raya_standard_cutover >/dev/null 2>&1; then
  fail "unresolved legacy side effects must block quiesce and install"
else
  pass "unresolved legacy side effects block quiesce and install"
fi
expect_eq "" "$(cat "$CALLS")" "blocked cutover performs no lifecycle operation"
eval "$saved_quiesce"

write_p6_manifest
rm -f "$RAYA_DEPLOY_RECEIPT" "$RAYA_DEPLOYED_SHA_FILE"
if declare -F raya_verify_frozen_source >/dev/null 2>&1; then
  saved_fence="$(declare -f raya_verify_frozen_source)"
  saved_receipt_writer="$(declare -f raya_write_standard_receipt)"
  raya_verify_frozen_source() { return 1; }
  raya_write_standard_receipt() { touch "$TMP/unexpected-receipt-write"; return 0; }
  if raya_standard_finalize >/dev/null 2>&1 || [[ -e "$TMP/unexpected-receipt-write" ]]; then
    fail "P7 must recheck the frozen source before writing its receipt"
  else
    pass "P7 rechecks the frozen source before writing its receipt"
  fi
  eval "$saved_fence"
  eval "$saved_receipt_writer"
else
  fail "P7 must expose and use a frozen-source verification fence"
fi
saved_writer="$(declare -f raya_write_standard_receipt)"
raya_write_standard_receipt() { return 1; }
if raya_standard_finalize >/dev/null 2>&1; then fail "receipt failure must fail finalization"; else
  pass "receipt failure fails finalization"
fi
if [[ -e "$RAYA_DEPLOYED_SHA_FILE" ]]; then fail "receipt failure must not advance the anchor"; else
  pass "receipt failure leaves the known-good anchor untouched"
fi
eval "$saved_writer"
if raya_standard_finalize; then pass "P7 finalizes after verified P6 evidence"; else
  fail "P7 finalizes after verified P6 evidence"
fi
expect_eq "$RAYA_TARGET" "$(sed -n '1p' "$RAYA_DEPLOYED_SHA_FILE")" "anchor advances only after the v2 receipt"

remote="$TMP/raya-remote.git"
publisher="$TMP/raya-publisher"
git init -q --bare -b main "$remote"
git -C "$RAYA_CODE_DIR" remote add origin "$remote"
git -C "$RAYA_CODE_DIR" push -q -u origin main
git clone -q "$remote" "$publisher"
git -C "$publisher" config user.email fly2445@example.test
git -C "$publisher" config user.name FLY-2445
mkdir -p "$publisher/packages/cos/dist"
printf 'console.log("cos-v2")\n' > "$publisher/packages/cos/dist/cli.js"
git -C "$publisher" add packages/cos/dist/cli.js
git -C "$publisher" commit -qm update
git -C "$publisher" push -q origin main
followup_target="$(git -C "$publisher" rev-parse HEAD)"
saved_bounded="$(declare -f raya_run_bounded_in_checkout)"
saved_lead="$(declare -f raya_standard_lead)"
raya_run_bounded_in_checkout() { return 0; }
: > "$CALLS"
raya_standard_lead() { printf '%s\n' "$*" >> "$CALLS"; return 0; }

legacy_plist_dir="$TMP/legacy-launch-agents"
mkdir -p "$legacy_plist_dir"
touch "$legacy_plist_dir/com.xrli.raya.brain.plist"
export RAYA_LEGACY_PLIST_DIR="$legacy_plist_dir"
export RAYA_MIGRATION_ALLOW_LEGACY_STOP=0
blocked_head="$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)"
blocked_pointer="$(readlink "$RAYA_WORKSPACE/business/current")"
cp "$RAYA_MIGRATION_MANIFEST" "$TMP/pre-blocked-manifest.json"
write_p2_manifest
: > "$TMP/blocked-fetch-calls"
saved_guarded_fetch="$(declare -f raya_git_fetch_bounded)"
eval "$(declare -f raya_git_fetch_bounded | sed '1s/raya_git_fetch_bounded/raya_git_fetch_bounded_real/')"
raya_git_fetch_bounded() {
  printf 'fetch\n' >> "$TMP/blocked-fetch-calls"
  raya_git_fetch_bounded_real "$@"
}
if ! raya_prepare_source >/dev/null 2>&1 \
  && [[ ! -s "$TMP/blocked-fetch-calls" ]] \
  && [[ "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" == "$blocked_head" ]] \
  && [[ "$(readlink "$RAYA_WORKSPACE/business/current")" == "$blocked_pointer" ]]; then
  pass "unapproved legacy owner blocks source mutation before fetch"
else
  fail "unapproved legacy owner must leave checkout and business projection untouched"
fi
unset -f raya_git_fetch_bounded raya_git_fetch_bounded_real
eval "$saved_guarded_fetch"
git -C "$RAYA_CODE_DIR" reset --hard -q "$blocked_head"
rm -f "$RAYA_WORKSPACE/business/current"
ln -s "$blocked_pointer" "$RAYA_WORKSPACE/business/current"
cp "$TMP/pre-blocked-manifest.json" "$RAYA_MIGRATION_MANIFEST"
chmod 600 "$RAYA_MIGRATION_MANIFEST"
rm -f "$legacy_plist_dir/com.xrli.raya.brain.plist"
unset RAYA_LEGACY_PLIST_DIR RAYA_MIGRATION_ALLOW_LEGACY_STOP

if raya_prepare_source \
  && [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == P5 ]] \
  && [[ "$(jq -r .mode "$RAYA_MIGRATION_MANIFEST")" == standard-update ]] \
  && [[ "$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")" == "$followup_target" ]] \
  && [[ "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" == "$followup_target" ]] \
  && [[ "$(readlink "$RAYA_WORKSPACE/business/current")" == "$RAYA_WORKSPACE/.flywheel-managed/versions/$followup_target" ]]; then
  pass "P7 starts a new resumable standard update transaction when Raya main advances"
else
  fail "P7 must not freeze the scheduled Raya shuttle at the first migrated SHA"
fi
expected_followup_calls=$'preflight '$RAYA_CANONICAL_MANIFEST$'\ninstall --project raya --lead raya\nverify --stage installed '$RAYA_CANONICAL_MANIFEST
expect_eq "$expected_followup_calls" "$(cat "$CALLS")" "follow-up update uses only the public standard Lead lifecycle"

proof_migration="$(jq -r .migration_id "$RAYA_MIGRATION_MANIFEST")"
proof_raya="$(jq -r .raya_sha "$RAYA_MIGRATION_MANIFEST")"
proof_flywheel="$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")"
cat > "$RAYA_STANDARD_PROOF_FILE" <<JSON
{"migration_id":"$proof_migration","raya_sha":"$proof_raya","flywheel_deployed_sha":"$proof_flywheel","lead":{},"business":{},"checks":{},"cutover":{}}
JSON
chmod 600 "$RAYA_STANDARD_PROOF_FILE"
if ! raya_standard_collect_proof >/dev/null 2>&1 \
  && [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == P5 ]]; then
  pass "matching proof with incomplete P6 evidence is rejected before checkpoint advance"
else
  fail "matching proof with incomplete P6 evidence must not advance the checkpoint"
fi
# Restore the P5 fixture even while this assertion is RED so the stale-pair
# assertion below remains independent.
jq '.checkpoint="P5" | .lead=null | .business=null | .checks=null | .cutover=null' \
  "$RAYA_MIGRATION_MANIFEST" > "$RAYA_MIGRATION_MANIFEST.tmp"
mv "$RAYA_MIGRATION_MANIFEST.tmp" "$RAYA_MIGRATION_MANIFEST"
chmod 600 "$RAYA_MIGRATION_MANIFEST"

jq -n --slurpfile manifest "$RAYA_MIGRATION_MANIFEST" '
  $manifest[0] as $m | {
    migration_id:$m.migration_id,raya_sha:$m.raya_sha,
    flywheel_deployed_sha:$m.flywheel_deployed_sha,
    lead:{project:"raya",id:"raya",key:"raya-raya",identity_digest:("f"*64),
      registry_digest:$m.registry_digest,summary_receipt_digest:$m.summary_receipt_digest,
      manifest_digest:$m.canonical_manifest_digest,pid:7654,
      process_started_at:"2026-09-08T11:00:00Z",activation_id:"activation-followup",
      thread_id:"thread-followup",tui_visible:true},
    business:{source_sha:$m.raya_sha,artifact_digest:$m.artifact.digest,
      persona_digest:$m.artifact.persona_digest,workspace:$m.artifact.workspace,
      state_schema_version:$m.artifact.state_schema_version},
    checks:{preflight:true,unique_owner:true,pump:true,text_delivery_id:"chat:raya:900",
      outbound_message_id:"901",summary_round_id:"round-followup",
      summary_delivery_id:"summary:followup",mailbox_acked:true,bridge_sent:true,
      bridge_identity_verified:true,alert_channel_id:"902",alert_delivery_id:"903",
      alert_reachable:true},
    cutover:{seed_digest:$m.cursor.sha256,seeded_at:"2026-09-08T10:58:00Z",
      old_stopped_at:"2026-09-08T10:59:00Z",activated_at:"2026-09-08T11:00:00Z",
      activation_id:"activation-followup",channels:[{channel_id:"904",seeded_after:"905"}],
      window_message_id:"906",window_delivery_id:"chat:raya:906",
      window_outbound_message_id:"907",unresolved_count:0}
  }
' > "$RAYA_STANDARD_PROOF_FILE"
chmod 600 "$RAYA_STANDARD_PROOF_FILE"
if raya_standard_collect_proof \
  && jq -e '.checkpoint == "P6" and .lead.activation_id == "activation-followup"' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null; then
  pass "matching complete proof advances P5 to P6 with the current activation evidence"
else
  fail "matching complete proof must advance P5 to P6"
fi
jq '.checkpoint="P5" | .lead=null | .business=null | .checks=null | .cutover=null' \
  "$RAYA_MIGRATION_MANIFEST" > "$RAYA_MIGRATION_MANIFEST.tmp"
mv "$RAYA_MIGRATION_MANIFEST.tmp" "$RAYA_MIGRATION_MANIFEST"
chmod 600 "$RAYA_MIGRATION_MANIFEST"

cat > "$RAYA_STANDARD_PROOF_FILE" <<JSON
{"migration_id":"stale-migration","raya_sha":"$frozen_raya","flywheel_deployed_sha":"$frozen_flywheel","lead":{},"business":{},"checks":{},"cutover":{}}
JSON
chmod 600 "$RAYA_STANDARD_PROOF_FILE"
if raya_standard_collect_proof >/dev/null 2>&1; then
  fail "proof from an earlier migration or SHA pair must not be reusable"
else
  pass "proof is bound to the current migration and two-repository SHA pair"
fi
eval "$saved_bounded"
eval "$saved_lead"

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
