#!/usr/bin/env bash
# FLY-1256 M6 / FLY-1182: hermetic on-machine E2E for the Claude-external quota daemon.
#
# This launches the real compiled daemon against a local OAuth/usage server, a
# scratch Keychain adapter, the real flywheel-claude-profile switch script, an
# isolated tmux server, and an isolated alert sink. No production credential,
# tmux server, alert channel, config, store, cache, or lock is reachable.
set -euo pipefail

QA_MODE="${1:-account}"
case "$QA_MODE" in
  account|model|rate-limit|unmanaged-model) ;;
  *) echo "usage: $0 [account|model|rate-limit|unmanaged-model]" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEAMLEAD_DIR="$REPO_DIR/packages/teamlead"
DAEMON_BIN="$TEAMLEAD_DIR/bin/flywheel-quota-monitor"
PROFILE_BIN="$REPO_DIR/packages/claude-runner/bin/flywheel-claude-profile"
FRESHNESS_BIN="$TEAMLEAD_DIR/bin/flywheel-claude-freshness"
if [[ "$QA_MODE" == "model" || "$QA_MODE" == "unmanaged-model" ]]; then
  PANE_FIXTURE="$TEAMLEAD_DIR/src/__tests__/fixtures/lead-panes/model-limit-real.txt"
  PANE_MATCH='reached your Fable 5 limit'
else
  PANE_FIXTURE="$TEAMLEAD_DIR/src/__tests__/fixtures/lead-panes/usage-limit-real.txt"
  PANE_MATCH='Claude usage limit reached'
fi
RECOVERED_FIXTURE="$TEAMLEAD_DIR/src/__tests__/fixtures/lead-panes/idle-product-lead.txt"
TMP_BASE="${TMPDIR:-/tmp}"
ROOT="$(mktemp -d "${TMP_BASE%/}/fly1256-${QA_MODE}-e2e.XXXXXX")"
TMUX_SOCKET="fly1256-${QA_MODE}-e2e-$$"
SERVER_PID="" DAEMON_PID=""

log() { echo "[FLY-1256 ${QA_MODE} E2E] $*"; }
fail() { echo "[FLY-1256 ${QA_MODE} E2E] FAIL: $*" >&2; exit 1; }
cleanup() {
  [[ -n "$DAEMON_PID" ]] && kill -TERM "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$DAEMON_PID" ]] && wait "$DAEMON_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill -TERM "$SERVER_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  if [[ "${FLYWHEEL_QUOTA_E2E_KEEP:-0}" == "1" ]]; then
    log "kept scratch evidence at $ROOT"
  else
    rm -rf "$ROOT"
  fi
}
on_error() {
  rc=$?
  echo "[FLY-1256 ${QA_MODE} E2E] diagnostic tail:" >&2
  tail -40 "$ROOT/daemon.log" "$ROOT/http.log" "$ROOT/alerts.log" 2>/dev/null >&2 || true
  exit "$rc"
}
trap on_error ERR
trap cleanup EXIT

for tool in node pnpm jq tmux ps; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing prerequisite: $tool"
done
[[ -x "$DAEMON_BIN" && -x "$PROFILE_BIN" && -x "$FRESHNESS_BIN" ]] \
  || fail "quota/profile/freshness launchers must be executable"
[[ -f "$PANE_FIXTURE" && -f "$RECOVERED_FIXTURE" ]] \
  || fail "quota/recovered pane fixture missing"

log "building the production daemon entry"
pnpm --dir "$TEAMLEAD_DIR" build >/dev/null

mkdir -p "$ROOT/home/.flywheel" "$ROOT/home/.claude" "$ROOT/pool" "$ROOT/bin"
POOL="$ROOT/pool"
STORE="$ROOT/home/.flywheel/claude-accounts.json"
LOCK="$ROOT/home/.flywheel/claude-accounts.lock"
CONFIG="$ROOT/home/.flywheel/quota-monitor.json"
STATE="$ROOT/home/.flywheel/quota-monitor-state.json"
PIDFILE="$ROOT/home/.flywheel/quota-monitor.pid"
CACHE="$ROOT/home/.claude/usage-api-cache.json"
KEYCHAIN_STATE="$ROOT/keychain-state.json"

make_credential() { # profile access refresh canonical-email
  local profile="$1" access="$2" refresh="$3" email="$4"
  mkdir -p "$POOL/$profile"
  chmod 700 "$POOL" "$POOL/$profile"
  jq -cn --arg access "$access" --arg refresh "$refresh" \
    '{claudeAiOauth:{accessToken:$access,refreshToken:$refresh,expiresAt:4102444800000}}' \
    > "$POOL/$profile/.credentials.json"
  chmod 600 "$POOL/$profile/.credentials.json"
  jq -cn --arg suffix "$profile" --arg email "$email" \
    '{accountUuid:("uuid-"+$suffix),emailAddress:$email,organizationUuid:("org-"+$suffix),organizationName:("Org "+$suffix)}' \
    > "$POOL/$profile/oauthAccount.json"
  chmod 600 "$POOL/$profile/oauthAccount.json"
  jq -cn --arg suffix "$profile" --arg email "$email" \
    '{accountUuid:("uuid-"+$suffix),email:$email,anchoredAt:"2026-07-16T00:00:00.000Z",anchoredBy:"fly1256-hermetic-e2e",confirmedBy:"scratch-fixture"}' \
    > "$POOL/$profile/identity-anchor.json"
  chmod 600 "$POOL/$profile/identity-anchor.json"
}
make_credential shopping shopping-active shopping-refresh xrliannie.shopping@gmail.com
make_credential school school-old school-refresh xiaorongli2011@u.northwestern.edu
make_credential backup backup-old backup-refresh backup@example.test
jq -n '{
  version:1,
  artifactId:"fly1256-hermetic-identity-map",
  confirmedAt:"2026-07-16T00:00:00.000Z",
  labels:{
    business:"xrliannie.b@gmail.com",
    personal:"xrliannie@gmail.com",
    personal1:"xrliannie.1@gmail.com",
    school:"xiaorongli2011@u.northwestern.edu",
    shopping:"xrliannie.shopping@gmail.com"
  }
}' > "$POOL/identity-map.json"
chmod 600 "$POOL/identity-map.json"
printf '%s' shopping > "$POOL/.active"
chmod 600 "$POOL/.active"
printf '%s' "$(cat "$POOL/shopping/.credentials.json")" > "$KEYCHAIN_STATE"
chmod 600 "$KEYCHAIN_STATE"
jq -n '{
  generation:0,
  activeAccount:"shopping",
  accounts:[
    {name:"shopping",email:"xrliannie.shopping@gmail.com"},
    {name:"school",email:"xiaorongli2011@u.northwestern.edu"},
    {name:"backup",email:"backup@example.test"}
  ] | map({
    name: .name,
    quotaExhaustedUntil:null,
    weeklyResetAt:null,
    identity:{email:.email,setAt:"2026-07-16T00:00:00.000Z"}
  })
}' > "$STORE"
chmod 600 "$STORE"
jq -n '{
  trigger5hPct:90,
  basePollMinutes:1,
  acceleratePct:70,
  acceleratedPollMinutes:1,
  candidateSweepMinutes:60,
  minSwitchIntervalMinutes:1,
  order:["shopping","school","backup"],
  writeStatuslineCache:true,
  paneScanSeconds:1,
  confirmDelayMinutes:5
}' > "$CONFIG"
chmod 600 "$CONFIG"
cp "$POOL/shopping/oauthAccount.json" "$ROOT/active-identity.json"
jq -n --slurpfile identity "$ROOT/active-identity.json" '{numStartups:1,oauthAccount:$identity[0]}' \
  > "$ROOT/home/.claude.json"
chmod 600 "$ROOT/home/.claude.json"

# Scratch replacement for macOS `security`: secrets flow on stdin for writes,
# never argv, matching the real flywheel-claude-profile contract.
cat > "$ROOT/bin/security" <<'SECURITY'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_SECURITY_ARGV_LOG"
case "${1:-}" in
  find-generic-password)
    cat "$FAKE_SECURITY_STATE"
    ;;
  -i)
    command_text="$(cat)"
    value="$(printf '%s' "$command_text" | sed -n 's/.* -w \([^ ]*\).*/\1/p')"
    [[ -n "$value" ]] || exit 2
    if [[ -f "${FAKE_SECURITY_CORRUPT_NEXT_WRITE_FILE:-}" ]]; then
      rm -f "$FAKE_SECURITY_CORRUPT_NEXT_WRITE_FILE"
      printf '%s' '{"corrupted":true}' > "$FAKE_SECURITY_STATE"
    else
      printf '%s' "$value" > "$FAKE_SECURITY_STATE"
    fi
    ;;
  *) exit 2 ;;
esac
SECURITY

# A sentinel proves no Claude executable participates in detection/switching.
cat > "$ROOT/bin/claude" <<'CLAUDE'
#!/usr/bin/env bash
printf 'unexpected claude invocation: %s\n' "$*" >> "$CLAUDE_PARTICIPATION_LOG"
exit 99
CLAUDE

cat > "$ROOT/bin/lead-alert" <<'ALERT'
#!/usr/bin/env bash
set -euo pipefail
printf 'channel=%s|%s\n' "${FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID:-}" "$*" >> "$FAKE_ALERT_LOG"
printf 'sent\n'
ALERT
chmod +x "$ROOT/bin/security" "$ROOT/bin/claude" "$ROOT/bin/lead-alert"
: > "$ROOT/security-argv.log"
: > "$ROOT/alerts.log"
: > "$ROOT/claude-participation.log"

# Local server logs only account classes and request ordering, never tokens.
cat > "$ROOT/mock-server.mjs" <<'MOCK'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const [portFile, logFile, mode] = process.argv.slice(2);
let refreshCounter = 0;
const record = (line) => appendFileSync(logFile, `${line}\n`);
const json = (res, status, body) => {
  const raw = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
};
const resetBase = Date.now();
const future = (hours) => new Date(resetBase + hours * 60 * 60_000).toISOString();
const usage = (account) => ({
  five_hour: { utilization: account === "shopping" ? (mode.includes("model") ? 20 : 92) : account === "school" ? 3 : 4, resets_at: future(2) },
  // Deliberately invert the legacy configured order: backup is listed after
  // school but has the earlier weekly reset, so the generic selector must win.
  seven_day: { utilization: account === "shopping" ? 20 : 10, resets_at: future(account === "backup" ? 48 : 72) },
  limits: [{
    kind: "weekly_scoped",
    percent: account === "shopping" ? 84 : account === "school" ? 11 : 12,
    resets_at: future(96),
    scope: { model: { id: null, display_name: "Fable" }, surface: null },
  }],
});
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/oauth/profile") {
    const auth = String(req.headers.authorization ?? "");
    const account = auth.includes("shopping-") ? "shopping" : auth.includes("school-") ? "school" : auth.includes("backup-") ? "backup" : "unknown";
    const emails = {
      shopping: "xrliannie.shopping@gmail.com",
      school: "xiaorongli2011@u.northwestern.edu",
      backup: "backup@example.test",
    };
    record(`identity:${account}`);
    if (account === "unknown") return json(res, 401, { error: "unauthorized" });
    return json(res, 200, { account: { uuid: `uuid-${account}`, email: emails[account] } });
  }
  if (req.method === "GET" && req.url === "/api/oauth/usage") {
    const auth = String(req.headers.authorization ?? "");
    const account = auth.includes("shopping-") ? "shopping" : auth.includes("school-") ? "school" : auth.includes("backup-") ? "backup" : "unknown";
    record(`usage:${account}`);
    if (account === "unknown") return json(res, 401, { error: "unauthorized" });
    if (mode === "rate-limit" && account === "shopping") return json(res, 529, { error: "overloaded" });
    return json(res, 200, usage(account));
  }
  if (req.method === "POST" && req.url === "/v1/oauth/token") {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "bad_json" }); }
      const refresh = String(body.refresh_token ?? "");
      const account = refresh.startsWith("school-") ? "school" : refresh.startsWith("backup-") ? "backup" : "unknown";
      record(`refresh:${account}`);
      if (account === "unknown") return json(res, 401, { error: "bad_refresh" });
      refreshCounter += 1;
      return json(res, 200, {
        access_token: `${account}-rotated-${refreshCounter}`,
        refresh_token: `${account}-refresh-${refreshCounter}`,
        expires_in: 3600,
      });
    });
    return;
  }
  json(res, 404, { error: "not_found" });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  writeFileSync(portFile, `${address.port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
MOCK
: > "$ROOT/http.log"
node "$ROOT/mock-server.mjs" "$ROOT/http-port" "$ROOT/http.log" "$QA_MODE" > "$ROOT/mock.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do [[ -s "$ROOT/http-port" ]] && break; sleep 0.1; done
[[ -s "$ROOT/http-port" ]] || fail "mock server did not bind"
PORT="$(cat "$ROOT/http-port")"

# The pane is deliberately only a shell reading stdin. It becomes eligible only
# through the two-key QA seam: a pane-local marker plus the isolated daemon env
# gate below. No production pane or ordinary shell can inherit this authority.
cat > "$ROOT/quota-pane.sh" <<PANE
#!/usr/bin/env bash
cat "$PANE_FIXTURE"
IFS= read -r response
printf '%s\n' "\$response" > "$ROOT/pane-response"
if [[ "$QA_MODE" == "model" ]]; then
  while [[ ! -e "$ROOT/allow-pane-recovery" ]]; do sleep 0.05; done
  printf '\033[2J\033[H'
  cat "$RECOVERED_FIXTURE"
fi
while :; do sleep 60; done
PANE
chmod +x "$ROOT/quota-pane.sh"
# Match a real Lead pane width so the audited cap sentence remains one line;
# the classifier deliberately rejects a sentence wrapped before its period.
tmux -L "$TMUX_SOCKET" new-session -d -x 220 -y 20 \
  -s flywheel-quota-qa -n FLY-1182-quota-dead "$ROOT/quota-pane.sh"
PANE_TARGET='flywheel-quota-qa:FLY-1182-quota-dead.0'
if [[ "$QA_MODE" != "unmanaged-model" ]]; then
  tmux -L "$TMUX_SOCKET" set-option -p -t "$PANE_TARGET" \
    @flywheel_quota_qa 1
fi
for _ in $(seq 1 50); do
  tmux -L "$TMUX_SOCKET" capture-pane -p -t "$PANE_TARGET" 2>/dev/null \
    | grep -q "$PANE_MATCH" && break
  sleep 0.1
done
tmux -L "$TMUX_SOCKET" capture-pane -p -t "$PANE_TARGET" \
  | grep -q "$PANE_MATCH" \
  || fail "isolated tmux pane never rendered the quota fixture"

export HOME="$ROOT/home"
export PATH="$ROOT/bin:$PATH"
export FLYWHEEL_QUOTA_MONITOR_CONFIG="$CONFIG"
export FLYWHEEL_QUOTA_API_BASE="http://127.0.0.1:$PORT"
export FLYWHEEL_QUOTA_STATUSLINE_CACHE="$CACHE"
export FLYWHEEL_QUOTA_TMUX_SOCKET="$TMUX_SOCKET"
export FLYWHEEL_QUOTA_QA_INJECTION=1
export FLYWHEEL_QUOTA_STATE_PATH="$STATE"
export FLYWHEEL_QUOTA_PIDFILE="$PIDFILE"
export FLYWHEEL_QUOTA_CONFIRMATION_DIR="$ROOT/confirmations"
export FLYWHEEL_CLAUDE_PROFILES_DIR="$POOL"
export FLYWHEEL_CLAUDE_ACCOUNTS_PATH="$STORE"
export FLYWHEEL_CLAUDE_ACCOUNTS_LOCK="$LOCK"
export FLYWHEEL_CLAUDE_SECURITY_BIN="$ROOT/bin/security"
export FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE="FLY-1256 Scratch-credentials"
export FLYWHEEL_CLAUDE_KEYCHAIN_ACCOUNT="fly1256-e2e"
export FLYWHEEL_CLAUDE_PROFILE_BIN="$PROFILE_BIN"
export FLYWHEEL_CLAUDE_FRESHNESS_BIN="$FRESHNESS_BIN"
export FLYWHEEL_CLAUDE_OAUTH_ENDPOINT="http://127.0.0.1:$PORT/v1/oauth/token"
export FLYWHEEL_PROFILE_IDENTITY_ENDPOINT="http://127.0.0.1:$PORT/v1/oauth/profile"
export FLYWHEEL_PROFILE_IDENTITY_MAP="$POOL/identity-map.json"
export FLYWHEEL_CLAUDE_JSON="$ROOT/home/.claude.json"
export FLYWHEEL_CLAUDE_JSON_LOCK="$ROOT/home/.claude.json.lock"
export FLYWHEEL_LEAD_ALERT_BIN="$ROOT/bin/lead-alert"
export FLYWHEEL_NOTIFY_CHANNEL="$(printf '7%.0s' {1..18})"
export FLYWHEEL_FOUNDER_TZ="America/Los_Angeles"
export FAKE_SECURITY_STATE="$KEYCHAIN_STATE"
export FAKE_SECURITY_ARGV_LOG="$ROOT/security-argv.log"
export FAKE_SECURITY_CORRUPT_NEXT_WRITE_FILE="$ROOT/corrupt-next-security-write"
export FAKE_ALERT_LOG="$ROOT/alerts.log"
export CLAUDE_PARTICIPATION_LOG="$ROOT/claude-participation.log"

# Centralized zero-pollution gate: every mutable/read-sensitive seam must stay
# under the one scratch root before the production entrypoint may start.
assert_scratch_path() {
  case "$1" in "$ROOT"/*) ;; *) fail "non-scratch path refused: $1" ;; esac
}
for scratch_path in \
  "$HOME" "$CONFIG" "$CACHE" "$STATE" "$PIDFILE" "$FLYWHEEL_QUOTA_CONFIRMATION_DIR" \
  "$POOL" "$STORE" "$LOCK" "$KEYCHAIN_STATE" "$FLYWHEEL_CLAUDE_SECURITY_BIN" \
  "$FLYWHEEL_CLAUDE_JSON" "$FLYWHEEL_CLAUDE_JSON_LOCK" "$FLYWHEEL_LEAD_ALERT_BIN"; do
  assert_scratch_path "$scratch_path"
done
[[ "$FLYWHEEL_QUOTA_API_BASE" == http://127.0.0.1:* ]] || fail "usage API is not loopback"
[[ "$FLYWHEEL_CLAUDE_OAUTH_ENDPOINT" == http://127.0.0.1:* ]] || fail "OAuth endpoint is not loopback"
[[ "$FLYWHEEL_CLAUDE_KEYCHAIN_SERVICE" == "FLY-1256 Scratch-credentials" ]] \
  || fail "scratch Keychain service guard failed"
[[ "$FLYWHEEL_QUOTA_QA_INJECTION" == "1" && "$TMUX_SOCKET" == fly1256-*-e2e-* ]] \
  || fail "QA injection/socket guard failed"

if [[ "$QA_MODE" == "model" ]]; then
  cp "$KEYCHAIN_STATE" "$ROOT/keychain-before-rollback.json"
  : > "$FAKE_SECURITY_CORRUPT_NEXT_WRITE_FILE"
  if "$PROFILE_BIN" use school > "$ROOT/rollback.log" 2>&1; then
    fail "profile switch unexpectedly committed after a corrupted Keychain write"
  fi
  [[ ! -e "$FAKE_SECURITY_CORRUPT_NEXT_WRITE_FILE" ]] \
    || fail "rollback injection was not consumed; profile failed before the Keychain write"
  [[ "$(jq -r '.corrupted // false' "$KEYCHAIN_STATE")" == "true" ]] \
    || fail "concurrent Keychain mutation was overwritten after verification failed"
  [[ "$(cat "$POOL/.active")" == "shopping" ]] \
    || fail "failed profile verification changed .active"
  grep -q 'FLYWHEEL_MANUAL_SWITCH_FAILED reason=keychain_preimage_conflict' "$ROOT/rollback.log" \
    || fail "atomic executor did not report the fail-closed preimage conflict"
  # Reset only the scratch fixture after proving the production command refused
  # to overwrite a concurrent mutation; the daemon scenario starts from the
  # original shopping credential.
  cp "$ROOT/keychain-before-rollback.json" "$KEYCHAIN_STATE"
  chmod 600 "$KEYCHAIN_STATE"
fi

log "starting real daemon with Claude absent"
"$DAEMON_BIN" > "$ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 0.2
kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon exited during startup"
for _ in $(seq 1 50); do [[ -s "$PIDFILE" ]] && break; sleep 0.1; done
[[ "$(jq -r '.pid // empty' "$PIDFILE" 2>/dev/null)" == "$DAEMON_PID" ]] \
  || fail "singleton pidfile is not owned by the daemon"
if daemon_comm="$(ps -p "$DAEMON_PID" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')" \
  && [[ -n "$daemon_comm" ]]; then
  [[ "$daemon_comm" == "node" ]] || fail "daemon owner is not Node (comm=$daemon_comm)"
  ps_proof="ps"
else
  # Some CI/sandbox hosts deny /bin/ps. The pidfile owner plus the claude
  # executable sentinel still proves the tested process path; unsandboxed
  # on-machine QA records the stronger ps branch above.
  daemon_comm="node(pidfile)"
  ps_proof="pidfile+exec-sentinel (ps unavailable)"
fi

if [[ "$QA_MODE" == "rate-limit" || "$QA_MODE" == "unmanaged-model" ]]; then
  for _ in $(seq 1 100); do
    if [[ "$QA_MODE" == "rate-limit" ]]; then
      [[ "$(jq -r '.errorStreak' "$STATE" 2>/dev/null || true)" =~ ^[1-9][0-9]*$ ]] && break
    else
      [[ "$(jq -r '.lastSuccessfulUsageAt != null' "$STATE" 2>/dev/null || true)" == "true" ]] && break
    fi
    sleep 0.1
  done
  [[ "$(cat "$POOL/.active")" == "shopping" ]] || fail "negative case switched the profile"
  [[ "$(jq -r '.generation' "$STORE")" == "0" ]] || fail "negative case changed the account generation"
  [[ "$(jq -r '.pendingDetection' "$STATE")" == "null" ]] || fail "negative case persisted a model detection"
  [[ ! -e "$ROOT/pane-response" ]] || fail "negative case sent continue to the pane"
  if grep -Eq -- '--kind (account_switched|model_cap_switched)' "$ROOT/alerts.log"; then
    fail "negative case emitted a switch alert"
  fi
  [[ ! -s "$ROOT/claude-participation.log" ]] || fail "a Claude executable participated"
  kill -TERM "$DAEMON_PID"
  wait "$DAEMON_PID"
  DAEMON_PID=""
  [[ ! -e "$PIDFILE" ]] || fail "graceful shutdown left the singleton pidfile behind"
  if [[ "$QA_MODE" == "rate-limit" ]]; then
    log "PASS: live HTTP 529 produced no switch, no generation change, and no pane keystroke"
  else
    log "PASS: an unmarked shell rendering the real model-cap fixture produced no detection, switch, or keystroke"
  fi
  exit 0
fi

# Every successful account change emits the same durable notification kind;
# the trigger remains context in the body (quota:5h vs model:Fable 5).
SWITCH_KIND="account_switched"
EXPECTED_TARGET="backup"
EXPECTED_TARGET_EMAIL="backup@example.test"
EXPECTED_TARGET_FIVE_H="4"
for _ in $(seq 1 300); do
  [[ "$(cat "$POOL/.active" 2>/dev/null || true)" == "$EXPECTED_TARGET" ]] \
    && [[ "$(cat "$ROOT/pane-response" 2>/dev/null || true)" == "continue" ]] \
    && grep -q -- "--kind $SWITCH_KIND" "$ROOT/alerts.log" 2>/dev/null \
    && [[ "$(jq -r '[.reviveEpoch.panes[].attempts] | max // 0' "$STATE" 2>/dev/null || true)" -ge 1 ]] \
    && [[ "$(jq -r '[.reviveEpoch.panes[].attempts] | max // 0' "$STATE" 2>/dev/null || true)" -le 3 ]] \
    && break
  sleep 0.1
done

[[ "$(cat "$POOL/.active")" == "$EXPECTED_TARGET" ]] \
  || fail "profile did not select the earliest-reset target ($EXPECTED_TARGET)"
[[ "$(jq -r '.activeAccount' "$STORE")" == "$EXPECTED_TARGET" ]] \
  || fail "CAS store did not commit $EXPECTED_TARGET"
[[ "$(jq -r '.generation' "$STORE")" == "1" ]] || fail "CAS generation did not increment exactly once"
[[ "$(cat "$ROOT/pane-response")" == "continue" ]] || fail "quota-stuck pane was not revived with literal continue+Enter"
grep -q -- "--kind $SWITCH_KIND" "$ROOT/alerts.log" || fail "isolated alert sink missed $SWITCH_KIND"
grep -q -- '--strict-delivery' "$ROOT/alerts.log" || fail "alert did not use strict delivery"
if [[ "$QA_MODE" == "model" ]]; then
  grep -q -- '（model:Fable 5）' "$ROOT/alerts.log" \
    || fail "unified switch notification omitted the model trigger"
fi
if [[ "$QA_MODE" != "model" ]]; then
  grep -q -- "channel=$FLYWHEEL_NOTIFY_CHANNEL|.*--kind account_switched" "$ROOT/alerts.log" \
    || fail "account_switched did not inherit the notification-channel override"
  grep -q -- '--plain-message' "$ROOT/alerts.log" \
    || fail "account_switched did not request ordinary-message rendering"
  grep -q -- "Claude 已切号：\*\*shopping → $EXPECTED_TARGET\*\*" "$ROOT/alerts.log" \
    || fail "account_switched omitted the unified switch summary"
  grep -q -- 'xrliannie.shopping@gmail.com' "$ROOT/alerts.log" \
    || fail "account_switched omitted the source email"
  grep -q -- "$EXPECTED_TARGET_EMAIL" "$ROOT/alerts.log" \
    || fail "account_switched omitted the target email"
  grep -Eq -- '5h[[:space:]]+92%[[:space:]]+8%' "$ROOT/alerts.log" \
    || fail "account_switched omitted the source five-hour usage/remaining row"
  grep -Eq -- 'Fable[[:space:]]+84%[[:space:]]+16%' "$ROOT/alerts.log" \
    || fail "account_switched omitted the source Fable quota"
  if grep -Eq -- '切号时|继续指令|仍在等待|已恢复' "$ROOT/alerts.log"; then
    fail "account_switched leaked founder-rejected pane revive status"
  fi
  if grep -Eq -- 'from5h=|to5h=|revived=|pending=' "$ROOT/alerts.log"; then
    fail "account_switched leaked the superseded machine-field copy"
  fi
fi
[[ "$(jq -r '.five_hour.utilization' "$CACHE")" == "$EXPECTED_TARGET_FIVE_H" ]] \
  || fail "statusline cache was not refreshed from new account"
revive_attempts="$(jq -r '[.reviveEpoch.panes[].attempts] | max // 0' "$STATE")"
[[ "$revive_attempts" -ge 1 && "$revive_attempts" -le 3 ]] \
  || fail "revive attempts were not durably bounded to 1..3 (got $revive_attempts)"
[[ "$(jq -r --arg target "$EXPECTED_TARGET" '.claudeAiOauth.accessToken | startswith($target + "-rotated-")' "$KEYCHAIN_STATE")" == "true" ]] \
  || fail "scratch Keychain was not switched to refreshed $EXPECTED_TARGET credential"

if [[ "$QA_MODE" == "model" ]]; then
  : > "$ROOT/allow-pane-recovery"
  for _ in $(seq 1 100); do
    tmux -L "$TMUX_SOCKET" capture-pane -p -t "$PANE_TARGET" 2>/dev/null \
      | grep -q "$PANE_MATCH" || break
    sleep 0.1
  done
fi

grep -q '^refresh:school$' "$ROOT/http.log" \
  || fail "generic selection did not live-verify school"
grep -q '^refresh:backup$' "$ROOT/http.log" \
  || fail "generic selection did not live-verify backup"
backup_reset="$(jq -r '.accounts[] | select(.name == "backup") | .weeklyResetAt' "$STORE")"
school_reset="$(jq -r '.accounts[] | select(.name == "school") | .weeklyResetAt' "$STORE")"
[[ "$backup_reset" < "$school_reset" ]] \
  || fail "fixture did not preserve backup as the earlier weekly reset"

if [[ "$QA_MODE" == "model" ]]; then
  [[ "$(jq -r '.accounts[] | select(.name == "shopping") | .quotaExhaustedUntil' "$STORE")" == "null" ]] \
    || fail "model cap incorrectly benched the whole shopping account"
  [[ "$(jq -r '.accounts[] | select(.name == "shopping") | .modelCaps["Fable 5"].backoffMs' "$STORE")" == "1800000" ]] \
    || fail "model bench was not committed with the bounded base backoff"
  [[ "$(jq -r '.confirmation.generation' "$STATE")" == "1" ]] \
    || fail "delayed model confirmation was not durably scheduled"
  if tmux -L "$TMUX_SOCKET" capture-pane -p -t "$PANE_TARGET" | grep -q "$PANE_MATCH"; then
    fail "model-cap pane remained visibly capped after continue"
  fi

  # Crash after the committed switch and its durable confirmation intent, then
  # advance only the scratch intent deadline. A fresh real daemon must reclaim
  # the stale pidfile, scan the recovered pane, post confirmation, and drain the
  # durable outbox. This avoids adding a production timing bypass.
  kill -KILL "$DAEMON_PID"
  wait "$DAEMON_PID" 2>/dev/null || true
  DAEMON_PID=""
  jq '(.confirmation.dueAt)=0 | .confirmDueAt=0 | .nextPaneScanDueAt=0' "$STATE" > "$ROOT/state-restart.json"
  chmod 600 "$ROOT/state-restart.json"
  mv "$ROOT/state-restart.json" "$STATE"
  "$DAEMON_BIN" >> "$ROOT/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 100); do
    grep -q -- '--kind quota_switch_confirmation' "$ROOT/alerts.log" 2>/dev/null \
      && [[ "$(jq -r '.confirmation' "$STATE" 2>/dev/null || true)" == "null" ]] \
      && [[ "$(jq -r '.alertOutbox | length' "$STATE" 2>/dev/null || true)" == "0" ]] \
      && break
    sleep 0.1
  done
  grep -q -- '--kind quota_switch_confirmation' "$ROOT/alerts.log" \
    || fail "restart did not deliver the delayed confirmation alert"
  grep -q -- "channel=$FLYWHEEL_NOTIFY_CHANNEL|.*--kind quota_switch_confirmation" "$ROOT/alerts.log" \
    || fail "quota_switch_confirmation did not inherit the notification-channel override"
  grep -q -- 'Claude 切号后的恢复检查已完成' "$ROOT/alerts.log" \
    || fail "quota_switch_confirmation did not render human recovery copy"
  evidence_file="$(find "$FLYWHEEL_QUOTA_CONFIRMATION_DIR" -type f -name '*.json' -print -quit 2>/dev/null || true)"
  [[ -n "$evidence_file" ]] || fail "restart did not write confirmation evidence"
  [[ "$(jq -r '[.recovered,.total,.panes[0].status] | @tsv' "$evidence_file")" == $'1\t1\trecovered' ]] \
    || fail "confirmation evidence did not prove the affected pane recovered"
fi

[[ ! -s "$ROOT/claude-participation.log" ]] || fail "a Claude executable participated"
pane_pid="$(tmux -L "$TMUX_SOCKET" list-panes -t "$PANE_TARGET" -F '#{pane_pid}')"
if pane_comm="$(ps -p "$pane_pid" -o comm= 2>/dev/null | sed 's|.*/||' | tr -d ' ')" \
  && [[ -n "$pane_comm" ]]; then
  [[ "$pane_comm" != "claude" ]] || fail "quota fixture pane unexpectedly runs Claude"
else
  pane_comm="shell(pidfile)"
fi

# Secrets may exist only in the scratch pool/Keychain. They must not cross argv,
# state, cache, daemon logs, HTTP classification logs, or alert payloads.
if grep -E 'shopping-active|school-old|backup-old|shopping-refresh|school-refresh|backup-refresh' \
    "$ROOT/security-argv.log" "$STATE" "$CACHE" "$ROOT/daemon.log" "$ROOT/http.log" "$ROOT/alerts.log" >/dev/null; then
  fail "credential material leaked outside scratch pool/Keychain"
fi

kill -TERM "$DAEMON_PID"
wait "$DAEMON_PID"
DAEMON_PID=""
[[ ! -e "$PIDFILE" ]] || fail "graceful shutdown left the singleton pidfile behind"

if [[ "$QA_MODE" == "model" ]]; then
  log "PASS: real model-cap fixture detected, scratch Keychain/store switched, affected pane revived, crash/restart confirmation recovered"
else
  log "PASS: full pool live-verified, earliest-reset backup selected over configured-order school, quota pane revived, alert isolated"
fi
log "PASS: daemon=$daemon_comm pane=$pane_comm proof=$ps_proof; fake claude invocation count=0"
