#!/usr/bin/env bash
# FLY-2654: an emergency request must carry verified founder, Lead, trigger and version evidence.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REAL_NODE="$(command -v node)"
REAL_RESTART_CLI="$ROOT/packages/teamlead/dist/bin/restart-request.js"
REQUEST="$ROOT/scripts/request-restart.sh"
UPDATER="$ROOT/scripts/update-flywheel.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly2654-request.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

REMOTE_SHA=1111111111111111111111111111111111111111
OTHER_SHA=5555555555555555555555555555555555555555
FROM_SHA=2222222222222222222222222222222222222222
PRE_MERGE_HEAD=3333333333333333333333333333333333333333
PULL_REQUEST_HEAD=4444444444444444444444444444444444444444
REQUEST_ID=11111111-2222-4333-8444-555555555555
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/home/.flywheel"

cat > "$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'prompt=%s\t%s\n' "${GIT_TERMINAL_PROMPT:-unset}" "$*" >> "$RR_GIT_LOG"
case " $* " in
  *" ls-remote origin refs/heads/main "*)
    [ "${RR_GIT_MODE:-ok}" = ok ] || { printf 'remote failed\n' >&2; exit 2; }
    printf '%s\trefs/heads/main\n' "$RR_REMOTE_SHA"
    ;;
  *" rev-parse HEAD "*) printf '%s\n' "$RR_PRE_MERGE_HEAD" ;;
  *" cat-file -e "*) [ "${RR_TRIGGER_PRESENT:-1}" = 1 ] ;;
  *" merge-base --is-ancestor "*) [ "${RR_TRIGGER_PRESENT:-1}" = 1 ] ;;
  *) exit 64 ;;
esac
EOF

cat > "$TMP/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RR_LAUNCHCTL_LOG"
case "${1:-}" in
  print) [ "${RR_UPDATER_LOADED:-1}" = 1 ] ;;
  print-disabled)
    case "${RR_DISABLED_MODE:-enabled}" in
      enabled) printf 'disabled services = {\n\t"com.flywheel.updater" => enabled\n}\n' ;;
      disabled) printf 'disabled services = {\n\t"com.flywheel.updater" => disabled\n}\n' ;;
      *) exit 64 ;;
    esac
    ;;
  kickstart)
    for arg in "$@"; do
      [ "$arg" != -k ] || exit 99
    done
    find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' -print >> "$RR_LAUNCHCTL_LOG"
    [ "${RR_KICKSTART_OK:-1}" = 1 ]
    ;;
  *) exit 64 ;;
esac
EOF

cat > "$TMP/bin/lead-alert" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RR_ALERT_LOG"
EOF

# The TypeScript verifier has focused tests. This shim proves the shell
# transport passes frozen values to it, persists its exact ticket and invokes
# the one-use transition before publishing the queue entry.
cat > "$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RR_NODE_LOG"
[ "${RR_CLI_OK:-1}" = 1 ] || exit 7
shift
command="${1:-}"; shift || true
case "$command" in
  verify)
    manifest=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --manifest) manifest="$2"; shift 2 ;;
        *) shift 2 2>/dev/null || shift ;;
      esac
    done
    jq -c '{packageDigest}' "$manifest"
    ;;
  resolve)
    root="" path=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --root) root="$2"; shift 2 ;;
        --path) path="$2"; shift 2 ;;
        *) shift 2 2>/dev/null || shift ;;
      esac
    done
    printf '%s/%s\n' "$root" "$path"
    ;;
  scope-snapshot)
    request=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --request) request="$2"; shift 2 ;;
        *) shift 2 2>/dev/null || shift ;;
      esac
    done
    jq -c '.scopeSnapshot' "$request"
    ;;
  prepare)
    request="" pre=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --request) request="$2"; shift 2 ;;
        --pre-merge-head) pre="$2"; shift 2 ;;
        --contains-trigger) shift ;;
        *) shift 2 2>/dev/null || shift ;;
      esac
    done
    jq -c --arg pre "$pre" \
      '. + {preMergeHead:$pre,validatedAt:"2026-09-18T05:00:01.000Z",requestDigest:("a"*64)}' \
      "$request"
    ;;
  transition)
    index=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --index) index="$2"; shift 2 ;;
        *) shift 2 2>/dev/null || shift ;;
      esac
    done
    mkdir -p "$(dirname "$index")"
    printf '%s\n' '{"schemaVersion":1,"intents":{"fixture":{"state":"prepared"}}}' > "$index"
    chmod 600 "$index"
    printf '%s\n' '{"schemaVersion":1}'
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$TMP/bin/git" "$TMP/bin/launchctl" "$TMP/bin/lead-alert" "$TMP/bin/node"
: > "$TMP/restart-request.js"
chmod 600 "$TMP/restart-request.js"

export HOME="$TMP/home"
export FLYWHEEL_HOME="$HOME/.flywheel"
export FLYWHEEL_DIR="$TMP/repo"
export REQUEST_RESTART_GIT="$TMP/bin/git"
export REQUEST_RESTART_NODE="$TMP/bin/node"
export REQUEST_RESTART_CLI="$TMP/restart-request.js"
export REQUEST_RESTART_ALERT_CMD="$TMP/bin/lead-alert"
export REQUEST_RESTART_DEPLOYED_SHA_FILE="$FLYWHEEL_HOME/deployed-sha"
export RESTART_REQUEST_AUDIT_DIR="$FLYWHEEL_HOME/restart-request-audit"
export RESTART_REQUEST_INDEX="$FLYWHEEL_HOME/restart-request-index.json"
export RESTART_WAVE_ACTIVE_TICKET="$FLYWHEEL_HOME/restart-wave-active-ticket.json"
export RESTART_WAVE_REVOCATION_DIR="$RESTART_REQUEST_AUDIT_DIR/restart-wave-revocations"
export SELF_SHIP_LAUNCHCTL="$TMP/bin/launchctl"
export SELF_SHIP_UPDATER_LABEL=com.flywheel.updater
export SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/self-ship-urgent.d"
export RR_GIT_LOG="$TMP/git.log"
export RR_NODE_LOG="$TMP/node.log"
export RR_LAUNCHCTL_LOG="$TMP/launchctl.log"
export RR_ALERT_LOG="$TMP/alert.log"
export RR_REMOTE_SHA="$REMOTE_SHA"
export RR_PRE_MERGE_HEAD="$PRE_MERGE_HEAD"
export FLYWHEEL_LEAD_CARRIER_INSTANCE_ID=carrier-instance-raw-secret
export REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS=1

REQUEST_JSON="$TMP/request.json"
write_request() {
  jq -n \
    --arg requestId "$REQUEST_ID" --arg target "$REMOTE_SHA" --arg from "$FROM_SHA" --arg prHead "$PULL_REQUEST_HEAD" \
    '{schemaVersion:3,kind:"lead-closeout-restart",decisionId:$requestId,waveId:"closeout-wave-1",revision:1,
      authority:{kind:"standing-carve-out",entryId:"lead-closeout-restart/v1",entryDigest:("a"*64),manifestRevision:2,manifestDigest:("b"*64)},
      intent:{kind:"closeout-restart-intent/v1",classification:"precondition-not-authorization",messageRef:{channelId:"100000000000000003",messageId:"100000000000000005",authorId:"100000000000000001",timestamp:"2026-09-17T20:00:00.000-07:00",contentDigest:("c"*64)},timezone:"America/Los_Angeles",founderLocalDate:"2026-09-17",expiresAt:"2026-09-18T07:00:00.000Z"},
      scopeSnapshot:{version:"restart-scope-snapshot/v1",capturedAt:"2026-09-17T21:50:00.000-07:00",sources:[],entries:[],snapshotDigest:("d"*64)},
      readiness:{kind:"all-ready",executionIds:[]},
      requestedBy:{projectName:"flywheel",leadId:"flywheel-eng-lead",instanceId:"current",botUserId:"100000000000000002"},
      announcement:{channelId:"100000000000000004",messageId:"100000000000000006",authorId:"100000000000000002",timestamp:"2026-09-17T21:59:00.000-07:00",contentDigest:("e"*64),purpose:"finish approved closeout",affectedExecutionIds:[],recoveryExpectations:"resume all parked executions"},
      fromDeployedSha:$from,targetSha:$target,executionPackage:{root:"/private/release",packageDigest:("f"*64),sourceCommit:$target},createdAt:"2026-09-17T22:00:00.000-07:00"}' > "$REQUEST_JSON"
  chmod 600 "$REQUEST_JSON"
}

reset_state() {
  rm -rf "$SELF_SHIP_URGENT_DIR" "$RESTART_REQUEST_AUDIT_DIR" \
    "$RESTART_REQUEST_INDEX" "$RESTART_WAVE_ACTIVE_TICKET" "$FLYWHEEL_HOME"/.urgent-claim.*
  mkdir -p "$FLYWHEEL_HOME"
  printf '%s\n' "$FROM_SHA" > "$REQUEST_RESTART_DEPLOYED_SHA_FILE"
  : > "$RR_GIT_LOG"
  : > "$RR_NODE_LOG"
  : > "$RR_LAUNCHCTL_LOG"
  : > "$RR_ALERT_LOG"
  write_request
}
token_count() { find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' 2>/dev/null | wc -l | tr -d ' '; }
token_path() { find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' 2>/dev/null | head -1; }
duplicate_audit_count() { find "$RESTART_REQUEST_AUDIT_DIR/restart-wave-duplicates" -type f 2>/dev/null | wc -l | tr -d ' '; }
json_result() { printf '%s\n' "$1" | tail -1 | jq -r '.result // empty' 2>/dev/null; }
json_ticket() { printf '%s\n' "$1" | tail -1 | jq -r '.ticket // empty' 2>/dev/null; }

reset_state
out="$("$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$?
token="$(token_path)"
audit="$RESTART_REQUEST_AUDIT_DIR/$REQUEST_ID.prepared.json"
if [ "$rc" -eq 0 ] && [ "$(token_count)" = 1 ] \
  && jq -e --arg target "$REMOTE_SHA" --arg from "$FROM_SHA" --arg pre "$PRE_MERGE_HEAD" '
      .schemaVersion == 3 and .kind == "lead-closeout-restart" and
      .authority.kind == "standing-carve-out" and .authority.entryId == "lead-closeout-restart/v1" and
      .requestedBy.leadId == "flywheel-eng-lead" and
      .targetSha == $target and .fromDeployedSha == $from and .preMergeHead == $pre and
      (.requestDigest | test("^[a-f0-9]{64}$"))' "$token" >/dev/null \
  && cmp -s "$token" "$audit" \
  && jq -e '.schemaVersion == 1' "$RESTART_REQUEST_INDEX" >/dev/null \
  && grep -q ' prepare ' "$RR_NODE_LOG" && grep -q ' transition ' "$RR_NODE_LOG" \
  && ! grep -q ' scope-snapshot ' "$RR_NODE_LOG" \
  && ! grep -q -- '--instance-id\|carrier-instance-raw-secret' "$RR_NODE_LOG" \
  && grep -q '^kickstart gui/.*/com.flywheel.updater$' "$RR_LAUNCHCTL_LOG" \
  && grep -q '不代表重启完成' <<<"$out"; then
  pass "verified v3 standing-authority request is audited and indexed before one no-k queue publication"
else
  fail "v3 happy path drifted (rc=$rc tokens=$(token_count) out=$out)"
fi

reset_state
out="$("$REQUEST" 2>&1)"; rc=$?
token="$(token_path)"
if [ "$rc" -eq 0 ] && [ "$(token_count)" = 1 ] \
  && jq -e --arg target "$REMOTE_SHA" '
      .schemaVersion == 1 and .kind == "founder-urgent-restart" and
      .targetSha == $target and (.createdAt | type == "number")' "$token" >/dev/null \
  && [ ! -s "$RR_NODE_LOG" ] \
  && grep -q '^kickstart gui/.*/com.flywheel.updater$' "$RR_LAUNCHCTL_LOG" \
  && grep -q '不代表重启完成' <<<"$out"; then
  pass "bare founder-direct request preserves the verdict-free urgent path"
else
  fail "bare founder-direct request regressed (rc=$rc tokens=$(token_count) out=$out)"
fi

reset_state
rejected_out="$(RR_CLI_OK=0 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rejected_rc=$?
fallback_out="$("$REQUEST" 2>&1)"; fallback_rc=$?
rejection="$(find "$RESTART_REQUEST_AUDIT_DIR/closeout-rejections" -type f 2>/dev/null | head -1)"
fallback="$(find "$RESTART_REQUEST_AUDIT_DIR/possible-closeout-fallback" -type f 2>/dev/null | head -1)"
if [ "$rejected_rc" -eq 69 ] && [ "$fallback_rc" -eq 0 ] \
  && [ -f "$rejection" ] && [ -f "$fallback" ] \
  && jq -e --arg decision "$REQUEST_ID" '
      .event == "possible-closeout-fallback" and
      .linkedRejection.decisionId == $decision and
      .singleAuthorizationRef == null and
      .anomaly == "missing-single-authorization-reference"' "$fallback" >/dev/null \
  && grep -q 'possible-closeout-fallback' <<<"$fallback_out" \
  && grep -q 'Possible closeout restart fallback' "$RR_ALERT_LOG"; then
  pass "bare v1 within 30 minutes of a rejected v3 is linked and visibly flagged when no single authorization reference exists"
else
  fail "possible-closeout-fallback audit missing (rc=$rejected_rc/$fallback_rc rejection=$rejection fallback=$fallback out=$rejected_out | $fallback_out)"
fi

reset_state
first_out="$("$REQUEST" 2>&1)"; first_rc=$?
second_out="$("$REQUEST" 2>&1)"; second_rc=$?
third_out="$("$REQUEST" 2>&1)"; third_rc=$?
if [ "$first_rc" -eq 0 ] && [ "$second_rc" -eq 0 ] && [ "$third_rc" -eq 0 ] \
  && [ "$(token_count)" = 1 ] \
  && [ "$(json_result "$first_out")" = accepted ] \
  && [ "$(json_result "$second_out")" = deduplicated-existing-ticket ] \
  && [ "$(json_result "$third_out")" = deduplicated-existing-ticket ] \
  && [ "$(duplicate_audit_count)" = 2 ] \
  && [ "$(grep -c '^kickstart ' "$RR_LAUNCHCTL_LOG")" = 1 ]; then
  pass "same restart condition submitted N times creates one ticket and auditable machine-readable dedup results"
else
  fail "same-condition single-wave invariant failed (rc=$first_rc/$second_rc/$third_rc tokens=$(token_count) audits=$(duplicate_audit_count) out=$first_out | $second_out | $third_out)"
fi

reset_state
first_out="$("$REQUEST" 2>&1)"; first_rc=$?
first_ticket="$(json_ticket "$first_out")"
mkdir -p "$FLYWHEEL_HOME/.urgent-claim.in-flight"
mv "$(token_path)" "$FLYWHEEL_HOME/.urgent-claim.in-flight/active-restart-wave.urgent.json"
different_out="$(RR_REMOTE_SHA="$OTHER_SHA" "$REQUEST" 2>&1)"; different_rc=$?
if [ "$first_rc" -eq 0 ] && [ "$different_rc" -eq 0 ] \
  && [ "$(json_result "$different_out")" = deduplicated-existing-ticket ] \
  && [ "$(token_count)" = 0 ] \
  && [ "$(find "$FLYWHEEL_HOME/.urgent-claim.in-flight" -name '*.urgent.json' | wc -l | tr -d ' ')" = 1 ] \
  && [ "$(duplicate_audit_count)" = 1 ]; then
  pass "a different target submitted during an active wave cannot create a concurrent or follow-on wave"
else
  fail "different-target active-wave guard failed (rc=$first_rc/$different_rc queue=$(token_count) audits=$(duplicate_audit_count) out=$different_out)"
fi
too_late_out="$("$REQUEST" --revoke --request "$first_ticket" 2>&1)"; too_late_rc=$?
if [ "$too_late_rc" -eq 75 ] \
  && [ "$(json_result "$too_late_out")" = too-late-wave-started ] \
  && [ "$(find "$FLYWHEEL_HOME/.urgent-claim.in-flight" -name '*.urgent.json' | wc -l | tr -d ' ')" = 1 ]; then
  pass "revocation after updater claim is explicit, non-successful, and cannot disguise an in-flight wave"
else
  fail "started-wave revocation was not explicit (rc=$too_late_rc out=$too_late_out)"
fi

reset_state
accepted_out="$("$REQUEST" 2>&1)"; accepted_rc=$?
accepted_ticket="$(json_ticket "$accepted_out")"
revoked_out="$("$REQUEST" --revoke --request "$accepted_ticket" 2>&1)"; revoked_rc=$?
again_out="$("$REQUEST" --revoke --request "$accepted_ticket" 2>&1)"; again_rc=$?
if [ "$accepted_rc" -eq 0 ] && [ "$revoked_rc" -eq 0 ] && [ "$again_rc" -eq 0 ] \
  && [ "$(json_result "$revoked_out")" = revoked-before-start ] \
  && [ "$(json_result "$again_out")" = already-revoked ] \
  && [ "$(token_count)" = 0 ] && [ ! -e "$RESTART_WAVE_ACTIVE_TICKET" ]; then
  pass "founder-direct pre-start revocation is deterministic and idempotent without natural-language scanning"
else
  fail "founder-direct deterministic revocation failed (rc=$accepted_rc/$revoked_rc/$again_rc queue=$(token_count) out=$revoked_out | $again_out)"
fi

reset_state
accepted_out="$("$REQUEST" --request "$REQUEST_JSON" 2>&1)"; accepted_rc=$?
: > "$RR_NODE_LOG"
revoked_out="$("$REQUEST" --revoke --request "$RESTART_REQUEST_AUDIT_DIR/$REQUEST_ID.prepared.json" 2>&1)"; revoked_rc=$?
if [ "$accepted_rc" -eq 0 ] && [ "$revoked_rc" -eq 0 ] \
  && [ "$(json_result "$revoked_out")" = revoked-before-start ] \
  && [ "$(token_count)" = 0 ] \
  && grep -q ' transition .*--state revoked' "$RR_NODE_LOG" \
  && ! grep -q ' prepare \| verify ' "$RR_NODE_LOG"; then
  pass "Lead-created v3 tickets use creator-independent deterministic revoke without a natural-language verification pass"
else
  fail "creator-independent v3 revocation failed (rc=$accepted_rc/$revoked_rc queue=$(token_count) node=$(cat "$RR_NODE_LOG") out=$revoked_out)"
fi

reset_state
jq '.schemaVersion=2 | .kind="authorized-urgent-restart" | .requestId=.decisionId | del(.decisionId)' "$REQUEST_JSON" > "$TMP/v2-request.json"
chmod 600 "$TMP/v2-request.json"
out="$("$REQUEST" --request "$TMP/v2-request.json" 2>&1)"; rc=$?
if [ "$rc" -eq 64 ] && [ "$(token_count)" = 0 ] \
  && [ ! -e "$RESTART_REQUEST_INDEX" ] && grep -q 'retired-conditional-authority' <<<"$out"; then
  pass "unstarted v2 request is retired before verification or durable state"
else
  fail "v2 request was not retired fail-closed (rc=$rc out=$out)"
fi

reset_state
out="$(cd "$TMP" && "$REQUEST" --request request.json 2>&1)"; rc=$?
if [ "$rc" -eq 64 ] && [ "$(token_count)" = 0 ]; then
  pass "relative request paths are refused"
else
  fail "relative request path escaped (rc=$rc out=$out)"
fi

for mode in remote deployed trigger cli; do
  reset_state
  case "$mode" in
    remote) out="$(RR_REMOTE_SHA=4444444444444444444444444444444444444444 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$? ;;
    deployed) printf '%s\n' 5555555555555555555555555555555555555555 > "$REQUEST_RESTART_DEPLOYED_SHA_FILE"; out="$("$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$? ;;
    trigger) out="$(RR_TRIGGER_PRESENT=0 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$? ;;
    cli) out="$(RR_CLI_OK=0 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$? ;;
  esac
  if [ "$rc" -ne 0 ] && [ "$(token_count)" = 0 ] && [ ! -e "$RESTART_REQUEST_INDEX" ]; then
    pass "$mode evidence failure creates no ticket or one-use state"
  else
    fail "$mode evidence failure escaped (rc=$rc tokens=$(token_count) out=$out)"
  fi
done

for mode in unloaded disabled; do
  reset_state
  if [ "$mode" = unloaded ]; then
    out="$(RR_UPDATER_LOADED=0 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$?
  else
    out="$(RR_DISABLED_MODE=disabled "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$?
  fi
  if [ "$rc" -eq 69 ] && [ "$(token_count)" = 0 ] && [ ! -e "$RESTART_REQUEST_INDEX" ]; then
    pass "$mode updater fails before durable request publication"
  else
    fail "$mode updater failure escaped (rc=$rc out=$out)"
  fi
done

reset_state
out="$("$REQUEST" --dry-run --request "$REQUEST_JSON" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ "$(token_count)" = 0 ] \
  && [ ! -e "$RESTART_REQUEST_AUDIT_DIR" ] && [ ! -e "$RESTART_REQUEST_INDEX" ] \
  && ! grep -q '^kickstart ' "$RR_LAUNCHCTL_LOG" && grep -q 'DRY RUN' <<<"$out"; then
  pass "dry-run verifies evidence but writes no Flywheel state, queue entry or launchd action"
else
  fail "dry-run mutated durable state (rc=$rc out=$out)"
fi

reset_state
out="$(RR_KICKSTART_OK=0 "$REQUEST" --request "$REQUEST_JSON" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(token_count)" = 1 ] \
  && [ -f "$RESTART_REQUEST_INDEX" ] && [ -f "$RESTART_REQUEST_AUDIT_DIR/$REQUEST_ID.prepared.json" ] \
  && grep -qi 'token\|票' <<<"$out"; then
  pass "kickstart uncertainty preserves one durable audited request without minting another"
else
  fail "kickstart uncertainty lost intent (rc=$rc tokens=$(token_count) out=$out)"
fi

if ! rg -q 'restart-services\.sh' "$REQUEST" \
  && rg -q 'restart-services\.sh" --reason updater' "$UPDATER"; then
  pass "request producer cannot bypass the independent updater transport"
else
  fail "request producer bypasses or no longer proves the updater transport"
fi

mkdir -p "$HOME/.flywheel/manifests"
jq -n --argjson pid "$$" \
  '{projectName:"flywheel",leadId:"flywheel-eng-lead",pid:$pid}' \
  > "$HOME/.flywheel/manifests/flywheel-flywheel-eng-lead.json"
chmod 600 "$HOME/.flywheel/manifests/flywheel-flywheel-eng-lead.json"
instance_out="$(
  "$REAL_NODE" "$REAL_RESTART_CLI" instance \
    --home "$HOME" --project flywheel --lead flywheel-eng-lead 2>&1
)"; instance_rc=$?
if [ "$instance_rc" -eq 0 ] \
  && [[ "$instance_out" =~ ^[a-f0-9]{64}$ ]] \
  && [[ "$instance_out" != *carrier-instance-raw-secret* ]]; then
  pass "real CLI resolves a live manifest generation to a public instance digest without the raw carrier claim"
else
  fail "real CLI did not resolve public runtime identity (rc=$instance_rc out=$instance_out)"
fi

jq '.pid = 99999999' "$HOME/.flywheel/manifests/flywheel-flywheel-eng-lead.json" \
  > "$HOME/.flywheel/manifests/dead.json"
mv "$HOME/.flywheel/manifests/dead.json" \
  "$HOME/.flywheel/manifests/flywheel-flywheel-eng-lead.json"
chmod 600 "$HOME/.flywheel/manifests/flywheel-flywheel-eng-lead.json"
dead_out="$(
  "$REAL_NODE" "$REAL_RESTART_CLI" instance \
    --home "$HOME" --project flywheel --lead flywheel-eng-lead 2>&1
)"; dead_rc=$?
if [ "$dead_rc" -ne 0 ] && [[ "$dead_out" == *lead-runtime-invalid* ]]; then
  pass "real CLI rejects a stale manifest PID instead of minting an instance digest"
else
  fail "real CLI accepted stale runtime identity (rc=$dead_rc out=$dead_out)"
fi

# A standing-authority producer is itself authority-sensitive code. Once an
# independently confirmed active package exists, explicit v3 create/revoke
# requests must execute from that immutable package. The founder-direct bare
# v1 interface stays on its existing path and is not reinterpreted as standing
# authority.
reset_state
PACKAGE_ROOT="$TMP/immutable-package"
PACKAGE_CLI_REL=packages/teamlead/dist/bin/standing-authority-package-cli.js
PACKAGE_REQUEST_REL=scripts/request-restart.sh
mkdir -p "$PACKAGE_ROOT/$(dirname "$PACKAGE_CLI_REL")" "$PACKAGE_ROOT/scripts"
printf '%s\n' '#!/usr/bin/env node' > "$PACKAGE_ROOT/$PACKAGE_CLI_REL"
chmod 500 "$PACKAGE_ROOT/$PACKAGE_CLI_REL"
PACKAGE_CLI_DIGEST="$(shasum -a 256 "$PACKAGE_ROOT/$PACKAGE_CLI_REL" | awk '{print $1}')"
PACKAGE_DIGEST="$(printf 'f%.0s' {1..64})"
jq -n \
  --arg packageDigest "$PACKAGE_DIGEST" \
  --arg cliPath "$PACKAGE_CLI_REL" \
  --arg cliDigest "$PACKAGE_CLI_DIGEST" \
  '{packageDigest:$packageDigest,files:[{path:$cliPath,sha256:$cliDigest}]}' \
  > "$PACKAGE_ROOT/standing-authority-package.json"
chmod 400 "$PACKAGE_ROOT/standing-authority-package.json"
PACKAGE_LOG="$TMP/package-request.log"
export RR_PACKAGE_LOG="$PACKAGE_LOG"
printf '%s\n' '#!/usr/bin/env bash' 'printf "packaged:%s\n" "$*" >> "$RR_PACKAGE_LOG"' \
  > "$PACKAGE_ROOT/$PACKAGE_REQUEST_REL"
chmod 500 "$PACKAGE_ROOT/$PACKAGE_REQUEST_REL"
mkdir -p "$HOME/.flywheel/state/standing-authority"
PACKAGE_RECEIPT="$(printf '9%.0s' {1..64})"
jq -n --arg root "$PACKAGE_ROOT" --arg digest "$PACKAGE_DIGEST" --arg receipt "$PACKAGE_RECEIPT" \
  '{schemaVersion:1,immutableRoot:$root,packageDigest:$digest,activatedByReceiptId:$receipt}' \
  > "$HOME/.flywheel/state/standing-authority/active-package.json"
chmod 600 "$HOME/.flywheel/state/standing-authority/active-package.json"

# FLY-2654 review R7 round 2: an active-package pointer is only a request; the
# fence must read the Bridge confirmation ledger back. Seed a ledger row that
# binds the pointer's activatedByReceiptId to the package digest.
seed_standing_ledger() {
    local ledger="$1" receipt="$2" package_digest="$3"
    mkdir -p "$(dirname "$ledger")"
    # Production shape: WAL StateStore after a clean Bridge close (no -wal/-shm).
    sqlite3 "$ledger" "PRAGMA journal_mode=wal; CREATE TABLE IF NOT EXISTS standing_authority_confirmation (receipt_id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_digest TEXT NOT NULL, evidence_body_digest TEXT NOT NULL, package_digest TEXT NOT NULL, confirmer_identity TEXT NOT NULL, confirmer_identity_digest TEXT NOT NULL, carrier_claim TEXT NOT NULL, confirmed_at TEXT NOT NULL, recorded_at TEXT NOT NULL); INSERT OR REPLACE INTO standing_authority_confirmation VALUES ('${receipt}','raya-carrier-follow-main/v1',1,'$(printf 'a%.0s' {1..64})','$(printf 'b%.0s' {1..64})','${package_digest}','flywheel-cos-lead','$(printf 'c%.0s' {1..64})','carrier-claim','2026-09-21T00:00:00.000Z','2026-09-21T00:00:01.000Z');" > /dev/null
    rm -f "${ledger}-wal" "${ledger}-shm"
}

# Without the Bridge confirmation row the pointer alone must not elect the
# package (review R7 round 2).
: > "$RR_NODE_LOG"
unconfirmed_out="$($REQUEST --request "$REQUEST_JSON" 2>&1)"; unconfirmed_rc=$?
if [ "$unconfirmed_rc" -eq 78 ] \
  && printf '%s' "$unconfirmed_out" | grep -Fq 'confirmation-ledger-unavailable' \
  && ! grep -q ' resolve ' "$RR_NODE_LOG" \
  && [ ! -s "$PACKAGE_LOG" ] \
  && [ "$(token_count)" = 0 ]; then
  pass "an active-package pointer without a Bridge confirmation row cannot elect the execution package"
else
  fail "pointer-only activation elected the package (rc=$unconfirmed_rc out=$unconfirmed_out node=$(cat "$RR_NODE_LOG"))"
fi
seed_standing_ledger "$HOME/.flywheel/teamlead.db" "$(printf '5%.0s' {1..64})" "$PACKAGE_DIGEST"
: > "$RR_NODE_LOG"
missing_row_out="$($REQUEST --request "$REQUEST_JSON" 2>&1)"; missing_row_rc=$?
if [ "$missing_row_rc" -eq 78 ] \
  && printf '%s' "$missing_row_out" | grep -Fq 'confirmation-record-missing' \
  && [ ! -s "$PACKAGE_LOG" ]; then
  pass "a ledger without the pointer's receipt row refuses the package"
else
  fail "missing receipt row elected the package (rc=$missing_row_rc out=$missing_row_out)"
fi
seed_standing_ledger "$HOME/.flywheel/teamlead.db" "$PACKAGE_RECEIPT" "$PACKAGE_DIGEST"
: > "$RR_NODE_LOG"
packaged_out="$($REQUEST --request "$REQUEST_JSON" 2>&1)"; packaged_rc=$?
if [ "$packaged_rc" -eq 0 ] \
  && grep -Fq "packaged:--request $REQUEST_JSON" "$PACKAGE_LOG" \
  && grep -q ' verify ' "$RR_NODE_LOG" \
  && grep -q ' resolve ' "$RR_NODE_LOG" \
  && ! grep -q ' prepare ' "$RR_NODE_LOG" \
  && [ "$(token_count)" = 0 ]; then
  pass "explicit standing-authority requests enter the independently confirmed immutable execution package"
else
  fail "standing-authority producer did not enter the active package (rc=$packaged_rc out=$packaged_out node=$(cat "$RR_NODE_LOG"))"
fi

reset_state
spoofed_out="$(FLYWHEEL_STANDING_PACKAGE_ACTIVE=1 \
  FLYWHEEL_STANDING_PACKAGE_ROOT="$PACKAGE_ROOT" \
  $REQUEST --request "$REQUEST_JSON" 2>&1)"; spoofed_rc=$?
if [ "$spoofed_rc" -eq 78 ] && [ "$(token_count)" = 0 ] \
  && ! grep -q ' prepare ' "$RR_NODE_LOG"; then
  pass "caller-controlled package-active environment cannot bypass the immutable producer entry"
else
  fail "package-active environment bypassed immutable producer admission (rc=$spoofed_rc out=$spoofed_out)"
fi

reset_state
chmod 700 "$PACKAGE_ROOT/$PACKAGE_CLI_REL"
printf '%s\n' '// tampered' >> "$PACKAGE_ROOT/$PACKAGE_CLI_REL"
chmod 500 "$PACKAGE_ROOT/$PACKAGE_CLI_REL"
tampered_out="$($REQUEST --request "$REQUEST_JSON" 2>&1)"; tampered_rc=$?
if [ "$tampered_rc" -eq 78 ] && [ "$(token_count)" = 0 ] \
  && ! grep -q ' prepare ' "$RR_NODE_LOG"; then
  pass "a tampered active execution package fails closed without mutable-checkout fallback"
else
  fail "tampered package escaped to mutable request code (rc=$tampered_rc out=$tampered_out)"
fi

reset_state
before_package_lines="$(wc -l < "$PACKAGE_LOG" | tr -d ' ')"
bare_out="$($REQUEST 2>&1)"; bare_rc=$?
after_package_lines="$(wc -l < "$PACKAGE_LOG" | tr -d ' ')"
if [ "$bare_rc" -eq 0 ] && [ "$before_package_lines" = "$after_package_lines" ] \
  && [ "$(token_count)" = 1 ] && [ ! -s "$RR_NODE_LOG" ]; then
  pass "bare founder-direct v1 bypasses the standing-authority package entry"
else
  fail "bare founder-direct path was reinterpreted by package entry (rc=$bare_rc out=$bare_out)"
fi

# FLY-2654 QA2 rework (hard-red 3): everything above drives the shell transport
# through a node shim, so a mutant inside the shipped dist producer stayed green
# here. Drive the REAL dist module with a digest-bound fixture: a non-matching
# founder intent and an announcement that drops any one required line must be
# refused by the compiled bytes the immutable package ships, not only by the
# TypeScript vitest.
if [ -f "$REAL_RESTART_CLI" ]; then
  cat > "$TMP/dist-closeout-guards.mjs" <<'EOF'
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
const dist = await import(pathToFileURL(process.argv[2]).href);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const founderId = "100000000000000001", leadBotId = "100000000000000002";
const founderChannel = "100000000000000003", engineerChannel = "100000000000000004";
const founderMessageId = "100000000000000005", announcementMessageId = "100000000000000006";
const decisionId = "11111111-2222-4333-8444-555555555555";
const executionId = "21111111-2222-4333-8444-555555555555";
const fromSha = "1".repeat(40), targetSha = "2".repeat(40), headSha = "3".repeat(40);
const createdAt = "2026-09-17T22:00:00.000-07:00";
function fixture(intentText, dropLine = -1) {
  const scope = {
    version: "restart-scope-snapshot/v1", capturedAt: "2026-09-17T21:50:00.000-07:00",
    sources: [
      { kind: "state-store", receiptId: "state-1", digest: "4".repeat(64) },
      { kind: "comm-db", receiptId: "comm-1", digest: "5".repeat(64) },
      { kind: "turn-wake", receiptId: "turn-1", digest: "6".repeat(64) },
      { kind: "process-service", receiptId: "process-1", digest: "7".repeat(64) },
    ],
    entries: [{
      executionId, activationId: "activation-1", project: "flywheel", phase: "implement",
      repo: "xrliAnnie/flywheel", worktree: "/Users/test/Dev/flywheel-FLY-3000",
      headSha, pushedHeadSha: headSha, clean: true, parked: true, activeWrite: false, pendingWakeIds: [],
      verdict: { kind: "code-review", receiptId: "review-1", status: "approved", headSha },
      recovery: { path: "/Users/test/.flywheel/recovery/exec-1.json", digest: "d".repeat(64) },
    }],
    snapshotDigest: "",
  };
  scope.snapshotDigest = dist.closeoutScopeDigest(scope);
  const lines = [
    `[closeout-restart:${decisionId}:r1]`, "wave:closeout-wave-1",
    `intent:${founderChannel}/${founderMessageId}`, `scope:${scope.snapshotDigest}`,
    `target:${targetSha}`, "purpose:finish the approved closeout restart",
    `interrupts:${executionId}`, "recovery:resume every parked execution from its durable context",
  ];
  const announcementText = lines.filter((_, at) => at !== dropLine).join("\n");
  const request = {
    schemaVersion: 3, kind: "lead-closeout-restart", decisionId, waveId: "closeout-wave-1", revision: 1,
    authority: { kind: "standing-carve-out", entryId: "lead-closeout-restart/v1", entryDigest: "a".repeat(64), manifestRevision: 2, manifestDigest: "b".repeat(64) },
    intent: {
      kind: "closeout-restart-intent/v1", classification: "precondition-not-authorization",
      messageRef: { channelId: founderChannel, messageId: founderMessageId, authorId: founderId, timestamp: "2026-09-17T20:00:00.000-07:00", contentDigest: digest(intentText) },
      timezone: "America/Los_Angeles", founderLocalDate: "2026-09-17", expiresAt: "2026-09-18T07:00:00.000Z",
    },
    scopeSnapshot: scope, readiness: { kind: "all-ready", executionIds: [executionId] },
    requestedBy: { projectName: "flywheel", leadId: "flywheel-eng-lead", instanceId: "e".repeat(64), botUserId: leadBotId },
    announcement: {
      channelId: engineerChannel, messageId: announcementMessageId, authorId: leadBotId,
      timestamp: "2026-09-17T21:59:00.000-07:00", contentDigest: digest(announcementText),
      purpose: "finish the approved closeout restart", affectedExecutionIds: [executionId],
      recoveryExpectations: "resume every parked execution from its durable context",
    },
    fromDeployedSha: fromSha, targetSha,
    executionPackage: { root: "/Users/test/.flywheel/releases/standing/package-1", packageDigest: "c".repeat(64), sourceCommit: targetSha },
    createdAt,
  };
  const context = {
    now: Date.parse(createdAt) + 1000, founderId, founderTimezone: "America/Los_Angeles",
    founderMessage: { id: founderMessageId, channelId: founderChannel, authorId: founderId, authorBot: false, content: intentText, timestamp: "2026-09-17T20:00:00.000-07:00" },
    announcementMessage: { id: announcementMessageId, channelId: engineerChannel, authorId: leadBotId, authorBot: true, content: announcementText, timestamp: "2026-09-17T21:59:00.000-07:00" },
    laterFounderMessages: [], contextComplete: true,
    leadRegistry: [{ projectName: "flywheel", leadId: "flywheel-eng-lead", botUserId: leadBotId }],
    currentInstanceId: "e".repeat(64), deployedSha: fromSha, remoteMainSha: targetSha, preMergeHead: fromSha,
    activeAuthority: { entryDigest: "a".repeat(64), manifestRevision: 2, manifestDigest: "b".repeat(64), packageDigest: "c".repeat(64), packageRoot: request.executionPackage.root, sourceCommit: targetSha },
    currentScopeSnapshot: structuredClone(scope),
  };
  return { request, context, lineCount: lines.length };
}
const outcome = (intent, drop) => {
  const { request, context, lineCount } = fixture(intent, drop);
  try { return { ok: true, decisionId: dist.prepareCloseoutRestartTicket(request, context).decisionId, lineCount }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error), lineCount }; }
};
// Review round 5 HIGH: the shipped one-use ledger must stay terminal after a
// started wave failed with side effects; no re-prepare, no retroactive
// zero-side-effect stamp.
const ledgerReplay = () => {
  const { request, context } = fixture("收尾后重启", -1);
  const ticket = dist.prepareCloseoutRestartTicket(request, context);
  let index = dist.transitionRestartIntent(undefined, ticket, { state: "prepared", at: createdAt, zeroSideEffects: true });
  const attempt = (action) => { try { dist.transitionRestartIntent(index, ticket, action); return "accepted"; } catch (error) { return String(error?.message ?? error); } };
  // Producer re-submission plants the flag on the prepared row (review round 6).
  index = dist.transitionRestartIntent(index, ticket, { state: "prepared", at: "2026-09-18T05:00:30.000Z", zeroSideEffects: true });
  const plantedZero = Object.values(index.intents)[0].zeroSideEffects ?? null;
  const startedStamp = attempt({ state: "started", at: "2026-09-18T05:01:00.000Z", waveId: ticket.waveId, zeroSideEffects: true });
  index = dist.transitionRestartIntent(index, ticket, { state: "started", at: "2026-09-18T05:01:00.000Z", waveId: ticket.waveId });
  const startedZero = Object.values(index.intents)[0].zeroSideEffects ?? null;
  const stamp = attempt({ state: "failed", at: "2026-09-18T05:02:00.000Z", waveId: ticket.waveId, zeroSideEffects: true });
  index = dist.transitionRestartIntent(index, ticket, { state: "failed", at: "2026-09-18T05:02:00.000Z", waveId: ticket.waveId });
  const rearm = attempt({ state: "prepared", at: "2026-09-18T05:03:00.000Z", zeroSideEffects: true });
  return { stamp, rearm, plantedZero, startedStamp, startedZero, terminalState: Object.values(index.intents)[0].state, terminalZero: Object.values(index.intents)[0].zeroSideEffects ?? null };
};
const report = {
  ledger: ledgerReplay(),
  positive: outcome("收尾后重启", -1),
  nonMatching: ["先交给班车，然后请重启", "收尾后重启吗？", "不要收尾后重启", "昨天收尾后重启"].map((text) => ({ text, ...outcome(text, -1) })),
  dropped: [],
};
for (let at = 0; at < report.positive.lineCount; at += 1) report.dropped.push({ at, ...outcome("收尾后重启", at) });
process.stdout.write(`${JSON.stringify(report)}\n`);
EOF
  guards_out="$("$REAL_NODE" "$TMP/dist-closeout-guards.mjs" "$REAL_RESTART_CLI" 2>&1)"; guards_rc=$?
  if [ "$guards_rc" -eq 0 ] \
    && jq -e --arg decision "$REQUEST_ID" '
        .ledger.stamp == "restart-request-side-effects-not-provable" and
        .ledger.rearm == "restart-request-already-used" and
        .ledger.plantedZero == true and .ledger.startedStamp == "restart-request-side-effects-not-provable" and .ledger.startedZero == null and
        .ledger.terminalState == "failed" and .ledger.terminalZero == null and
        .positive.ok == true and .positive.decisionId == $decision and .positive.lineCount == 8 and
        (.nonMatching | length == 4) and all(.nonMatching[]; .ok == false and .error == "restart-request-intent-unverified") and
        (.dropped | length == 8) and all(.dropped[]; .ok == false and .error == "restart-request-announcement-unbound")' \
        <<<"$guards_out" >/dev/null; then
    pass "shipped dist producer refuses non-matching founder intent, any dropped announcement line, and re-arming a failed started wave"
  else
    fail "shipped dist producer guards drifted (rc=$guards_rc out=$guards_out)"
  fi
else
  fail "teamlead dist is required for the dist-driven closeout guards: missing $REAL_RESTART_CLI"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
