#!/usr/bin/env bash
# FLY-2271: hermetic before/after evidence for profile switching and daemon restart.
set -euo pipefail

SCENARIO="${1:-all}"
shift || true
case "$SCENARIO" in
  token-rotation|true-drift|old-daemon|all) ;;
  *) echo "usage: $0 <token-rotation|true-drift|old-daemon|all> [--baseline <ref>] [--old-daemon-ref <ref>]" >&2; exit 2 ;;
esac
BASELINE_REF=""
OLD_DAEMON_REF="155e1e78a^"
while (( $# > 0 )); do
  case "$1" in
    --baseline) BASELINE_REF="${2:?missing baseline ref}"; shift 2 ;;
    --old-daemon-ref) OLD_DAEMON_REF="${2:?missing old-daemon ref}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EVIDENCE_DIR="$REPO_DIR/engineering/doc/FLY-2271-daemon-switch-evidence/evidence"
TMP_BASE="${TMPDIR:-/tmp}"
ROOT="$(mktemp -d "${TMP_BASE%/}/fly2271-switch-e2e.XXXXXX")"
ROOT="$(cd "$ROOT" && pwd -P)"
CURRENT_TREE="$REPO_DIR"
BASELINE_TREE=""
OLD_TREE=""
SERVER_PID=""
DAEMON_PID=""
WORKTREES=""
STARTED_PID=""
ADDED_TREE=""
PORT=""

log() { echo "[FLY-2271 E2E] $*"; }
fail() { echo "[FLY-2271 E2E] FAIL: $*" >&2; exit 1; }
stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  local tree
  stop_pid "$DAEMON_PID"
  stop_pid "$SERVER_PID"
  for tree in $WORKTREES; do git -C "$REPO_DIR" worktree remove --force "$tree" >/dev/null 2>&1 || true; done
  if [[ "${FLYWHEEL_QUOTA_E2E_KEEP:-0}" == "1" ]]; then
    log "kept scratch evidence at $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
on_error() {
  local rc=$?
  find "$ROOT" -name daemon.log -o -name manual.log 2>/dev/null | while IFS= read -r file; do
    echo "--- $file" >&2
    tail -30 "$file" >&2 || true
  done
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT

for tool in node pnpm jq git curl; do command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"; done

build_tree() {
  local tree="$1"
  (cd "$tree" && pnpm --filter flywheel-teamlead build >/dev/null) || fail "teamlead build failed in $tree"
}
add_tree() {
  local name="$1" ref="$2" tree
  tree="$ROOT/tree-$name"
  git -C "$REPO_DIR" worktree add --detach "$tree" "$ref" >/dev/null || fail "could not create $name worktree at $ref"
  WORKTREES="$WORKTREES $tree"
  if ! (cd "$tree" && pnpm --store-dir "$REPO_DIR/.pnpm-store" --filter 'flywheel-teamlead...' install --offline --frozen-lockfile && pnpm --filter 'flywheel-teamlead^...' build && pnpm --filter flywheel-teamlead build) > "$ROOT/$name-build.log" 2>&1; then
    tail -80 "$ROOT/$name-build.log" >&2 || true
    fail "offline install/build failed for $name at $ref"
  fi
  if [[ -x "$tree/packages/teamlead/bin/flywheel-claude-switch" ]]; then
    [[ "$("$tree/packages/teamlead/bin/flywheel-claude-switch" --runtime-check)" == "FLYWHEEL_ATOMIC_SWITCH_RUNTIME_OK" ]] \
      || fail "built $name switch runtime failed its self-check"
  fi
  ADDED_TREE="$tree"
}

log "building current daemon"
build_tree "$CURRENT_TREE"
if [[ -n "$BASELINE_REF" ]]; then
  add_tree baseline "$BASELINE_REF"
  BASELINE_TREE="$ADDED_TREE"
fi
if [[ "$SCENARIO" == "old-daemon" || "$SCENARIO" == "all" ]]; then
  add_tree old-daemon "$OLD_DAEMON_REF"
  OLD_TREE="$ADDED_TREE"
fi

mkdir -p "$ROOT/bin" "$ROOT/seed/pool" "$EVIDENCE_DIR"

cat > "$ROOT/bin/security" <<'SECURITY'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  find-generic-password)
    if [[ -f "$FAKE_SECURITY_FAIL_NEXT_READ_FILE" ]]; then
      rm -f "$FAKE_SECURITY_FAIL_NEXT_READ_FILE"
      exit 1
    fi
    cat "$FAKE_SECURITY_STATE"
    ;;
  -i)
    command_text="$(cat)"
    value="$(printf '%s' "$command_text" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
    [[ -n "$value" ]] || exit 2
    printf '%s' "$value" > "$FAKE_SECURITY_STATE"
    chmod 600 "$FAKE_SECURITY_STATE"
    ;;
  *) exit 2 ;;
esac
SECURITY
cat > "$ROOT/bin/lead-alert" <<'ALERT'
#!/usr/bin/env bash
set -euo pipefail
kind="" body=""
while (( $# > 0 )); do
  case "$1" in
    --kind) kind="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
jq -cn --arg kind "$kind" --arg body "$body" '{kind:$kind,body:$body}' >> "$FAKE_ALERT_LOG"
printf 'sent\n'
ALERT
cat > "$ROOT/bin/tmux" <<'TMUX'
#!/usr/bin/env bash
exit 1
TMUX
cat > "$ROOT/bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'unexpected claude invocation\n' >> "$CLAUDE_PARTICIPATION_LOG"
exit 99
CLAUDE
chmod +x "$ROOT/bin/security" "$ROOT/bin/lead-alert" "$ROOT/bin/tmux" "$ROOT/bin/claude"

cat > "$ROOT/mock-server.mjs" <<'MOCK'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const [portFile] = process.argv.slice(2);
let refresh = 0;
const classify = (auth) => auth.includes("personal-") ? "personal" : auth.includes("school-") ? "school" : auth.includes("business-") ? "business" : "unknown";
const identity = {
  personal: { uuid: "uuid-personal", email: "personal@example.test" },
  school: { uuid: "uuid-school", email: "school@example.test" },
  business: { uuid: "uuid-business", email: "business@example.test" },
};
const respond = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};
const usage = (name) => ({
  five_hour: { utilization: name === "school" ? 5 : 95, resets_at: new Date(Date.now() + 2 * 60 * 60_000).toISOString() },
  seven_day: { utilization: name === "school" ? 5 : 50, resets_at: new Date(Date.now() + (name === "school" ? 24 : 72) * 60 * 60_000).toISOString() },
  limits: [],
});
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/oauth/profile") {
    const name = classify(String(req.headers.authorization ?? ""));
    return name === "unknown" ? respond(res, 401, { error: "unauthorized" }) : respond(res, 200, { account: identity[name] });
  }
  if (req.method === "GET" && req.url === "/api/oauth/usage") {
    const name = classify(String(req.headers.authorization ?? ""));
    return name === "unknown" ? respond(res, 401, { error: "unauthorized" }) : respond(res, 200, usage(name));
  }
  if (req.method === "POST" && req.url === "/v1/oauth/token") {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return respond(res, 400, { error: "bad_json" }); }
      const name = String(body.refresh_token ?? "").split("-")[0];
      if (!(name in identity)) return respond(res, 401, { error: "bad_refresh" });
      refresh += 1;
      return respond(res, 200, { access_token: `${name}-refreshed-${refresh}`, refresh_token: `${name}-refresh-${refresh}`, expires_in: 3600 });
    });
    return;
  }
  respond(res, 404, { error: "not_found" });
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, `${server.address().port}\n`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
MOCK
node "$ROOT/mock-server.mjs" "$ROOT/http-port" > "$ROOT/http.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do [[ -s "$ROOT/http-port" ]] && break; sleep 0.05; done
[[ -s "$ROOT/http-port" ]] || fail "mock server did not bind"
PORT="$(cat "$ROOT/http-port")"

make_credential() {
  local profile="$1" email="$2" dir credential
  dir="$ROOT/seed/pool/$profile"
  mkdir -p "$dir"
  credential="$(jq -cn --arg access "$profile-original" --arg refresh "$profile-refresh" \
    '{claudeAiOauth:{accessToken:$access,refreshToken:$refresh,expiresAt:4102444800000}}')"
  printf '%s' "$credential" > "$dir/.credentials.json"
  jq -cn --arg profile "$profile" --arg email "$email" \
    '{accountUuid:("uuid-"+$profile),emailAddress:$email,organizationUuid:("org-"+$profile),organizationName:("Org "+$profile)}' > "$dir/oauthAccount.json"
  jq -cn --arg profile "$profile" --arg email "$email" \
    '{accountUuid:("uuid-"+$profile),email:$email,anchoredAt:"2026-09-02T00:00:00.000Z",anchoredBy:"fly2271-e2e",confirmedBy:"scratch-fixture"}' > "$dir/identity-anchor.json"
  chmod 700 "$dir"
  chmod 600 "$dir"/*.json "$dir"/.credentials.json
}
make_credential personal personal@example.test
make_credential school school@example.test
make_credential business business@example.test
chmod 700 "$ROOT/seed/pool"
printf '%s' personal > "$ROOT/seed/pool/.active"
chmod 600 "$ROOT/seed/pool/.active"
jq -n '{version:1,artifactId:"fly2271-e2e-map",confirmedAt:"2026-09-02T00:00:00.000Z",labels:{personal:"personal@example.test",school:"school@example.test",business:"business@example.test"}}' > "$ROOT/seed/pool/identity-map.json"
chmod 600 "$ROOT/seed/pool/identity-map.json"
jq -n '{generation:0,activeAccount:"personal",accounts:[
  {name:"personal",identity:{email:"personal@example.test",setAt:"2026-09-02T00:00:00.000Z"}},
  {name:"school",identity:{email:"school@example.test",setAt:"2026-09-02T00:00:00.000Z"}},
  {name:"business",identity:{email:"business@example.test",setAt:"2026-09-02T00:00:00.000Z"}}
] | map(. + {quotaExhaustedUntil:null,weeklyResetAt:null})}' > "$ROOT/seed/store.json"
jq -n '{trigger5hPct:90,basePollMinutes:1,acceleratePct:70,acceleratedPollMinutes:1,candidateSweepMinutes:60,minSwitchIntervalMinutes:1,order:["personal","school","business"],writeStatuslineCache:true,paneScanSeconds:60,confirmDelayMinutes:5}' > "$ROOT/seed/config.json"
jq -n '{numStartups:1,oauthAccount:{accountUuid:"uuid-personal",emailAddress:"personal@example.test",organizationUuid:"org-personal",organizationName:"Org personal"}}' > "$ROOT/seed/claude.json"

make_fixture() {
  local name="$1" fixture
  fixture="$ROOT/fixtures/$name"
  mkdir -p "$fixture/home/.flywheel" "$fixture/home/.claude" "$fixture/bin"
  cp -R "$ROOT/seed/pool" "$fixture/pool"
  cp "$ROOT/seed/store.json" "$fixture/home/.flywheel/claude-accounts.json"
  cp "$ROOT/seed/config.json" "$fixture/home/.flywheel/quota-monitor.json"
  cp "$ROOT/seed/claude.json" "$fixture/home/.claude.json"
  printf '%s' "$(cat "$fixture/pool/personal/.credentials.json")" > "$fixture/keychain.json"
  chmod 600 "$fixture/home/.flywheel/"*.json "$fixture/home/.claude.json" "$fixture/keychain.json"
  : > "$fixture/daemon.log"
  : > "$fixture/alerts.log"
  : > "$fixture/claude.log"
  printf '%s\n' "$fixture"
}

export_fixture_env() {
  local fixture="$1" tree="$2" profile_tree="$3"
  export HOME="$fixture/home"
  export PATH="$ROOT/bin:$PATH"
  export FLYWHEEL_QUOTA_MONITOR_CONFIG="$fixture/home/.flywheel/quota-monitor.json"
  export FLYWHEEL_QUOTA_API_BASE="http://127.0.0.1:$PORT"
  export FLYWHEEL_QUOTA_STATUSLINE_CACHE="$fixture/home/.claude/usage-api-cache.json"
  export FLYWHEEL_QUOTA_STATE_PATH="$fixture/home/.flywheel/quota-monitor-state.json"
  export FLYWHEEL_QUOTA_PIDFILE="$fixture/home/.flywheel/quota-monitor.pid"
  export FLYWHEEL_QUOTA_HEALTH_MARKER="$fixture/home/.flywheel/quota-monitor.health.json"
  export FLYWHEEL_QUOTA_RUN_MARKER="$fixture/home/.flywheel/quota-monitor.running"
  export FLYWHEEL_QUOTA_CONFIRMATION_DIR="$fixture/confirmations"
  export FLYWHEEL_QUOTA_TMUX_SOCKET="fly2271-e2e-$$"
  export FLYWHEEL_CLAUDE_PROFILES_DIR="$fixture/pool"
  export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$fixture/home/.flywheel/claude-accounts.json"
  export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$fixture/home/.flywheel/claude-accounts.lock"
  export FLYWHEEL_CLAUDE_SECURITY_BIN="$ROOT/bin/security"
  export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="FLY-2271 Scratch-credentials"
  export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="fly2271-e2e"
  export FLYWHEEL_CLAUDE_PROFILE_BIN="$profile_tree/packages/claude-runner/bin/flywheel-claude-profile"
  export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$tree/packages/teamlead/bin/flywheel-claude-freshness"
  export FLYWHEEL_CLAUDE_OAUTH_ENDPOINT="http://127.0.0.1:$PORT/v1/oauth/token"
  export FLYWHEEL_PROFILE_IDENTITY_ENDPOINT="http://127.0.0.1:$PORT/v1/oauth/profile"
  export FLYWHEEL_PROFILE_IDENTITY_MAP="$fixture/pool/identity-map.json"
  export FLYWHEEL_PROFILE_AUDIT_LOG="$fixture/audit.log"
  export FLYWHEEL_CLAUDE_JSON="$fixture/home/.claude.json"
  export FLYWHEEL_CLAUDE_JSON_LOCK="$fixture/home/.claude.json.lock"
  export FLYWHEEL_LEAD_ALERT_BIN="$ROOT/bin/lead-alert"
  export FLYWHEEL_NOTIFY_CHANNEL="777777777777777777"
  export FLYWHEEL_FOUNDER_TZ="America/Los_Angeles"
  export FAKE_SECURITY_STATE="$fixture/keychain.json"
  export FAKE_SECURITY_FAIL_NEXT_READ_FILE="$fixture/fail-next-security-read"
  export FAKE_ALERT_LOG="$fixture/alerts.log"
  export CLAUDE_PARTICIPATION_LOG="$fixture/claude.log"
  FLYWHEEL_NODE_BIN="$(command -v node)"
  export FLYWHEEL_NODE_BIN
}

rotate_live_personal() {
  local fixture="$1"
  jq -c '.claudeAiOauth.accessToken="personal-rotated"' "$fixture/keychain.json" > "$fixture/keychain.next"
  chmod 600 "$fixture/keychain.next"
  mv "$fixture/keychain.next" "$fixture/keychain.json"
}
drift_live_to_business() { cp "$1/pool/business/.credentials.json" "$1/keychain.json"; chmod 600 "$1/keychain.json"; }

wait_for_log() {
  local file="$1" pattern="$2"
  for _ in $(seq 1 300); do grep -E "$pattern" "$file" >/dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
start_daemon() {
  local tree="$1" fixture="$2" mode="${3:-truncate}"
  if [[ "$mode" == "append" ]]; then
    "$tree/packages/teamlead/bin/flywheel-quota-monitor" >> "$fixture/daemon.log" 2>&1 &
  else
    "$tree/packages/teamlead/bin/flywheel-quota-monitor" > "$fixture/daemon.log" 2>&1 &
  fi
  STARTED_PID=$!
  DAEMON_PID="$STARTED_PID"
}
stop_daemon() { stop_pid "$DAEMON_PID"; DAEMON_PID=""; }

write_evidence() {
  local scenario="$1" revision="$2" entry="$3" fixture="$4" rc="$5" output
  output="$EVIDENCE_DIR/$scenario-$revision-$entry.json"
  local audit alerts daemon
  audit="$fixture/audit.log"
  alerts="$fixture/alerts.log"
  daemon="$fixture/daemon.log"
  [[ -f "$audit" ]] || : > "$audit"
  jq -Rsc --argjson rc "$rc" \
    --slurpfile alerts <(jq -s '.' "$alerts" 2>/dev/null || printf '[]') \
    --slurpfile events <(jq -Rsc '[split("\n")[] | fromjson? | select(.event == "quota_poll" or .event == "account_switch_failed" or .event == "account_switch_reconcile") | {event,outcome,trigger,reasonCode,exitCode,childStarted,detail,from,to,ok}]' "$daemon") \
    '{rc:$rc,auditLines:[split("\n")[] | fromjson? | {cmd,phase,exitCode,probeSummary}],events:$events[0],alertBodies:[$alerts[0][]?.body]}' \
    "$audit" > "$output"
}

run_manual() {
  local scenario="$1" revision="$2" tree="$3" fixture rc=0
  fixture="$(make_fixture "$scenario-$revision-manual")"
  export_fixture_env "$fixture" "$tree" "$tree"
  if [[ "$scenario" == "token-rotation" ]]; then rotate_live_personal "$fixture"; else drift_live_to_business "$fixture"; fi
  set +e
  "$tree/packages/claude-runner/bin/flywheel-claude-profile" use school > "$fixture/manual.log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { tail -80 "$fixture/manual.log" >&2; fail "$scenario $revision manual returned $rc"; }
  [[ "$(cat "$fixture/pool/.active")" == "school" ]] || { echo "tree=$tree head=$(git -C "$tree" rev-parse HEAD)" >&2; tail -80 "$fixture/manual.log" >&2; fail "$scenario $revision manual did not switch to school"; }
  if [[ "$scenario" == "token-rotation" ]]; then
    [[ "$(jq -r '.claudeAiOauth.accessToken' "$fixture/pool/personal/.credentials.json")" == "personal-rotated" ]] \
      || fail "$scenario $revision manual did not synchronize the rotated personal credential"
    [[ "$(wc -l < "$fixture/audit.log" | tr -d ' ')" == "2" ]] || fail "$scenario $revision manual audit was not one entry/exit pair"
  fi
  write_evidence "$scenario" "$revision" manual "$fixture" "$rc"
}

run_daemon() {
  local scenario="$1" revision="$2" tree="$3" fixture outcome
  fixture="$(make_fixture "$scenario-$revision-daemon")"
  export_fixture_env "$fixture" "$tree" "$tree"
  if [[ "$scenario" == "token-rotation" ]]; then
    rotate_live_personal "$fixture"
    : > "$fixture/fail-next-security-read"
  else
    drift_live_to_business "$fixture"
    : > "$fixture/fail-next-security-read"
    [[ "$(cat "$fixture/pool/.active")" == "personal" ]] || fail "$scenario $revision drift fixture marker changed before trigger"
    curl -fsS -H "Authorization: Bearer business-original" "http://127.0.0.1:$PORT/v1/oauth/profile" | jq -e '.account.uuid == "uuid-business"' >/dev/null \
      || fail "$scenario $revision drift fixture did not resolve live identity as business"
  fi
  start_daemon "$tree" "$fixture"
  wait_for_log "$fixture/daemon.log" '"event":"quota_poll"' || fail "$scenario $revision daemon did not complete a quota poll"
  stop_daemon
  outcome="$(jq -Rr 'fromjson? | select(.event == "quota_poll") | .outcome' "$fixture/daemon.log" | tail -1)"
  if [[ "$scenario" == "token-rotation" ]]; then
    [[ "$outcome" == "switched" && "$(cat "$fixture/pool/.active")" == "school" ]] || fail "$scenario $revision daemon outcome was $outcome"
    [[ "$(jq -r '.claudeAiOauth.accessToken' "$fixture/pool/personal/.credentials.json")" == "personal-rotated" ]] \
      || fail "$scenario $revision daemon did not synchronize the rotated credential"
    [[ "$(wc -l < "$fixture/audit.log" | tr -d ' ')" == "2" ]] || fail "$scenario $revision daemon audit was not one entry/exit pair"
  elif [[ "$revision" == "baseline" ]]; then
    [[ "$outcome" == "switch_failed" ]] || fail "$scenario baseline daemon unexpectedly returned $outcome"
    grep -q '"trigger":"witness"' "$fixture/daemon.log" && fail "$scenario baseline witness repaired drift before the switch path"
    grep -q 'detail' "$fixture/daemon.log" && fail "$scenario baseline daemon unexpectedly exposed failure detail"
  else
    [[ "$outcome" == "switched" && "$(cat "$fixture/pool/.active")" == "school" ]] || fail "$scenario current daemon outcome was $outcome"
    jq -Re 'fromjson? | select(.event == "account_switch_reconcile" and .trigger == "drift_recovery" and .ok == true and .from == "personal" and .to == "business")' "$fixture/daemon.log" >/dev/null \
      || fail "$scenario current daemon missed strict drift recovery evidence"
    grep -q '"trigger":"witness"' "$fixture/daemon.log" && fail "$scenario current witness repaired drift before the switch path"
    grep -q '"event":"account_switch_failed"' "$fixture/daemon.log" && fail "$scenario current daemon logged a final switch failure"
    jq -e 'select(.kind == "account_switch_failed")' "$fixture/alerts.log" >/dev/null && fail "$scenario current daemon emitted a failed-switch alert"
  fi
  [[ ! -s "$fixture/claude.log" ]] || fail "$scenario $revision invoked Claude"
  write_evidence "$scenario" "$revision" daemon "$fixture" 0
}

empty_state() {
  local generation="$1" due="$2"
  jq -cn --argjson generation "$generation" --argjson due "$due" '{version:2,lastPollAt:null,lastSuccessfulUsageAt:null,errorStreak:0,backoffUntilMs:0,nextUsageDueAt:$due,nextPaneScanDueAt:0,confirmDueAt:null,tier:"base",lastCandidateSweepAt:null,lastSwitchAt:null,observedGeneration:$generation,reviveEpoch:null,pendingDetection:null,alertOutbox:[],confirmation:null,unknownPanes:{},modelPaneSuppressions:{},blockedEpisode:null,pendingSwitchFailure:null,identityMismatchEpisodes:null,identityAlertCursor:null}'
}
reset_monitor_state_due_now() {
  local fixture="$1" state generation
  state="$fixture/home/.flywheel/quota-monitor-state.json"
  generation="$(jq -r '.generation' "$fixture/home/.flywheel/claude-accounts.json")"
  if [[ -s "$state" ]]; then
    jq --argjson generation "$generation" '.observedGeneration=$generation | .nextUsageDueAt=0 | .lastSwitchAt=null | .backoffUntilMs=0' "$state" > "$state.next"
  else
    empty_state "$generation" 0 > "$state.next"
  fi
  chmod 600 "$state.next"
  mv "$state.next" "$state"
}
runtime_sha() {
  local tree="$1"
  node --input-type=module -e 'import {pathToFileURL} from "node:url"; const [modulePath,treePath]=process.argv.slice(1); const {runtimeTreeSha256}=await import(pathToFileURL(modulePath)); process.stdout.write(runtimeTreeSha256(treePath));' \
    "$CURRENT_TREE/packages/teamlead/dist/account-heal/runtime-tree-hash.js" "$tree/packages/teamlead/dist/account-heal"
}

run_old_daemon_entry() {
  local revision="$1" profile_tree="$2" fixture old_sha current_sha exit_lines
  fixture="$(make_fixture "old-daemon-$revision-daemon")"
  export_fixture_env "$fixture" "$OLD_TREE" "$profile_tree"
  empty_state 0 4102444800000 > "$fixture/home/.flywheel/quota-monitor-state.json"
  chmod 600 "$fixture/home/.flywheel/quota-monitor-state.json"
  start_daemon "$OLD_TREE" "$fixture"
  for _ in $(seq 1 1200); do [[ -s "$fixture/home/.flywheel/quota-monitor.pid" && -s "$fixture/home/.flywheel/quota-monitor.health.json" ]] && break; sleep 0.1; done
  local pidfile_pid
  pidfile_pid="$(jq -r '.pid' "$fixture/home/.flywheel/quota-monitor.pid" 2>/dev/null || true)"
  if [[ "$pidfile_pid" != "$DAEMON_PID" || ! -s "$fixture/home/.flywheel/quota-monitor.health.json" ]]; then
    echo "old-daemon barrier: shell_pid=$DAEMON_PID pidfile_pid=${pidfile_pid:-missing} alive=$(kill -0 "$DAEMON_PID" 2>/dev/null && echo yes || echo no) health=$([[ -s "$fixture/home/.flywheel/quota-monitor.health.json" ]] && echo yes || echo no)" >&2
    ps -p "$DAEMON_PID" -o pid=,stat=,command= >&2 || true
    tail -80 "$fixture/daemon.log" >&2 || true
    fail "old-daemon $revision pidfile did not identify the old process"
  fi
  old_sha="$(runtime_sha "$OLD_TREE")"
  current_sha="$(runtime_sha "$CURRENT_TREE")"
  [[ "$old_sha" != "$current_sha" ]] || fail "old and current daemon runtime hashes unexpectedly match"
  [[ "$(jq -r '.runtimeTreeSha256' "$fixture/home/.flywheel/quota-monitor.health.json")" == "$old_sha" ]] || fail "old-daemon $revision health marker did not prove old runtime"
  rotate_live_personal "$fixture"
  : > "$fixture/fail-next-security-read"
  reset_monitor_state_due_now "$fixture"
  kill -USR1 "$DAEMON_PID"
  wait_for_log "$fixture/daemon.log" '"event":"quota_poll","outcome":"switch_failed"' || fail "old-daemon $revision did not expose switch_failed"
  if [[ "$revision" == "baseline-script" ]]; then
    [[ ! -s "$fixture/audit.log" ]] || fail "old daemon with baseline script unexpectedly audited its pre-entry failure"
    grep -q 'exit=' "$fixture/alerts.log" && fail "old daemon baseline alert unexpectedly exposed exit evidence"
  else
    exit_lines="$(jq -r 'select(.cmd == "use" and .phase == "exit" and .exitCode == 48 and (.probeSummary | contains("atomic_apply_contract_mismatch"))) | 1' "$fixture/audit.log" | wc -l | tr -d ' ')"
    [[ "$exit_lines" -ge 1 ]] || fail "old daemon with current script missed audited exit 48 contract evidence"
  fi
  write_evidence old-daemon "$revision" daemon "$fixture" 0

  if [[ "$revision" == "current-script" && -r "$CURRENT_TREE/scripts/lib/restart-quota-monitor.sh" ]]; then
    # The production helper owns the decision; these seams only emulate launchd in scratch.
    # shellcheck disable=SC1091
    source "$CURRENT_TREE/scripts/lib/restart-quota-monitor.sh"
    _rqm_runtime_sha() { "$CURRENT_TREE/packages/teamlead/bin/flywheel-quota-monitor" --runtime-tree-sha; }
    _rqm_health_marker_path() { printf '%s\n' "$fixture/home/.flywheel/quota-monitor.health.json"; }
    _rqm_pidfile_path() { printf '%s\n' "$fixture/home/.flywheel/quota-monitor.pid"; }
    _rqm_process_start_time() {
      local pid="$1"
      kill -0 "$pid" 2>/dev/null || return 1
      jq -r --argjson pid "$pid" 'select(.pid == $pid) | .processStartTime' "$fixture/home/.flywheel/quota-monitor.pid"
    }
    _rqm_sleep() { sleep 0.1; }
    _rqm_launchctl() {
      case "$1" in
        print) kill -0 "$DAEMON_PID" 2>/dev/null ;;
        kickstart)
          stop_daemon
          reset_monitor_state_due_now "$fixture"
          export_fixture_env "$fixture" "$CURRENT_TREE" "$CURRENT_TREE"
          start_daemon "$CURRENT_TREE" "$fixture" append
          ;;
        *) return 2 ;;
      esac
    }
    restart_quota_monitor
    [[ "$QUOTA_MONITOR_RESTART_STATE" == "restarted" ]] || fail "restart helper returned $QUOTA_MONITOR_RESTART_STATE: $QUOTA_MONITOR_RESTART_DETAIL"
    wait_for_log "$fixture/daemon.log" '"event":"quota_poll","outcome":"switched"' || fail "restarted current daemon did not switch"
    stop_daemon
    write_evidence old-daemon restarted-current daemon "$fixture" 0
  fi
}

if [[ "$SCENARIO" == "token-rotation" || "$SCENARIO" == "all" ]]; then
  [[ -z "$BASELINE_TREE" ]] || { run_manual token-rotation baseline "$BASELINE_TREE"; run_daemon token-rotation baseline "$BASELINE_TREE"; }
  run_manual token-rotation current "$CURRENT_TREE"
  run_daemon token-rotation current "$CURRENT_TREE"
fi
if [[ "$SCENARIO" == "true-drift" || "$SCENARIO" == "all" ]]; then
  [[ -z "$BASELINE_TREE" ]] || { run_manual true-drift baseline "$BASELINE_TREE"; run_daemon true-drift baseline "$BASELINE_TREE"; }
  run_manual true-drift current "$CURRENT_TREE"
  run_daemon true-drift current "$CURRENT_TREE"
fi
if [[ "$SCENARIO" == "old-daemon" || "$SCENARIO" == "all" ]]; then
  [[ -z "$BASELINE_TREE" ]] || run_old_daemon_entry baseline-script "$BASELINE_TREE"
  run_old_daemon_entry current-script "$CURRENT_TREE"
fi

baseline_token="not run (--baseline omitted)"
baseline_manual_drift="not run (--baseline omitted)"
baseline_drift="not run (--baseline omitted)"
baseline_old="not run (--baseline omitted)"
if [[ -n "$BASELINE_REF" ]]; then
  baseline_token="switched; one audit entry/exit; rotated live credential captured"
  baseline_manual_drift="strict reconcile then switched"
  baseline_drift="switch_failed; no daemon detail"
  baseline_old="baseline script: switch_failed, zero audit/exit evidence"
fi
cat > "$EVIDENCE_DIR/README.md" <<EOF
# FLY-2271 daemon switch evidence — 台架证据
Issue: FLY-2271 (https://linear.app/geoforge3d/issue/FLY-2271/切号器daemon-自动切号在-token-轮转后必失败委托模式对-stale-active-marker不修复直接-46)
日期: $(date +%F)
基于: ../plan.md

| Scenario | Baseline | Current |
| --- | --- | --- |
| token rotation, manual | $baseline_token | switched; one audit entry/exit; rotated live credential captured |
| token rotation, daemon | $baseline_token | switched; one audit entry/exit; rotated live credential captured |
| true identity drift, manual | $baseline_manual_drift | strict reconcile then switched |
| true identity drift, daemon | $baseline_drift | strict drift recovery personal→business, then switched |
| old daemon + tested script | $baseline_old | current script: audited exit 48; restart helper restarted; current daemon switched |

Generated by \`bash scripts/qa-fly-2271-switch-evidence-e2e.sh $SCENARIO${BASELINE_REF:+ --baseline $BASELINE_REF}\`. JSON files contain only redacted audit fields, structured events, and alert bodies.
EOF

if grep -R -F -e personal-original -e school-original -e business-original -e personal-refresh -e school-refresh -e business-refresh -e personal-rotated "$EVIDENCE_DIR" >/dev/null; then
  fail "credential material leaked into committed evidence"
fi
log "PASS: $SCENARIO evidence written to $EVIDENCE_DIR"
