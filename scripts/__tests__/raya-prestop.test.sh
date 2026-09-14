#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/raya-prestop.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
passed=0 failed=0
run_case() (
  trap - EXIT
  local scenario="$1"
  export HOME="$TMP/$scenario" UPDATE_FLYWHEEL_SOURCED=1 BASH_ENV=""
  export RAYA_HOME="$HOME/.flywheel/raya" RAYA_CODE_DIR="$HOME/.flywheel/raya/code"
  export FLYWHEEL_HOME="$HOME/.flywheel"
  source "$ROOT/scripts/lib/updater-raya-deploy.sh"
  raya_configure_runtime_paths
  mkdir -p "$RAYA_CODE_DIR" "$RAYA_WORKSPACE/.lead/raya" "$(dirname "$RAYA_CANONICAL_MANIFEST")" "$(dirname "$RAYA_MIGRATION_MANIFEST")"
  git -C "$RAYA_CODE_DIR" init -q -b main
  git -C "$RAYA_CODE_DIR" config user.email fixture@example.test
  git -C "$RAYA_CODE_DIR" config user.name fixture
  mkdir -p "$RAYA_CODE_DIR/.lead/raya" "$RAYA_CODE_DIR/packages/cos/dist" "$RAYA_CODE_DIR/packages/brain/dist"
  printf 'persona\n' > "$RAYA_CODE_DIR/.lead/raya/identity.md"
  cp "$RAYA_CODE_DIR/.lead/raya/identity.md" "$RAYA_WORKSPACE/.lead/raya/identity.md"
  printf '{}\n' > "$RAYA_CODE_DIR/packages/cos/package.json"
  printf 'old\n' > "$RAYA_CODE_DIR/packages/cos/dist/cli.js"
  touch "$RAYA_CODE_DIR/packages/brain/dist/cli.js"
  git -C "$RAYA_CODE_DIR" add .
  git -C "$RAYA_CODE_DIR" commit -qm base
  local base target
  base="$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)"
  rm -rf "$RAYA_CODE_DIR/packages/brain"
  printf 'new\n' > "$RAYA_CODE_DIR/packages/cos/dist/cli.js"
  git -C "$RAYA_CODE_DIR" add -A
  git -C "$RAYA_CODE_DIR" commit -qm target
  target="$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)"
  git clone -q --bare "$RAYA_CODE_DIR" "$HOME/remote.git"
  git -C "$RAYA_CODE_DIR" remote add origin "$HOME/remote.git"
  git -C "$RAYA_CODE_DIR" reset --hard -q "$base"
  jq -n --arg workspace "$RAYA_WORKSPACE" '{projectName:"raya",leadId:"raya",projectDir:$workspace,leadBackend:{backendId:"codex-app-server"}}' > "$RAYA_CANONICAL_MANIFEST"
  printf '%040d\n' 2 > "$FLYWHEEL_DEPLOYED_SHA_FILE"
  jq -n --arg target "$target" '{schemaVersion:1,migration_id:"fixture",checkpoint:"P2",unresolved:[],target_raya_sha:$target,
    authorization:{legacy_stop:true,granted_by:"founder",evidence_message_id:"123456789012345678",evidence_channel_id:"223456789012345678",
      evidence_author_id:"323456789012345678",content_sha256:("a"*64),canonical_line:("FLY-2496 AUTHORIZE register cutover="+$target[0:8]+" urgent-restart baseline=quiet15m")},
    legacy_owner:[{label:"com.xrli.raya.brain"},{label:"com.xrli.raya.voice"}],cursor:{path:"/fixture",seed_input:"/fixture",sha256:null}}' > "$RAYA_MIGRATION_MANIFEST"
  chmod 600 "$RAYA_CANONICAL_MANIFEST" "$RAYA_MIGRATION_MANIFEST"
  if [[ "$scenario" == target-mismatch ]]; then
    jq --arg base "$base" '.target_raya_sha=$base | .authorization.canonical_line=("FLY-2496 AUTHORIZE register cutover="+$base[0:8]+" urgent-restart baseline=quiet15m")' "$RAYA_MIGRATION_MANIFEST" > "$HOME/changed"
    cat "$HOME/changed" > "$RAYA_MIGRATION_MANIFEST"
  fi
  if [[ "$scenario" == persona-drift ]]; then printf 'foreign\n' > "$RAYA_WORKSPACE/.lead/raya/identity.md"; fi
  if [[ "$scenario" == artifact-collision ]]; then
    mkdir -p "$RAYA_WORKSPACE/.flywheel-managed/versions/$target"
    printf 'foreign\n' > "$RAYA_WORKSPACE/.flywheel-managed/versions/$target/foreign"
  fi
  raya_git() {
    if [[ "$scenario" == ff-fail && "$1" == merge ]]; then return 1; fi
    git -C "$RAYA_CODE_DIR" "$@" || return
    if [[ "$scenario" == dirty-after-ff && "$1" == merge ]]; then touch "$RAYA_CODE_DIR/foreign"; fi
  }
  local calls="$HOME/calls" quiet=0 stopped=0 identities=0
  : > "$calls"
  raya_verify_legacy_retired() { return 0; } # This fixture isolates source preparation.
  raya_verify_legacy_owners() {
    printf 'identity\n' >> "$calls"; identities=$((identities+1))
    [[ !( "$scenario" == identity-drift && "$identities" == 2 ) ]]
  }
  raya_run_bounded_in_checkout() {
    printf 'build %s\n' "$RAYA_CODE_DIR" >> "$calls"
    [[ "$stopped" == 0 && "$scenario" != build-fail && "$RAYA_CODE_DIR" == "$RAYA_HOME/build-check/$target" ]]
  }
  raya_shuttle_step() {
    printf '%s\n' "$1" >> "$calls"
    if [[ "$1" == quiet-check ]]; then
      quiet=$((quiet+1))
      [[ "$scenario" != quiet-fail && !( "$scenario" == final-quiet-fail && "$quiet" == 2 ) ]]
    else return 0; fi
  }
  raya_ensure_legacy_quiesced() {
    printf 'stop\n' >> "$calls"; stopped=1
    raya_manifest_transform P2 P2 '.old_stopped_at="2026-09-13T00:00:00Z" | .legacy_owner |= map(.stop_started_at_ms=1 | .stopped_at_ms=2)' || return 1
    [[ "$scenario" != resume || -e "$HOME/retrying" ]]
  }
  local rc=0
  raya_prepare_source >/dev/null 2>&1 || rc=$?
  case "$scenario" in
    build-fail|quiet-fail|target-mismatch|persona-drift|ff-fail)
      [[ "$rc" != 0 && "$stopped" == 0 && "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" == "$base" ]] ;;
    final-quiet-fail|dirty-after-ff|identity-drift|artifact-collision)
      [[ "$rc" != 0 && "$stopped" == 0 && "$(git -C "$RAYA_CODE_DIR" rev-parse HEAD)" == "$target" ]] ;;
    success)
      [[ "$rc" == 0 && "$stopped" == 1 && "$quiet" == 2 && "$(readlink "$RAYA_WORKSPACE/business/current")" == "$RAYA_WORKSPACE/.flywheel-managed/versions/$target" ]] ;;
    resume)
      [[ "$rc" != 0 && "$stopped" == 1 ]] || exit 1
      touch "$HOME/retrying"; : > "$calls"
      raya_prepare_source >/dev/null 2>&1 || exit 1
      ! rg -q '^build|^quiet-check|^prestop-probe' "$calls" ;;
    pre-*)
      [[ "$rc" == 0 ]] || exit 1
      mkdir -p "$FLYWHEEL_HOME/state/summary-registry"
      printf '{}\n' > "$FLYWHEEL_HOME/projects.json"
      printf '{}\n' > "$FLYWHEEL_HOME/state/summary-registry/migration-receipt.json"
      raya_manifest_transform P2 P2 '.registry_digest=$digest | .summary_receipt_digest=$digest' \
        --arg digest "$(raya_sha256 "$FLYWHEEL_HOME/projects.json")" || exit 1
      local checkpoint=P3 expected=awaiting_proof
      case "$scenario" in pre-p2) checkpoint=P2 ;; pre-p4b) checkpoint=P4b ;; esac
      raya_manifest_transform P2 "$checkpoint" '.' || exit 1
      if [[ "$scenario" == pre-p2 ]]; then
        raya_manifest_transform P2 P2 'del(.artifact,.old_stopped_at) | .legacy_owner[1].stopped_at_ms=null' || exit 1
        rm -f "$RAYA_WORKSPACE/business/current"
        rm -rf "$RAYA_WORKSPACE/.flywheel-managed/versions/$target"
      fi
      if [[ "$scenario" == pre-p3-unresolved ]]; then
        raya_manifest_transform P3 P3 '.unresolved=[{reason:"stop-window",message_id:"123456789012345678"}]' || exit 1
        expected=awaiting_reconciliation
      else
        raya_standard_cutover() { printf 'cutover\n' >> "$calls"; }
      fi
      printf '%040d\n' 3 > "$FLYWHEEL_DEPLOYED_SHA_FILE"
      raya_process_start() { printf 'fixture-start\n'; }
      raya_standard_lead() { printf 'public %s\n' "$*" >> "$calls"; [[ "$scenario" != pre-public-fail ]]; }
      curl() { [[ "$scenario" != pre-health-fail ]] || return 1; printf '{"ok":true,"buildSha":"%040d"}\n' 3; }
      raya_standard_collect_proof() { return 2; }
      raya_alert() { printf 'severe\n' >> "$calls"; }
      case "$scenario" in
        pre-registry-drift) printf 'drift\n' >> "$FLYWHEEL_HOME/projects.json" ;;
        pre-artifact-drift) printf 'drift\n' >> "$RAYA_WORKSPACE/.lead/raya/identity.md" ;;
        pre-checkout-drift) touch "$RAYA_CODE_DIR/unexpected" ;;
      esac
      : > "$calls"
      updater_raya_pass >/dev/null 2>&1
      if [[ "$scenario" == pre-health-fail || "$scenario" == pre-public-fail || "$scenario" == pre-*-drift ]]; then
        [[ "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" == "$(printf '%040d' 2)" ]] || exit 1
        [[ "$RAYA_DEPLOY_DETAIL" == awaiting_pre_activation_rebind ]] || exit 1
      else
        [[ "$RAYA_DEPLOY_STATE" == "$expected" && "$(jq -r .flywheel_deployed_sha "$RAYA_MIGRATION_MANIFEST")" == "$(printf '%040d' 3)" ]] || exit 1
        jq -e --arg checkpoint "$checkpoint" '.checkpoint==$checkpoint and .pre_activation_rebinds[-1].checkpoint==$checkpoint' "$RAYA_MIGRATION_MANIFEST" >/dev/null || exit 1
        rg -q '^public verify --stage registered ' "$calls" || exit 1
      fi
      ! rg -q '^severe|^build|^prestop-probe|^quiet-check' "$calls" ;;
  esac
)
for scenario in build-fail quiet-fail target-mismatch persona-drift ff-fail final-quiet-fail dirty-after-ff identity-drift artifact-collision success resume pre-p2 pre-p3 pre-p4b pre-p3-unresolved pre-health-fail pre-public-fail pre-registry-drift pre-artifact-drift pre-checkout-drift; do
  if run_case "$scenario"; then printf '[TEST] ok - %s\n' "$scenario"; passed=$((passed+1)); else
    printf '[TEST] FAIL - %s\n' "$scenario"; failed=$((failed+1))
  fi
done
printf 'Results: %s passed, %s failed\n' "$passed" "$failed"
(( failed == 0 ))
