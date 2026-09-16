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
      target_raya_sha:("1"*40),
      authorization:{legacy_stop:true,granted_by:"founder",granted_at:"2026-09-13T00:00:00Z",
        evidence_message_id:"12345678901234567",evidence_channel_id:"22345678901234567",
        evidence_author_id:"32345678901234567",content_sha256:("a"*64),
        canonical_line:"FLY-2496 AUTHORIZE register cutover=11111111 urgent-restart baseline=quiet15m",
        issued_by:"flywheel-eng-lead"},
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

# Registration precedes founder-authorized migration preparation. No ledger
# means a normal skipped shuttle, including when the caller inherited a stop flag.
(
  raya_lock_acquire() { printf 'lock\n' >> "$TMP/no-ledger-effects"; return 1; }
  raya_write_standard_receipt() { printf 'receipt\n' >> "$TMP/no-ledger-effects"; }
  raya_alert() { printf 'alert\n' >> "$TMP/no-ledger-effects"; }
  export RAYA_MIGRATION_ALLOW_LEGACY_STOP=1
  updater_raya_pass > "$TMP/no-ledger-output" 2>&1
  [[ "$RAYA_DEPLOY_STATE" == not_configured && "$RAYA_DEPLOY_DETAIL" == migration-ledger-absent ]] \
    && [[ ! -e "$TMP/no-ledger-effects" && ! -s "$TMP/no-ledger-output" ]] \
    && [[ -z "${RAYA_MIGRATION_ALLOW_LEGACY_STOP+x}" ]]
)
if [[ $? == 0 ]]; then
  pass "missing migration ledger skips without lock, receipt, alert or inherited stop authority"
else
  fail "missing migration ledger must skip without lock, receipt, alert or inherited stop authority"
fi

# Exercise real plist matching and lifecycle commands in an isolated fake host.
(
  trap - EXIT
  export RAYA_LEGACY_PLIST_DIR="$TMP/authorization-plists"
  mkdir -p "$RAYA_LEGACY_PLIST_DIR"
  python3 - "$RAYA_LEGACY_PLIST_DIR" "$RAYA_CODE_DIR" "$RAYA_HOME" "$(command -v node)" <<'PY'
import os, plistlib, sys
directory, code, home, node = sys.argv[1:]
for app in ('brain', 'voice'):
    label = 'com.xrli.raya.' + app
    with open(os.path.join(directory, label + '.plist'), 'wb') as handle:
        plistlib.dump({'Label': label, 'RunAtLoad': True, 'ProgramArguments': [os.path.realpath(node), code + '/apps/' + app + '/dist/cli.js', 'run'],
                      'WorkingDirectory': code, 'EnvironmentVariables': {'RAYA_ENV_FILE': home + '/raya.env'}}, handle)
PY
  launchctl() {
    case "$1" in
      print) return 0 ;;
      bootout) printf '%s\n' "$*" >> "$TMP/unauthorized-bootout"; return 1 ;;
      *) return 1 ;;
    esac
  }
  for mutation in 'del(.authorization)' '.authorization.legacy_stop=false' \
    '.authorization.granted_by="lead"' 'del(.authorization.evidence_author_id)' \
    '.authorization.content_sha256="invalid"' '.target_raya_sha=("2"*40)' \
    '.authorization.canonical_line="FLY-2496 AUTHORIZE register cutover=11111111 baseline=quiet15m"' \
    '.authorization.canonical_line="FLY-2496 AUTHORIZE register cutover=11111111 urgent-restart"'; do
    write_p2_manifest
    jq "$mutation" "$RAYA_MIGRATION_MANIFEST" > "$TMP/auth-mutated.json"
    cat "$TMP/auth-mutated.json" > "$RAYA_MIGRATION_MANIFEST"
    export RAYA_MIGRATION_ALLOW_LEGACY_STOP=1
    raya_ensure_legacy_quiesced >/dev/null 2>&1
    [[ ! -e "$TMP/unauthorized-bootout" ]] || exit 1
  done
)
if [[ $? == 0 ]]; then
  pass "inherited stop flag cannot bypass missing, malformed or incomplete founder authorization"
else
  fail "inherited stop flag must never bypass the migration authorization ledger"
fi
rm -f "$RAYA_MIGRATION_MANIFEST"

(
  trap - EXIT
  export RAYA_LEGACY_PLIST_DIR="$TMP/authorization-plists"
  write_p2_manifest
  raya_process_start() { printf '%s\n' 'Sun Sep 13 10:00:00 2026'; }
  for app in brain voice; do
    label="com.xrli.raya.$app"
    digest="$(raya_sha256 "$RAYA_LEGACY_PLIST_DIR/$label.plist")"
    raya_manifest_transform P2 P2 \
      '.legacy_owner += [{label:$label,plist_sha256:$digest,loaded:true,pid:$pid,start:$start}]' \
      --arg label "$label" --arg digest "$digest" --argjson pid "$$" \
      --arg start "$(raya_process_start "$$")" || exit 1
    touch "$TMP/$label.loaded"
  done
  launchctl() {
    local app label
    case "$1" in
      print)
        label="${2##*/}"
        [[ -f "$TMP/$label.loaded" ]] || { printf "Could not find service\n" >&2; return 1; }
        printf 'pid = %s\n' "$$" ;;
      disable)
        label="${2##*/}"
        [[ ! -e "$TMP/deny-disable" ]] || return 1
        touch "$TMP/$label.disabled" ;;
      print-disabled)
        printf 'disabled services = {\n'
        for app in brain voice; do
          label="com.xrli.raya.$app"
          [[ ! -e "$TMP/$label.disabled" ]] || printf '"%s" => disabled\n' "$label"
        done
        printf '}\n' ;;
      bootout)
        label="${3##*/}"; label="${label%.plist}"
        printf '%s\n' "$label" >> "$TMP/resume-bootouts"
        if [[ "$label" == com.xrli.raya.voice && ! -e "$TMP/allow-voice-stop" ]]; then return 1; fi
        # Stop intent must be durable before the first destructive command.
        jq -e --arg label "$label" \
          '.legacy_owner[] | select(.label == $label) | .stop_started_at_ms | type == "number"' \
          "$RAYA_MIGRATION_MANIFEST" >/dev/null || return 1
        rm "$TMP/$label.loaded" ;;
      *) return 1 ;;
    esac
  }
  cp "$RAYA_MIGRATION_MANIFEST" "$TMP/resume-initial.json"
  # Target tree has deleted the old runtime entrypoints; identity is still
  # the recorded executable/argv/cwd/env tuple, not CLI file existence.
  [[ ! -e "$RAYA_CODE_DIR/apps/brain/dist/cli.js" && ! -e "$RAYA_CODE_DIR/apps/voice/dist/cli.js" ]] || exit 1
  raya_verify_legacy_owners || exit 1
  for mutation in '.legacy_owner[0].plist_sha256=("b"*64)' \
    '.legacy_owner[0].pid=1' '.legacy_owner[0].start="different process birth"'; do
    jq "$mutation" "$TMP/resume-initial.json" > "$RAYA_MIGRATION_MANIFEST"
    raya_verify_legacy_owners >/dev/null 2>&1 && exit 1
    raya_ensure_legacy_quiesced >/dev/null 2>&1 && exit 1
    [[ ! -e "$TMP/resume-bootouts" ]] || exit 1
  done
  cat "$TMP/resume-initial.json" > "$RAYA_MIGRATION_MANIFEST"
  # Simulate login with ignored build output surviving the source ff.
  mkdir -p "$RAYA_CODE_DIR/apps/brain/dist"
  git init -q "$TMP/ignored-runtime"
  printf 'dist/\n' > "$TMP/ignored-runtime/.gitignore"
  mkdir -p "$TMP/ignored-runtime/apps/brain/dist"
  printf 'legacy compiled runtime\n' > "$TMP/ignored-runtime/apps/brain/dist/cli.js"
  git -C "$TMP/ignored-runtime" check-ignore -q apps/brain/dist/cli.js || exit 1
  printf 'legacy compiled runtime\n' > "$RAYA_CODE_DIR/apps/brain/dist/cli.js"
  reboot_legacy() {
    for app in brain voice; do
      label="com.xrli.raya.$app"
      if [[ ! -e "$TMP/$label.disabled" ]]; then
        python3 - "$RAYA_LEGACY_PLIST_DIR/$label.plist" <<'PYREBOOT' || return 1
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    assert plistlib.load(f)['RunAtLoad'] is True
PYREBOOT
        touch "$TMP/$label.loaded"
      fi
    done
  }
  rm "$TMP/com.xrli.raya.brain.loaded"
  reboot_legacy
  [[ -e "$TMP/com.xrli.raya.brain.loaded" ]] || exit 1
  touch "$TMP/deny-disable"
  raya_ensure_legacy_quiesced >/dev/null 2>&1 && exit 1
  [[ -e "$TMP/com.xrli.raya.brain.loaded" && ! -e "$TMP/resume-bootouts" ]] || exit 1
  rm "$TMP/deny-disable"
  raya_ensure_legacy_quiesced >/dev/null 2>&1 && exit 1
  [[ ! -e "$TMP/com.xrli.raya.brain.loaded" ]] || exit 1
  jq -e '.old_stopped_at == null and
    (.legacy_owner[] | select(.label == "com.xrli.raya.brain") | .stopped_at_ms | type == "number")' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null || exit 1
  touch "$TMP/allow-voice-stop"
  raya_ensure_legacy_quiesced || exit 1
  [[ "$(rg -c '^com.xrli.raya.brain$' "$TMP/resume-bootouts")" == 1 ]] || exit 1
  reboot_legacy
  [[ ! -e "$TMP/com.xrli.raya.brain.loaded" && ! -e "$TMP/com.xrli.raya.voice.loaded" ]] || exit 1
  jq -e 'all(.legacy_owner[]; .disabled_at_ms | type == "number")' "$RAYA_MIGRATION_MANIFEST" >/dev/null || exit 1
  rm "$TMP/com.xrli.raya.brain.disabled"
  raya_ensure_legacy_quiesced >/dev/null 2>&1 && exit 1
  raya_verify_legacy_owners >/dev/null 2>&1 && exit 1
  raya_begin_followup_transaction >/dev/null 2>&1 && exit 1
  raya_standard_finalize >/dev/null 2>&1 && exit 1
  touch "$TMP/com.xrli.raya.brain.disabled"
  raya_verify_legacy_retired || exit 1
  jq -e '(.old_stopped_at | type == "string") and
    ([.legacy_owner[] | .stopped_at_ms >= .stop_started_at_ms] | all)' \
    "$RAYA_MIGRATION_MANIFEST" >/dev/null
)
if [[ $? == 0 ]]; then
  pass "partial legacy stop resumes voice without repeating brain and persists per-job stop times"
else
  fail "partial legacy stop must persist intent and resume only the unfinished job"
fi
rm -f "$RAYA_MIGRATION_MANIFEST"

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

# Exact launchd readback formats, including older boolean output.
(
  readback="disabled"
  launchctl() { printf '"com.xrli.raya.brain" => %s\n' "$readback"; }
  for readback in disabled true; do raya_legacy_disabled com.xrli.raya.brain || exit 1; done
  for readback in enabled false unknown; do
    raya_legacy_disabled com.xrli.raya.brain && exit 1
  done
  exit 0
)
if [[ $? == 0 ]]; then pass "disabled readback accepts current and old formats and rejects other values"; else
  fail "disabled readback format contract"
fi

# The following source/receipt fixtures isolate their own gates. Real launchd
# retirement, including refusal after an override removal, is covered above.
raya_verify_legacy_retired() { return 0; }

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
raya_emit_window_probe() { printf '%s\n' window-probe >> "$CALLS"; }
raya_compute_seed_boundary() { printf '%s\n' seed-boundary >> "$CALLS"; }
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
expected_calls=$'quiesce\nwindow-probe\nseed-boundary\npreflight '$RAYA_CANONICAL_MANIFEST$'\ninstall --project raya --lead raya\nverify --stage installed '$RAYA_CANONICAL_MANIFEST
expect_eq "$expected_calls" "$(cat "$CALLS")" "cutover orders quiesce, seed fence, preflight, install, verify"

: > "$CALLS"
write_p2_manifest '["message-unknown-side-effect"]'
if raya_standard_cutover >/dev/null 2>&1; then
  fail "unresolved legacy side effects must block quiesce and install"
else
  pass "unresolved legacy side effects block quiesce and install"
fi
expect_eq "" "$(cat "$CALLS")" "blocked cutover performs no lifecycle operation"
write_p2_manifest
: > "$CALLS"
raya_compute_seed_boundary() { return 1; }
if ! raya_standard_cutover && [[ "$(jq -r .checkpoint "$RAYA_MIGRATION_MANIFEST")" == P3 ]] \
  && [[ "$(cat "$CALLS")" == $'quiesce\nwindow-probe' ]]; then
  pass "unresolved seed boundary stops at P3 before install"
else
  fail "unresolved seed boundary must stop before install"
fi
unset -f raya_emit_window_probe raya_compute_seed_boundary
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
saved_summary_migration="$(declare -f raya_migrate_summary_presentation)"
raya_run_bounded_in_checkout() { return 0; }
: > "$CALLS"
raya_standard_lead() { printf '%s\n' "$*" >> "$CALLS"; return 0; }

# The standard update must complete the FLY-2619 data-first migration before
# preflight/install. Exercise the shell boundary with an isolated fake adapter;
# the TypeScript suite covers the real database classifier.
summary_node="$TMP/summary-migration-node"
summary_tool="$TMP/raya-summary-presentation-migrate.js"
summary_db="$TMP/teamlead.db"
summary_calls="$TMP/summary-migration-calls"
printf 'fixture tool\n' > "$summary_tool"
printf 'fixture db\n' > "$summary_db"
: > "$RAYA_WORKSPACE/state/summary-merge-receipts.jsonl"
cat > "$summary_node" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SUMMARY_MIGRATION_CALLS"
printf '%s\n' '{"state":"complete","boundarySeq":12,"cursorSeq":12}'
SH
chmod +x "$summary_node"
saved_summary_node="$RAYA_STANDARD_NODE_BIN"
saved_summary_tool="$RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL"
RAYA_STANDARD_NODE_BIN="$summary_node"
RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL="$summary_tool"
TEAMLEAD_DB_PATH="$summary_db"
export SUMMARY_MIGRATION_CALLS="$summary_calls"
if raya_migrate_summary_presentation \
  && grep -F -- "--db $summary_db --workspace $RAYA_WORKSPACE --project raya --lead raya" \
    "$summary_calls" >/dev/null; then
  pass "standard update completes the bounded summary presentation migration before install"
else
  fail "standard update must complete the bounded summary presentation migration before install"
fi
RAYA_STANDARD_NODE_BIN="$saved_summary_node"
RAYA_SUMMARY_PRESENTATION_MIGRATION_TOOL="$saved_summary_tool"
unset TEAMLEAD_DB_PATH SUMMARY_MIGRATION_CALLS
raya_migrate_summary_presentation() { return 0; }

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
eval "$saved_summary_migration"

# Flywheel may deploy while this migration waits at P5/P6. Rebinding must
# quarantine the old proof before changing its SHA owner, including crash recovery.
(
  trap - EXIT
  raya_lock_acquire() { RAYA_LOCK_OWNED=1; }
  raya_lock_release() { RAYA_LOCK_OWNED=0; }
  raya_standard_lead() { return 0; }
  raya_process_start() { printf '%s\n' 'Sun Sep 13 01:00:00 2026 UTC'; }
  launchctl() { printf 'pid = 4321\n'; }
  curl() { printf '{"ok":true,"buildSha":"%s"}\n' "$rebind_new_sha"; }
  raya_alert() { printf 'severe\n' >> "$TMP/rebind-alerts"; }
  rebind_old_sha=2222222222222222222222222222222222222222
  rebind_new_sha=3333333333333333333333333333333333333333
  rebind_fixture() {
    write_p6_manifest "$followup_target" "$rebind_old_sha"
    raya_manifest_transform P6 "$1" '
      .activated_at="2026-09-13T00:00:00Z" |
      .lead.activation_id=(.migration_id + ":" + .activated_at) |
      .cutover.activation_id=.lead.activation_id
    ' || return 1
    printf '%s\n' "$rebind_new_sha" > "$FLYWHEEL_DEPLOYED_SHA_FILE"
    jq '{migration_id,raya_sha,flywheel_deployed_sha,lead,business,checks,cutover}' \
      "$RAYA_MIGRATION_MANIFEST" > "$RAYA_STANDARD_PROOF_FILE"
    chmod 600 "$RAYA_STANDARD_PROOF_FILE"
    printf '{"schemaVersion":1,"codeDeployedSha":"%s","leadsRestartStatus":"healthy","failed":0,"skipped":0,"total":17,"recordedAt":"2026-09-13T02:00:00Z"}\n' \
      "$rebind_new_sha" > "$FLYWHEEL_HOME/leads-restart-status.json"
  }
  for checkpoint in P5 P6; do
    for crash in before-quarantine after-quarantine after-ledger; do
      rebind_fixture "$checkpoint" || exit 1
      eval "$(declare -f raya_atomic_replace | sed '1s/raya_atomic_replace/rebind_atomic_real/')"
      raya_atomic_replace() {
        if [[ "$crash" == before-quarantine && "$1" == "$RAYA_STANDARD_PROOF_FILE" ]]; then return 1; fi
        if [[ "$crash" == after-quarantine && "$2" == "$RAYA_MIGRATION_MANIFEST" ]]; then return 1; fi
        rebind_atomic_real "$@" || return 1
        if [[ "$crash" == after-ledger && "$2" == "$RAYA_MIGRATION_MANIFEST" ]]; then return 1; fi
      }
      updater_raya_pass >/dev/null 2>&1
      eval "$(declare -f rebind_atomic_real | sed '1s/rebind_atomic_real/raya_atomic_replace/')"
      unset -f rebind_atomic_real
      updater_raya_pass >/dev/null 2>&1
      [[ "$RAYA_DEPLOY_DETAIL" == awaiting_rebind_proof && ! -e "$RAYA_STANDARD_PROOF_FILE" ]] || exit 1
      [[ ! -e "$TMP/rebind-alerts" ]] || exit 1
      jq -e --arg sha "$rebind_new_sha" '
        .checkpoint == "P5" and .flywheel_deployed_sha == $sha and
        .activated_at == "2026-09-13T00:00:00Z" and
        (.flywheel_rebinds | length) == 1 and
        .lead == null and .checks == null and .cutover == null
      ' "$RAYA_MIGRATION_MANIFEST" >/dev/null || exit 1
    done
  done
  for mutation in '.leadsRestartStatus="degraded"' '.total=16' '.failed=1' '.skipped=1' '.schemaVersion=2' \
    '.recordedAt="2026-09-12T00:00:00Z"'; do
    rebind_fixture P5 || exit 1
    jq "$mutation" "$FLYWHEEL_HOME/leads-restart-status.json" > "$TMP/rebind-bad-status"
    cat "$TMP/rebind-bad-status" > "$FLYWHEEL_HOME/leads-restart-status.json"
    updater_raya_pass >/dev/null 2>&1
    [[ "$RAYA_DEPLOY_DETAIL" == awaiting_rebind && -e "$RAYA_STANDARD_PROOF_FILE" ]] || exit 1
    [[ "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" == "$rebind_old_sha" ]] || exit 1
    [[ ! -e "$TMP/rebind-alerts" ]] || exit 1
  done
  rebind_fixture P5 || exit 1
  rm "$RAYA_STANDARD_PROOF_FILE"
  updater_raya_pass >/dev/null 2>&1
  [[ "$RAYA_DEPLOY_DETAIL" == awaiting_rebind_proof ]] || exit 1
  for bound in activation previous-rebind; do
    rebind_fixture P5 || exit 1
    if [[ "$bound" == activation ]]; then
      raya_manifest_transform P5 P5 '.activated_at="2026-09-13T01:30:00Z"' || exit 1
    else
      raya_manifest_transform P5 P5 '.flywheel_rebinds=[{at:"2026-09-13T01:30:00Z"}]' || exit 1
    fi
    updater_raya_pass >/dev/null 2>&1
    [[ "$RAYA_DEPLOY_DETAIL" == awaiting_rebind && -e "$RAYA_STANDARD_PROOF_FILE" ]] || exit 1
    [[ ! -e "$TMP/rebind-alerts" ]] || exit 1
  done
)
if [[ $? == 0 ]]; then
  pass "P5/P6 SHA rebind is crash-resumable, invalid health waits, and old proof never produces severe"
else
  fail "P5/P6 SHA drift must rebind safely or wait without severe"
fi

(
  trap - EXIT
  write_p2_manifest
  jq '.checkpoint="P3" | .unresolved=[{reason:"stop-window",message_id:"123456789012345678"}]' \
    "$RAYA_MIGRATION_MANIFEST" > "$TMP/p3-unresolved"
  cat "$TMP/p3-unresolved" > "$RAYA_MIGRATION_MANIFEST"
  jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST" > "$FLYWHEEL_DEPLOYED_SHA_FILE"
  raya_process_start() { printf 'fixture-start\n'; }
  raya_prepare_source() { return 0; }
  raya_standard_cutover() { return 1; }
  raya_alert() { touch "$TMP/p3-unexpected-alert"; }
  updater_raya_pass >/dev/null 2>&1
  [[ "$RAYA_DEPLOY_STATE" == awaiting_reconciliation && ! -e "$TMP/p3-unexpected-alert" ]]
)
if [[ $? == 0 ]]; then pass "P3 human reconciliation waits without a severe deploy failure"; else
  fail "P3 human reconciliation must wait without a severe deploy failure"
fi
(
  trap - EXIT
  write_p2_manifest
  raya_prepare_source() { RAYA_DEPLOY_STATE=prestop-failed; RAYA_DEPLOY_DETAIL=channel-active; return 1; }
  raya_process_start() { printf 'fixture-start\n'; }
  raya_alert() { touch "$TMP/prestop-unexpected-alert"; }
  updater_raya_pass >/dev/null 2>&1
  [[ "$RAYA_DEPLOY_STATE" == prestop-failed && ! -e "$TMP/prestop-unexpected-alert" ]]
)
if [[ $? == 0 ]]; then pass "pre-stop deferral keeps its state without a severe alert"; else
  fail "pre-stop deferral must not be a severe deploy failure"
fi

printf 'Results: %s passed, %s failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
